// Compare — small KPI panel surfacing the client's recent
// performance against the saved competitor cohort.
//
// Three cards:
//   - Engagement vs cohort (precomputed competitorDelta from
//     /analytics/clients/{id}/momentum/signals).
//   - Observed posting frequency vs cohort. Labelled "observed"
//     deliberately — public scrape sees the scrape window only,
//     so this is a floor estimate, not an absolute number.
//   - Follower trajectory (already computed from /followers history).
//
// Pure display. No math.

import { fmtDelta, fmtCount } from "../utils/displayFormatters";

export function Compare({ momentum, cohort, clientPostsPerWeek, followerNow, followerPrev30d }) {
  const compDelta = momentum?.signals?.competitorDelta;
  const cohortPostsPerWeek = pickCohortPostsPerWeek(cohort);
  const postsDelta = (cohortPostsPerWeek && cohortPostsPerWeek > 0 && clientPostsPerWeek != null)
    ? (clientPostsPerWeek - cohortPostsPerWeek) / cohortPostsPerWeek
    : null;
  const followerDelta = (followerNow != null && followerPrev30d && followerPrev30d > 0)
    ? (followerNow - followerPrev30d) / followerPrev30d
    : null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 10,
      marginBottom: 14,
    }}>
      <Card
        label="Engagement vs cohort"
        value={compDelta != null ? fmtDelta(compDelta, 0) : "—"}
        positive={compDelta != null && compDelta > 0.01}
        negative={compDelta != null && compDelta < -0.01}
        hint={compDelta == null
          ? "Cohort engagement signal not available yet."
          : compDelta > 0
            ? "Your engagement rate is above your saved competitors' median over the last 30 days."
            : compDelta < 0
              ? "Your engagement rate is below your saved competitors' median over the last 30 days."
              : "On par with cohort."
        }
      />
      <Card
        label="Posting frequency vs cohort"
        sublabel="observed"
        value={postsDelta != null ? fmtDelta(postsDelta, 0) : "—"}
        positive={postsDelta != null && postsDelta > 0.01}
        negative={postsDelta != null && postsDelta < -0.01}
        hint={postsDelta == null
          ? "Need both your and your cohort's recent posting data."
          : "Observed posts/week — public scrape only sees what the actor returns, so treat as a floor estimate, not absolute."
        }
      />
      <Card
        label="Followers (30d)"
        value={followerDelta != null ? fmtDelta(followerDelta, 1) : "—"}
        positive={followerDelta != null && followerDelta > 0}
        negative={followerDelta != null && followerDelta < 0}
        hint={followerNow != null
          ? `Currently ${fmtCount(followerNow)} followers.`
          : "Follower count not yet captured."}
      />
    </div>
  );
}

function pickCohortPostsPerWeek(cohort) {
  if (!cohort) return null;
  // v1 IG only — collapse cleanly if more platforms come online.
  const v = cohort?.instagram?.pooled?.observedPostsPerWeek;
  return v ?? null;
}

function Card({ label, sublabel, value, hint, positive, negative }) {
  const colour = positive ? "#10B981" : negative ? "#EF4444" : "var(--fg)";
  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "12px 14px",
    }}>
      <div style={{
        fontSize: 9, fontWeight: 800, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: 0.5,
        display: "flex", gap: 6, alignItems: "baseline",
      }}>
        {label}
        {sublabel && (
          <span title="Observed = derived from posts the actor returned in the scrape window. Treat as a floor estimate, not absolute."
            style={{ fontSize: 9, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase" }}>
            ({sublabel})
          </span>
        )}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 22, fontWeight: 800, color: colour, marginTop: 6,
        lineHeight: 1,
      }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
