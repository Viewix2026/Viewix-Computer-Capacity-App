// NichePulse — max 2 dot-points naming the patterns competitors are
// riding this week. Generated weekly by Claude in the recompute
// spine; this component just renders.
//
// Phase 7 ships. Empty state when Claude is disabled or no clear
// pattern emerged.

export function NichePulse({ pulse }) {
  const items = Array.isArray(pulse?.pulse) ? pulse.pulse : [];

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "14px 18px",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
      }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)" }}>
          Niche pulse
        </div>
        <span style={{
          padding: "2px 8px", borderRadius: 4,
          background: "rgba(16,185,129,0.15)", color: "#10B981",
          fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
        }}>
          AI · weekly
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, lineHeight: 1.5 }}>
        What's working across the cohort right now. Max two patterns;
        the rest is noise.
      </div>

      {items.length === 0 ? (
        <div style={{
          padding: 12, textAlign: "center",
          color: "var(--muted)", fontSize: 12,
          background: "var(--bg)",
          border: "1px dashed var(--border)", borderRadius: 8,
        }}>
          No clear pattern this week. Try widening the competitor list
          or waiting for the next scrape cycle.
        </div>
      ) : (
        <ul style={{
          listStyle: "none", margin: 0, padding: 0,
          display: "grid", gap: 6,
        }}>
          {items.map((line, i) => (
            <li key={i} style={{
              display: "flex", alignItems: "flex-start", gap: 8,
              fontSize: 12, color: "var(--fg)", lineHeight: 1.5,
            }}>
              <span style={{
                color: "#10B981", flexShrink: 0,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700, marginTop: 1,
              }}>•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
