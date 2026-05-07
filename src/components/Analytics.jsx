// Analytics — placeholder tab.
//
// Per Jeremy's CLAUDE.md rule "every sidebar tab goes in its own
// src/components/<Feature>.jsx file" — landing the empty shell now
// so future analytics work has a real place to live without
// another round of routing wiring + role-gate decisions later.
//
// Same access pattern as Projects + Pre-Prod (the tabs it sits
// between in the sidebar): founder-tier or lead. Editors / trial
// / closer don't see it — analytics views are intended for
// operations + leadership, not crew.

export function Analytics() {
  return (
    <>
      <div
        style={{
          padding: "12px 28px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "var(--card)",
        }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>
          Analytics
        </span>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: "rgba(248,119,0,0.15)",
            color: "#F87700",
            fontSize: 9,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
          title="Placeholder tab — feature scope being defined">
          Coming soon
        </span>
      </div>

      <div style={{ maxWidth: 700, margin: "0 auto", padding: "60px 28px" }}>
        <div
          style={{
            background: "var(--card)",
            border: "1px dashed var(--border)",
            borderRadius: 12,
            padding: "48px 32px",
            textAlign: "center",
          }}>
          <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.5 }}>📈</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--fg)",
              marginBottom: 8,
            }}>
            Analytics is on its way
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--muted)",
              lineHeight: 1.6,
              maxWidth: 480,
              margin: "0 auto",
            }}>
            Cross-tab metrics — production throughput, project profitability,
            client-goal mix, editor utilisation — will live here. Specifics
            still being scoped. Drop ideas straight into Jeremy's vault and
            we'll build the first widget when the shape is clear.
          </div>
        </div>
      </div>
    </>
  );
}
