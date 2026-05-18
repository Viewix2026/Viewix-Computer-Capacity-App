// What the market is responding to — context, softened, lowest
// priority. Market-first takeaways. A competitor handle appears ONLY
// as a "See the post" source link, never as a headline, never
// "competitor X is beating you". If there's no competitor signal the
// server set dataState "absent" and we render NOTHING (no empty
// frame).

import { Section, Card, SourceLink } from "./_ui";
import { ZONE_TITLES, SOURCE_LINK_LABEL } from "../portalCopy";

export function Niche({ niche, dataState }) {
  // absent → hide the panel entirely. Not a gathering state, not a frame.
  if (dataState === "absent" || !niche?.marketTakeaways?.length) return null;
  return (
    <Section title={ZONE_TITLES.niche}>
      {niche.comparisonSentence && (
        <div style={{
          fontSize: 14, color: "var(--fg)", fontWeight: 600,
          lineHeight: 1.55, margin: "0 2px 12px",
        }}>
          {niche.comparisonSentence}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {niche.marketTakeaways.map((t, i) => (
          <Card key={i}>
            <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.55 }}>
              {t.takeaway}
            </div>
            {t.sourcePostUrl && (
              <div style={{ marginTop: 10 }}>
                <SourceLink href={t.sourcePostUrl} label={SOURCE_LINK_LABEL} />
              </div>
            )}
          </Card>
        ))}
      </div>
    </Section>
  );
}
