// Your progress with Viewix — strictly factual, never a causation
// claim. The server already enforced the date-safe window ("Since
// tracking began") and authored facts only. The client draws the
// conclusion; we never state it. Understated confidence.

import { Section, Card, Gathering, fmtCount, SourceLink } from "./_ui";
import { ZONE_TITLES, GATHERING, SOURCE_LINK_LABEL } from "../portalCopy";

export function Story({ story, dataState }) {
  if (dataState === "gathering" || !story) {
    return <Gathering title={ZONE_TITLES.story} message={GATHERING.story} />;
  }
  const t = story.followerTrajectory;
  return (
    <Section title={ZONE_TITLES.story}>
      <Card>
        <div style={{
          fontSize: 12, fontWeight: 800, color: "var(--muted)",
          textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14,
        }}>
          {story.sinceLabel}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 28 }}>
          {story.postsPublished != null && (
            <Fact value={fmtCount(story.postsPublished)} label="posts published" />
          )}
          {story.bestPost?.views != null && (
            <Fact value={fmtCount(story.bestPost.views)} label="best post views" />
          )}
          {t && t.start != null && t.latest != null && (
            <Fact value={fmtCount(t.latest)} label={t.label || "followers"} />
          )}
        </div>
        {story.bestPost?.caption && (
          <div style={{
            marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)",
            fontSize: 14, color: "var(--fg)", lineHeight: 1.55,
          }}>
            <span style={{ color: "var(--muted)", fontWeight: 700 }}>Best post: </span>
            {story.bestPost.caption}
            {story.bestPost.postUrl && (
              <div style={{ marginTop: 10 }}>
                <SourceLink href={story.bestPost.postUrl} label={SOURCE_LINK_LABEL} />
              </div>
            )}
          </div>
        )}
      </Card>
    </Section>
  );
}

function Fact({ value, label }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 24, fontWeight: 800, color: "var(--navy)" }}>{value}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>{label}</span>
    </div>
  );
}
