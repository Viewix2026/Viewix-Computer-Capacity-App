// EngagementChart — hand-rolled SVG line chart.
//
// Two lines:
//   - The client's engagement rate per recent post (sorted by date).
//   - The competitor cohort's pooled median engagement rate — a flat
//     reference line so the founder can see at a glance where the
//     client sits vs the niche.
//
// No chart library. Per the plan: "Check first whether existing
// UIComponents or hand-rolled SVG/CSS is enough." For one chart with
// a single overlay line, SVG is cleaner than pulling in Recharts.
//
// All values rendered here are precomputed truth. The component
// neither computes a median nor a rate — it reads what
// recomputeClientAnalytics has already written.

import { useMemo } from "react";
import { fmtPct } from "../utils/displayFormatters";

export function EngagementChart({ videos, cohortMedian, height = 180 }) {
  // Flatten + sort client posts by timestamp.
  const points = useMemo(() => {
    const all = [];
    for (const [platform, group] of Object.entries(videos || {})) {
      for (const v of Object.values(group || {})) {
        if (!v?.post?.timestamp) continue;
        const snaps = v.snapshots || {};
        const dates = Object.keys(snaps).sort();
        if (!dates.length) continue;
        const latest = snaps[dates[dates.length - 1]];
        if (latest?.engagementRate == null) continue;
        all.push({
          ts: new Date(v.post.timestamp).getTime(),
          rate: latest.engagementRate,
          platform,
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
        Not enough data points yet — need at least 2 posts with engagement
        rate to draw the chart. Comes online after the second scrape.
      </div>
    );
  }

  // Chart layout. SVG viewBox is data-coordinates; we transform to
  // pixel-space via plain JS for line + dot positions.
  const W = 600;
  const H = height;
  const PAD = { l: 36, r: 12, t: 10, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const tsRange = Math.max(1, tsMax - tsMin);

  // Y range: client rates + cohort median; pad a bit so the line
  // never kisses the top edge.
  const allRates = points.map(p => p.rate);
  if (cohortMedian != null) allRates.push(cohortMedian);
  const yMin = 0;
  const yMax = Math.max(0.01, Math.max(...allRates) * 1.15);

  const xAt = (ts) => PAD.l + ((ts - tsMin) / tsRange) * innerW;
  const yAt = (rate) => PAD.t + innerH - (rate / yMax) * innerH;

  // Build the client line path.
  let path = "";
  points.forEach((p, i) => {
    const x = xAt(p.ts);
    const y = yAt(p.rate);
    path += `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
  });

  // Date ticks: first, middle, last.
  const ticks = [
    points[0],
    points[Math.floor(points.length / 2)],
    points[points.length - 1],
  ];

  return (
    <div>
      <Legend cohortMedian={cohortMedian} />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", overflow: "visible" }}
        preserveAspectRatio="none"
      >
        {/* Axes */}
        <line
          x1={PAD.l} y1={PAD.t}
          x2={PAD.l} y2={PAD.t + innerH}
          stroke="var(--border)" strokeWidth={1}
        />
        <line
          x1={PAD.l} y1={PAD.t + innerH}
          x2={PAD.l + innerW} y2={PAD.t + innerH}
          stroke="var(--border)" strokeWidth={1}
        />

        {/* Cohort median reference line */}
        {cohortMedian != null && cohortMedian <= yMax && (
          <>
            <line
              x1={PAD.l}
              y1={yAt(cohortMedian)}
              x2={PAD.l + innerW}
              y2={yAt(cohortMedian)}
              stroke="#F59E0B"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
            <text
              x={PAD.l + innerW - 4}
              y={yAt(cohortMedian) - 4}
              textAnchor="end"
              fontSize={9}
              fontFamily="'JetBrains Mono', monospace"
              fill="#F59E0B"
              fontWeight={700}
            >
              cohort median
            </text>
          </>
        )}

        {/* Client engagement-rate line */}
        <path d={path} fill="none" stroke="#0082FA" strokeWidth={2} strokeLinejoin="round" />

        {/* Dots */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xAt(p.ts)}
            cy={yAt(p.rate)}
            r={2.5}
            fill="#0082FA"
          />
        ))}

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

        {/* Y ticks: 0 + max */}
        <text
          x={PAD.l - 6}
          y={PAD.t + innerH}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={9}
          fontFamily="'JetBrains Mono', monospace"
          fill="var(--muted)"
        >
          0
        </text>
        <text
          x={PAD.l - 6}
          y={PAD.t}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={9}
          fontFamily="'JetBrains Mono', monospace"
          fill="var(--muted)"
        >
          {fmtPct(yMax / 100, 1)}
        </text>
      </svg>
    </div>
  );
}

function Legend({ cohortMedian }) {
  return (
    <div style={{
      display: "flex", gap: 14, marginBottom: 8,
      fontSize: 10, color: "var(--muted)",
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 14, height: 2, background: "#0082FA", display: "inline-block" }}/>
        Your engagement rate
      </span>
      {cohortMedian != null && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{
            width: 14, height: 0,
            borderTop: "1.5px dashed #F59E0B",
            display: "inline-block",
          }}/>
          Competitor cohort median
        </span>
      )}
    </div>
  );
}

function fmtDateShort(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
