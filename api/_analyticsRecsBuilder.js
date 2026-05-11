// api/_analyticsRecsBuilder.js — rule-based Next Video Recommendations.
//
// Phase 6 ships rules; Phase 7 layers Claude on top to generate
// natural-language framing. The recommendations themselves are
// always rule-driven so they're reproducible from the data.
//
// Recommendation Quality Gate — non-negotiable, enforced HERE at
// build time. A rec is written only if it carries ALL FIVE fields:
//   1. sourceIds          — clickable links back to underlying posts
//   2. ruleId             — which heuristic fired
//   3. confidence         — high / med / low (rule-defined)
//   4. rationale          — one-sentence why-this-matters
//   5. whyMightBeWrong    — internal failure-mode note (founder-only)
//
// Plus confidence + sample-size rules:
//   - confidence === "low" + tiny sample → drop the rec entirely
//   - confidence === "low" + reasonable sample → write but visually
//     demote (the UI reads the confidence field to dim the card)
//
// Storage: /analytics/insights/{clientId}/{weekId}/nextVideoRecs[]
// The webhook caller writes the array; this file just builds it.
//
// Pure function. No Firebase reads/writes.

// Serverless functions can't reach into src/ without Vite-bundling
// surprises, so the taxonomy + gate constants are duplicated here.
// Keep in sync with src/features/analytics/config/constants.js —
// if either side changes a label or threshold, update both.
const FORMAT_LABEL_BY_KEY = {
  founder_talking_head:  "Founder talking head",
  client_proof:          "Client proof",
  behind_the_scenes:     "Behind the scenes",
  transformation:        "Transformation",
  educational_explainer: "Educational explainer",
  objection_handling:    "Objection handling",
  trend_based:           "Trend / audio based",
  product_service_demo:  "Product or service demo",
  hiring_team_culture:   "Hiring / team culture",
  event_activation:      "Event / activation",
  other:                 "Other",
};
const REC_GATE = {
  minFormatSampleForRec: 3,
  minTimelineWeeksForRec: 2,
};

// Sample-size + confidence rules per the plan.
function shouldWriteRec(rec, sampleSize) {
  // Hard quality gate: every field must be present.
  for (const field of ["idea", "rationale", "sourceIds", "ruleId", "confidence", "whyMightBeWrong"]) {
    if (rec[field] == null) return false;
    if (Array.isArray(rec[field]) && rec[field].length === 0) return false;
  }
  // Confidence + sample-size:
  if (rec.confidence === "low") {
    if (sampleSize == null) return false;
    if (sampleSize < REC_GATE.minFormatSampleForRec) return false;
  }
  return true;
}

/**
 * buildNextVideoRecs({ clientVideos, cohortByHandle, formatCounts, now })
 *
 * @param clientVideos     [{ platform, videoId, post, snapshot, scoring, classification }]
 * @param competitorByHandle  { [handleKey]: { displayName, byVideo: [{ post, scoring, classification }] } }
 * @param formatCounts     { [format]: { count, lastPostedTs } } — derived from clientVideos
 * @param now              Date.now() — passed in so the result is deterministic for testing
 *
 * @returns array of rec objects, each carrying the Quality Gate
 * fields. Empty if no rec passes the gate.
 */
export function buildNextVideoRecs({
  clientVideos,
  competitorByHandle = {},
  formatCounts = {},
  now,
}) {
  const recs = [];
  const day = 24 * 3600 * 1000;

  // ─── Rule 1: "Make another version of this winning format" ────
  // Wired to the top Repeatable Win.
  const repeatables = (clientVideos || [])
    .filter(v => v.scoring?.repeatabilityLabel === "Likely repeatable")
    .sort((a, b) => (b.scoring?.repeatabilityScore || 0) - (a.scoring?.repeatabilityScore || 0));
  if (repeatables.length > 0) {
    const top = repeatables[0];
    const format = top.classification?.format || top.scoring?.tags?.find(t => FORMAT_LABEL_BY_KEY[t]) || null;
    const formatLabel = format ? FORMAT_LABEL_BY_KEY[format] : null;
    const sampleSize = format ? (formatCounts[format]?.count ?? 0) : 0;

    const rec = {
      ruleId: "rule.repeatable_win",
      idea: formatLabel
        ? `Make another ${formatLabel.toLowerCase()} in the same shape as your last winner.`
        : `Make another version of your top recent post.`,
      rationale: top.scoring?.overperformanceLabel
        ? `Top recent post hit ${top.scoring.overperformanceLabel} with repeatability ${top.scoring.repeatabilityScore}/100 — reproduce while the conditions are fresh.`
        : `Top recent post scored ${top.scoring.repeatabilityScore}/100 on repeatability — reproduce while the conditions are fresh.`,
      sourceIds: [top.videoId],
      sourceType: "client_post",
      confidence: top.scoring?.repeatabilityScore >= 85 ? "high"
        : top.scoring?.repeatabilityScore >= 70 ? "med"
        : "low",
      whyMightBeWrong: format
        ? `Format classifier is the v0 heuristic — ~70% accuracy. The "${formatLabel}" label may be wrong; double-check before shooting.`
        : `Could not classify the winning post's format — recommendation is based on the post itself, not a pattern.`,
      createdAt: new Date(now).toISOString(),
    };
    if (shouldWriteRec(rec, sampleSize)) recs.push(rec);
  }

  // ─── Rule 2: "You haven't posted {format X} in {N} days" ──────
  // Per-format silence threshold. Fires only for formats that have
  // a track record on this account (>= REC_GATE.minFormatSampleForRec).
  const SILENCE_DAYS = 21;
  for (const [format, stats] of Object.entries(formatCounts)) {
    if (format === "other") continue;
    if ((stats.count || 0) < REC_GATE.minFormatSampleForRec) continue;
    if (!stats.lastPostedTs) continue;
    const ageDays = Math.floor((now - stats.lastPostedTs) / day);
    if (ageDays < SILENCE_DAYS) continue;

    // Confidence ramps with sample size + format performance.
    let confidence = "low";
    if (stats.count >= 8 && stats.medianOverperf >= 1.2) confidence = "high";
    else if (stats.count >= 5) confidence = "med";

    const formatLabel = FORMAT_LABEL_BY_KEY[format] || format;
    const rec = {
      ruleId: "rule.format_silence",
      idea: `You haven't posted a ${formatLabel.toLowerCase()} in ${ageDays} days — that format has worked for you (${stats.count} posts in library).`,
      rationale: `${formatLabel} averaged ${(stats.medianOverperf || 1).toFixed(1)}x your usual views across ${stats.count} posts; the gap since last post is widening.`,
      sourceIds: stats.recentIds?.slice(0, 3) || [],
      sourceType: "format_silence",
      confidence,
      whyMightBeWrong: `Format classification is v0 heuristic (~70% accuracy). Format may have been mislabelled. Sample size: ${stats.count} posts.`,
      createdAt: new Date(now).toISOString(),
    };
    if (rec.sourceIds.length === 0) continue;     // Quality Gate requires sourceIds
    if (shouldWriteRec(rec, stats.count)) recs.push(rec);
  }

  // ─── Rule 3: "Competitor X is winning with format Y — try one" ─
  // Niche scan: find each competitor's recent top-performer and
  // surface the cross-niche pattern.
  for (const [handleKey, h] of Object.entries(competitorByHandle)) {
    const winners = (h.byVideo || [])
      .filter(v => v.post?.timestamp && (now - new Date(v.post.timestamp).getTime()) < 14 * day)
      .filter(v => v.scoring?.overperformanceLabel) // only over-performers
      .sort((a, b) => (b.scoring?.overperformanceScore || 0) - (a.scoring?.overperformanceScore || 0));
    if (winners.length === 0) continue;

    const top = winners[0];
    const format = top.classification?.format;
    if (!format || format === "other") continue;

    const formatLabel = FORMAT_LABEL_BY_KEY[format] || format;
    const rec = {
      ruleId: "rule.competitor_winning_format",
      idea: `${h.displayName} is winning with ${formatLabel.toLowerCase()} — try one in your voice.`,
      rationale: `${h.displayName}'s recent ${formatLabel.toLowerCase()} hit ${top.scoring.overperformanceLabel}. Adapt the angle to your client's positioning before shooting.`,
      sourceIds: [top.videoId],
      sourceType: "competitor_post",
      confidence: "med",  // medium by default — cross-niche signals are softer than client-own
      whyMightBeWrong: `Competitor format classification is v0 heuristic. Their context (audience, follower size, posting cadence) differs from your client; a format that works for them may not transplant directly.`,
      createdAt: new Date(now).toISOString(),
    };
    if (shouldWriteRec(rec, 1)) recs.push(rec);
  }

  // Cap to 5 recs total, ordered by rule priority (rule 1 > rule 2 > rule 3).
  return recs.slice(0, 5);
}
