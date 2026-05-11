// api/_analyticsFormatHeuristic.js — Phase 6 v0 format classifier.
//
// Deliberately crude. Keyword + hashtag matching against caption +
// metadata. Phase 7 replaces this with the Claude classifier; the
// field shape is identical so swap-in is wiring, not redesign.
//
// Expected accuracy: ~70%. The dashboard renders Format Playbook
// behind a "v0 — accuracy improving in Phase 7" caveat label so
// the team doesn't take the per-format counts as gospel yet.
//
// Manual override path:
//   /analytics/videos/{clientId}/{platform}/{videoId}/classifications/manualFormatOverride
//   is checked FIRST in recomputeClientAnalytics. If set, the
//   heuristic doesn't run for that post and the manual label sticks.
//   Phase 7's Claude pass respects the same field.
//
// Confidence values:
//   high  — strong, unambiguous match (e.g. "tutorial" in title)
//   med   — multiple weak signals or one weak signal
//   low   — fallback / "other"
//
// Boundary: no Firebase reads/writes in this file. Pure function.
// recomputeClientAnalytics calls classifyFormat() with each post.

const RULES = [
  // ─── founder_talking_head ───────────────────────────────────────
  // First-person + addressing the camera. The most common format
  // for retainer-style content, so this rule fires first to claim
  // ambiguous cases.
  {
    key: "founder_talking_head",
    high:  /\b(?:i'm|i am|i've|i've been|here's why|today i|let me tell)\b/i,
    med:   /\b(?:my|i think|i believe|i wanted|i decided)\b/i,
    hashtags: [/#founder/i, /#ceo/i],
  },

  // ─── client_proof ──────────────────────────────────────────────
  {
    key: "client_proof",
    high: /\b(?:testimonial|client review|customer review|happy client|client wins?)\b/i,
    med:  /\b(?:client|customer|review)\b/i,
    hashtags: [/#testimonial/i, /#clientwin/i, /#proof/i],
  },

  // ─── transformation ────────────────────────────────────────────
  {
    key: "transformation",
    high: /\b(?:before\s*(?:&|and|→|->)?\s*after|transformation|results in|went from)\b/i,
    med:  /\b(?:before|after|result|outcome)\b/i,
    hashtags: [/#transformation/i, /#beforeafter/i, /#results/i],
  },

  // ─── educational_explainer ─────────────────────────────────────
  {
    key: "educational_explainer",
    high: /\b(?:how to|tutorial|step[- ]by[- ]step|guide|explained|here's how)\b/i,
    med:  /\b(?:tips?|learn|teach|lesson)\b/i,
    hashtags: [/#tutorial/i, /#howto/i, /#tips/i],
  },

  // ─── objection_handling ────────────────────────────────────────
  // "Address a doubt the prospect has" content. Specific phrasing,
  // not just "but" anywhere in the caption.
  {
    key: "objection_handling",
    high: /\b(?:myth busted?|debunk|biggest myth|you might think|the truth about)\b/i,
    med:  /\b(?:myth|wrong|misconception|actually)\b/i,
    hashtags: [/#myth/i, /#truth/i, /#debunked/i],
  },

  // ─── trend_based ───────────────────────────────────────────────
  {
    key: "trend_based",
    high: /\b(?:trending|trend alert|viral sound|using this audio|on this trend)\b/i,
    med:  /\b(?:viral|trending|trend)\b/i,
    hashtags: [/#trending/i, /#fyp/i, /#viral/i, /#trend/i],
  },

  // ─── product_service_demo ──────────────────────────────────────
  {
    key: "product_service_demo",
    high: /\b(?:demo|product (?:walkthrough|tour)|here's (?:our|the) product|introducing\b)/i,
    med:  /\b(?:product|service|launch|feature)\b/i,
    hashtags: [/#product/i, /#launch/i, /#demo/i],
  },

  // ─── hiring_team_culture ───────────────────────────────────────
  {
    key: "hiring_team_culture",
    high: /\b(?:we're hiring|join (?:our|the) team|now hiring|open role|culture)\b/i,
    med:  /\b(?:team|hiring|career|colleague)\b/i,
    hashtags: [/#hiring/i, /#wereHiring/i, /#team/i, /#culture/i],
  },

  // ─── event_activation ──────────────────────────────────────────
  {
    key: "event_activation",
    high: /\b(?:event|conference|live (?:at|from)|launch (?:event|party)|recap)\b/i,
    med:  /\b(?:event|live|launch)\b/i,
    hashtags: [/#event/i, /#conference/i, /#launch/i],
  },

  // ─── behind_the_scenes ─────────────────────────────────────────
  // Last-but-not-other because BTS captions sometimes use words that
  // overlap with educational/founder — we want to give the more
  // specific rules a chance first.
  {
    key: "behind_the_scenes",
    high: /\b(?:behind the scenes|BTS|the process|day in the life|how (?:we|i) made)\b/i,
    med:  /\b(?:process|production|filming|shoot day)\b/i,
    hashtags: [/#bts/i, /#behindthescenes/i, /#process/i],
  },
];

/**
 * classifyFormat(post)
 *
 * @param {object} post — at minimum { caption, hashtags? }
 * @returns {object} { format, formatConfidence, heuristicReason }
 *
 * format             one of constants.FORMAT_BUCKETS keys, plus "other"
 * formatConfidence   "high" | "med" | "low"
 * heuristicReason    short string: which rule fired (for audit)
 */
export function classifyFormat(post) {
  const caption = (post?.caption || "").toString();
  const hashtags = extractHashtags(caption);

  // Match each rule in order. Track the best (highest-confidence) hit.
  let best = null;
  for (const rule of RULES) {
    const captionHigh = rule.high && rule.high.test(caption);
    const captionMed  = rule.med  && rule.med.test(caption);
    const hashtagHit  = (rule.hashtags || []).some(rx => hashtags.some(h => rx.test(h)));

    if (captionHigh) {
      best = pickBest(best, {
        format: rule.key,
        formatConfidence: "high",
        heuristicReason: `caption matched high-confidence pattern for ${rule.key}`,
      });
    } else if (captionMed || hashtagHit) {
      best = pickBest(best, {
        format: rule.key,
        formatConfidence: "med",
        heuristicReason: hashtagHit
          ? `hashtag matched for ${rule.key}`
          : `caption matched mid-confidence pattern for ${rule.key}`,
      });
    }
  }

  if (best) return best;

  // No rule matched. "Other" with low confidence so the playbook can
  // surface "lots of unclassified posts" if it's a big bucket.
  return {
    format: "other",
    formatConfidence: "low",
    heuristicReason: "no caption / hashtag rule matched",
  };
}

// Pick the higher-confidence of two classifications. High beats med
// beats low. Ties resolve to the first encountered (rule order).
function pickBest(a, b) {
  if (!a) return b;
  const rank = c => (c === "high" ? 3 : c === "med" ? 2 : 1);
  return rank(b.formatConfidence) > rank(a.formatConfidence) ? b : a;
}

function extractHashtags(caption) {
  if (!caption) return [];
  const out = [];
  const re = /#[A-Za-z0-9_]+/g;
  let m;
  while ((m = re.exec(caption)) !== null) out.push(m[0]);
  return out;
}
