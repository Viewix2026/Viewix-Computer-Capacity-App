// CompetitorWatchlist — list of saved competitors with each one's
// top recent post (last 7 days, by views). Phase 5 ships the raw
// list; Claude takes on each post ("why this is working, here's how
// to apply it") land in Phase 7.
//
// Pure display. The cohort + per-handle stats came from
// recomputeClientAnalytics. We just render.

import { fmtCount } from "../utils/displayFormatters";

export function CompetitorWatchlist({ cohort, competitorsRoot, platform = "instagram" }) {
  const byHandle = cohort?.[platform]?.byHandle || {};
  const competitors = competitorsRoot?.[platform] || {};

  // Sort: prefer handles with a top-recent post, then by post count.
  const entries = Object.entries(byHandle).sort(([, a], [, b]) => {
    const aHas = a.topRecentVideoId ? 1 : 0;
    const bHas = b.topRecentVideoId ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return (b.postCount || 0) - (a.postCount || 0);
  });

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "16px 18px",
    }}>
      <div style={{
        fontSize: 13, fontWeight: 800, color: "var(--fg)", marginBottom: 4,
      }}>
        Competitor watchlist
      </div>
      <div style={{
        fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5,
      }}>
        Each saved competitor's top post from the last 7 days. AI takes
        on what's working land in Phase 7.
      </div>

      {entries.length === 0 ? (
        <Empty>No competitor data yet. Add competitors in setup + run a refresh.</Empty>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {entries.map(([handleKey, stats]) => (
            <CompetitorRow
              key={handleKey}
              stats={stats}
              topVideo={pickTopVideo(competitors[handleKey], stats.topRecentVideoId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function pickTopVideo(handleData, topId) {
  if (!handleData || !topId) return null;
  return handleData?.videos?.[topId] || null;
}

function CompetitorRow({ stats, topVideo }) {
  const post = topVideo?.post;
  const latest = pickLatestSnapshot(topVideo);

  return (
    <div style={{
      display: "flex", gap: 12,
      padding: 10,
      background: "var(--bg)",
      borderRadius: 8,
      border: "1px solid var(--border)",
    }}>
      {post?.thumbnail ? (
        <a href={post.url} target="_blank" rel="noopener noreferrer"
          style={{
            flexShrink: 0, width: 64, height: 64, borderRadius: 6,
            overflow: "hidden", background: "var(--card)",
          }}>
          <img
            src={post.thumbnail} alt=""
            onError={e => { e.target.style.display = "none"; }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </a>
      ) : (
        <div style={{
          flexShrink: 0, width: 64, height: 64, borderRadius: 6,
          background: "var(--card)", border: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, opacity: 0.4,
        }}>—</div>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontSize: 13, fontWeight: 700, color: "var(--fg)",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {stats.displayName || stats.handle}
          </span>
          {stats.followerCount != null && (
            <span style={{ fontSize: 10, color: "var(--muted)" }}>
              {fmtCount(stats.followerCount)} followers
            </span>
          )}
        </div>

        {post ? (
          <>
            <div style={{
              fontSize: 11, color: "var(--fg)", marginTop: 4, lineHeight: 1.4,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}>
              {post.caption || "(no caption)"}
            </div>
            <div style={{
              display: "flex", gap: 10, marginTop: 4,
              fontSize: 10, color: "var(--muted)",
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {latest?.views != null && <span>{fmtCount(latest.views)} views</span>}
              {latest?.likes != null && <span>{fmtCount(latest.likes)} likes</span>}
              {latest?.comments != null && <span>{fmtCount(latest.comments)} comments</span>}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            No posts in the last 7 days.
          </div>
        )}

        <div style={{
          fontSize: 9, color: "var(--muted)", marginTop: 6,
          fontFamily: "'JetBrains Mono', monospace",
          textTransform: "uppercase", letterSpacing: 0.3,
        }}>
          {(stats.postCount || 0)} posts tracked
          {stats.observedPostsPerWeek ? ` · ~${stats.observedPostsPerWeek.toFixed(1)}/wk observed` : ""}
        </div>
      </div>
    </div>
  );
}

function pickLatestSnapshot(video) {
  if (!video) return null;
  const snaps = video?.snapshots || {};
  const keys = Object.keys(snaps).sort();
  if (!keys.length) return null;
  return snaps[keys[keys.length - 1]];
}

function Empty({ children }) {
  return (
    <div style={{
      padding: 16, textAlign: "center",
      color: "var(--muted)", fontSize: 12,
      background: "var(--bg)",
      border: "1px dashed var(--border)", borderRadius: 8,
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}
