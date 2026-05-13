// ViewsOverTimeChart — hand-rolled SVG chart for views per post over
// time. Unlike EngagementChart, this works WITHOUT follower data —
// views are returned directly by the IG post scraper, so this chart
// lights up on the first scrape (no waiting for profile-mode runs).
//
// Two visual layers:
//   - dots: one per post, x=postedAt, y=views (log-ish via sqrt so a
//     200K-view outlier doesn't flatten the rest of the line)
//   - dashed horizontal line: the client's median views (so the
//     founder can see at a glance which posts beat the median and by
//     how much)
//
// Median + scale are precomputed by the API; this component just
// reads /analytics/clients/{id}/baselines/medianViews and plots.
// No math here.

import { useMemo } from "react";
import { fmtCount } from "../utils/displayFormatters";

export function ViewsOverTimeChart({ videos, medianViews, height = 200 }) {
  // Flatten + sort posts by timestamp.
  const points = useMemo(() => {
    const all = [];
    for (const [platform, group] of Object.entries(videos || {})) {
      for (const [videoId, v] of Object.entries(group || {})) {
        if (!v?.post?.timestamp) continue;
        const snaps = v.snapshots || {};
        const dates = Object.keys(snaps).sort();
        if (!dates.length) continue;
        const latest = snaps[dates[dates.length - 1]];
        if (latest?.views == null) continue;
        all.push({
          ts: new Date(v.post.timestamp).getTime(),
          views: latest.views,
          platform,
          videoId,
          url: v.post?.url || null,
          caption: (v.post?.caption || "").slice(0, 80),
        });
      }
    }
    return all.sort((a, b) => a.ts - b.ts);
  }, [videos]);

  if (points.length < 2) {
    return (
      <div style={{
        padding: 32, textAlign: "center", color: "var(--muted)",
        fontSize: 12, lineHeight: 1.6,
        border: "1px dashed var(--border)", borderRadius: 8,
      }}>
        Not enough posts yet — need at least 2 with view counts to plot.
      </div>
    );
  }

  // Chart layout.
  const W = 600;
  const H = height;
  const PAD = { l: 48, r: 12, t: 14, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const tsRange = Math.max(1, tsMax - tsMin);

  // sqrt scale so outliers (a 200K-view banger) don't flatten the rest
  // of the line into the baseline. Pure cosmetic — doesn't change any
  // truth, just makes the chart readable.
  const scale = (v) => Math.sqrt(Math.max(0, v));
  const allScaled = points.map(p => scale(p.views));
  if (medianViews != null) allScaled.push(scale(medianViews));
  const yMaxScaled = Math.max(0.01, Math.max(...allScaled) * 1.1);

  const xAt = (ts) => PAD.l + ((ts - tsMin) / tsRange) * innerW;
  const yAt = (views) => PAD.t + innerH - (scale(views) / yMaxScaled) * innerH;

  // Date ticks: first, middle, last.
  const ticks = [
    points[0],
    points[Math.floor(points.length / 2)],
    points[points.length - 1],
  ];

  // Pick a couple of y-axis labels that show real view counts (not
  // sqrt-scaled). Quarter / max so the founder sees actual numbers.
  const yMaxRealViews = Math.pow(yMaxScaled, 2);
  const yLabels = [0, yMaxRealViews / 4, yMaxRealViews];

  const open = (url) => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div>
      <Legend medianViews={medianViews} />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", overflow: "visible" }}
        preserveAspectRatio="none"
      >
        {/* Axes */}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + innerH}
              stroke="var(--border)" strokeWidth={1} />
        <line x1={PAD.l} y1={PAD.t + innerH} x2={PAD.l + innerW} y2={PAD.t + innerH}
              stroke="var(--border)" strokeWidth={1} />

        {/* Median reference line */}
        {medianViews != null && scale(medianViews) <= yMaxScaled && (
          <>
            <line
              x1={PAD.l} y1={yAt(medianViews)}
              x2={PAD.l + innerW} y2={yAt(medianViews)}
              stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="4 4"
            />
            <text
              x={PAD.l + innerW - 4}
              y={yAt(medianViews) - 4}
              textAnchor="end" fontSize={9}
              fontFamily="'JetBrains Mono', monospace"
              fill="#F59E0B" fontWeight={700}
            >
              your median
            </text>
          </>
        )}

        {/* Dots */}
        {points.map((p, i) => {
          const aboveMedian = medianViews != null && p.views >= medianViews;
          return (
            <circle
              key={i}
              cx={xAt(p.ts)}
              cy={yAt(p.views)}
              r={3.5}
              fill={aboveMedian ? "#10B981" : "#0082FA"}
              fillOpacity={0.85}
              stroke={aboveMedian ? "#10B981" : "#0082FA"}
              strokeWidth={1}
              style={{ cursor: p.url ? "pointer" : "default" }}
              onClick={() => open(p.url)}
            >
              <title>{`${fmtCount(p.views)} views · ${new Date(p.ts).toLocaleDateString("en-AU")}\n${p.caption}`}</title>
            </circle>
          );
        })}

        {/* X ticks */}
        {ticks.map((t, i) => (
          <text
            key={i}
            x={xAt(t.ts)}
            y={PAD.t + innerH + 14}
            textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
            fill="var(--muted)"
          >
            {fmtDateShort(t.ts)}
          </text>
        ))}

        {/* Y ticks */}
        {yLabels.map((v, i) => {
          const y = i === 0 ? PAD.t + innerH : yAt(v);
          return (
            <text
              key={i}
              x={PAD.l - 6}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={9}
              fontFamily="'JetBrains Mono', monospace"
              fill="var(--muted)"
            >
              {fmtCount(Math.round(v))}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function Legend({ medianViews }) {
  return (
    <div style={{
      display: "flex", gap: 14, marginBottom: 8, flexWrap: "wrap",
      fontSize: 10, color: "var(--muted)",
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 4, background: "#10B981",
          display: "inline-block",
        }}/>
        Above your median
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 4, background: "#0082FA",
          display: "inline-block",
        }}/>
        Below your median
      </span>
      {medianViews != null && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{
            width: 14, height: 0,
            borderTop: "1.5px dashed #F59E0B",
            display: "inline-block",
          }}/>
          Median ({fmtCount(medianViews)} views)
        </span>
      )}
    </div>
  );
}

function fmtDateShort(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
