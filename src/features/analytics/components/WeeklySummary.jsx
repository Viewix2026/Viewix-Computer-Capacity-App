// WeeklySummary — Claude's 1-paragraph synthesis of the past week.
// Generated weekly by recomputeClientAnalytics (Phase 8). Cached by
// snapshot hash so re-runs on the same data hit cache.
//
// Renders precomputed text only. No fallback computation here.

export function WeeklySummary({ summary }) {
  if (!summary?.paragraph) return null;
  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "14px 18px",
      marginBottom: 16,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
      }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)" }}>
          This week
        </span>
        <span style={{
          padding: "2px 8px", borderRadius: 4,
          background: "rgba(16,185,129,0.15)", color: "#10B981",
          fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
        }}>
          AI summary
        </span>
        {summary.generatedAt && (
          <span style={{
            fontSize: 10, color: "var(--muted)",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {fmtRelative(summary.generatedAt)}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 13, color: "var(--fg)",
        lineHeight: 1.6,
      }}>
        {summary.paragraph}
      </div>
    </div>
  );
}

function fmtRelative(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch { return ""; }
}
