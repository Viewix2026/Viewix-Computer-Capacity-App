// Display helpers for the Analytics tab. Format precomputed metrics
// for rendering only.
//
// Examples: turn 0.024 → "2.4%", 12450 → "12.4K", a delta value → "+18%".
//
// CRITICAL: No scoring, no medians, no percentiles, no over/under
// performance calculations. Those are precomputed in
// api/_analyticsScoring.js and written to /analytics/... — this file
// only renders truth that's already there.

// Compact number: 12450 → "12.4K", 1_500_000 → "1.5M".
export function fmtCount(n) {
  if (n == null || Number.isNaN(+n)) return "—";
  const v = +n;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

// Percent: 0.024 → "2.4%", 1.42 → "142%".
export function fmtPct(p, digits = 1) {
  if (p == null || Number.isNaN(+p)) return "—";
  return `${(+p * 100).toFixed(digits)}%`;
}

// Signed delta with arrow: 0.32 → "+32% ↑", -0.08 → "-8% ↓".
export function fmtDelta(d, digits = 0) {
  if (d == null || Number.isNaN(+d)) return "—";
  const v = +d;
  const arrow = v > 0 ? "↑" : v < 0 ? "↓" : "→";
  const pct = `${v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
  return `${pct} ${arrow}`;
}

// "@handle" — strips any leading @ the producer typed and re-adds one
// canonical @. Forgiving input handler for the config form.
export function normaliseHandle(raw) {
  if (!raw) return "";
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

// Display @handle (with the @). Pass through normaliseHandle first.
export function displayHandle(raw) {
  const clean = normaliseHandle(raw);
  return clean ? `@${clean}` : "";
}
