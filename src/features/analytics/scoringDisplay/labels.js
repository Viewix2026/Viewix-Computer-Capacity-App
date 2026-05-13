// Scoring DISPLAY helpers. No math. No scoring decisions.
//
// These functions take values the API has already computed and
// written into /analytics/... and turn them into the human-readable
// labels that render on cards (e.g. "4.8x usual views", "likely
// repeatable", "one-off spike").
//
// The hard rule: if you find yourself doing arithmetic or comparison
// against a baseline here, stop and move it to api/_analyticsScoring.js.
// This file reads precomputed truth.

// Render an overperformance label from a precomputed score.
// score is views / clientMedian — already calculated by the API.
export function overperformanceLabel(score) {
  if (score == null || Number.isNaN(+score)) return null;
  const v = +score;
  if (v >= 1.5) return `${v.toFixed(1)}x usual views`;
  return null;
}

// Map a precomputed repeatabilityScore (0–100, set by the API) to a
// human label.
//
// IMPORTANT — this is a fallback for the case where the API didn't
// populate `repeatabilityLabel` directly. It MUST stay narrower than
// the API's labelling rules, because at display time we don't know
// whether the API withheld the label intentionally (e.g. because
// engagement/reach data was missing — "we can't claim spike-ness
// without evidence"). Synthesizing "One-off spike" from score alone
// here used to override that intentional silence and put red
// "ONE-OFF SPIKE" pills on Winning Videos cards.
//
// So: only synthesize the upbeat "Likely repeatable" label from a
// genuinely high score. Never invent "One-off spike — don't chase"
// here — that judgment requires evidence the API has access to and
// the display layer doesn't.
export function repeatabilityLabel(score) {
  if (score == null || Number.isNaN(+score)) return null;
  const v = +score;
  if (v >= 70) return "Likely repeatable";
  return null;
}

// Status badge text. The state comes from the API; this just maps
// to display copy.
export function statusBadgeText(state) {
  if (state === "growing")      return "Growing";
  if (state === "flat")         return "Flat";
  if (state === "losing")       return "Losing momentum";
  if (state === "insufficient") return "Not enough data";
  return "Unknown";
}
