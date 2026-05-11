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

function computeOverperformance({ views, medianViews }) {
  if (!views || !medianViews) return { score: null, label: null };
  const score = +(views / medianViews).toFixed(2);
  let label = null;
  if (score >= OVERPERF.noiseFloorScore) label = `${score.toFixed(1)}x usual views`;
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
  if (overperformanceScore >= OVERPERF.spikeScore
      && engagementVsBaseline != null
      && engagementVsBaseline < OVERPERF.spikeEngagementCutoff) {
    return { score: 15, label: "One-off spike — don't chase" };
  }

  let score = 0;
  if (overperformanceScore >= REPEAT.overperfMinForBonus) score += REPEAT.overperfBonus;
  if (engagementVsBaseline != null && engagementVsBaseline >= REPEAT.engagementMinForBonus) {
    score += REPEAT.engagementBonus;
  }
  if (followerNormalisedViews != null && followerNormalisedViews >= REPEAT.reachFollowerFraction) {
    score += REPEAT.reachBonus;
  }

  if (ageDays != null) {
    if (ageDays > REPEAT.recencyAgeMidDays) score -= REPEAT.recencyOldPenalty;
    else if (ageDays > REPEAT.recencyAgeFreshDays) score -= REPEAT.recencyMidPenalty;
  }

  score = clamp(score, 0, 100);

  let label = null;
  if (score >= REPEAT.repeatableMin) label = "Likely repeatable";
  else if (score <= REPEAT.oneOffMax) label = "One-off spike — don't chase";

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

  // ─── 2. Baselines per platform ─────────────────────────────────
  const baselines = {
    medianViews: {},
    medianEngagementRate: {},
    followerCount: {},
    updatedAt: computedAt,
  };

  const videoUpdates = []; // [{ platform, videoId, scoring }]
  const platformStats = {};

  for (const platform of enabledPlatforms) {
    const videos = videosRoot[platform] || {};
    const videosList = Object.entries(videos).map(([videoId, v]) => ({ videoId, ...v }));

    const allViews = [];
    const allEngagement = [];
    for (const v of videosList) {
      const snap = latestSnapshot(v);
      if (!snap) continue;
      if (snap.views != null) allViews.push(snap.views);
      if (snap.engagementRate != null) allEngagement.push(snap.engagementRate);
    }
    const medViews = median(allViews);
    const medEng = median(allEngagement);
    baselines.medianViews[platform] = Math.round(medViews);
    baselines.medianEngagementRate[platform] = +medEng.toFixed(3);
    baselines.followerCount[platform] = latestFollowerCount(followersRoot[platform]);

    // ─── 3. Per-video scoring (rule-based) ───────────────────────
    const followerCount = baselines.followerCount[platform];
    for (const v of videosList) {
      const snap = latestSnapshot(v);
      if (!snap) continue;

      const views = snap.views;
      const engagementRate = snap.engagementRate;
      const timestamp = v.post?.timestamp ? new Date(v.post.timestamp).getTime() : null;
      const ageDays = timestamp ? (now - timestamp) / (24 * 3600 * 1000) : null;

      const overperf = computeOverperformance({ views, medianViews: medViews });
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
      const views = snap?.views || 0;
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

  // ─── 5. Write baselines ──────────────────────────────────────────
  await fbSet(`/analytics/clients/${clientId}/baselines`, baselines);

  // ─── 6. Write per-video scoring (parallel) ───────────────────────
  await Promise.all(videoUpdates.map(u =>
    fbSet(`/analytics/videos/${clientId}/${u.platform}/${u.videoId}/scoring`, u.scoring)
  ));

  // ─── 7. Aggregate stats across platforms (v1: IG only, so this is
  //         effectively a passthrough — but keeps the door open for
  //         v2 multi-platform without rewiring). ────────────────────
  const aggregate = aggregatePlatformStats(platformStats);
  const status = computeStatus({
    posts30dViews: aggregate.posts30dViews,
    postsPrior30dViews: aggregate.postsPrior30dViews,
    postCount: aggregate.totalPosts,
    weeksOfData: aggregate.weeksOfData,
  });

  const viewsDelta = (aggregate.postsPrior30dViews && aggregate.postsPrior30dViews > 0)
    ? (aggregate.posts30dViews - aggregate.postsPrior30dViews) / aggregate.postsPrior30dViews
    : null;
  const engagementDelta = (aggregate.engagementPrior30d && aggregate.engagementPrior30d > 0)
    ? (aggregate.engagement30d - aggregate.engagementPrior30d) / aggregate.engagementPrior30d
    : null;
  const postFrequencyDelta = (aggregate.postsPerWeekPrior && aggregate.postsPerWeekPrior > 0)
    ? (aggregate.postsPerWeekRecent - aggregate.postsPerWeekPrior) / aggregate.postsPerWeekPrior
    : null;
  // competitorDelta lands in Phase 5 once competitor baselines compute.
  const competitorDelta = null;

  const momentum = computeMomentum({
    viewsDelta, engagementDelta, postFrequencyDelta, competitorDelta,
  });

  // ─── 8. Write status + momentum (overwrite, not patch — these
  //         records are wholly derived and should never carry
  //         stale fields from a prior recompute). ───────────────────
  await fbSet(`/analytics/clients/${clientId}/status`, {
    state: status.state,
    reason: status.reason,
    computedAt,
  });
  await fbSet(`/analytics/clients/${clientId}/momentum`, {
    score: momentum.score,
    reasonLine: momentum.reasonLine,
    signals: momentum.signals,
    delta30d: viewsDelta,
    computedAt,
  });

  // ─── 9. lastRecomputeAt last so it reflects a fully successful run.
  await fbPatch(`/analytics/clients/${clientId}`, {
    lastRecomputeAt: computedAt,
  });

  return {
    ok: true,
    clientId,
    status: status.state,
    momentum: momentum.score,
    videosScored: videoUpdates.length,
    enabledPlatforms,
  };
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
