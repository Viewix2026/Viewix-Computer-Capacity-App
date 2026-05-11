// Analytics taxonomy + thresholds. Exposed here so the team can tune
// without hunting through component code. Phase 1 only uses the
// platform list + the format-bucket and hook-type names for the
// config form's eventual classifier hooks; the scoring thresholds
// land in Phase 3 when status + momentum are computed.
//
// Boundary reminder: this file is config. It does NOT compute. All
// math lives in api/_analyticsScoring.js per the success criterion.

export const PLATFORMS = [
  { key: "instagram", label: "Instagram", v1: true },
  // TikTok + YouTube are v2 / v3 — kept here so the per-client
  // platforms toggle has a stable shape and adding them later is
  // wiring, not redesign.
  { key: "tiktok",    label: "TikTok",    v1: false },
  { key: "youtube",   label: "YouTube",   v1: false },
];

// Format buckets — closed list. "other" is the catch-all so the
// classifier in Phase 7 always has a valid output. Order is the
// playbook display order.
export const FORMAT_BUCKETS = [
  { key: "founder_talking_head",   label: "Founder talking head" },
  { key: "client_proof",           label: "Client proof" },
  { key: "behind_the_scenes",      label: "Behind the scenes" },
  { key: "transformation",         label: "Transformation" },
  { key: "educational_explainer",  label: "Educational explainer" },
  { key: "objection_handling",     label: "Objection handling" },
  { key: "trend_based",            label: "Trend / audio based" },
  { key: "product_service_demo",   label: "Product or service demo" },
  { key: "hiring_team_culture",    label: "Hiring / team culture" },
  { key: "event_activation",       label: "Event / activation" },
  { key: "other",                  label: "Other" },
];

// Hook types — closed list, used by the v1-stretch Hook Analyzer.
// Schema lives here from Phase 1 so adding the Analyzer in Phase 8
// is wiring, not redesign.
export const HOOK_TYPES = [
  { key: "question",       label: "Question" },
  { key: "claim",          label: "Claim" },
  { key: "contrarian",     label: "Contrarian" },
  { key: "curiosity_gap",  label: "Curiosity gap" },
  { key: "statistic",      label: "Statistic" },
  { key: "personal_story", label: "Personal story" },
  { key: "null",           label: "No clear hook" },
];

// Status badge thresholds — first-cut defaults. Tunable here without
// touching component code. Phase 3 reads these when computing the
// per-client status in api/_analyticsScoring.js.
export const STATUS_THRESHOLDS = {
  // Min sample required to compute status at all; below this we
  // emit "insufficient".
  minPostsForStatus: 10,
  minWeeksForStatus: 2,
  // 30-day views delta vs the prior 30 days.
  growingViewsDeltaPct: 0.10,   // +10% → growing
  losingViewsDeltaPct:  -0.10,  // -10% → losing
  // Anything in between is "flat".
};

// Recommendation Quality Gate thresholds (Phase 6). Stored here so the
// rule that suppresses speculative recs is auditable in one place.
export const REC_GATE = {
  // Below this format-post count we don't surface format-specific
  // recommendations at all — speculation on tiny samples is worse
  // than silence.
  minFormatSampleForRec: 3,
  // Below this many weeks of timeline data we don't surface
  // trajectory-based recommendations.
  minTimelineWeeksForRec: 2,
};
