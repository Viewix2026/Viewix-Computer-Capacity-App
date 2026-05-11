// RenewalAmmo — internal-only panel surfaced to founders + leads
// for retention conversations. Reads precomputed stats from
// /analytics/renewalAmmo/{clientId}/windows/sinceTrackingBegan.
//
// Honest copy by design (per the plan): never claims Viewix CAUSED
// the lift. Just shows the numbers — the reader makes the
// connection. The "since first Viewix delivery" window is v1.1.

import { fmtCount } from "../utils/displayFormatters";

export function RenewalAmmo({ ammo }) {
  const window = ammo?.windows?.sinceTrackingBegan;
  if (!window || (!window.topPosts?.length && !window.trajectoryHighlights?.length && !window.bestWeek)) {
    return null;
  }
  const topPosts = window.topPosts || [];
  const trajectory = window.trajectoryHighlights || [];
  const bestWeek = window.bestWeek || null;

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "16px 20px",
      marginBottom: 16,
      // Subtle distinguishing tint so internal-only panels are
      // visually obvious in the dashboard.
      borderLeft: "3px solid #F59E0B",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)" }}>
          Renewal ammo
        </span>
        <span style={{
          padding: "2px 8px", borderRadius: 4,
          background: "rgba(245,158,11,0.15)", color: "#F59E0B",
          fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
        }}>
          Internal only
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
        Since tracking began. Honest numbers — never overclaim causation.
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 14,
      }}>
        {bestWeek && (
          <BestWeekCard week={bestWeek} />
        )}
        {trajectory.map(t => (
          <TrajectoryCard key={t.platform} trajectory={t} />
        ))}
      </div>

      {topPosts.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 10, fontWeight: 800, color: "var(--muted)",
            textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8,
          }}>
            Top posts lifetime
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
            {topPosts.map(p => (
              <a
                key={p.videoId}
                href={p.url || "#"}
                target="_blank" rel="noopener noreferrer"
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  overflow: "hidden",
                  textDecoration: "none",
                  color: "inherit",
                }}>
                {p.thumbnail ? (
                  <img src={p.thumbnail} alt=""
                    onError={e => { e.target.style.display = "none"; }}
                    style={{ width: "100%", height: 96, objectFit: "cover", display: "block" }}/>
                ) : (
                  <div style={{
                    height: 96, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 24, opacity: 0.4,
                  }}>🎬</div>
                )}
                <div style={{ padding: 8 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: "#F59E0B",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {p.overperformanceLabel || `${(p.overperformanceScore || 0).toFixed(1)}x`}
                  </div>
                  <div style={{
                    fontSize: 10, color: "var(--muted)", marginTop: 2,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {fmtCount(p.views)} views
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BestWeekCard({ week }) {
  return (
    <div style={{
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      padding: "12px 14px",
    }}>
      <div style={{
        fontSize: 9, fontWeight: 800, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: 0.5,
      }}>
        Best week
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 18, fontWeight: 800, color: "#F59E0B", marginTop: 4,
      }}>
        {fmtCount(week.totalViews)}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, lineHeight: 1.4 }}>
        {week.startDate} → {week.endDate} · {week.postCount} posts
      </div>
    </div>
  );
}

function TrajectoryCard({ trajectory }) {
  const { platform, firstCount, lastCount, firstDate, lastDate } = trajectory;
  const delta = (firstCount && firstCount > 0)
    ? ((lastCount - firstCount) / firstCount)
    : null;
  return (
    <div style={{
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      padding: "12px 14px",
    }}>
      <div style={{
        fontSize: 9, fontWeight: 800, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: 0.5,
      }}>
        Followers · {platform}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 16, fontWeight: 800, color: "var(--fg)", marginTop: 4,
        display: "flex", alignItems: "baseline", gap: 6,
      }}>
        {fmtCount(firstCount)} → {fmtCount(lastCount)}
        {delta != null && (
          <span style={{
            fontSize: 11, fontWeight: 700,
            color: delta > 0 ? "#10B981" : delta < 0 ? "#EF4444" : "var(--muted)",
          }}>
            {delta > 0 ? "+" : ""}{(delta * 100).toFixed(1)}%
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, lineHeight: 1.4 }}>
        {firstDate} → {lastDate}
      </div>
    </div>
  );
}
