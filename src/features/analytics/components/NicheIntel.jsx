// NicheIntel — Phase 5 zone: niche intelligence + competitor cohort.
//
// Two-column layout:
//   Left:  Engagement chart (your rate over time + cohort median
//          overlay) + a Compare panel with three KPI cards.
//   Right: CompetitorWatchlist sidebar with each saved competitor's
//          top recent post.
//
// At narrow widths the columns stack. No dependency on a chart
// library — see EngagementChart for the hand-rolled SVG.

import { EngagementChart } from "./EngagementChart";
import { Compare } from "./Compare";
import { CompetitorWatchlist } from "./CompetitorWatchlist";
import { NichePulse } from "./NichePulse";

export function NicheIntel({ data, competitorsRoot }) {
  const cohort = data?.competitorCohort || null;
  const cohortMedian = cohort?.instagram?.pooled?.medianEngagementRate ?? null;
  const nichePulse = data?.insights?.nichePulse || null;
  const thisWeekInNiche = data?.insights?.thisWeekInNiche || null;

  const followerHistory = (data?.followers?.instagram) || {};
  const followerDates = Object.keys(followerHistory).sort();
  const followerNow = followerDates.length
    ? followerHistory[followerDates[followerDates.length - 1]]?.count ?? null
    : null;
  // Closest date AT OR BEFORE (today - 30d).
  const targetMs = Date.now() - 30 * 24 * 3600 * 1000;
  let followerPrev30d = null;
  for (let i = followerDates.length - 1; i >= 0; i--) {
    if (new Date(followerDates[i]).getTime() <= targetMs) {
      followerPrev30d = followerHistory[followerDates[i]]?.count ?? null;
      break;
    }
  }

  // Posts-per-week observed for the client (read from
  // baselines/recent stats — we don't have a precomputed field for
  // this on the client side yet; momentum.signals.postFrequencyDelta
  // is normalised and not what we want here). Phase 5.1 can move
  // this to baselines if it becomes load-bearing; for v1 the
  // Compare panel will quietly hide the metric if absent.
  // (Leaving null means the card shows "—" rather than guessing.)
  const clientPostsPerWeek = null;

  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHeading
        title="Niche intelligence"
        sub="Your performance against the saved competitor cohort. The cohort is the niche."
      />
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 360px)",
        gap: 14,
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Compare
            momentum={data?.momentum}
            cohort={cohort}
            clientPostsPerWeek={clientPostsPerWeek}
            followerNow={followerNow}
            followerPrev30d={followerPrev30d}
          />
          {nichePulse && <NichePulse pulse={nichePulse} />}
          <div style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "16px 18px",
          }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)", marginBottom: 4 }}>
              Engagement rate over time
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
              Each dot is one of your recent posts. The dashed line is the
              pooled median across your saved competitors — your niche
              benchmark.
            </div>
            <EngagementChart
              videos={data?.videos}
              cohortMedian={cohortMedian}
            />
          </div>
        </div>

        <CompetitorWatchlist
          cohort={cohort}
          competitorsRoot={competitorsRoot}
          thisWeekInNiche={thisWeekInNiche}
          platform="instagram"
        />
      </div>
    </div>
  );
}

function SectionHeading({ title, sub }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)" }}>
        {title}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
