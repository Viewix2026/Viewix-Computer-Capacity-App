// src/components/TimeLogAnalytics.jsx
//
// "Analytics" sub-view of the Time Logs tab. A current-state SNAPSHOT of
// how long each kind of video takes to edit and how much revisions add —
// NOT an over-time trend (native tracking is only ~5 weeks old; the trend
// view is deferred to v2, see docs/plans/time-log-analytics.md).
//
// All maths lives in the pure, tested src/timeLogStats.js. This component
// only shapes and renders precomputed truth.

import { useState, useMemo } from "react";
import { Metric } from "./UIComponents";
import { MultiSeriesLineChart } from "./MultiSeriesLineChart";
import { CAT_COLORS } from "../config";
import { todayKey } from "../utils";
import {
  buildProjectIndex,
  buildVideoFacts,
  summariseByCategory,
  summariseOverall,
  filterFactsByDays,
  buildWeeklySeries,
  computeDailyAllocations,
} from "../timeLogStats";

const PERIODS = [{ k: 0, label: "All" }, { k: 30, label: "Last 30d" }, { k: 90, label: "Last 90d" }];
const colorFor = (cat) => CAT_COLORS[cat] || "#94A3B8";
const fmtH = (h) => `${(h || 0).toFixed(1)}h`;
const fmtPct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—");

const mono = { fontFamily: "'JetBrains Mono',monospace" };
const sectionTitle = { fontSize: 13, fontWeight: 700, color: "var(--fg)", margin: "0 0 4px" };
const sectionSub = { fontSize: 11, color: "var(--muted)", margin: "0 0 14px" };

export function TimeLogAnalytics({ allTimeLogs, projects }) {
  const [days, setDays] = useState(0);
  const [adjusted, setAdjusted] = useState(true); // default to the paid-hours-adjusted view

  const { cats, overall, weekly } = useMemo(() => {
    const idx = buildProjectIndex(projects);
    const allocations = computeDailyAllocations(allTimeLogs || {});
    const all = buildVideoFacts(allTimeLogs || {}, idx, allocations);
    const f = filterFactsByDays(all, days, todayKey());
    // The line graph is the over-time view, so it always uses FULL history
    // (the period toggle scopes only the snapshot sections below it).
    return {
      cats: summariseByCategory(f, adjusted),
      overall: summariseOverall(f, adjusted),
      weekly: buildWeeklySeries(all, adjusted),
    };
  }, [allTimeLogs, projects, days, adjusted]);

  const editVideoN = weekly.series.reduce((s, x) => s + x.n, 0);
  const chartLabel = weekly.weeks.length
    ? `Full history · ${fmtDate(weekly.weeks[0])} – ${fmtDate(weekly.weeks[weekly.weeks.length - 1])} · ${editVideoN} edited videos`
    : "Full history";
  const snapshotLabel = `Completed videos · ${fmtDate(overall.firstDate)} – ${fmtDate(overall.lastDate)} · n=${overall.n}`;

  // headline: revision burden, worst (highest) first; n/a (null burden) sorts last.
  const burdenRows = [...cats].sort((a, b) => {
    if (a.revisionBurden == null && b.revisionBurden == null) return 0;
    if (a.revisionBurden == null) return 1;
    if (b.revisionBurden == null) return -1;
    return b.revisionBurden - a.revisionBurden;
  });
  const worstBurden = burdenRows.find((r) => r.revisionBurden > 0);
  const maxMedian = Math.max(0.01, ...cats.map((c) => c.medianEditH));
  const maxBurden = Math.max(1, ...cats.map((c) => c.revisionBurden || 0));

  const periodBar = (
    <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
      {PERIODS.map((p) => (
        <button key={p.k} onClick={() => setDays(p.k)}
          style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
            background: days === p.k ? "var(--card)" : "transparent", color: days === p.k ? "var(--fg)" : "var(--muted)" }}>
          {p.label}
        </button>
      ))}
    </div>
  );

  const modeBar = (
    <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
      {[{ k: true, label: "Adjusted" }, { k: false, label: "Logged" }].map((m) => (
        <button key={String(m.k)} onClick={() => setAdjusted(m.k)}
          title={m.k ? "Logged edit time + each task's share of unlogged paid hours" : "Raw reported time only"}
          style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
            background: adjusted === m.k ? "var(--card)" : "transparent", color: adjusted === m.k ? "var(--fg)" : "var(--muted)" }}>
          {m.label}
        </button>
      ))}
    </div>
  );
  const editLabel = adjusted ? "adjusted edit h / video" : "edit h / video";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {/* Toggles: Adjusted/Logged (affects all metrics) + period (scopes the snapshot) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {modeBar}
        {periodBar}
      </div>

      {/* Edit-time trend — the line graph (always full history) */}
      <div>
        <h3 style={sectionTitle}>Average {adjusted ? "adjusted " : ""}edit time per video, over time</h3>
        <p style={sectionSub}>
          Weekly trend, one line per category — each video plotted in the week its edit finished. {chartLabel}.
          {adjusted && " Adjusted = logged edit time + each task's share of unlogged paid hours (8h/day)."}
        </p>
        <MultiSeriesLineChart weeks={weekly.weeks} series={weekly.series} colorFor={colorFor} yLabel={editLabel} />
      </div>

      {overall.n === 0 ? (
        <div style={sectionSub}>No completed videos in the selected period — adjust the filter above for the snapshot breakdown.</div>
      ) : (<>
      {/* Snapshot scope */}
      <div style={{ fontSize: 11, color: "var(--muted)", ...mono }}>{snapshotLabel}</div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Metric label="Completed Videos" value={overall.n} sub="edit/revision tracked" />
        <Metric label={`Median ${adjusted ? "Adj. " : ""}Edit / Video`} value={fmtH(overall.medianEditH)} sub={`mean ${fmtH(overall.meanEditH)}`} />
        <Metric label="Revision Rate" value={fmtPct(overall.revisionRate)} sub="videos needing revisions" />
        <Metric label="Revision Burden" value={fmtPct(overall.revisionBurden)} sub="revision ÷ edit hours" accent="#F87700" />
      </div>

      {/* Edit time by category */}
      <div>
        <h3 style={sectionTitle}>{adjusted ? "Adjusted edit" : "Edit"} time by category</h3>
        <p style={sectionSub}>Median {editLabel} (bar). Mean shown alongside — the gap reveals long-tail jobs.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {cats.map((c) => (
            <div key={c.category} style={{ display: "grid", gridTemplateColumns: "150px 1fr 150px", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>
                {c.category} <span style={{ color: "var(--muted)", fontWeight: 500 }}>· n={c.n}</span>
              </div>
              <div style={{ background: "var(--bar-bg)", borderRadius: 6, height: 22, overflow: "hidden" }}>
                <div style={{ width: `${(c.medianEditH / maxMedian) * 100}%`, height: "100%", background: colorFor(c.category), borderRadius: 6, minWidth: 2, transition: "width 0.3s" }} />
              </div>
              <div style={{ fontSize: 12, color: "var(--fg)", textAlign: "right", ...mono }}>
                <strong>{fmtH(c.medianEditH)}</strong>
                <span style={{ color: "var(--muted)" }}> · mean {fmtH(c.meanEditH)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Revision burden — headline */}
      <div>
        <h3 style={sectionTitle}>Revision burden by category</h3>
        <p style={sectionSub}>
          Revision hours as a share of edit hours (logged, unaffected by the Adjusted toggle) — the pricing/process signal.
          {worstBurden && (
            <> Heaviest: <strong style={{ color: "#F87700" }}>{worstBurden.category} ({fmtPct(worstBurden.revisionBurden)})</strong>.</>
          )}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {burdenRows.map((c) => {
            const isWorst = worstBurden && c.category === worstBurden.category;
            return (
              <div key={c.category} style={{ display: "grid", gridTemplateColumns: "150px 1fr 230px", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>
                  {isWorst && <span title="heaviest revision burden">🚩 </span>}{c.category}
                </div>
                <div style={{ background: "var(--bar-bg)", borderRadius: 6, height: 18, overflow: "hidden" }}>
                  <div style={{ width: `${((c.revisionBurden || 0) / maxBurden) * 100}%`, height: "100%", background: isWorst ? "#F87700" : "#F8770088", borderRadius: 6, minWidth: c.revisionBurden ? 2 : 0, transition: "width 0.3s" }} />
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "right", ...mono }}>
                  <strong style={{ color: "var(--fg)" }}>{fmtPct(c.revisionBurden)}</strong>
                  {" · "}edit {fmtH(c.editHPerVideoLogged)} · rev {fmtH(c.revisionHPerVideo)} · {fmtPct(c.revisionRate)} revised
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Spread (five-number summary) */}
      <div>
        <h3 style={sectionTitle}>{adjusted ? "Adjusted edit-time" : "Edit-time"} spread by category</h3>
        <p style={sectionSub}>Five-number summary of {editLabel} (min · p25 · median · p75 · p90).</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cats.map((c) => (
            <div key={c.category} style={{ display: "grid", gridTemplateColumns: "150px 1fr", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>{c.category}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", ...mono }}>
                {fmtH(c.min)} · {fmtH(c.p25)} · <strong style={{ color: "var(--fg)" }}>{fmtH(c.medianEditH)}</strong> · {fmtH(c.p75)} · {fmtH(c.p90)}
                {c.outliers > 0 && <span style={{ color: "#F87700" }}>  · {c.outliers} outlier{c.outliers > 1 ? "s" : ""}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
      </>)}
    </div>
  );
}
