// api/_analyticsScoring.js — single source of truth for everything
// derived from raw analytics data.
//
// Phase 3 implements the real recompute math. The function shape +
// invocation contract were locked in Phase 2; this phase just fills
// in the body. Callers (webhook, cron, manual refresh) didn't need
// to change.
//
// Boundary: this module is API-only. The frontend never imports it
// or any subset of it. Frontend renders precomputed truth from
// /analytics/clients/{id}/... and /analytics/videos/.../scoring.
//
// Fixed-order computation inside recomputeClientAnalytics:
//   1. Load all videos for this client (across configured platforms).
//   2. Recompute baselines (median views, median engagement,
//      follower count from the latest /analytics/followers entry).
//   3. Recompute per-video scoring + write each to
//      /analytics/videos/{clientId}/{platform}/{videoId}/scoring.
//      Rule-based, no AI.
//   4. Recompute status badge + momentum (with reason line).
//   5. Decay alerts deferred to Phase 8 (stretch).
//
// All scoring labels written here read from thresholds we keep
// auditable in one place. The frontend's scoringDisplay/* helpers
// turn these into strings; this file is the *truth*.

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { classifyFormat } from "./_analyticsFormatHeuristic.js";
import { buildNextVideoRecs } from "./_analyticsRecsBuilder.js";
import { buildClientProjection, makePortalShortId } from "./_analyticsClientProjection.js";
import { primaryMetricValue, metricNoun, platformMetrics } from "./_platformMetrics.js";
import {
  isClaudeEnabled,
  classifyFormatWithClaude,
  nicheTakeForCompetitorPost,
  nichePulse,
  weeklySummary,
} from "./_analyticsAi.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// ─── Thresholds (single source of truth) ──────────────────────────
// Keep these here, in the API. The frontend's
// src/features/analytics/config/constants.js has mirrors for form UX
// thresholds (e.g. minFormatSampleForRec) but anything scoring-related
// lives server-side, here.
const STATUS = {
  minPostsForStatus: 10,
  minWeeksForStatus: 2,
  growingViewsDeltaPct: 0.10,    // +10% → growing
  losingViewsDeltaPct:  -0.10,   // -10% → losing
};

const OVERPERF = {
  // A post "overperforms" when views are >= 1.5x the client median.
  // Below this the label doesn't render at all.
  noiseFloorScore: 1.5,
  // 3x median views without matching engagement = likely algorithm
  // push, not a connecting piece. Tag as one-off.
  spikeScore: 3.0,
  // If engagementVsBaseline is below this on a high-views post, that's
  // the "spike but didn't connect" signature.
  spikeEngagementCutoff: 0.7,
};

const REPEAT = {
  // Tunable thresholds — start conservative per the plan's
  // "highest-stakes scoring decision" note in the Risks section.
  overperfBonus: 40,       // contribution if overperformanceScore >= 2.0
  overperfMinForBonus: 2.0,
  engagementBonus: 30,     // contribution if engagementVsBaseline >= 1.5
  engagementMinForBonus: 1.5,
  reachBonus: 20,          // contribution if views >= followerCount * 0.5
  reachFollowerFraction: 0.5,
  // Recency penalty: older wins fade, harder to reproduce conditions.
  recencyAgeFreshDays: 14,
  recencyAgeMidDays: 60,
  recencyMidPenalty: 10,
  recencyOldPenalty: 20,
  // Label cutoffs (0–100 → label).
  repeatableMin: 70,
  oneOffMax: 30,
};

const MOMENTUM = {
  base: 50,
  viewsWeight: 20,
  engagementWeight: 10,
  postFrequencyWeight: 10,
  competitorWeight: 10,
};

// ─── fb helpers (admin-or-REST) ────────────────────────────────────

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export const _fb = { fbGet, fbSet, fbPatch };

// ─── Math helpers (pure) ──────────────────────────────────────────

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].filter(v => v != null && !Number.isNaN(+v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function latestSnapshot(video) {
  const snaps = video?.snapshots || {};
  const keys = Object.keys(snaps).sort();
  if (!keys.length) return null;
  return snaps[keys[keys.length - 1]];
}

function latestFollowerCount(followers) {
  const map = followers || {};
  const keys = Object.keys(map).sort();
  if (!keys.length) return null;
  const last = map[keys[keys.length - 1]];
  return last?.count ?? null;
}

// ─── Scoring computations (pure, given precomputed inputs) ────────

// `metric` is the headline value for this platform (views for IG/YT/
// TikTok, impressions for LinkedIn/FB) and `median` its baseline. The
// arg is still loosely called via {views, medianViews} at IG call sites
// for back-compat, but the noun is platform-driven so the label reads
// "4.8x usual impressions" on LinkedIn, "4.8x usual views" on IG.
function computeOverperformance({ views, medianViews, noun = "views" }) {
  if (!views || !medianViews) return { score: null, label: null };
  const score = +(views / medianViews).toFixed(2);
  let label = null;
  if (score >= OVERPERF.noiseFloorScore) label = `${score.toFixed(1)}x usual ${noun}`;
  return { score, label };
}

function computeEngagementVsBaseline({ engagementRate, medianEngagementRate }) {
  if (engagementRate == null || !medianEngagementRate) return null;
  return +(engagementRate / medianEngagementRate).toFixed(2);
}

function computeFollowerNormalisedViews({ views, followerCount }) {
  if (!views || !followerCount) return null;
  return +(views / followerCount).toFixed(3);
}

function computeRepeatability({
  overperformanceScore,
  engagementVsBaseline,
  followerNormalisedViews,
  ageDays,
}) {
  // Hard-flag algorithm-spike posts as one-off.
  // Requires POSITIVE evidence of an algorithm push: high views AND
  // measurably-low engagement. Without engagement data we can't make
  // that call, so the spike detector stays quiet.
  if (overperformanceScore >= OVERPERF.spikeScore
      && engagementVsBaseline != null
      && engagementVsBaseline < OVERPERF.spikeEngagementCutoff) {
    return { score: 15, label: "One-off spike — don't chase" };
  }

  // Track which signals we actually have. The label rules below treat
  // "we have no engagement data" differently from "we have engagement
  // data and it's weak." The former leaves the post unlabelled; the
  // latter is a real one-off-spike signal.
  const haveEngagement = engagementVsBaseline != null;
  const haveReach = followerNormalisedViews != null;
  const haveAnySecondarySignal = haveEngagement || haveReach;

  let score = 0;
  if (overperformanceScore >= REPEAT.overperfMinForBonus) score += REPEAT.overperfBonus;
  if (haveEngagement && engagementVsBaseline >= REPEAT.engagementMinForBonus) {
    score += REPEAT.engagementBonus;
  }
  if (haveReach && followerNormalisedViews >= REPEAT.reachFollowerFraction) {
    score += REPEAT.reachBonus;
  }

  if (ageDays != null) {
    if (ageDays > REPEAT.recencyAgeMidDays) score -= REPEAT.recencyOldPenalty;
    else if (ageDays > REPEAT.recencyAgeFreshDays) score -= REPEAT.recencyMidPenalty;
  }

  score = clamp(score, 0, 100);

  let label = null;
  if (score >= REPEAT.repeatableMin) label = "Likely repeatable";
  else if (haveAnySecondarySignal && score <= REPEAT.oneOffMax) {
    // Only call something a one-off spike if we have at least one
    // secondary signal (engagement or reach) to back the negative
    // judgment. Without any, we just don't render a repeatability
    // label — overperformance alone speaks for itself.
    label = "One-off spike — don't chase";
  }

  return { score, label };
}

function computeTags({
  overperformanceScore,
  engagementVsBaseline,
  followerNormalisedViews,
}) {
  const tags = [];
  if (overperformanceScore != null && overperformanceScore >= OVERPERF.noiseFloorScore) {
    tags.push("over_performer");
  }
  if (engagementVsBaseline != null && engagementVsBaseline >= REPEAT.engagementMinForBonus) {
    tags.push("high_engagement");
  }
  if (followerNormalisedViews != null && followerNormalisedViews >= REPEAT.reachFollowerFraction) {
    tags.push("broad_reach");
  }
  if (overperformanceScore != null && overperformanceScore >= OVERPERF.spikeScore
      && engagementVsBaseline != null && engagementVsBaseline < OVERPERF.spikeEngagementCutoff) {
    tags.push("algorithm_spike");
  }
  return tags;
}

// ─── Status badge ─────────────────────────────────────────────────

function computeStatus({ posts30dViews, postsPrior30dViews, postCount, weeksOfData }) {
  if (postCount < STATUS.minPostsForStatus || weeksOfData < STATUS.minWeeksForStatus) {
    return {
      state: "insufficient",
      reason: `Need ${STATUS.minPostsForStatus}+ posts and ${STATUS.minWeeksForStatus}+ weeks of data (have ${postCount} posts, ${weeksOfData.toFixed(1)} weeks).`,
    };
  }
  const prior = postsPrior30dViews;
  if (!prior || prior === 0) {
    return {
      state: "insufficient",
      reason: "No views in the prior 30-day window to compare against.",
    };
  }
  const delta = (posts30dViews - prior) / prior;
  if (delta >= STATUS.growingViewsDeltaPct) {
    return { state: "growing", reason: `Views up ${(delta * 100).toFixed(0)}% vs the prior 30 days.` };
  }
  if (delta <= STATUS.losingViewsDeltaPct) {
    return { state: "losing", reason: `Views down ${(Math.abs(delta) * 100).toFixed(0)}% vs the prior 30 days.` };
  }
  return {
    state: "flat",
    reason: `Views ${delta >= 0 ? "up" : "down"} ${(Math.abs(delta) * 100).toFixed(0)}% vs the prior 30 days — within the flat band.`,
  };
}

// ─── Momentum score with explainable reason line ──────────────────

function computeMomentum({ viewsDelta, engagementDelta, postFrequencyDelta, competitorDelta }) {
  const signals = { viewsDelta, engagementDelta, postFrequencyDelta, competitorDelta };

  const contributions = {
    views:      viewsDelta != null      ? clamp(viewsDelta, -1, 1) * MOMENTUM.viewsWeight       : 0,
    engagement: engagementDelta != null ? clamp(engagementDelta, -1, 1) * MOMENTUM.engagementWeight : 0,
    frequency:  postFrequencyDelta != null ? clamp(postFrequencyDelta, -1, 1) * MOMENTUM.postFrequencyWeight : 0,
    competitor: competitorDelta != null ? clamp(competitorDelta, -1, 1) * MOMENTUM.competitorWeight : 0,
  };
  const raw = MOMENTUM.base + contributions.views + contributions.engagement
            + contributions.frequency + contributions.competitor;
  const score = Math.round(clamp(raw, 0, 100));

  // Reason line — name the top contributing signals (by magnitude),
  // up to 3. Never a black-box number, per the plan.
  const named = [
    { key: "views",      label: "views",             value: viewsDelta },
    { key: "engagement", label: "engagement rate",   value: engagementDelta },
    { key: "frequency",  label: "posting frequency", value: postFrequencyDelta },
    { key: "competitor", label: "competitor median", value: competitorDelta },
  ].filter(s => s.value != null);

  let reasonLine;
  if (named.length === 0) {
    reasonLine = "Not enough signal yet — momentum starts neutral.";
  } else {
    const topThree = [...named]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 3);
    reasonLine = topThree.map(s => {
      const pct = (s.value * 100).toFixed(0);
      if (s.value > 0.01) return `${s.label} up ${pct}%`;
      if (s.value < -0.01) return `${s.label} down ${Math.abs(pct)}%`;
      return `${s.label} flat`;
    }).join(", ");
  }

  return { score, signals, reasonLine };
}

// ─── Main entry point ──────────────────────────────────────────────

/**
 * recomputeClientAnalytics(clientId)
 *
 * Single source of truth for everything derived. Called by webhook,
 * cron, and manual refresh. Idempotent within the same data state.
 *
 * Phase 3 fills in the body (Phase 2 shipped this as a stub). The
 * function signature + call sites are unchanged.
 */
export async function recomputeClientAnalytics(clientId) {
  if (!clientId) throw new Error("recomputeClientAnalytics: missing clientId");

  const now = Date.now();
  const computedAt = new Date(now).toISOString();

  // ─── 1. Load everything we need ────────────────────────────────
  const config = await fbGet(`/analytics/clients/${clientId}/config`);
  if (!config) {
    await fbPatch(`/analytics/clients/${clientId}`, { lastRecomputeAt: computedAt });
    return { ok: true, clientId, reason: "no_config" };
  }
  const enabledPlatforms = Object.keys(config.platforms || {}).filter(p => config.platforms[p]);

  const videosRoot = (await fbGet(`/analytics/videos/${clientId}`)) || {};
  const followersRoot = (await fbGet(`/analytics/followers/${clientId}`)) || {};
  const competitorsRoot = (await fbGet(`/analytics/competitors/${clientId}`)) || {};

  // ─── 2. Baselines per platform ─────────────────────────────────
  const baselines = {
    medianViews: {},
    medianEngagementRate: {},
    followerCount: {},
    updatedAt: computedAt,
  };

  const videoUpdates = []; // [{ platform, videoId, scoring }]
  const platformStats = {};

  // ─── Phase 7: pre-fetch Claude classifications in parallel ──────
  // Done before the per-platform loop so the scoring loop can stay
  // synchronous. The cache in _analyticsAi.js makes repeat recomputes
  // sub-second; the first one pays the classifier cost. We skip any
  // video with a manualFormatOverride (manual always wins).
  // Concurrency cap of 5 to be polite to the Anthropic rate limits.
  const claudeClassifications = new Map(); // videoId → { format, formatConfidence, source, claudeReason }
  if (isClaudeEnabled()) {
    const toClassify = [];
    for (const platform of enabledPlatforms) {
      for (const [videoId, v] of Object.entries(videosRoot[platform] || {})) {
        if (!v?.post) continue;
        if (v.classifications?.manualFormatOverride) continue;
        toClassify.push({ videoId, post: v.post });
      }
    }
    await runWithConcurrency(toClassify, 5, async ({ videoId, post }) => {
      try {
        const result = await classifyFormatWithClaude(post);
        claudeClassifications.set(videoId, result);
      } catch (err) {
        // Soft fail — caller falls back to the v0 heuristic for this
        // video. Log + continue; never let one classifier error
        // cascade into a failed recompute.
        console.warn(`[analytics-scoring] Claude classify failed for ${videoId}: ${err.message}`);
      }
    });
  }

  for (const platform of enabledPlatforms) {
    const videos = videosRoot[platform] || {};
    const videosList = Object.entries(videos).map(([videoId, v]) => ({ videoId, ...v }));

    // Platform metric semantics: IG/YT/TikTok score on `views`, LinkedIn/
    // FB on `impressions`. `primaryMetricValue` falls back to views so
    // legacy IG snapshots are unaffected. `pMetric`/`pNoun` drive the
    // baseline key meaning + the overperformance label noun.
    const pMeta = platformMetrics(platform);
    const pNoun = metricNoun(platform);

    const allViews = [];
    const allEngagement = [];
    for (const v of videosList) {
      const snap = latestSnapshot(v);
      if (!snap) continue;
      const primary = primaryMetricValue(snap, platform);
      if (primary != null) allViews.push(primary);
      if (snap.engagementRate != null) allEngagement.push(snap.engagementRate);
    }
    const medViews = median(allViews);
    const medEng = median(allEngagement);
    // `medianViews` key kept for back-compat; for non-IG platforms it now
    // holds the median of the platform's primary metric. `primaryMetric`
    // records which metric that is so consumers never misread it.
    baselines.medianViews[platform] = Math.round(medViews);
    baselines.medianEngagementRate[platform] = +medEng.toFixed(3);
    baselines.followerCount[platform] = latestFollowerCount(followersRoot[platform]);
    if (!baselines.primaryMetric) baselines.primaryMetric = {};
    baselines.primaryMetric[platform] = pMeta.primary;

    // ─── 3. Per-video scoring (rule-based) ───────────────────────
    // Follower-normalised reach only where the platform has a meaningful
    // follower count (gated by platformMetrics.hasFollowers — e.g. not
    // TikTok). Otherwise that signal stays null and scoring leans on
    // overperformance + engagement.
    const followerCount = pMeta.hasFollowers ? baselines.followerCount[platform] : null;
    for (const v of videosList) {
      const snap = latestSnapshot(v);
      if (!snap) continue;

      const views = primaryMetricValue(snap, platform);
      const engagementRate = snap.engagementRate;
      const timestamp = v.post?.timestamp ? new Date(v.post.timestamp).getTime() : null;
      const ageDays = timestamp ? (now - timestamp) / (24 * 3600 * 1000) : null;

      const overperf = computeOverperformance({ views, medianViews: medViews, noun: pNoun });
      const engagementVsBaseline = computeEngagementVsBaseline({
        engagementRate, medianEngagementRate: medEng,
      });
      const followerNormalisedViews = computeFollowerNormalisedViews({ views, followerCount });
      const repeatability = computeRepeatability({
        overperformanceScore: overperf.score ?? 0,
        engagementVsBaseline,
        followerNormalisedViews,
        ageDays,
      });
      const tags = computeTags({
        overperformanceScore: overperf.score,
        engagementVsBaseline,
        followerNormalisedViews,
      });

      // ─── Phase 6: heuristic format classification ──────────────
      // Preserve any manual override the team has set; the heuristic
      // (and Phase 7's Claude classifier) never overwrites the
      // manualFormatOverride field.
      const existing = v.classifications || {};
      let classification;
      if (existing.manualFormatOverride) {
        // Manual override always wins, per the plan. Claude
        // reclassifications never touch the override fields.
        classification = {
          format: existing.manualFormatOverride,
          formatConfidence: "high",
          source: "manual",
          classifierReason: "manual override",
          manualFormatOverride: existing.manualFormatOverride,
          manualFormatOverrideBy: existing.manualFormatOverrideBy ?? null,
          manualFormatOverrideAt: existing.manualFormatOverrideAt ?? null,
          manualFormatOverrideReason: existing.manualFormatOverrideReason ?? null,
        };
      } else {
        // Phase 7: use the precomputed Claude classification if
        // available (filled in before this loop); fall back to the
        // Phase 6 heuristic if Claude is disabled or errored.
        const pre = claudeClassifications.get(v.videoId);
        if (pre) {
          classification = {
            format: pre.format,
            formatConfidence: pre.formatConfidence,
            source: pre.source,             // "claude" if present
            classifierReason: pre.claudeReason || "claude classifier",
            manualFormatOverride: existing.manualFormatOverride ?? null,
            manualFormatOverrideBy: existing.manualFormatOverrideBy ?? null,
            manualFormatOverrideAt: existing.manualFormatOverrideAt ?? null,
            manualFormatOverrideReason: existing.manualFormatOverrideReason ?? null,
          };
        } else {
          const h = classifyFormat({ caption: v.post?.caption || "" });
          classification = {
            format: h.format,
            formatConfidence: h.formatConfidence,
            source: "heuristic",
            classifierReason: h.heuristicReason,
            manualFormatOverride: existing.manualFormatOverride ?? null,
            manualFormatOverrideBy: existing.manualFormatOverrideBy ?? null,
            manualFormatOverrideAt: existing.manualFormatOverrideAt ?? null,
            manualFormatOverrideReason: existing.manualFormatOverrideReason ?? null,
          };
        }
      }

      videoUpdates.push({
        platform,
        videoId: v.videoId,
        scoring: {
          overperformanceScore: overperf.score,
          overperformanceLabel: overperf.label,
          repeatabilityScore: repeatability.score,
          repeatabilityLabel: repeatability.label,
          engagementVsBaseline,
          followerNormalisedViews,
          tags,
          computedAt,
        },
        classification,
        // Stamp the source timestamp inline so it's available
        // BEFORE buildFormatCounts runs. Without this, the
        // "you haven't posted X in N days" silence rec never fires
        // because lastPostedTs stays null.
        _sourceTimestamp: v.post?.timestamp || null,
      });
    }

    // ─── 4. Per-platform stats for status + momentum ──────────────
    const day = 24 * 3600 * 1000;
    const win30 = now - 30 * day;
    const winPrior30 = now - 60 * day;
    const win4w = now - 28 * day;
    const winPrior4w = now - 56 * day;

    let posts30dViews = 0, postsPrior30dViews = 0;
    let posts30dEngagementSum = 0, postsPrior30dEngagementSum = 0;
    let posts30dEngagementN = 0, postsPrior30dEngagementN = 0;
    let postsRecent = 0, postsPrior = 0;
    let oldestTs = now;
    for (const v of videosList) {
      const ts = v.post?.timestamp ? new Date(v.post.timestamp).getTime() : null;
      if (!ts) continue;
      if (ts < oldestTs) oldestTs = ts;
      const snap = latestSnapshot(v);
      // Primary metric per platform (views for IG/YT/TikTok, impressions
      // for LinkedIn/FB). The var stays named `views` to keep the window
      // math below unchanged.
      const views = primaryMetricValue(snap, platform) || 0;
      const er = snap?.engagementRate;
      if (ts >= win30) {
        posts30dViews += views;
        if (er != null) { posts30dEngagementSum += er; posts30dEngagementN++; }
      } else if (ts >= winPrior30) {
        postsPrior30dViews += views;
        if (er != null) { postsPrior30dEngagementSum += er; postsPrior30dEngagementN++; }
      }
      if (ts >= win4w) postsRecent++;
      else if (ts >= winPrior4w) postsPrior++;
    }
    const weeksOfData = oldestTs && oldestTs < now ? (now - oldestTs) / (7 * day) : 0;

    platformStats[platform] = {
      totalPosts: videosList.length,
      posts30dViews,
      postsPrior30dViews,
      engagement30d: posts30dEngagementN ? posts30dEngagementSum / posts30dEngagementN : null,
      engagementPrior30d: postsPrior30dEngagementN ? postsPrior30dEngagementSum / postsPrior30dEngagementN : null,
      postsPerWeekRecent: postsRecent / 4,
      postsPerWeekPrior:  postsPrior  / 4,
      weeksOfData,
    };
  }

  // ─── 5+6. Bulk-write per-video scoring + classifications ────────
  //
  // 57 client videos × 2 writes each (scoring + classifications) was
  // 114 separate HTTP requests over REST. With ingest already bulked
  // by the prior fix, this was the next big slow point. Group by
  // platform and PATCH each platform's videos in one call using
  // slash-keyed paths — same write semantics, one HTTP round-trip
  // per platform regardless of how many videos.
  //
  // Baselines also batched into the same parent PATCH on the client
  // record (one write for baselines + status + momentum + cohort +
  // bookkeeping — added below).
  {
    const byPlatform = {};
    for (const u of videoUpdates) {
      if (!byPlatform[u.platform]) byPlatform[u.platform] = {};
      byPlatform[u.platform][`${u.videoId}/scoring`] = u.scoring;
      byPlatform[u.platform][`${u.videoId}/classifications`] = u.classification;
    }
    await Promise.all(
      Object.entries(byPlatform).map(([platform, batch]) =>
        fbPatch(`/analytics/videos/${clientId}/${platform}`, batch)
      )
    );
  }

  // ─── 7. Competitor cohort baselines (Phase 5) ──────────────────────
  // The client's saved competitors define the niche cohort (per the
  // plan's "niche = saved competitors" decision). For each platform
  // we compute:
  //   - per-handle baselines (median views + engagement per handle)
  //   - pooled cohort baselines (median across ALL competitor videos)
  //   - observed posting frequency per handle
  // Note the wording: this is OBSERVED posting frequency. Public
  // scrape only sees posts the actor returned — if a competitor
  // posts stories or paid-only content we don't capture, we don't
  // know about them. UI labels must reflect that uncertainty.
  const competitorCohort = await computeCompetitorCohorts({
    competitorsRoot, enabledPlatforms, now,
  });

  // ─── 7b. Per-platform status + momentum (NOT cross-platform summed) ──
  //
  // Summing a `views` field across platforms is meaningless once metrics
  // differ — LinkedIn impressions vs TikTok views (Codex review). So
  // status + momentum are computed PER platform from that platform's own
  // stats + cohort, and written under clients/{id}/platforms/{platform}/.
  //
  // Back-compat: the root clients/{id}/status + /momentum are MIRRORED
  // from the "primary" platform — Instagram when present (so the existing
  // IG pilot's root keys stay byte-identical), else the configured
  // primaryPlatform, else the first enabled platform. No consumer reading
  // the root path breaks; multi-platform clients get the primary
  // platform's headline at the root PLUS the full per-platform breakdown.
  const perPlatformDerived = {}; // platform -> { status, momentum }
  for (const platform of enabledPlatforms) {
    const s = platformStats[platform];
    if (!s) continue;
    const pStatus = computeStatus({
      posts30dViews: s.posts30dViews,
      postsPrior30dViews: s.postsPrior30dViews,
      postCount: s.totalPosts,
      weeksOfData: s.weeksOfData,
    });
    const vDelta = (s.postsPrior30dViews && s.postsPrior30dViews > 0)
      ? (s.posts30dViews - s.postsPrior30dViews) / s.postsPrior30dViews : null;
    const eDelta = (s.engagementPrior30d && s.engagementPrior30d > 0)
      ? (s.engagement30d - s.engagementPrior30d) / s.engagementPrior30d : null;
    const fDelta = (s.postsPerWeekPrior && s.postsPerWeekPrior > 0)
      ? (s.postsPerWeekRecent - s.postsPerWeekPrior) / s.postsPerWeekPrior : null;
    const cohortEng = competitorCohort?.[platform]?.pooled?.engagement30d ?? null;
    const cDelta = (cohortEng && cohortEng > 0 && s.engagement30d != null)
      ? (s.engagement30d - cohortEng) / cohortEng : null;
    const pMomentum = computeMomentum({
      viewsDelta: vDelta, engagementDelta: eDelta,
      postFrequencyDelta: fDelta, competitorDelta: cDelta,
    });
    perPlatformDerived[platform] = {
      status: { state: pStatus.state, reason: pStatus.reason, computedAt },
      momentum: {
        score: pMomentum.score,
        reasonLine: pMomentum.reasonLine,
        signals: pMomentum.signals,
        delta30d: vDelta,
        computedAt,
      },
    };
  }

  // Primary platform for the back-compat root mirror.
  const primaryPlatform =
    enabledPlatforms.includes("instagram") ? "instagram"
    : (config.primaryPlatform && enabledPlatforms.includes(config.primaryPlatform)) ? config.primaryPlatform
    : (enabledPlatforms[0] || null);
  const rootDerived = primaryPlatform ? perPlatformDerived[primaryPlatform] : null;
  const status = rootDerived?.status
    || { state: "insufficient", reason: "No enabled platforms with data yet.", computedAt };
  const momentum = rootDerived?.momentum
    || { score: 50, reasonLine: "Not enough signal yet — momentum starts neutral.", signals: {}, delta30d: null, computedAt };
  const viewsDelta = momentum.delta30d ?? null;

  // ─── 8. Bulk-PATCH all per-client derived state in one call ─────
  // baselines + cohort + (root-mirrored) status + momentum + the full
  // per-platform breakdown, in one atomic patch. Root status/momentum
  // keep the exact shape existing consumers expect.
  const clientPatch = {
    baselines,
    competitorCohort: { ...competitorCohort, updatedAt: computedAt },
    status,
    momentum,
    primaryPlatform,
  };
  for (const [platform, d] of Object.entries(perPlatformDerived)) {
    clientPatch[`platforms/${platform}/status`] = d.status;
    clientPatch[`platforms/${platform}/momentum`] = d.momentum;
  }
  await fbPatch(`/analytics/clients/${clientId}`, clientPatch);

  // ─── 9. Format Playbook aggregation + Next Video Recommendations
  //         (Phase 6, rules-first). ─────────────────────────────────
  //
  // Aggregate format counts from this run's classifications (the
  // playbook UI reads these). Then build rule-based recs with the
  // Quality Gate enforced at write-time in _analyticsRecsBuilder.
  // Insights write to /analytics/insights/{clientId}/{weekId}/...
  // and overwrite — derived state, never carried stale.
  const formatCounts = buildFormatCounts(videoUpdates, now);
  const competitorByHandleForRecs = buildCompetitorRecInputs(competitorsRoot, enabledPlatforms);
  const clientVideosForRecs = buildClientRecInputs(videoUpdates, videosRoot);

  let recs = [];
  try {
    recs = buildNextVideoRecs({
      clientVideos: clientVideosForRecs,
      competitorByHandle: competitorByHandleForRecs,
      formatCounts,
      now,
    });
  } catch (err) {
    console.error(`[analytics-scoring] recs build failed for ${clientId}:`, err);
  }

  const weekId = isoWeekId(now);
  // The format playbook's caveat is determined by what actually
  // classified the posts. If Claude ran for the majority, drop the
  // v0 caveat. Otherwise keep it.
  const claudeClassifiedCount = videoUpdates.filter(u => u.classification?.source === "claude").length;
  const usingClaude = isClaudeEnabled() && claudeClassifiedCount > 0 && (claudeClassifiedCount / Math.max(1, videoUpdates.length)) > 0.5;

  // Compute decay alerts up here so they land in the same bulk insights
  // PATCH as formatPlaybook + nextVideoRecs (was a separate fbSet below).
  const decayAlerts = computeDecayAlerts(videoUpdates, videosRoot, now);

  // Bulk-PATCH the rule-based insights (formatPlaybook + nextVideoRecs
  // + decayAlerts) in one HTTP call. Claude-gated insights
  // (thisWeekInNiche, nichePulse, weeklySummary) stay as separate writes
  // below because they're conditional and slow; we don't want a
  // transient Claude failure to wipe the rule-based outputs.
  // currentInsightsWeek piggy-backs on the same call so the client
  // record points at the new week's bucket atomically with the writes
  // that populated it.
  await Promise.all([
    fbPatch(`/analytics/insights/${clientId}/${weekId}`, {
      formatPlaybook: {
        formats: formatCounts,
        computedAt,
        classifierSource: usingClaude ? "claude" : "heuristic",
        accuracyCaveat: usingClaude
          ? null
          : "v0 heuristic — ~70% accuracy. Phase 7's Claude classifier hasn't run on these posts yet.",
      },
      nextVideoRecs: recs,
      decayAlerts,
    }),
    fbPatch(`/analytics/clients/${clientId}`, { currentInsightsWeek: weekId }),
  ]);

  // ─── Phase 7: niche takes + pulse ──────────────────────────────
  // Top 3 competitor posts of the last 7d get a 2-sentence Claude take.
  // Niche pulse summarises last-7d competitor posts into max 2 dot-points.
  // Both gated on isClaudeEnabled — recompute still succeeds without them.
  // Captured here (not just written to Firebase) so the client-safe
  // projection at the tail can reuse the takes without a re-read.
  let thisWeekInNicheForProjection = null;
  if (isClaudeEnabled()) {
    try {
      const last7dCompetitorPosts = collectRecentCompetitorPosts(competitorsRoot, enabledPlatforms, now, 7);
      const topThree = pickTopRecent(last7dCompetitorPosts, 3);
      const takes = await runWithConcurrency(topThree, 3, async (entry) => {
        try {
          const { take } = await nicheTakeForCompetitorPost(entry.post, entry.handle);
          return {
            handle: entry.handle,
            platform: entry.platform,
            videoId: entry.videoId,
            post: {
              url: entry.post.url || null,
              thumbnail: entry.post.thumbnail || null,
              caption: (entry.post.caption || "").slice(0, 600),
            },
            take,
            generatedAt: new Date().toISOString(),
          };
        } catch (err) {
          console.warn(`[analytics-scoring] niche take failed for ${entry.handle}/${entry.videoId}: ${err.message}`);
          return null;
        }
      });
      thisWeekInNicheForProjection = { posts: takes.filter(Boolean) };
      await fbSet(`/analytics/insights/${clientId}/${weekId}/thisWeekInNiche`, {
        posts: takes.filter(Boolean),
        generatedAt: new Date().toISOString(),
      });

      const pulseInput = last7dCompetitorPosts.map(p => ({ caption: p.post?.caption || "" }));
      try {
        const { pulse, generatedAt: pulseAt } = await nichePulse(pulseInput);
        await fbSet(`/analytics/insights/${clientId}/${weekId}/nichePulse`, {
          pulse,
          generatedAt: pulseAt,
        });
      } catch (err) {
        console.warn(`[analytics-scoring] niche pulse failed for ${clientId}: ${err.message}`);
      }
    } catch (err) {
      console.warn(`[analytics-scoring] Phase 7 niche generation failed for ${clientId}: ${err.message}`);
    }
  }

  // ─── Phase 8: Renewal Ammo (basic v1, since tracking began) ─────
  // Internal-only — surfaced to founders + leads in the dashboard
  // for retention conversations. Per the plan, the
  // "since first Viewix delivery" window is v1.1; this phase ships
  // only the "since tracking began" window.
  const renewalAmmo = computeRenewalAmmoSinceTrackingBegan({
    videoUpdates, videosRoot, followersRoot, enabledPlatforms, now,
  });
  await fbSet(`/analytics/renewalAmmo/${clientId}`, {
    windows: { sinceTrackingBegan: renewalAmmo },
    generatedAt: computedAt,
  });

  // ─── Phase 8: AI Weekly Summary (Claude, optional) ──────────────
  // Reads precomputed state, outputs a 1-paragraph synthesis +
  // 1 actionable recommendation. Caches by snapshot hash.
  if (isClaudeEnabled()) {
    try {
      const snapshot = buildWeeklySummarySnapshot({
        status, momentum, formatCounts, decayAlerts,
        topRecs: recs.slice(0, 3),
        winningVideos: videoUpdates
          .filter(u => u.scoring?.repeatabilityLabel === "Likely repeatable")
          .slice(0, 3)
          .map(u => ({
            format: u.classification?.format,
            overperformanceLabel: u.scoring.overperformanceLabel,
            repeatabilityScore: u.scoring.repeatabilityScore,
          })),
      });
      const { paragraph, generatedAt: summaryAt } = await weeklySummary(snapshot);
      if (paragraph) {
        await fbSet(`/analytics/insights/${clientId}/${weekId}/weeklySummary`, {
          paragraph,
          generatedAt: summaryAt,
        });
      }
    } catch (err) {
      console.warn(`[analytics-scoring] weekly summary failed for ${clientId}: ${err.message}`);
    }
  }

  // ─── 9b. Client-safe projection (powers the external light portal)
  // The portal reads ONLY /analytics/public/{portalShortId}. Build
  // the client-safe view from the state we just computed and write it
  // there. Fully guarded: a projection failure logs and is swallowed
  // so it can never break the internal pipeline. "Auto-building" is
  // preserved — this regenerates on every recompute (webhook/cron/
  // manual) the engine already runs.
  //
  // MULTI-PLATFORM GATE (Codex review): buildClientProjection is
  // Instagram-only — it hardcodes "public Instagram video posts" and
  // drops platform identity. Running it for a client with any non-IG
  // platform enabled would publish a broken, IG-labelled portal the
  // instant Zernio data lands. So we ONLY auto-write the portal
  // projection for IG-only clients until the multi-platform projection
  // (Phase 4) exists. Multi-platform clients get no portal yet (the deck
  // is their deliverable); their analytics still compute + store fully.
  const isIgOnly = enabledPlatforms.length > 0 && enabledPlatforms.every(p => p === "instagram");
  if (!isIgOnly) {
    console.log(`[analytics-scoring] ${clientId}: multi-platform (${enabledPlatforms.join(",") || "none"}) — skipping IG-only portal projection (Phase 4 adds the multi-platform portal).`);
    // TOMBSTONE (Codex r3): if this client previously had an IG-only
    // portal, skipping the write would leave /analytics/public/{id} live
    // serving STALE Instagram data after they went multi-platform. Retire
    // it so the portal stops serving rather than silently going stale.
    // (Portals aren't client-facing yet — pilot only — so urgency is low,
    // but the gate must be correct.)
    if (config.portalShortId) {
      try {
        // Only write the tombstone ONCE — not on every recompute (Codex
        // r4). Read the current public record; if it's already retired,
        // leave it alone.
        const existingPublic = await fbGet(`/analytics/public/${config.portalShortId}`);
        if (!existingPublic?.retired) {
          await fbSet(`/analytics/public/${config.portalShortId}`, {
            retired: true,
            reason: "client_went_multi_platform",
            retiredAt: computedAt,
            clientId,
            portalShortId: config.portalShortId,
          });
        }
      } catch (err) {
        console.warn(`[analytics-scoring] portal tombstone failed for ${clientId}: ${err.message}`);
      }
    }
  } else {
    try {
      let portalShortId = config.portalShortId;
      if (!portalShortId) {
        portalShortId = makePortalShortId();
        await fbPatch(`/analytics/clients/${clientId}/config`, { portalShortId });
      }
      const projection = buildClientProjection({
        config, status, momentum, baselines, competitorCohort,
        formatCounts, recs, videoUpdates, videosRoot, competitorsRoot,
        renewalAmmo, thisWeekInNiche: thisWeekInNicheForProjection,
        enabledPlatforms, computedAt,
      });
      await fbSet(`/analytics/public/${portalShortId}`, {
        ...projection,
        clientId,                 // back-reference (server-only consumers)
        portalShortId,
      });
    } catch (err) {
      console.warn(`[analytics-scoring] client projection failed for ${clientId}: ${err.message}`);
    }
  }

  // ─── 10. lastRecomputeAt last so it reflects a fully successful run.
  await fbPatch(`/analytics/clients/${clientId}`, {
    lastRecomputeAt: computedAt,
  });

  return {
    ok: true,
    clientId,
    status: status.state,
    momentum: momentum.score,
    videosScored: videoUpdates.length,
    recsWritten: recs.length,
    enabledPlatforms,
  };
}

// ISO-week id (e.g. "2026-W19"). Used to bucket weekly insights so
// rerunning the recompute on the same week overwrites the same
// slot; a fresh week creates a new one (and last week's recs stay
// readable for context).
function isoWeekId(now) {
  const d = new Date(now);
  // Thursday-shift trick: pick the Thursday of this week, then year + ISO week number.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // shift to Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Build the per-format aggregate the recs builder + Format Playbook UI both need.
function buildFormatCounts(videoUpdates, now) {
  const out = {};
  for (const u of videoUpdates) {
    const format = u.classification?.format;
    if (!format) continue;
    if (!out[format]) {
      out[format] = {
        count: 0,
        sumOverperf: 0,
        sumOverperfN: 0,
        lastPostedTs: 0,
        recentIds: [], // recent video ids for sourceIds in the silence rec
      };
    }
    const slot = out[format];
    slot.count++;
    const op = u.scoring?.overperformanceScore;
    if (op != null) { slot.sumOverperf += op; slot.sumOverperfN++; }
    // We don't have timestamp on the videoUpdate directly; resolve
    // from the original video record passed in. Falls back gracefully
    // if missing.
    const tsIso = u._sourceTimestamp;
    const ts = tsIso ? new Date(tsIso).getTime() : null;
    if (ts && ts > slot.lastPostedTs) slot.lastPostedTs = ts;
    if (slot.recentIds.length < 3) slot.recentIds.push(u.videoId);
  }
  // Reduce to the shape the recs builder expects.
  const final = {};
  for (const [k, v] of Object.entries(out)) {
    final[k] = {
      count: v.count,
      medianOverperf: v.sumOverperfN ? v.sumOverperf / v.sumOverperfN : null,
      lastPostedTs: v.lastPostedTs || null,
      recentIds: v.recentIds,
    };
  }
  return final;
}

// Build the input array the recs builder expects from the client side.
// Pairs each videoUpdate's classification + scoring with its post +
// snapshot from the source videosRoot.
function buildClientRecInputs(videoUpdates, videosRoot) {
  const out = [];
  for (const u of videoUpdates) {
    const src = videosRoot?.[u.platform]?.[u.videoId];
    if (!src) continue;
    out.push({
      platform: u.platform,
      videoId: u.videoId,
      post: src.post,
      snapshot: latestSnapshot(src),
      scoring: u.scoring,
      classification: u.classification,
    });
    // _sourceTimestamp is stamped at videoUpdates.push() time
    // (in the scoring loop) so it's available to buildFormatCounts
    // which runs BEFORE this function.
  }
  return out;
}

// Build the competitor input map the recs builder expects.
//
// Competitor videos are NOT scored by recomputeClientAnalytics
// (per the data model: scoring fields live only on client videos).
// So we compute per-handle median views inline here and derive
// each competitor video's overperformance score relative to its
// own handle's baseline. Without this, the rec builder's
// `v.scoring?.overperformanceLabel` filter rejects every
// competitor video and "Competitor X is winning with Y" never
// fires.
//
// Format classifier is re-run here on each competitor post (cheap —
// caption-only heuristic match).
function buildCompetitorRecInputs(competitorsRoot, enabledPlatforms) {
  const out = {};
  for (const platform of enabledPlatforms) {
    const handles = competitorsRoot?.[platform] || {};
    for (const [handleKey, entry] of Object.entries(handles)) {
      if (!entry?.videos) continue;

      // Per-handle median for this handle's videos. Reading the
      // latest snapshot view count per video (same shape as the
      // client-side scoring uses).
      const handleViews = [];
      for (const v of Object.values(entry.videos)) {
        const snap = latestSnapshot(v);
        if (snap?.views != null) handleViews.push(snap.views);
      }
      const handleMedianViews = median(handleViews) || null;

      const byVideo = Object.entries(entry.videos).map(([videoId, v]) => {
        const snap = latestSnapshot(v);
        // Compute overperformance against this handle's own median.
        // Only emit a label at the 1.5x noise floor (matches the
        // client-side overperformance threshold so the rec doesn't
        // surface marginal posts).
        let scoring = null;
        if (snap?.views != null && handleMedianViews && handleMedianViews > 0) {
          const score = +(snap.views / handleMedianViews).toFixed(2);
          scoring = {
            overperformanceScore: score,
            overperformanceLabel: score >= OVERPERF.noiseFloorScore
              ? `${score.toFixed(1)}x their usual views`
              : null,
          };
        }
        return {
          videoId,
          post: v.post,
          snapshot: snap,
          scoring,
          classification: classifyFormat({ caption: v.post?.caption || "" }),
        };
      });

      out[handleKey] = {
        displayName: entry?.profile?.displayName || `@${handleKey}`,
        byVideo,
      };
    }
  }
  return out;
}

function aggregatePlatformStats(byPlatform) {
  const agg = {
    totalPosts: 0,
    posts30dViews: 0,
    postsPrior30dViews: 0,
    engagement30d: null,
    engagementPrior30d: null,
    postsPerWeekRecent: 0,
    postsPerWeekPrior: 0,
    weeksOfData: 0,
  };
  let engSum30 = 0, engN30 = 0;
  let engSumPrior = 0, engNPrior = 0;
  for (const s of Object.values(byPlatform)) {
    agg.totalPosts += s.totalPosts || 0;
    agg.posts30dViews += s.posts30dViews || 0;
    agg.postsPrior30dViews += s.postsPrior30dViews || 0;
    if (s.engagement30d != null) { engSum30 += s.engagement30d; engN30++; }
    if (s.engagementPrior30d != null) { engSumPrior += s.engagementPrior30d; engNPrior++; }
    agg.postsPerWeekRecent += s.postsPerWeekRecent || 0;
    agg.postsPerWeekPrior += s.postsPerWeekPrior || 0;
    if (s.weeksOfData > agg.weeksOfData) agg.weeksOfData = s.weeksOfData;
  }
  if (engN30) agg.engagement30d = engSum30 / engN30;
  if (engNPrior) agg.engagementPrior30d = engSumPrior / engNPrior;
  return agg;
}

// ─── Competitor cohort computation (Phase 5) ──────────────────────
//
// Pooled cohort vs per-handle stats:
//   - byPlatform[platform].pooled — one set of stats across ALL
//     competitor videos for that platform. The benchmark line on
//     the engagement chart reads this.
//   - byPlatform[platform].byHandle[handle] — per-competitor stats.
//     The CompetitorWatchlist sidebar reads this.
//
// Returns:
//   {
//     instagram: {
//       pooled: {
//         medianViews, medianEngagementRate,
//         engagement30d, postCount, sampleHandles, observedPostsPerWeek,
//       },
//       byHandle: {
//         [handleKey]: { handle, displayName, followerCount,
//                        medianViews, medianEngagementRate,
//                        engagement30d, postCount, observedPostsPerWeek,
//                        topRecentVideoId },
//       },
//     },
//   }
function computeCompetitorCohorts({ competitorsRoot, enabledPlatforms, now }) {
  const day = 24 * 3600 * 1000;
  const win30 = now - 30 * day;
  const win28 = now - 28 * day;

  const out = {};
  for (const platform of enabledPlatforms) {
    const platformData = competitorsRoot?.[platform] || {};
    const handleKeys = Object.keys(platformData);
    const byHandle = {};
    const allViews = [];
    const allEng = [];
    let pooledEng30Sum = 0, pooledEng30N = 0;
    let pooledPostCount = 0;
    let pooledPostsRecent = 0;

    for (const handleKey of handleKeys) {
      const entry = platformData[handleKey] || {};
      const profile = entry.profile || {};
      const videos = Object.entries(entry.videos || {}).map(([videoId, v]) => ({ videoId, ...v }));
      if (videos.length === 0) {
        // Still record the handle with empty stats so the UI can
        // show "scraped, no posts yet" rather than just hiding it.
        byHandle[handleKey] = {
          handle: profile.displayName || `@${handleKey}`,
          displayName: profile.displayName || `@${handleKey}`,
          followerCount: profile.followerCount ?? null,
          medianViews: null,
          medianEngagementRate: null,
          engagement30d: null,
          postCount: 0,
          observedPostsPerWeek: 0,
          topRecentVideoId: null,
        };
        continue;
      }

      const handleViews = [];
      const handleEng = [];
      let handleEng30Sum = 0, handleEng30N = 0;
      let handleRecent = 0;
      let topRecent = null;
      for (const v of videos) {
        const snap = latestSnapshotForCompetitor(v);
        if (!snap) continue;
        if (snap.views != null) handleViews.push(snap.views);
        if (snap.engagementRate != null) handleEng.push(snap.engagementRate);
        const ts = v.post?.timestamp ? new Date(v.post.timestamp).getTime() : null;
        if (ts && ts >= win30) {
          if (snap.engagementRate != null) { handleEng30Sum += snap.engagementRate; handleEng30N++; }
        }
        if (ts && ts >= win28) handleRecent++;
        // Track top recent by views in the last 7d for the watchlist.
        if (ts && ts >= now - 7 * day) {
          if (!topRecent || (snap.views || 0) > (topRecent.views || 0)) {
            topRecent = { videoId: v.videoId, views: snap.views || 0 };
          }
        }

        allViews.push(snap.views || 0);
        if (snap.engagementRate != null) allEng.push(snap.engagementRate);
        if (ts && ts >= win30 && snap.engagementRate != null) {
          pooledEng30Sum += snap.engagementRate; pooledEng30N++;
        }
        if (ts && ts >= win28) pooledPostsRecent++;
        pooledPostCount++;
      }

      byHandle[handleKey] = {
        handle: profile.displayName || `@${handleKey}`,
        displayName: profile.displayName || `@${handleKey}`,
        followerCount: profile.followerCount ?? null,
        medianViews: Math.round(median(handleViews)) || null,
        medianEngagementRate: +median(handleEng).toFixed(3) || null,
        engagement30d: handleEng30N ? +(handleEng30Sum / handleEng30N).toFixed(3) : null,
        postCount: videos.length,
        observedPostsPerWeek: +(handleRecent / 4).toFixed(2),
        topRecentVideoId: topRecent?.videoId || null,
      };
    }

    out[platform] = {
      pooled: {
        medianViews: Math.round(median(allViews)) || null,
        medianEngagementRate: +median(allEng).toFixed(3) || null,
        engagement30d: pooledEng30N ? +(pooledEng30Sum / pooledEng30N).toFixed(3) : null,
        postCount: pooledPostCount,
        sampleHandles: handleKeys.length,
        observedPostsPerWeek: +(pooledPostsRecent / 4 / Math.max(1, handleKeys.length)).toFixed(2),
      },
      byHandle,
    };
  }
  return out;
}

function latestSnapshotForCompetitor(video) {
  const snaps = video?.snapshots || {};
  const keys = Object.keys(snaps).sort();
  if (!keys.length) return null;
  return snaps[keys[keys.length - 1]];
}

// ─── Phase 7 helpers ───────────────────────────────────────────────

// Simple bounded-concurrency map. Caps in-flight promises at `limit`.
// Returns the same shape Promise.all would (array of resolved values).
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (err) { results[idx] = { _error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// Walk /analytics/competitors/{clientId} and pull every post from
// the last N days into a flat array.
function collectRecentCompetitorPosts(competitorsRoot, enabledPlatforms, now, days = 7) {
  const cutoff = now - days * 24 * 3600 * 1000;
  const out = [];
  for (const platform of enabledPlatforms) {
    const handles = competitorsRoot?.[platform] || {};
    for (const [handleKey, entry] of Object.entries(handles)) {
      const displayName = entry?.profile?.displayName || `@${handleKey}`;
      for (const [videoId, v] of Object.entries(entry?.videos || {})) {
        if (!v?.post?.timestamp) continue;
        const ts = new Date(v.post.timestamp).getTime();
        if (ts < cutoff) continue;
        const snap = latestSnapshotForCompetitor(v);
        out.push({
          platform, handle: displayName, videoId,
          post: v.post,
          views: snap?.views || 0,
        });
      }
    }
  }
  return out;
}

function pickTopRecent(posts, n) {
  return [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, n);
}

// ─── Phase 8 helpers ───────────────────────────────────────────────

// Decay alerts — format-level engagement trend.
// Walks videoUpdates (which now carry classification.format), groups
// by format, splits into recent (last 30d) and prior (30–90d), and
// flags formats whose performance has dropped meaningfully.
//
// Output: array of { format, trend, message, prevOverperf,
//                    currentOverperf, prevSampleSize, currentSampleSize }
function computeDecayAlerts(videoUpdates, videosRoot, now) {
  const day = 24 * 3600 * 1000;
  const winRecent = now - 30 * day;
  const winPrior  = now - 90 * day;
  // Group by format → { recent: [overperf], prior: [overperf] }
  const grouped = {};
  for (const u of videoUpdates) {
    const format = u.classification?.format;
    if (!format || format === "other") continue;
    const src = videosRoot?.[u.platform]?.[u.videoId];
    const ts = src?.post?.timestamp ? new Date(src.post.timestamp).getTime() : null;
    if (!ts) continue;
    const op = u.scoring?.overperformanceScore;
    if (op == null) continue;
    if (!grouped[format]) grouped[format] = { recent: [], prior: [] };
    if (ts >= winRecent) grouped[format].recent.push(op);
    else if (ts >= winPrior) grouped[format].prior.push(op);
  }

  const alerts = [];
  for (const [format, { recent, prior }] of Object.entries(grouped)) {
    if (recent.length < 3 || prior.length < 3) continue;     // sample-size guard
    const prevMed = median(prior);
    const curMed  = median(recent);
    if (prevMed < 1.2) continue;                              // was it ever winning?
    if (curMed > prevMed * 0.75) continue;                    // < 25% drop → not decay
    const dropPct = Math.round((1 - curMed / prevMed) * 100);
    alerts.push({
      format,
      trend: "down",
      message: `${format} was averaging ${prevMed.toFixed(2)}x your usual views; last 30 days it's at ${curMed.toFixed(2)}x — down ${dropPct}% vs the prior window.`,
      prevOverperf: +prevMed.toFixed(2),
      currentOverperf: +curMed.toFixed(2),
      prevSampleSize: prior.length,
      currentSampleSize: recent.length,
    });
  }
  return alerts;
}

// Renewal Ammo — internal-only "since tracking began" stats. Top
// posts by overperformance, follower trajectory milestones, best
// week (rolling 7-day window of summed views). Honest copy: never
// overclaim that Viewix caused the lift; the reader makes the
// connection.
function computeRenewalAmmoSinceTrackingBegan({
  videoUpdates, videosRoot, followersRoot, enabledPlatforms, now,
}) {
  // Top performing posts lifetime — by overperformanceScore.
  const topPosts = [...videoUpdates]
    .filter(u => u.scoring?.overperformanceScore != null)
    .sort((a, b) => (b.scoring.overperformanceScore || 0) - (a.scoring.overperformanceScore || 0))
    .slice(0, 5)
    .map(u => {
      const src = videosRoot?.[u.platform]?.[u.videoId];
      const snap = latestSnapshot(src);
      return {
        platform: u.platform,
        videoId: u.videoId,
        url: src?.post?.url || null,
        thumbnail: src?.post?.thumbnail || null,
        caption: (src?.post?.caption || "").slice(0, 200),
        views: snap?.views ?? null,                 // raw views (back-compat; IG)
        // Platform-correct headline value + its name, so a LinkedIn post
        // shows impressions not a misleading views:0.
        primaryMetric: platformMetrics(u.platform).primary,
        primaryValue: primaryMetricValue(snap, u.platform),
        overperformanceLabel: u.scoring.overperformanceLabel,
        overperformanceScore: u.scoring.overperformanceScore,
        timestamp: src?.post?.timestamp || null,
      };
    });

  // Follower trajectory across enabled platforms. For each platform,
  // sample the first + last data point + roughly monthly mileposts
  // in between. Keeps the chart compact in the UI.
  const trajectoryHighlights = [];
  for (const platform of enabledPlatforms) {
    const map = followersRoot?.[platform] || {};
    const dates = Object.keys(map).sort();
    if (dates.length === 0) continue;
    const points = dates.map(d => ({ date: d, count: map[d]?.count ?? null })).filter(p => p.count != null);
    if (points.length === 0) continue;
    // Sample: first, last, and roughly monthly between.
    const sampled = [];
    let lastMs = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const ms = new Date(points[i].date).getTime();
      const isFirst = i === 0;
      const isLast = i === points.length - 1;
      const monthAway = ms - lastMs >= 28 * 24 * 3600 * 1000;
      if (isFirst || isLast || monthAway) {
        sampled.push(points[i]);
        lastMs = ms;
      }
    }
    trajectoryHighlights.push({
      platform,
      points: sampled,
      firstCount: points[0].count,
      lastCount: points[points.length - 1].count,
      firstDate: points[0].date,
      lastDate: points[points.length - 1].date,
    });
  }

  // Best week — PER PLATFORM (Codex r3: never blend a metric across
  // platforms). Each platform's best 7-day window is summed using THAT
  // platform's primary metric (views for IG/YT/TikTok, impressions for
  // LinkedIn/FB). Returns bestWeekByPlatform; the top-level `bestWeek`
  // mirrors the primary platform's window for back-compat with the
  // existing IG portal consumer (for an IG-only client that's IG over
  // views — byte-identical to before).
  const rollingBestWeek = (rows) => {
    const arr = rows.filter(p => p.ts != null).sort((a, b) => a.ts - b.ts);
    if (arr.length === 0) return null;
    let windowStart = 0, windowSum = 0, windowCount = 0;
    let best = { sum: -1, start: null, end: null, count: 0 };
    for (let i = 0; i < arr.length; i++) {
      windowSum += arr[i].value; windowCount++;
      while (arr[i].ts - arr[windowStart].ts > 7 * 24 * 3600 * 1000) {
        windowSum -= arr[windowStart].value; windowCount--; windowStart++;
      }
      if (windowSum > best.sum) {
        best = { sum: windowSum, start: arr[windowStart].ts, end: arr[i].ts, count: windowCount };
      }
    }
    if (best.sum <= 0) return null;
    return {
      startDate: new Date(best.start).toISOString().slice(0, 10),
      endDate: new Date(best.end).toISOString().slice(0, 10),
      total: best.sum,
      postCount: best.count,
    };
  };

  const bestWeekByPlatform = {};
  for (const platform of enabledPlatforms) {
    const rows = videoUpdates
      .filter(u => u.platform === platform)
      .map(u => {
        const src = videosRoot?.[u.platform]?.[u.videoId];
        const snap = latestSnapshot(src);
        return {
          ts: src?.post?.timestamp ? new Date(src.post.timestamp).getTime() : null,
          value: primaryMetricValue(snap, platform) || 0,
        };
      });
    const bw = rollingBestWeek(rows);
    if (bw) {
      bestWeekByPlatform[platform] = {
        ...bw,
        metric: platformMetrics(platform).primary,
        metricNoun: metricNoun(platform),
      };
    }
  }

  // Back-compat top-level bestWeek = the primary platform's window, with
  // the legacy `totalViews` key preserved (IG-only → views, unchanged).
  const primaryPlatform = enabledPlatforms.includes("instagram")
    ? "instagram"
    : (enabledPlatforms[0] || null);
  const primaryBest = primaryPlatform ? bestWeekByPlatform[primaryPlatform] : null;
  const bestWeek = primaryBest
    ? {
        startDate: primaryBest.startDate,
        endDate: primaryBest.endDate,
        totalViews: primaryBest.total,   // legacy key; = primary metric total
        total: primaryBest.total,
        metric: primaryBest.metric,
        metricNoun: primaryBest.metricNoun,
        postCount: primaryBest.postCount,
      }
    : null;

  return {
    topPosts,
    trajectoryHighlights,
    bestWeek,
    bestWeekByPlatform,
  };
}

// Snapshot the recompute hands to the weekly-summary Claude call.
// Bounded shape so the cache hit rate is high — adding new noisy
// fields invalidates everything.
function buildWeeklySummarySnapshot({ status, momentum, formatCounts, decayAlerts, topRecs, winningVideos }) {
  return {
    status: { state: status.state, reason: status.reason },
    momentum: { score: momentum.score, reasonLine: momentum.reasonLine },
    topFormats: Object.entries(formatCounts || {})
      .filter(([k]) => k !== "other")
      .map(([k, v]) => ({
        format: k, count: v.count, medianOverperf: v.medianOverperf,
      }))
      .sort((a, b) => (b.medianOverperf || 0) - (a.medianOverperf || 0))
      .slice(0, 5),
    decayAlerts: (decayAlerts || []).map(d => ({ format: d.format, drop: `${Math.round((1 - d.currentOverperf / d.prevOverperf) * 100)}%` })),
    winningVideos: winningVideos || [],
    topRecs: (topRecs || []).map(r => ({ idea: r.idea, ruleId: r.ruleId, confidence: r.confidence })),
  };
}

function aggregateCohortEngagement30d(competitorCohort, enabledPlatforms) {
  let sum = 0, n = 0;
  for (const platform of enabledPlatforms) {
    const v = competitorCohort?.[platform]?.pooled?.engagement30d;
    if (v != null) { sum += v; n++; }
  }
  return n ? sum / n : null;
}
