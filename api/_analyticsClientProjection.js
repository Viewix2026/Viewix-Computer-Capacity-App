// api/_analyticsClientProjection.js
//
// Single source of truth for "what a Viewix client may see."
//
// recomputeClientAnalytics() builds rich INTERNAL state (scores, rule
// ids, raw confidence, Renewal Ammo, debug notes). The client portal
// must never read any of that. Instead, the recompute tail calls
// buildClientProjection() and writes ONLY the returned object to
// /analytics/public/{portalShortId}. The portal reads that subtree
// and nothing else — so "nothing internal leaks" is enforced at the
// storage layer, not just hidden in the UI.
//
// Every string a client reads is authored here, in the approved
// voice. Hard copy rules from the design brief are enforced in this
// file:
//   - every quantitative claim carries metric + range + baseline
//   - banned words ("scored", "repeatability", rule ids, "confidence",
//     "n=3", SaaS sludge) are never produced
//   - thin data → plain gathering-data / negative-state copy, never a
//     bluff, never an empty frame
//   - competitor handles appear only as source links, never headlines
//   - the Viewix story is factual, date-safe, never a causation claim
//
// This module is PURE: inputs in, client-safe object out. No I/O.
// The recompute decides when to write it; this decides what's safe.

import crypto from "crypto";

// Stable, URL-safe portal token. Mirrors the makeShortId spirit used
// for delivery/preproduction share links, server-side (api/ can't
// import src/utils.js).
export function makePortalShortId() {
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

// Internal format keys → client-friendly labels. The client never
// sees the snake_case keys or the word "format bucket".
const FORMAT_LABELS = {
  founder_talking_head: "founder-led",
  client_proof: "client proof",
  behind_the_scenes: "behind the scenes",
  transformation: "transformation",
  educational_explainer: "educational explainer",
  objection_handling: "objection-handling",
  trend_based: "trend-based",
  product_service_demo: "product/service demo",
  hiring_team_culture: "team & culture",
  event_activation: "event",
  other: "other",
};
const fmtLabel = (k) => FORMAT_LABELS[k] || "other";

// Data-contract minimums.
const MIN_FORMAT_SAMPLE = 3;     // never call a format a winner off < 3 posts
const MIN_WINNING_MULTIPLE = 1.5; // only surface posts that beat usual by ≥1.5×
const MAX_WINNING = 5;
const MAX_NEXT = 4;
const MAX_NICHE = 3;

function shortDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function pct(n) {
  if (n == null || Number.isNaN(+n)) return null;
  return Math.round(Math.abs(+n) * 100);
}

// ─── Header: momentum sentence + hero proof ───────────────────────
// Every claim carries metric + range + baseline. "insufficient" →
// honest gathering-data copy, never a vague momentum vibe.
function buildHeader({ config, status, momentum, topWinner }) {
  const companyName = config?.companyName || "Your content";

  let momentumSentence;
  let positive = false;
  const vd = momentum?.signals?.viewsDelta;
  if (status?.state === "growing" && vd != null) {
    momentumSentence = `Views up ${pct(vd)}% vs the prior 30 days.`;
    positive = true;
  } else if (status?.state === "losing" && vd != null) {
    momentumSentence = `Quieter month — views down ${pct(vd)}% vs the prior 30 days. Here's the one change worth testing.`;
  } else if (status?.state === "flat" && vd != null) {
    momentumSentence = `Views held steady (within ${pct(vd) || 0}%) vs the prior 30 days. We're still finding the strongest pattern.`;
  } else {
    // insufficient / no baseline — gathering data, no number invented.
    return {
      companyName,
      momentumSentence: "We're collecting your first month of data — your dashboard fills in as we go.",
      heroProof: null,
      positive: false,
      gathering: true,
    };
  }

  // Hero proof — only renders with a real top post + multiple.
  let heroProof = null;
  if (topWinner && topWinner.multiple >= MIN_WINNING_MULTIPLE) {
    const fl = topWinner.formatLabel;
    const mult = topWinner.multiple.toFixed(1).replace(/\.0$/, "");
    heroProof = fl
      ? `Your strongest videos this month are ${fl} clips. The top one reached ${mult}× your usual views.`
      : `Your top video this month reached ${mult}× your usual views.`;
  }

  return { companyName, momentumSentence, heroProof, positive, gathering: false };
}

// ─── Winning: top posts in plain language, no scores/jargon ───────
function buildWinning({ videoUpdates, videosRoot }) {
  const rows = [];
  for (const u of videoUpdates || []) {
    const score = u.scoring?.overperformanceScore;
    if (score == null || score < MIN_WINNING_MULTIPLE) continue;
    const src = videosRoot?.[u.platform]?.[u.videoId];
    if (!src?.post) continue;
    const snap = latestSnap(src);
    rows.push({
      multiple: +score,
      formatLabel: fmtLabel(u.classification?.format),
      winLabel: `${(+score).toFixed(1).replace(/\.0$/, "")}× your usual views`,
      views: snap?.views ?? null,
      likes: snap?.likes ?? null,
      comments: snap?.comments ?? null,
      caption: (src.post.caption || "").slice(0, 160),
      postUrl: src.post.url || null,
      thumbnail: src.post.thumbnail || null,
    });
  }
  rows.sort((a, b) => b.multiple - a.multiple);
  return rows.slice(0, MAX_WINNING).map(({ multiple, ...client }) => client);
}

// ─── Next videos: idea + one-line why + source link only ──────────
// Translates internal recs. Drops ruleId / confidence / whyMightBeWrong.
// Competitor-sourced recs are reworded market-first; the competitor
// becomes a source link, never the headline.
function buildNextVideos({ recs, videosRoot, competitorsRoot, enabledPlatforms }) {
  const out = [];
  for (const r of recs || []) {
    if (!r?.idea) continue;
    let idea = r.idea;
    let why = r.rationale || "";
    let sourcePostUrl = resolveSourceUrl(r.sourceIds?.[0], videosRoot, enabledPlatforms);

    if (r.sourceType === "competitor_post") {
      // Strip the competitor name out of the headline; lead with the
      // market signal. The competitor stays only as a source link.
      idea = "The market is responding to this format right now — worth making one in your voice.";
      why = "A creator in your space is getting strong traction with this angle. Adapt it to your positioning before shooting.";
      sourcePostUrl = resolveCompetitorUrl(r.sourceIds?.[0], competitorsRoot, enabledPlatforms) || sourcePostUrl;
    }
    out.push({ idea, why: why.slice(0, 180), sourcePostUrl: sourcePostUrl || null });
    if (out.length >= MAX_NEXT) break;
  }
  return out;
}

// ─── Format playbook: human comparison, ≥3 posts only ─────────────
function buildFormatPlaybook({ formatCounts }) {
  const rows = [];
  for (const [key, v] of Object.entries(formatCounts || {})) {
    if (key === "other") continue;
    if (!v || v.count < MIN_FORMAT_SAMPLE || v.medianOverperf == null) continue;
    const mult = v.medianOverperf;
    if (mult < 1.0) continue; // only surface formats that help
    rows.push({
      format: fmtLabel(key),
      comparisonSentence: `Your ${fmtLabel(key)} videos pull ${mult.toFixed(1).replace(/\.0$/, "")}× your usual views.`,
      sampleWords: `based on ${v.count} posts so far`,
      _m: mult,
    });
  }
  rows.sort((a, b) => b._m - a._m);
  return rows.slice(0, 4).map(({ _m, ...c }) => c);
}

// ─── Viewix story: facts only, date-safe, no causation ────────────
// We don't have clean per-client first-delivery dates wired, so the
// window is ALWAYS "Since tracking began". Never a causation verb.
function buildStory({ renewalAmmo }) {
  const a = renewalAmmo || {};
  const top = a.topPosts?.[0] || null;
  const traj = (a.trajectoryHighlights || [])[0] || null;
  if (!a.topPosts?.length && !traj) return null;
  return {
    sinceLabel: "Since tracking began",
    postsPublished: a.totalPosts ?? (a.topPosts?.length || null),
    bestPost: top
      ? { caption: (top.caption || "").slice(0, 120), views: top.views ?? null, postUrl: top.url || null }
      : null,
    followerTrajectory: traj
      ? { start: traj.startCount ?? null, latest: traj.latestCount ?? null, label: traj.label || null }
      : null,
  };
}

// ─── Niche: market-first, competitor only as a source link ────────
function buildNiche({ thisWeekInNiche, competitorCohort, baselines, enabledPlatforms }) {
  const platform = (enabledPlatforms && enabledPlatforms[0]) || "instagram";
  const takes = thisWeekInNiche?.posts || [];
  if (!takes.length) return null; // no competitor signal → hide panel entirely

  const marketTakeaways = takes.slice(0, MAX_NICHE).map(t => ({
    takeaway: t.take || "Worth a look — a creator in your space is getting traction here.",
    sourcePostUrl: t.post?.url || null, // competitor appears ONLY as a link
  }));

  let comparisonSentence = null;
  const mine = baselines?.medianEngagementRate?.[platform];
  const cohort = competitorCohort?.[platform]?.medianEngagementRate;
  if (mine != null && cohort != null && cohort > 0) {
    const rel = mine / cohort;
    comparisonSentence = rel >= 1
      ? `Your engagement is running ${rel.toFixed(1).replace(/\.0$/, "")}× the typical account in your space.`
      : `The market's typical engagement is currently ahead — the takeaways below are where to close the gap.`;
  }
  return { marketTakeaways, comparisonSentence };
}

// ─── helpers ──────────────────────────────────────────────────────
function latestSnap(video) {
  const snaps = video?.snapshots || {};
  const keys = Object.keys(snaps).sort();
  return keys.length ? snaps[keys[keys.length - 1]] : null;
}
function resolveSourceUrl(videoId, videosRoot, platforms) {
  if (!videoId) return null;
  for (const p of platforms || ["instagram"]) {
    const v = videosRoot?.[p]?.[videoId];
    if (v?.post?.url) return v.post.url;
  }
  return null;
}
function resolveCompetitorUrl(videoId, competitorsRoot, platforms) {
  if (!videoId) return null;
  for (const p of platforms || ["instagram"]) {
    const handles = competitorsRoot?.[p] || {};
    for (const entry of Object.values(handles)) {
      const v = entry?.videos?.[videoId];
      if (v?.post?.url) return v.post.url;
    }
  }
  return null;
}

// ─── Main entry ───────────────────────────────────────────────────
/**
 * buildClientProjection(input) → client-safe object for
 * /analytics/public/{portalShortId}. PURE. The recompute tail owns
 * the write; this owns what is safe to write.
 *
 * Per-panel data contract: a panel key is only populated when its
 * required fields exist; otherwise it's null and meta.dataState marks
 * it so the portal renders honest gathering-data copy, never an empty
 * frame and never a bluff.
 */
export function buildClientProjection(input) {
  const {
    config, status, momentum, baselines, competitorCohort,
    formatCounts, recs, videoUpdates, videosRoot, competitorsRoot,
    renewalAmmo, thisWeekInNiche, enabledPlatforms, computedAt,
  } = input || {};

  const winning = buildWinning({ videoUpdates, videosRoot });
  const topWinner = (videoUpdates || [])
    .filter(u => u.scoring?.overperformanceScore != null)
    .sort((a, b) => b.scoring.overperformanceScore - a.scoring.overperformanceScore)[0];
  const header = buildHeader({
    config, status, momentum,
    topWinner: topWinner
      ? { multiple: +topWinner.scoring.overperformanceScore, formatLabel: fmtLabel(topWinner.classification?.format) }
      : null,
  });
  const nextVideos = buildNextVideos({ recs, videosRoot, competitorsRoot, enabledPlatforms });
  const formatPlaybook = buildFormatPlaybook({ formatCounts });
  const story = buildStory({ renewalAmmo });
  const niche = buildNiche({ thisWeekInNiche, competitorCohort, baselines, enabledPlatforms });

  const dataState = {
    header: header?.gathering ? "gathering" : "ready",
    winning: winning.length ? "ready" : "gathering",
    nextVideos: nextVideos.length ? "ready" : "gathering",
    formatPlaybook: formatPlaybook.length ? "ready" : "gathering",
    story: story ? "ready" : "gathering",
    niche: niche ? "ready" : "absent", // absent → portal hides the panel
  };

  return {
    meta: {
      generatedAt: computedAt || new Date().toISOString(),
      freshnessLine: `Updated ${shortDate(computedAt)}. Based on public Instagram data we can access.`,
      whatThisIncludes:
        "This covers your public Instagram video posts and what we can see publicly from similar accounts. " +
        "It does not include stories, saves, or shares — those aren't available from public data.",
      dataState,
    },
    header,
    winning: winning.length ? winning : null,
    nextVideos: nextVideos.length ? nextVideos : null,
    formatPlaybook: formatPlaybook.length ? formatPlaybook : null,
    story,
    niche,
  };
}
