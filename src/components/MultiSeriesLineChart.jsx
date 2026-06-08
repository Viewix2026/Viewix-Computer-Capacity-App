// src/components/MultiSeriesLineChart.jsx
//
// Hand-rolled SVG multi-series line chart (no chart library — matches the
// codebase convention, see EngagementChart). Plots one connected line per
// series over a shared, continuous x-axis; null y-values break the line into
// a gap rather than drawing a misleading zero. A single transparent overlay
// drives a nearest-x hover tooltip listing every series at that x.
//
// Pure presentation: it renders precomputed {weeks, series} from
// buildWeeklySeries — no maths beyond pixel scaling.

import { useState } from "react";

const W = 640;
const PAD = { l: 44, r: 16, t: 14, b: 30 };

const fmtH = (h) => `${(h || 0).toFixed(1)}h`;
// axis tick labels: add a 2nd decimal when the step is sub-0.1h so small
// increments don't all render as "0.0h".
const fmtTickH = (h, step) => `${(h || 0).toFixed(step < 0.1 ? 2 : 1)}h`;
const fmtWeek = (key) => {
  if (!key) return "";
  const d = new Date(key + "T00:00:00");
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};

// "Nice" y-axis: rounds the data max up to a clean ceiling and returns evenly
// spaced increment values (1/2/5 × 10ⁿ) so the axis reads in round numbers.
function niceAxis(dataMax) {
  if (!(dataMax > 0)) return { ticks: [0, 0.5], max: 0.5, step: 0.5 };
  const rawStep = dataMax / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const max = Math.ceil(dataMax / step) * step;
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return { ticks, max, step };
}

export function MultiSeriesLineChart({ weeks, series, colorFor, height = 240, yLabel = "avg edit h / video" }) {
  const [hover, setHover] = useState(null); // hovered week index
  const [hidden, setHidden] = useState(() => new Set()); // categories toggled off via legend
  const toggle = (cat) => setHidden((prev) => {
    const next = new Set(prev);
    next.has(cat) ? next.delete(cat) : next.add(cat);
    return next;
  });

  if (!weeks || weeks.length < 2) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--muted)", fontSize: 12, lineHeight: 1.6, border: "1px dashed var(--border)", borderRadius: 8 }}>
        Not enough weeks of data to draw a trend yet — need at least 2 weeks of completed edits.
        The line fills in as more weeks accrue.
      </div>
    );
  }

  const H = height;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  // Only the toggled-on lines drive the render AND the y-axis scale, so
  // hiding an outlier category (e.g. a spiky Corporate week) rescales the
  // chart to make the remaining lines readable.
  const visible = series.filter((s) => !hidden.has(s.category));
  // Only true if a category that ACTUALLY exists in the current series is
  // hidden — guards against a phantom "reset" from stale hidden entries.
  const hasCurrentHidden = series.some((s) => hidden.has(s.category));
  const allY = visible.flatMap((s) => s.points.map((p) => p.y)).filter((y) => y != null);
  const yAxis = niceAxis(Math.max(...allY, 0));
  const yMax = yAxis.max;
  const xLabelEvery = Math.max(1, Math.ceil(weeks.length / 8)); // thin x labels if many weeks

  const xAt = (i) => PAD.l + (weeks.length === 1 ? innerW / 2 : (i / (weeks.length - 1)) * innerW);
  const yAt = (y) => PAD.t + innerH - (y / yMax) * innerH;

  // Build a gap-aware path: start a new subpath after each null.
  const pathFor = (pts) => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      if (p.y == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"} ${xAt(p.x).toFixed(1)} ${yAt(p.y).toFixed(1)} `;
      pen = true;
    }
    return d;
  };

  const onMove = (e) => {
    // Map client X → viewBox X off the whole SVG (it's width:100% with
    // preserveAspectRatio="none", so 0..W maps linearly to its client width).
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / innerW) * (weeks.length - 1));
    setHover(Math.max(0, Math.min(weeks.length - 1, i)));
  };

  return (
    <div>
      {/* Legend — click a category to show/hide its line */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
        {series.map((s) => {
          const off = hidden.has(s.category);
          return (
            <button
              key={s.category}
              onClick={() => toggle(s.category)}
              aria-pressed={!off}
              title={off ? "Show this line" : "Hide this line"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11,
                color: "var(--muted)", background: "transparent", border: "1px solid var(--border)",
                borderRadius: 999, padding: "3px 10px", cursor: "pointer",
                opacity: off ? 0.4 : 1, textDecoration: off ? "line-through" : "none",
              }}
            >
              <span style={{ width: 16, height: 3, borderRadius: 2, background: colorFor(s.category), display: "inline-block", opacity: off ? 0.5 : 1 }} />
              {s.category} <span style={{ opacity: 0.6 }}>· n={s.n}</span>
            </button>
          );
        })}
        {hasCurrentHidden && (
          <button onClick={() => setHidden(new Set())} style={{ fontSize: 11, color: "var(--accent)", background: "transparent", border: "none", cursor: "pointer", padding: "3px 4px" }}>
            reset
          </button>
        )}
      </div>

      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible" }} preserveAspectRatio="none">
          {/* axes */}
          <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + innerH} stroke="var(--border)" strokeWidth={1} />
          <line x1={PAD.l} y1={PAD.t + innerH} x2={PAD.l + innerW} y2={PAD.t + innerH} stroke="var(--border)" strokeWidth={1} />

          {/* y gridlines + increment labels */}
          {yAxis.ticks.map((t, i) => (
            <g key={`y${i}`}>
              {i > 0 && <line x1={PAD.l} y1={yAt(t)} x2={PAD.l + innerW} y2={yAt(t)} stroke="var(--border)" strokeWidth={1} strokeOpacity={0.4} strokeDasharray="2 3" />}
              <text x={PAD.l - 6} y={yAt(t)} textAnchor="end" dominantBaseline="middle" fontSize={9} fontFamily="'JetBrains Mono',monospace" fill="var(--muted)">{fmtTickH(t, yAxis.step)}</text>
            </g>
          ))}
          {/* x gridlines + increment labels (one per week, labels thinned if many) */}
          {weeks.map((wk, i) => {
            const showLabel = i % xLabelEvery === 0 || i === weeks.length - 1;
            return (
              <g key={`x${i}`}>
                <line x1={xAt(i)} y1={PAD.t} x2={xAt(i)} y2={PAD.t + innerH} stroke="var(--border)" strokeWidth={1} strokeOpacity={0.22} />
                {showLabel && <text x={xAt(i)} y={PAD.t + innerH + 14} textAnchor={i === 0 ? "start" : i === weeks.length - 1 ? "end" : "middle"} fontSize={9} fontFamily="'JetBrains Mono',monospace" fill="var(--muted)">{fmtWeek(wk)}</text>}
              </g>
            );
          })}

          {/* hover guide line (only when something is plotted) */}
          {hover != null && visible.length > 0 && (
            <line x1={xAt(hover)} y1={PAD.t} x2={xAt(hover)} y2={PAD.t + innerH} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
          )}

          {/* series (only the toggled-on ones) */}
          {visible.map((s) => (
            <g key={s.category}>
              <path d={pathFor(s.points)} fill="none" stroke={colorFor(s.category)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.points.map((p) => p.y == null ? null : (
                <circle key={p.x} cx={xAt(p.x)} cy={yAt(p.y)} r={hover === p.x ? 4 : 2.5} fill={colorFor(s.category)} />
              ))}
            </g>
          ))}
          {visible.length === 0 && (
            <text x={PAD.l + innerW / 2} y={PAD.t + innerH / 2} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="var(--muted)">All lines hidden — click a category above to show it</text>
          )}

          {/* y-axis label */}
          <text x={PAD.l} y={PAD.t - 4} textAnchor="start" fontSize={9} fill="var(--muted)">{yLabel}</text>

          {/* transparent hover overlay */}
          <rect x={PAD.l} y={PAD.t} width={innerW} height={innerH} fill="transparent" style={{ cursor: "crosshair" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>

        {/* tooltip (suppressed when no lines are visible) */}
        {hover != null && visible.length > 0 && (
          <div style={{ position: "absolute", top: 0, left: `${(xAt(hover) / W) * 100}%`, transform: xAt(hover) > W / 2 ? "translateX(-105%)" : "translateX(5%)", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 11, pointerEvents: "none", boxShadow: "0 4px 16px rgba(0,0,0,0.18)", minWidth: 130, zIndex: 5 }}>
            <div style={{ fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Week of {fmtWeek(weeks[hover])}</div>
            {visible.map((s) => {
              const p = s.points[hover];
              return (
                <div key={s.category} style={{ display: "flex", justifyContent: "space-between", gap: 10, color: "var(--muted)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: colorFor(s.category), display: "inline-block" }} />
                    {s.category}
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>
                    {p && p.y != null ? `${fmtH(p.y)} (n=${p.n})` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
