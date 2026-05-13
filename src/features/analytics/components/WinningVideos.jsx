// WinningVideos — scored ranked feed of this client's top posts.
// Pulls from precomputed scoring on each video; never re-derives.

import { useMemo } from "react";
import { flattenVideos, selectWinningVideos } from "../hooks/useClientDashboardData";
import { PostCard } from "./PostCard";

export function WinningVideos({ videos, limit = 5 }) {
  const list = useMemo(() => {
    const flat = flattenVideos(videos);
    return selectWinningVideos(flat, limit);
  }, [videos, limit]);

  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHeading
        title="Winning videos"
        sub="Ranked by repeatability — over-performers we think you can do again. One-off spikes are filtered out."
      />
      {list.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {list.map(v => (
            <PostCard key={`${v.platform}:${v.videoId}`} video={v} />
          ))}
        </div>
      )}
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

function EmptyState() {
  return (
    <div style={{
      padding: 24,
      background: "var(--card)",
      border: "1px dashed var(--border)",
      borderRadius: 10,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12,
      lineHeight: 1.6,
    }}>
      No winning videos yet. Either the scrape hasn't completed, or no
      recent posts beat the client's own median by enough to surface.
    </div>
  );
}
