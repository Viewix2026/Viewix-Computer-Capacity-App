// What to make next — the payoff. A creative partner's suggestions,
// not a report appendix. Idea + one-line why + a source link to the
// post that inspired it (trust, not a black box). No confidence tags,
// no rule names — those never reached the projection.

import { Section, Card, Gathering, SourceLink } from "./_ui";
import { ZONE_TITLES, GATHERING, SOURCE_LINK_LABEL } from "../portalCopy";

export function NextVideos({ items, dataState }) {
  if (dataState === "gathering" || !items?.length) {
    return <Gathering title={ZONE_TITLES.nextVideos} message={GATHERING.nextVideos} />;
  }
  return (
    <Section title={ZONE_TITLES.nextVideos}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((r, i) => (
          <Card key={i} style={{ borderLeft: "3px solid var(--accent-2)" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)", lineHeight: 1.45 }}>
              {r.idea}
            </div>
            {r.why && (
              <div style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.55, marginTop: 8 }}>
                {r.why}
              </div>
            )}
            {r.sourcePostUrl && (
              <div style={{ marginTop: 12 }}>
                <SourceLink href={r.sourcePostUrl} label={SOURCE_LINK_LABEL} />
              </div>
            )}
          </Card>
        ))}
      </div>
    </Section>
  );
}
