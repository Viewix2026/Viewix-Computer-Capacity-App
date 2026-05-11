// Status / momentum / score → colour map. Pure lookup, no math.
// Keep palette aligned with the rest of the Viewix dashboard.

export const STATUS_COLORS = {
  growing:      { fg: "#10B981", bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.35)" },
  flat:         { fg: "#9CA3AF", bg: "rgba(156,163,175,0.12)", border: "rgba(156,163,175,0.35)" },
  losing:       { fg: "#EF4444", bg: "rgba(239,68,68,0.12)",   border: "rgba(239,68,68,0.35)" },
  insufficient: { fg: "var(--muted)", bg: "var(--bg)",          border: "var(--border)" },
};

// Momentum 0–100 → fg colour. Smooth ramp.
export function momentumColor(score) {
  if (score == null || Number.isNaN(+score)) return "var(--muted)";
  const v = +score;
  if (v >= 70) return "#10B981"; // green
  if (v >= 50) return "#F59E0B"; // amber
  return "#EF4444";              // red
}

// Trend arrow direction for a delta. Sign only, no formatting.
export function trendDirection(delta) {
  if (delta == null || Number.isNaN(+delta)) return "flat";
  const v = +delta;
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "flat";
}
