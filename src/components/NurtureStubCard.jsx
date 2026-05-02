// NurtureStubCard — shared "Coming soon" card used by every nurture
// sub-tab that hasn't been wired up yet. Lays out the sequence's
// purpose, trigger, data sources, and target outreach actions so the
// future shape of the hub is visible while we build sequences out
// one at a time.

export function NurtureStubCard({ title, intent, trigger, dataSources, targetActions }) {
  return (
    <div style={{ maxWidth: 900, margin: "32px auto", padding: "0 28px" }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "28px 32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--fg)", margin: 0, lineHeight: 1.2 }}>{title}</h2>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--bg)", border: "1px solid var(--border)", padding: "4px 10px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
            Coming soon · automation pending
          </span>
        </div>

        <Section label="Intent" body={intent} />
        <Section label="Trigger" body={trigger} mono />
        <Section label="Data sources" body={dataSources} />
        <Section label="Outreach actions" body={targetActions} />

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
          When this sequence goes live: a new cron worker fires the trigger above, writes its sequence state into Firebase, and replaces this card with a populated funnel + activity table matching the Lapsed Proposals layout.
        </div>
      </div>
    </div>
  );
}

function Section({ label, body, mono }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--fg)", fontWeight: 500, lineHeight: 1.5, fontFamily: mono ? "'JetBrains Mono',monospace" : "inherit" }}>{body}</div>
    </div>
  );
}
