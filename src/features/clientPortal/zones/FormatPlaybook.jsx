// Why it's working — which formats earn the most lift vs the client's
// own baseline, in plain words. Blue bars; the top performer gets the
// single Orange highlight (the ≤10% accent). Sample honesty in human
// words ("based on 3 posts so far"), never "n=3".

import { Section, Card, Gathering } from "./_ui";
import { ZONE_TITLES, GATHERING } from "../portalCopy";

export function FormatPlaybook({ items, dataState }) {
  if (dataState === "gathering" || !items?.length) {
    return <Gathering title={ZONE_TITLES.formatPlaybook} message={GATHERING.formatPlaybook} />;
  }
  // Scale bars to the strongest format so the comparison is visual.
  const max = Math.max(...items.map(it => parseMultiple(it.comparisonSentence)), 1);
  return (
    <Section title={ZONE_TITLES.formatPlaybook}>
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {items.map((it, i) => {
            const m = parseMultiple(it.comparisonSentence);
            const pctW = Math.max(8, Math.round((m / max) * 100));
            const top = i === 0;
            return (
              <div key={i}>
                <div style={{
                  fontSize: 14, fontWeight: 700, color: "var(--fg)",
                  marginBottom: 6, lineHeight: 1.45,
                }}>
                  {it.comparisonSentence}
                </div>
                <div style={{
                  height: 10, borderRadius: 999, background: "var(--bar-bg)",
                  overflow: "hidden",
                }}>
                  <div style={{
                    width: `${pctW}%`, height: "100%", borderRadius: 999,
                    background: top ? "var(--accent-2)" : "var(--accent)",
                  }} />
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 5 }}>
                  {it.sampleWords}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </Section>
  );
}

// The projection authored "Your X videos pull 1.4× your usual views."
// Pull the multiple out for bar scaling only — no scoring in the UI,
// just reading a number the server already decided to surface.
function parseMultiple(sentence) {
  const m = String(sentence || "").match(/([\d.]+)×/);
  return m ? parseFloat(m[1]) : 1;
}
