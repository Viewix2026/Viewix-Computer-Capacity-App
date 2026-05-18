// What's winning — celebratory but credible. Plain win labels
// ("4.8× your usual views"), no scores/jargon. The client should feel
// proud and understand why this one worked.

import { Section, Card, Gathering, PreviewTile, fmtCount } from "./_ui";
import { ZONE_TITLES, GATHERING } from "../portalCopy";

export function Winning({ items, dataState }) {
  if (dataState === "gathering" || !items?.length) {
    return <Gathering title={ZONE_TITLES.winning} message={GATHERING.winning} />;
  }
  return (
    <Section title={ZONE_TITLES.winning}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((v, i) => (
          <Card
            key={i}
            accent={i === 0}
            onClick={v.postUrl ? () => window.open(v.postUrl, "_blank", "noopener,noreferrer") : undefined}
            style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <PreviewTile thumbnail={v.thumbnail} size={84} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: "inline-block", fontSize: 13, fontWeight: 800,
                color: "#fff", background: "var(--accent)",
                padding: "4px 10px", borderRadius: 999, marginBottom: 8,
              }}>
                {v.winLabel}
              </div>
              <div style={{
                fontSize: 14, color: "var(--fg)", lineHeight: 1.5,
                display: "-webkit-box", WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>
                {v.caption || "(no caption)"}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
                {v.views != null && <Mini label="views" value={fmtCount(v.views)} />}
                {v.likes != null && <Mini label="likes" value={fmtCount(v.likes)} />}
                {v.comments != null && <Mini label="comments" value={fmtCount(v.comments)} />}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function Mini({ label, value }) {
  return (
    <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>
      <strong style={{ color: "var(--fg)", fontWeight: 800 }}>{value}</strong> {label}
    </span>
  );
}
