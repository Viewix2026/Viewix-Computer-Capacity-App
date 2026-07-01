// Founders Dashboard — revenue tracker, north-star metrics, Attio deals sync,
// per-month revenue chart, plus Data + AI Learnings sub-tabs (which are their
// own components). Only the dual-founder role (password "Sanpel") sees this tab.

import { useState, useEffect, useMemo } from "react";
import { BTN, SALE_VIDEO_TYPES, DEFAULT_SALE_PRICING, DEFAULT_SALE_THANKYOU } from "../config";
import { pct, fmtCur } from "../utils";
import { authFetch, fbSet } from "../firebase";
import { FoundersData } from "./FoundersData";
import { FoundersLearnings } from "./FoundersLearnings";
import { FoundersGoals } from "./FoundersGoals";
import { FoundersAdvisor } from "./FoundersAdvisor";
import { BuyerJourney } from "./BuyerJourney";
import { TranscriptInsightsLab } from "./TranscriptInsightsLab";
import { FoundersProfitability } from "./FoundersProfitability";
import { TimeLogAnalytics } from "./TimeLogAnalytics";
import { FoundersRequests } from "./FoundersRequests";
import { computeFoundersMetrics } from "../../api/_attio-metrics";
import { buildMonthlyWonSeries } from "../lib/revenueSeries";
import { computeForecast, computeTTM } from "../lib/revenueForecast";
import {
  CATEGORIES, CATEGORY_COLORS, ALL_FIELDS, formatValue,
} from "./foundersShared";

// ─── Monthly revenue chart ─────────────────────────────────────────
// Bars glow with the brand neon green (#10B981) at rest; the current
// month uses Viewix accent blue. Hovering a bar brightens it, scales
// it up slightly, and floats a tooltip card above it with the month
// label, revenue, growth vs last month, and growth vs same month
// last year.
function deltaPct(curr, prev) {
  if (prev == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}
function fmtPct(d) {
  if (d == null || !isFinite(d)) return "—";
  const sign = d >= 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}%`;
}
function pctColour(d) {
  if (d == null || !isFinite(d)) return "var(--muted)";
  return d >= 0 ? "#10B981" : "#F472B6";
}
function prevMonthKey(key) {
  const [y, m] = key.split("-").map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}
function lastYearKey(key) {
  const [y, m] = key.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}`;
}

function HoverTip({ m, prev, yoy }) {
  const dPrev = deltaPct(m.revenue, prev?.revenue);
  const dYoy = deltaPct(m.revenue, yoy?.revenue);
  return (
    <div style={{
      position: "absolute",
      bottom: "calc(100% + 16px)",
      left: "50%",
      transform: "translateX(-50%)",
      minWidth: 200,
      background: "var(--card)",
      border: "1px solid rgba(16,185,129,0.5)",
      borderRadius: 8,
      padding: "10px 14px",
      boxShadow: "0 10px 28px rgba(0,0,0,0.55), 0 0 18px rgba(16,185,129,0.25)",
      zIndex: 10,
      fontSize: 11,
      lineHeight: 1.5,
      whiteSpace: "nowrap",
      pointerEvents: "none",
      fontFamily: "inherit",
    }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>
        {m.label}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", color: "#10B981", fontSize: 18, fontWeight: 800, marginBottom: 8, letterSpacing: 0.3 }}>
        {fmtCur(m.revenue)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", marginBottom: 3 }}>
        <span>vs last month</span>
        <span style={{ color: pctColour(dPrev), fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", marginLeft: 12 }}>
          {fmtPct(dPrev)}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)" }}>
        <span>vs same month last year</span>
        <span style={{ color: pctColour(dYoy), fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", marginLeft: 12 }}>
          {fmtPct(dYoy)}
        </span>
      </div>
      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 6 }}>
        {m.count} deal{m.count === 1 ? "" : "s"}
      </div>
    </div>
  );
}

// Format a dollar value as "$1,234,567" — no cents. Used for the
// headline revenue numbers (YTD + target) where rounded thousands
// read more cleanly than the .00-suffixed fmtCur output.
function fmtCurNoCents(v) {
  const n = Math.round(Number(v) || 0);
  return `$${n.toLocaleString("en-AU")}`;
}

// ─── Ticker bar ─────────────────────────────────────────────────────
// Stock-ticker style strip that scrolls horizontally across the top
// of the Dashboard tab. Each entry shows a 3-letter "symbol", value,
// and a coloured arrow + delta. We render the entries TWICE in a row
// and animate -50% so the loop is seamless (no visible reset).
//
// Pulls from foundersData (north-star fields, current month) +
// foundersMetrics (latest two months for vs-last-month deltas).
function buildTickerEntries(foundersData, foundersMetrics) {
  // Find the two most recent months in foundersMetrics to compute
  // mom deltas for fields that have history.
  const sortedKeys = Object.keys(foundersMetrics || {}).sort().reverse();
  const latest = sortedKeys[0] ? foundersMetrics[sortedKeys[0]] : null;
  const prev = sortedKeys[1] ? foundersMetrics[sortedKeys[1]] : null;

  const fmt = (v, kind) => {
    if (v == null || !isFinite(v)) return "—";
    if (kind === "money") return fmtCur(v);
    if (kind === "pct") return `${(+v).toFixed(1)}%`;
    if (kind === "ratio") return `${(+v).toFixed(2)}x`;
    return String(v);
  };
  const delta = (curr, p) => {
    if (curr == null || p == null || p === 0) return null;
    return ((curr - p) / Math.abs(p)) * 100;
  };

  const entries = [];
  const push = (sym, value, kind, mom) => {
    entries.push({ sym, value: fmt(value, kind), delta: mom });
  };

  // North-star metrics from /foundersData (also driven by the Attio
  // Sync button). Best-effort vs-last-month using foundersMetrics.
  push("REV/MO",   foundersData?.monthlyRevenue,    "money", delta(latest?.monthlyRevenue, prev?.monthlyRevenue));
  push("YTD",      foundersData?.currentRevenue,    "money", null);
  push("TARGET",   foundersData?.revenueTarget,     "money", null);
  push("CLIENTS",  foundersData?.activeClients,     "num",   delta(latest?.activeClients, prev?.activeClients));
  push("RETAINER", foundersData?.avgRetainerValue,  "money", delta(latest?.avgRetainerValue, prev?.avgRetainerValue));
  push("PIPELINE", foundersData?.leadPipelineValue, "money", null);
  push("CLOSE",    foundersData?.closingRate,       "pct",   delta(latest?.closeRateCallToDeal, prev?.closeRateCallToDeal));
  push("CHURN",    foundersData?.churnRate,         "pct",   delta(latest?.retainerChurnRate, prev?.retainerChurnRate));
  push("LTV:CAC",  latest?.ltvCacRatio,             "ratio", delta(latest?.ltvCacRatio, prev?.ltvCacRatio));
  push("CPL",      latest?.cpl,                     "money", delta(latest?.cpl, prev?.cpl));

  return entries.filter(e => e.value !== "—");
}
function FoundersTicker({ foundersData, foundersMetrics }) {
  const entries = buildTickerEntries(foundersData, foundersMetrics);
  if (entries.length === 0) return null;
  // Render the row twice for the seamless -50% loop.
  const renderRow = (keyPrefix) => entries.map((e, i) => {
    // For CHURN and CPL "lower is better" — invert delta colour.
    const inverted = e.sym === "CHURN" || e.sym === "CPL";
    const positive = e.delta != null && (inverted ? e.delta < 0 : e.delta > 0);
    const negative = e.delta != null && (inverted ? e.delta > 0 : e.delta < 0);
    const arrow = e.delta == null ? "" : (e.delta >= 0 ? "↗" : "↘");
    const colour = positive ? "#10B981" : negative ? "#F472B6" : "var(--muted)";
    return (
      <span key={`${keyPrefix}-${i}`} style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "0 28px",
        whiteSpace: "nowrap",
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 12,
      }}>
        <span style={{ color: "var(--muted)", fontWeight: 700, letterSpacing: 0.6 }}>{e.sym}</span>
        <span style={{ color: "var(--fg)", fontWeight: 700 }}>{e.value}</span>
        {e.delta != null && (
          <>
            <span style={{ color: colour, fontSize: 13, fontWeight: 800 }}>{arrow}</span>
            <span style={{ color: colour, fontWeight: 700 }}>{Math.abs(e.delta).toFixed(2)}%</span>
          </>
        )}
        <span style={{ color: "rgba(255,255,255,0.06)" }}>·</span>
      </span>
    );
  });
  return (
    <div style={{
      width: "100%",
      overflow: "hidden",
      background: "linear-gradient(180deg, rgba(16,185,129,0.04), transparent)",
      borderTop: "1px solid var(--border)",
      borderBottom: "1px solid var(--border)",
      padding: "10px 0",
      marginBottom: 24,
      maskImage: "linear-gradient(90deg, transparent 0, black 60px, black calc(100% - 60px), transparent 100%)",
      WebkitMaskImage: "linear-gradient(90deg, transparent 0, black 60px, black calc(100% - 60px), transparent 100%)",
    }}>
      <div className="founders-ticker-track" style={{
        display: "inline-flex",
        whiteSpace: "nowrap",
      }}>
        {renderRow("a")}
        {renderRow("b")}
      </div>
    </div>
  );
}

// ─── Neon-styled metric card ────────────────────────────────────────
// Wraps a label + value (optional delta) in a card with a coloured
// glow ring matching the chart aesthetic. `tone` picks the colour
// family: green (default), blue (current month / target), pink
// (negative metrics like churn), amber (warning).
function NeonCard({ label, children, tone = "green", style = {} }) {
  const tones = {
    green:  { ring: "rgba(16,185,129,0.35)",   glow: "rgba(16,185,129,0.25)" },
    blue:   { ring: "rgba(0,130,250,0.40)",    glow: "rgba(0,130,250,0.28)" },
    pink:   { ring: "rgba(244,114,182,0.35)",  glow: "rgba(244,114,182,0.20)" },
    amber:  { ring: "rgba(245,158,11,0.35)",   glow: "rgba(245,158,11,0.18)" },
    violet: { ring: "rgba(139,92,246,0.38)",   glow: "rgba(139,92,246,0.22)" },
  };
  const t = tones[tone] || tones.green;
  return (
    <div style={{
      padding: "14px 18px",
      background: "var(--bg)",
      border: `1px solid ${t.ring}`,
      borderRadius: 10,
      boxShadow: `0 0 0 1px ${t.ring}, 0 0 18px ${t.glow}`,
      ...style,
    }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// ─── Forecast subtab ───────────────────────────────────────────────
// Interactive revenue scenario modelling. Pure math lives in
// src/lib/revenueForecast.js; this is the founder-only surface.
const SCENARIO_META = {
  flat:   { label: "Flat run-rate",   color: "#F59E0B" },
  trend:  { label: "Trend continues", color: "#10B981" },
  custom: { label: "Custom",          color: "#0082FA" },
};
const fmtPctSigned = g => `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%/mo`;
// Cumulative revenue milestones drawn as dotted reference lines on the
// all-time forecast chart (replaces the single annual-target line).
const MILESTONES = [2_000_000, 3_000_000, 5_000_000, 10_000_000];
const fmtMs = m => `$${m / 1e6}M`;

const TTM_COLOR = "#8B5CF6";
function ForecastChart({ fc, active, monthly, MONTH_NAMES, ttm, showTTM }) {
  const W = 820, H = 340, P = { t: 20, r: 16, b: 30, l: 64 };
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const { targetYear, horizonYear, currentRevenue, forwardBaseline } = fc;
  const now = new Date();
  const curMonth = now.getMonth();

  // ── Chart spans the business's first deal month → the chosen horizon. ──
  const keys = Object.keys(monthly);
  const startYear = keys.length
    ? Math.min(targetYear, ...keys.map(key => parseInt(key.slice(0, 4), 10)))
    : targetYear;
  const totalMonths = (horizonYear - startYear + 1) * 12;
  const yearOffset = (targetYear - startYear) * 12;   // months from chart start to Jan(targetYear)
  const daysInYear = 365;
  const dayOfYear = Math.floor((now - new Date(targetYear, 0, 0)) / 86400000);
  const todayX = yearOffset + (dayOfYear / daysInYear) * 12;

  // ── Continuous all-time cumulative history ──
  // Prior years plot at ACTUAL won revenue; the current year's increments are
  // scaled by k so the line lands exactly on the headline YTD at today (matches
  // the dashboard card). The current partial month is absorbed into that anchor.
  let ytdDealSum = 0;
  for (let m = 0; m <= curMonth; m++) ytdDealSum += monthly[`${targetYear}-${String(m + 1).padStart(2, "0")}`]?.revenue || 0;
  const k = ytdDealSum > 0 ? currentRevenue / ytdDealSum : 1;
  const scaled = ytdDealSum > 0 && Math.abs(k - 1) > 0.02;

  const histPts = [{ x: 0, y: 0 }];
  let cum = 0;
  for (let yr = startYear; yr < targetYear; yr++) {     // prior years, raw cumulative
    for (let m = 0; m < 12; m++) {
      cum += monthly[`${yr}-${String(m + 1).padStart(2, "0")}`]?.revenue || 0;
      histPts.push({ x: (yr - startYear) * 12 + m + 1, y: cum });
    }
  }
  const priorCum = cum;                                  // = prior-years total
  let yCum = 0;
  for (let m = 0; m < curMonth; m++) {                   // completed months this year
    yCum += monthly[`${targetYear}-${String(m + 1).padStart(2, "0")}`]?.revenue || 0;
    histPts.push({ x: yearOffset + m + 1, y: priorCum + yCum * k, actualCum: priorCum + yCum, shown: priorCum + yCum * k });
  }
  histPts.push({ x: todayX, y: forwardBaseline });       // anchor on all-time total at the headline YTD

  // ── Forward cumulative per active scenario, continuing from all-time. ──
  const fwdLines = Object.keys(SCENARIO_META).filter(key => active[key] && fc.scenarios[key]).map(key => {
    const sc = fc.scenarios[key];
    const pts = [{ x: todayX, y: forwardBaseline }];
    let c = forwardBaseline;
    sc.forwardMonthly.forEach((v, i) => { c += v; pts.push({ x: yearOffset + curMonth + 1 + i, y: c }); });
    return { key, color: SCENARIO_META[key].color, pts };
  });

  // ── TTM (trailing-12-mo revenue) line — rolling annual run rate. ──
  const ttmPts = (showTTM && ttm?.points?.length)
    ? ttm.points.map(p => ({ x: (p.year - startYear) * 12 + p.monthIdx + 1, y: p.value }))
    : [];

  // ── Milestones: keep one aspirational line just above the data peak. ──
  const dataMax = Math.max(forwardBaseline, ...fwdLines.flatMap(l => l.pts.map(p => p.y)), ...histPts.map(p => p.y), 1);
  const nextMs = MILESTONES.find(m => m > dataMax);
  const yMax = (nextMs ? Math.max(dataMax, nextMs) : dataMax) * 1.06;
  const shownMilestones = MILESTONES.filter(m => m <= yMax);

  const X = mx => P.l + (mx / totalMonths) * cw;
  const Y = v => P.t + ch - (v / yMax) * ch;
  const path = pts => pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");

  // Y gridlines
  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (yMax / ticks) * i);
  const years = Array.from({ length: horizonYear - startYear + 1 }, (_, i) => startYear + i);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
        {gridVals.map((v, i) => (
          <g key={i}>
            <line x1={P.l} y1={Y(v)} x2={W - P.r} y2={Y(v)} stroke="var(--border)" strokeWidth="1" opacity="0.5" />
            <text x={P.l - 8} y={Y(v) + 4} textAnchor="end" fontSize="10" fill="var(--muted)" fontFamily="'JetBrains Mono',monospace">
              {v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`}
            </text>
          </g>
        ))}
        {/* Year axis labels + faint year boundaries */}
        {years.map(yr => {
          const mx = (yr - startYear) * 12;
          return (
            <g key={yr}>
              {yr > startYear && <line x1={X(mx)} y1={P.t} x2={X(mx)} y2={P.t + ch} stroke="var(--border)" strokeWidth="1" opacity="0.25" />}
              <text x={X(mx + 6)} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--muted)" fontWeight="600">{yr}</text>
            </g>
          );
        })}
        {/* Milestone lines (dotted) — faded when above the data peak */}
        {shownMilestones.map(m => (
          <g key={m}>
            <line x1={P.l} y1={Y(m)} x2={W - P.r} y2={Y(m)} stroke="#EF4444" strokeWidth="1.25" strokeDasharray="5 4" opacity={m > dataMax ? 0.4 : 0.7} />
            <text x={W - P.r} y={Y(m) - 5} textAnchor="end" fontSize="10" fill="#EF4444" fontWeight="700" opacity={m > dataMax ? 0.6 : 0.9}>{fmtMs(m)}</text>
          </g>
        ))}
        {/* Today marker */}
        <line x1={X(todayX)} y1={P.t} x2={X(todayX)} y2={P.t + ch} stroke="#F59E0B" strokeWidth="1" opacity="0.6" />
        <text x={X(todayX)} y={P.t - 6} textAnchor="middle" fontSize="9" fill="#F59E0B" fontWeight="700">today</text>
        {/* Historical line */}
        <path d={path(histPts)} fill="none" stroke="var(--fg)" strokeWidth="2.5" opacity="0.85" />
        {/* hover dots disclose scaled vs actual on the current-year segment */}
        {scaled && histPts.filter(p => p.actualCum != null).map((p, i) => (
          <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="6" fill="transparent">
            <title>{`Actual won cumulative ${fmtCur(p.actualCum)} → shown ${fmtCur(p.shown)} (current year scaled ×${k.toFixed(2)} to match headline YTD)`}</title>
          </circle>
        ))}
        {/* Forward scenario lines */}
        {fwdLines.map(l => (
          <path key={l.key} d={path(l.pts)} fill="none" stroke={l.color} strokeWidth="2.5"
            strokeDasharray="6 3" style={{ filter: `drop-shadow(0 0 4px ${l.color}88)` }} />
        ))}
        {/* TTM line — solid violet, rolling 12-mo revenue (an annual run rate,
            NOT cumulative). Sits low vs the all-time line; read it against the
            milestone lines: TTM crossing $2M = running at a $2M/yr pace. */}
        {ttmPts.length >= 2 && (
          <>
            <path d={path(ttmPts)} fill="none" stroke={TTM_COLOR} strokeWidth="2.25"
              style={{ filter: `drop-shadow(0 0 4px ${TTM_COLOR}88)` }} />
            <text x={X(ttmPts[ttmPts.length - 1].x) - 4} y={Y(ttmPts[ttmPts.length - 1].y) - 6}
              textAnchor="end" fontSize="9" fill={TTM_COLOR} fontWeight="700">TTM</text>
          </>
        )}
      </svg>
      {scaled && (
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
          Current year scaled ×{k.toFixed(2)} to match the headline YTD ({fmtCur(currentRevenue)} vs {fmtCur(ytdDealSum)} of dated won deals); prior years shown at actual. Hover a point for both.
        </div>
      )}
    </div>
  );
}

function ForecastTab({ attioDeals, foundersData }) {
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = useMemo(() => new Date(), []); // stable per mount so memos don't thrash
  const targetYear = now.getFullYear();
  const currentRevenue = foundersData?.currentRevenue || 0;
  const target = foundersData?.revenueTarget || 0;
  const dayOfYear = Math.floor((now - new Date(targetYear, 0, 0)) / 86400000);
  const yearProgress = dayOfYear / 365; // kept identical to the dashboard card (Codex #4 deferred)
  const projectedFlat = yearProgress > 0 ? currentRevenue / yearProgress : 0;

  // Recompute the won-deal series only when the deals change, not on slider drags.
  const series = useMemo(() => buildMonthlyWonSeries(attioDeals?.data || []), [attioDeals?.data]);
  const monthly = series.byKey;
  // Forward lines extend from the ALL-TIME cumulative at "today": prior years'
  // actual won revenue + the trusted headline YTD for the current year (so the
  // current partial month isn't double-counted against the forward run-rate).
  const forwardBaseline = useMemo(() => {
    let thisYearDated = 0;
    for (let m = 0; m <= now.getMonth(); m++) thisYearDated += monthly[`${targetYear}-${String(m + 1).padStart(2, "0")}`]?.revenue || 0;
    const priorTotal = Math.max(0, series.allTimeTotal - thisYearDated);
    return priorTotal + currentRevenue;
  }, [monthly, series.allTimeTotal, now, targetYear, currentRevenue]);

  // Trailing-12-mo revenue (rolling annual run rate). Independent of the
  // scenario math; recompute only when the deal series changes.
  const ttm = useMemo(() => computeTTM(monthly, now), [monthly, now]);

  const [horizonYear, setHorizonYear] = useState(targetYear);
  const [customGrowthPct, setCustomGrowthPct] = useState(null); // null → seed from trend
  const [customTouched, setCustomTouched] = useState(false);
  const [active, setActive] = useState({ flat: true, trend: true, custom: true });
  const [showTTM, setShowTTM] = useState(false); // TTM line is opt-in (the checkbox)

  const fc = useMemo(() => computeForecast({
    byKey: monthly, currentRevenue, projectedFlat, target, forwardBaseline,
    now, horizonYear, customGrowthPct: customGrowthPct ?? 0,
  }), [monthly, currentRevenue, projectedFlat, target, forwardBaseline, now, horizonYear, customGrowthPct]);

  // Seed the custom slider to the detected trend rate until the founder drags it.
  // Re-seeds if a later Attio sync changes the trend (Codex #6: no stale value).
  useEffect(() => {
    if (!customTouched && fc.available && fc.trend.enabled) {
      setCustomGrowthPct(Math.round(fc.trend.projectedG * 1000) / 10);
    }
  }, [customTouched, fc.available, fc.trend?.enabled, fc.trend?.projectedG]);

  if (!fc.available) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12, fontSize: 13 }}>
        {fc.reason}
      </div>
    );
  }

  const customPctVal = customGrowthPct ?? 0;
  const scenarioCard = (key) => {
    const sc = fc.scenarios[key];
    if (!sc || !active[key]) return null;
    const meta = SCENARIO_META[key];
    const gOut = key === "flat" ? 0 : key === "custom" ? fc.customG : fc.trend.projectedG;
    const capped = key === "trend" && fc.trend.isCapped;
    return (
      <NeonCard key={key} label={meta.label} tone={key === "flat" ? "amber" : key === "trend" ? "green" : "blue"}>
        <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: meta.color }}>{fmtCur(sc.landing)}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {fmtPctSigned(gOut)}{capped ? ` (raw ${fmtPctSigned(fc.trend.rawG)})` : ""}
        </div>
        {(() => {
          // Milestone progress for the all-time landing at the chosen horizon.
          const cleared = MILESTONES.filter(m => m <= sc.landing);
          const next = MILESTONES.find(m => m > sc.landing);
          return (
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 6, color: cleared.length ? "#10B981" : "var(--muted)" }}>
              {cleared.length ? `Clears ${fmtMs(cleared[cleared.length - 1])}` : `Below ${fmtMs(MILESTONES[0])}`}
              {next && <span style={{ color: "var(--muted)", fontWeight: 500 }}> · {fmtCur(next - sc.landing)} to {fmtMs(next)}</span>}
            </div>
          );
        })()}
      </NeonCard>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Revenue Forecast</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            All-time revenue trajectory and where it heads under different growth assumptions. Flat = current pace; Trend = your actual recent growth continued. Dotted lines mark cumulative milestones.
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          {[targetYear, targetYear + 1, targetYear + 2, targetYear + 3, targetYear + 4, targetYear + 5].map(y => (
            <button key={y} onClick={() => setHorizonYear(y)} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: horizonYear === y ? "var(--card)" : "transparent", color: horizonYear === y ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {y === targetYear ? `End ${y}` : y}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, marginBottom: 16 }}>
        <ForecastChart fc={fc} active={active} monthly={monthly} MONTH_NAMES={MONTH_NAMES} ttm={ttm} showTTM={showTTM} />
        {/* Scenario toggles */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
          {Object.keys(SCENARIO_META).map(key => {
            const disabled = key === "trend" && !fc.trend.enabled;
            return (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: disabled ? "var(--muted)" : "var(--fg)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}>
                <input type="checkbox" checked={active[key] && !disabled} disabled={disabled} onChange={e => setActive(a => ({ ...a, [key]: e.target.checked }))} />
                <span style={{ width: 12, height: 3, background: SCENARIO_META[key].color, borderRadius: 2, display: "inline-block" }} />
                {SCENARIO_META[key].label}
              </label>
            );
          })}
          {(() => {
            const disabled = !(ttm?.points?.length >= 2);
            return (
              <label title={disabled ? "Needs 12+ months of history" : "Rolling 12-month revenue (annual run rate)"}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: disabled ? "var(--muted)" : "var(--fg)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, marginLeft: 4, paddingLeft: 14, borderLeft: "1px solid var(--border)" }}>
                <input type="checkbox" checked={showTTM && !disabled} disabled={disabled} onChange={e => setShowTTM(e.target.checked)} />
                <span style={{ width: 12, height: 3, background: TTM_COLOR, borderRadius: 2, display: "inline-block" }} />
                Trailing 12-mo (TTM)
              </label>
            );
          })()}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        {Object.keys(SCENARIO_META).map(scenarioCard)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: ttm.available ? "1fr 1fr 1fr" : "1fr 1fr", gap: 12, marginBottom: 16 }}>
        {ttm.available && (
          <NeonCard label="Trailing 12-mo revenue" tone="violet">
            <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: TTM_COLOR }}>{fmtCur(ttm.current)}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              rolling annual run rate{ttm.yoy != null ? ` · ${ttm.yoy >= 0 ? "+" : ""}${(ttm.yoy * 100).toFixed(0)}% YoY` : ""}
              {ttm.youngHistory ? " · <12mo history, still filling" : ""}
            </div>
          </NeonCard>
        )}
        <NeonCard label="Required / month to hit target" tone="pink">
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fc.requiredMonthly != null ? fmtCur(fc.requiredMonthly) : "—"}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{fc.requiredMonthly != null ? `over the remaining ${fc.monthsRemaining} month${fc.monthsRemaining === 1 ? "" : "s"} of ${targetYear}` : "set a revenue target to see this"}</div>
        </NeonCard>
        <NeonCard label="Detected trend" tone="green">
          {fc.trend.enabled ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#10B981" }}>
                {fmtPctSigned(fc.trend.rawG)}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                from {fc.trend.windowLabel}{fc.trend.isCapped ? ` · projected capped at ${fmtPctSigned(fc.trend.projectedG)}` : ""}
                {fc.trend.outlierHeavy ? " · ⚠ one big month is driving this" : ""}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{fc.trend.reason}</div>
          )}
        </NeonCard>
      </div>

      {/* Custom growth control */}
      <div style={{ padding: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>Custom growth rate</span>
          <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: SCENARIO_META.custom.color }}>{fmtPctSigned(fc.customG)}</span>
        </div>
        <input type="range" min={-30} max={30} step={0.5} value={customPctVal}
          onChange={e => { setCustomGrowthPct(parseFloat(e.target.value)); setCustomTouched(true); }}
          style={{ width: "100%", accentColor: SCENARIO_META.custom.color }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
          <span>−30%/mo</span><span>0</span><span>+30%/mo</span>
        </div>
      </div>
    </div>
  );
}

// ─── SparkChart: one tiny chart per logged metric ──────────────────
// Self-scaled Y-axis, minimal X-axis ticks, soft area fill in the
// category colour. Top-right number aggregates: "sum" for flow
// metrics (cumulative), "latest" otherwise (last non-empty point).
function SparkChart({ entries, field }) {
  if (!entries || entries.length < 2) return null;
  const W = 280, H = 110, PAD = { t: 14, r: 10, b: 22, l: 36 };
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
  const colour = CATEGORY_COLORS[field.category] || "#8B5CF6";

  const pairs = entries
    .map(e => ({ v: parseFloat(e[field.key]), date: e.date }))
    .filter(p => !Number.isNaN(p.v));
  const vals = pairs.map(p => p.v);

  if (vals.length === 0) {
    return (
      <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, minHeight: H + 38 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>{field.label}</div>
        <div style={{ fontSize: 10, color: "var(--muted)", height: H, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 8px", fontStyle: "italic" }}>
          No data in this window — try <strong style={{ fontWeight: 700 }}>All time</strong>
        </div>
      </div>
    );
  }

  if (vals.length < 2) {
    const single = pairs[0];
    const fmtDateSingle = (iso) => {
      if (!iso) return "";
      const [y, m] = iso.split("-");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${months[parseInt(m) - 1] || m} '${y?.slice(2)}`;
    };
    return (
      <div style={{ background: "var(--bg)", border: `1px solid ${colour}33`, borderRadius: 8, padding: 12, minHeight: H + 38, display: "flex", flexDirection: "column", boxShadow: `0 0 12px ${colour}1A` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>{field.label}</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: colour, fontFamily: "'JetBrains Mono',monospace", textShadow: `0 0 10px ${colour}55` }}>
            {formatValue(single.v, field.unit)}
          </div>
          <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>
            {fmtDateSingle(single.date)} · 1 month logged
          </div>
        </div>
      </div>
    );
  }

  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const pad = (maxV - minV) * 0.12 || Math.abs(maxV) * 0.12 || 1;
  const yMin = minV - pad;
  const yMax = maxV + pad;
  const range = yMax - yMin || 1;

  const xStep = cw / (entries.length - 1);
  const yScale = v => PAD.t + ch - ((v - yMin) / range) * ch;
  const xPos = i => PAD.l + i * xStep;

  const points = entries.map((e, i) => {
    const v = parseFloat(e[field.key]);
    if (Number.isNaN(v)) return null;
    return { x: xPos(i), y: yScale(v), v, date: e.date };
  }).filter(Boolean);

  const dPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaD = `${dPath} L${points[points.length - 1].x},${PAD.t + ch} L${points[0].x},${PAD.t + ch} Z`;

  const yTick = (v) => {
    const abs = Math.abs(v);
    if (field.unit === "$") {
      if (abs >= 1000) return `$${(v / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
      return `$${Math.round(v)}`;
    }
    if (field.unit === "%") return `${v.toFixed(0)}%`;
    if (field.unit === "x") return `${v.toFixed(1)}×`;
    if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return `${Math.round(v)}`;
  };

  const fmtDate = (iso) => {
    if (!iso) return "";
    const [y, m] = iso.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m) - 1] || m} '${y?.slice(2)}`;
  };

  let displayVal = null;
  let displaySuffix = null;
  if (field.agg === "sum") {
    const sum = entries.reduce((acc, e) => {
      const v = parseFloat(e?.[field.key]);
      return Number.isNaN(v) ? acc : acc + v;
    }, 0);
    if (vals.length > 0) {
      displayVal = sum;
      displaySuffix = "total";
    }
  } else {
    for (let i = entries.length - 1; i >= 0; i--) {
      const v = entries[i]?.[field.key];
      if (v !== "" && v != null && !Number.isNaN(parseFloat(v))) {
        displayVal = v;
        break;
      }
    }
  }
  const formatted = formatValue(displayVal, field.unit);

  return (
    <div style={{
      background: "var(--bg)",
      border: `1px solid ${colour}33`,
      borderRadius: 8,
      padding: 12,
      // Soft per-card neon ring matching the chart category — keeps
      // the trend grid visually consistent with the rest of the
      // dashboard's "live trading" surface.
      boxShadow: `0 0 0 1px ${colour}22, 0 0 14px ${colour}1A`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={field.label}>
          {field.label}
        </div>
        {formatted && (
          <div style={{ fontSize: 12, fontWeight: 700, color: colour, fontFamily: "'JetBrains Mono',monospace", flexShrink: 0, textAlign: "right", textShadow: `0 0 8px ${colour}55` }}>
            {formatted}
            {displaySuffix && (
              <div style={{ fontSize: 9, fontWeight: 500, color: "var(--muted)", marginTop: -1, textShadow: "none" }}>{displaySuffix}</div>
            )}
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        <defs>
          <linearGradient id={`grad-${field.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.32" />
            <stop offset="100%" stopColor={colour} stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${field.key}`}>
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <text x={PAD.l - 4} y={PAD.t + 4} fill="#61728C" fontSize={8} textAnchor="end" fontFamily="'JetBrains Mono',monospace">{yTick(yMax)}</text>
        <text x={PAD.l - 4} y={PAD.t + ch} fill="#61728C" fontSize={8} textAnchor="end" fontFamily="'JetBrains Mono',monospace">{yTick(yMin)}</text>
        <line x1={PAD.l} y1={PAD.t + ch} x2={W - PAD.r} y2={PAD.t + ch} stroke="#222D40" strokeWidth={1} />
        <path d={areaD} fill={`url(#grad-${field.key})`} />
        <path d={dPath} fill="none" stroke={colour} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" filter={`url(#glow-${field.key})`} />
        {points.length > 0 && (
          <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={3.5} fill={colour} stroke="#0A0E17" strokeWidth={1.5} filter={`url(#glow-${field.key})`} />
        )}
        <text x={PAD.l} y={H - 6} fill="#61728C" fontSize={8} textAnchor="start" fontFamily="'JetBrains Mono',monospace">
          {fmtDate(entries[0].date)}
        </text>
        <text x={W - PAD.r} y={H - 6} fill="#61728C" fontSize={8} textAnchor="end" fontFamily="'JetBrains Mono',monospace">
          {fmtDate(entries[entries.length - 1].date)}
        </text>
      </svg>
    </div>
  );
}

// ─── Trend grid: small-multiples sparkline gallery ─────────────────
// Mounted on the Dashboard tab below the existing KPIs / bar chart.
// Year filter narrows the X axis; category chips show/hide whole
// groups. Reads from /foundersMetrics (logged via the Data tab's
// monthly form).
function FoundersTrendGrid({ metrics }) {
  const [yearFilter, setYearFilter] = useState("last12");
  const [visibleCats, setVisibleCats] = useState(
    Object.fromEntries(CATEGORIES.map(c => [c.key, true]))
  );

  const entries = Object.values(metrics || {}).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (entries.length < 1) return null;

  const filtered = entries.filter(e => {
    if (!yearFilter || yearFilter === "all") return true;
    if (yearFilter === "last12") {
      const latestDate = entries[entries.length - 1]?.date;
      if (!latestDate) return true;
      const [ly, lm] = latestDate.split("-").map(Number);
      const cutoff = new Date(ly, lm - 12, 1);
      const [ey, em] = e.date.split("-").map(Number);
      return new Date(ey, em - 1, 1) >= cutoff;
    }
    return e.date.startsWith(yearFilter);
  });

  const years = Array.from(new Set(entries.map(e => e.date.split("-")[0]))).sort();
  const filterChips = [
    { key: "last12", label: "Last 12 months" },
    { key: "all",    label: "All time" },
    ...years.map(y => ({ key: y, label: y })),
  ];

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--fg)", letterSpacing: 0.2 }}>Trends</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            One line per logged metric. Each chart is scaled to its own range so the shape is always readable. Latest value (or window total for flow metrics) on the top right.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {filterChips.map(f => {
          const active = yearFilter === f.key;
          return (
            <button key={f.key} onClick={() => setYearFilter(f.key)}
              style={{
                padding: "5px 12px", borderRadius: 4, border: "none",
                background: active ? "var(--accent)" : "var(--bg)",
                color: active ? "#fff" : "var(--muted)",
                fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                boxShadow: active ? "0 0 10px rgba(0,130,250,0.35)" : "none",
              }}>
              {f.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
        {CATEGORIES.map(cat => {
          const catFields = ALL_FIELDS.filter(f => f.category === cat.key);
          if (!catFields.length) return null;
          const active = !!visibleCats[cat.key];
          const colour = CATEGORY_COLORS[cat.key];
          return (
            <button key={cat.key} onClick={() => setVisibleCats(p => ({ ...p, [cat.key]: !p[cat.key] }))}
              style={{
                padding: "4px 10px", borderRadius: 4, border: "none",
                background: active ? `${colour}20` : "var(--bg)",
                color: active ? colour : "var(--muted)",
                fontSize: 10, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit",
                boxShadow: active ? `0 0 8px ${colour}33` : "none",
              }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? colour : "var(--muted)", opacity: active ? 1 : 0.3, boxShadow: active ? `0 0 6px ${colour}` : "none" }} />
              {cat.label}
            </button>
          );
        })}
      </div>

      {filtered.length < 2 ? (
        <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          Not enough data points in the selected window. Widen the filter or wait for another month of data.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 18 }}>
          {CATEGORIES.map(cat => {
            if (!visibleCats[cat.key]) return null;
            const catFields = ALL_FIELDS.filter(f => f.category === cat.key);
            if (!catFields.length) return null;
            const colour = CATEGORY_COLORS[cat.key];
            return (
              <div key={cat.key}>
                <div style={{ fontSize: 11, fontWeight: 800, color: colour, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8, textShadow: `0 0 8px ${colour}55` }}>
                  {cat.label}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                  {catFields.map(f => (
                    <SparkChart key={f.key} entries={filtered} field={f} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MonthlyRevenueChart({ chronological, monthlyByKey, now, maxRev, monthlyTarget }) {
  const [hovered, setHovered] = useState(null);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 4, height: 170, padding: "12px 4px 0" }}>
        {chronological.map(([key, m]) => {
          const h = Math.max((m.revenue / maxRev) * 130, 4);
          const isCurrent = key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
          const isHovered = hovered === key;
          const baseColour = isCurrent ? "#0082FA" : "#10B981";
          const glowAlpha = isHovered ? "BB" : "55";
          const glowFar = isHovered ? "32px" : "12px";
          return (
            <div
              key={key}
              onMouseEnter={() => setHovered(key)}
              onMouseLeave={() => setHovered(null)}
              style={{
                flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
                gap: 3, minWidth: 0, position: "relative", cursor: "pointer",
                // Lift hovered column above neighbours so the tooltip
                // and glow aren't clipped by the next-bar's stacking.
                zIndex: isHovered ? 5 : 1,
              }}>
              <div style={{
                fontSize: isHovered ? 10 : 8, fontWeight: 800,
                color: isHovered ? baseColour : "var(--muted)",
                fontFamily: "'JetBrains Mono',monospace",
                whiteSpace: "nowrap", overflow: "hidden",
                transition: "all 0.15s",
                textShadow: isHovered ? `0 0 8px ${baseColour}66` : "none",
              }}>
                {fmtCur(m.revenue).replace("$", "")}
              </div>
              <div style={{
                width: isHovered ? "94%" : "82%",
                height: isHovered ? Math.round(h * 1.07) : h,
                background: baseColour,
                borderRadius: "4px 4px 0 0",
                // Layered glow: tight halo + soft outer bloom. Resting
                // bars also get a subtle glow so the whole chart reads
                // as neon.
                boxShadow: `0 0 6px ${baseColour}, 0 0 ${glowFar} ${baseColour}${glowAlpha}`,
                transition: "all 0.15s ease-out",
              }}/>
              <div style={{
                fontSize: 7, color: isHovered ? baseColour : "var(--muted)",
                fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap",
                fontWeight: isHovered ? 800 : 500,
                transition: "all 0.15s",
              }}>
                {m.label.split(" ").join("\n")}
              </div>
              {isHovered && (
                <HoverTip
                  m={m}
                  prev={monthlyByKey[prevMonthKey(key)]}
                  yoy={monthlyByKey[lastYearKey(key)]}
                />
              )}
            </div>
          );
        })}
        {monthlyTarget > 0 && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 4,
              right: 4,
              bottom: (monthlyTarget / maxRev) * 130,
              borderTop: "2px dotted #F59E0B",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <span style={{
              position: "absolute",
              right: 0,
              top: -14,
              fontSize: 9,
              fontWeight: 800,
              color: "#F59E0B",
              fontFamily: "'JetBrains Mono',monospace",
              background: "var(--card)",
              padding: "1px 4px",
              borderRadius: 3,
              letterSpacing: 0.3,
              whiteSpace: "nowrap",
            }}>
              TARGET {fmtCur(monthlyTarget)}/mo
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Founders({
  foundersData, setFoundersData,
  foundersGoals, setFoundersGoals,
  foundersMetrics, setFoundersMetrics,
  foundersTab, setFoundersTab,
  attioDeals, setAttioDeals,
  salePricing, setSalePricing,
  saleThankYou, setSaleThankYou,
  // Buyer Journey + Turnaround relocated here from the Accounts tab
  // (unified editor at Founders → Buyer Journey). Accounts is now
  // clients-only; timing data still reads from /turnaround via the
  // BuyerJourney Turnaround sub-tab.
  buyerJourney, setBuyerJourney,
  turnaround, setTurnaround,
  accounts,
  allTimeLogs, projects,
}) {
  const [attioLoading, setAttioLoading] = useState(false);
  const [revenueTableExpanded, setRevenueTableExpanded] = useState(false);
  // YTD revenue is hidden by default — clicked to reveal, click again
  // to re-hide. Default false so a casual glance over the founder's
  // shoulder doesn't expose the headline number.
  const [revenueVisible, setRevenueVisible] = useState(false);

  const REVENUE_TARGET = foundersData.revenueTarget || 3000000;
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
  const daysInYear = 365;
  const yearProgress = dayOfYear / daysInYear;

  const currentRevenue = foundersData.currentRevenue || 0;
  const revenueProgress = REVENUE_TARGET > 0 ? currentRevenue / REVENUE_TARGET : 0;
  // Projected full-year revenue if the YTD pace holds (linear
  // annualisation — YTD divided by the fraction of the year elapsed).
  const projectedRevenue = yearProgress > 0 ? currentRevenue / yearProgress : 0;
  // Gap between that projection and the target. Negative = on pace to
  // miss the goal; positive = on pace to beat it.
  const revenueDelta = projectedRevenue - REVENUE_TARGET;

  const updateMetric = (key, val) => setFoundersData(p => ({ ...p, [key]: val }));

  // ─── Attio sync: pulls all deals, auto-fills north-star metrics, caches in Firebase ───
  const syncAttio = () => {
    setAttioLoading(true);
    authFetch("/api/attio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "all_deals" }) })
      .then(r => r.json())
      .then(data => {
        const lastSyncedAt = new Date().toISOString();
        setAttioDeals({ ...data, lastSyncedAt });
        // Persist cache so data survives reloads. Same /attioCache path the
        // deal-won webhook writes to (admin SDK).
        if (data?.data) {
          fbSet("/attioCache", { data: data.data, total: data.total || data.data.length, lastSyncedAt, lastSyncTrigger: "manual" });
        }
        // Auto-calculate north-star metrics. Shared helper is also used
        // by api/webhook-deal-won.js so the manual button and the
        // webhook's auto-populate can't drift in what they compute.
        if (data?.data) {
          const m = computeFoundersMetrics(data.data, now);
          setFoundersData(p => ({
            ...p,
            monthlyRevenue:    m.monthlyRevenue    || p.monthlyRevenue,
            activeClients:     m.activeClients     || p.activeClients,
            avgRetainerValue:  m.avgRetainerValue  || p.avgRetainerValue,
            leadPipelineValue: m.leadPipelineValue || p.leadPipelineValue,
            closingRate:       m.closingRate       || p.closingRate,
          }));
          // updateRevenue was deleted in d766eb9 but this call site was
          // missed — the ReferenceError was swallowed by the .catch below,
          // so Sync from Attio never updated the YTD headline.
          if (m.ytdRevenue > 0) updateMetric("currentRevenue", m.ytdRevenue);
        }
        setAttioLoading(false);
      })
      .catch(e => { console.error("Attio fetch error:", e); setAttioLoading(false); });
  };

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Founders Dashboard</span>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          {[{ key: "dashboard", label: "Dashboard" }, { key: "forecast", label: "Forecast" }, { key: "goals", label: "Goals" }, { key: "advisor", label: "Advisor" }, { key: "data", label: "Data" }, { key: "profitability", label: "Profitability" }, { key: "learnings", label: "AI Learnings" }, { key: "insightsLab", label: "Transcript Insights Lab" }, { key: "timeLogAnalytics", label: "Time Log Analytics" }, { key: "thankyou", label: "Thank-You Pages" }, { key: "buyerJourney", label: "Buyer Journey" }, { key: "requests", label: "Requests" }].map(t => (
            <button key={t.key} onClick={() => setFoundersTab(t.key)} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: foundersTab === t.key ? "var(--card)" : "transparent", color: foundersTab === t.key ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
          ))}
        </div>
      </div>
      {/* Buyer Journey renders outside the maxWidth wrapper so its
          horizontal scroll can stretch the full viewport width — the
          swim-lane view is meaningless if capped at 1200px. */}
      {foundersTab === "buyerJourney" && (
        <BuyerJourney
          data={buyerJourney || {}} onChange={setBuyerJourney}
          turnaround={turnaround} setTurnaround={setTurnaround}
          accounts={accounts}
        />
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px", display: foundersTab === "buyerJourney" ? "none" : "block" }}>

        {foundersTab === "dashboard" && (<>

          {/* Revenue Tracker — YTD on the left (the bigger neon green
              number you actually want to see), Target on the right as
              the goalpost. Producer asked to flip from the previous
              target-left arrangement. */}
          <div style={{ marginBottom: 20, padding: "24px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 24 }}>
              <div>
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                  Current Revenue (YTD)
                </div>
                <div
                  onClick={() => setRevenueVisible(v => !v)}
                  title={revenueVisible ? "Click to hide" : "Click to reveal"}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    cursor: "pointer", userSelect: "none",
                    fontSize: 36, fontWeight: 800,
                    fontFamily: "'JetBrains Mono',monospace",
                    color: revenueVisible ? "#10B981" : "var(--muted)",
                    textShadow: revenueVisible ? "0 0 16px rgba(16,185,129,0.45)" : "none",
                    letterSpacing: revenueVisible ? 0 : 2,
                    minHeight: 48,
                    width: 280, maxWidth: "100%",
                  }}>
                  {revenueVisible ? fmtCurNoCents(currentRevenue) : "HIDDEN"}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Revenue Target {now.getFullYear()}</div>
                <div style={{
                  fontSize: 28, fontWeight: 800,
                  fontFamily: "'JetBrains Mono',monospace",
                  color: "var(--fg)",
                  width: 240, textAlign: "right", maxWidth: "100%",
                }}>
                  {fmtCurNoCents(REVENUE_TARGET)}
                </div>
              </div>
            </div>
            {/* Projected full-year revenue — pulled out of the bottom
                grid and centered above the progress bar as the headline
                "where we'll land at this pace" figure. */}
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              <NeonCard label="Projected (Full Year)" tone="amber" style={{ textAlign: "center", minWidth: 220 }}>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fmtCur(projectedRevenue)}</div>
              </NeonCard>
            </div>
            {/* Progress bar */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Progress: {pct(revenueProgress)}</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Year: {pct(yearProgress)} through</span>
              </div>
              <div style={{ width: "100%", height: 20, background: "var(--bar-bg)", borderRadius: 10, overflow: "hidden", position: "relative" }}>
                <div style={{
                  width: `${Math.min(revenueProgress * 100, 100)}%`, height: "100%",
                  borderRadius: 10,
                  background: revenueProgress >= yearProgress ? "#10B981" : "#EF4444",
                  boxShadow: revenueProgress >= yearProgress
                    ? "0 0 12px rgba(16,185,129,0.6), 0 0 24px rgba(16,185,129,0.35)"
                    : "0 0 12px rgba(239,68,68,0.55)",
                  transition: "width 0.4s",
                }} />
                <div style={{ position: "absolute", left: `${yearProgress * 100}%`, top: 0, bottom: 0, width: 2, background: "#F59E0B", boxShadow: "0 0 6px rgba(245,158,11,0.8)" }} title="Where you should be" />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <NeonCard label="Gap to Target" tone={revenueDelta >= 0 ? "green" : "pink"}>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: revenueDelta >= 0 ? "#10B981" : "#F472B6", textShadow: revenueDelta >= 0 ? "0 0 10px rgba(16,185,129,0.4)" : "0 0 10px rgba(244,114,182,0.4)" }}>{revenueDelta >= 0 ? "+" : ""}{fmtCur(revenueDelta)}</div>
              </NeonCard>
              <NeonCard label="Monthly Run Rate Needed" tone="blue">
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fmtCur(Math.max(0, (REVENUE_TARGET - currentRevenue) / (12 - now.getMonth())))}</div>
              </NeonCard>
            </div>
          </div>

          {/* KPI Ticker — sits BETWEEN the revenue tracker and the
              north-star metrics so the producer sees the headline
              numbers first, then the live ticker as a transition into
              the broader metrics surface below. Pauses on hover. */}
          <FoundersTicker foundersData={foundersData} foundersMetrics={foundersMetrics} />

          {/* North Star Metrics — neon-glow cards in the same green
              palette as the chart bars so the dashboard reads as a
              consistent "live trading" surface. Churn flips to pink
              since lower is better there. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 20 }}>
            {[
              { key: "monthlyRevenue",    label: "Monthly Revenue",    prefix: "$", tone: "green" },
              { key: "activeClients",     label: "Active Clients",     prefix: "",  tone: "blue"  },
              { key: "avgRetainerValue",  label: "Avg Retainer Value", prefix: "$", tone: "green" },
              { key: "clientChurnRate",   label: "Client Churn Rate",  suffix: "%", tone: "pink"  },
              { key: "leadPipelineValue", label: "Lead Pipeline Value",prefix: "$", tone: "amber" },
              { key: "closingRate",       label: "Close Rate (3mo)",   suffix: "%", tone: "green" },
            ].map(m => (
              <NeonCard key={m.key} label={m.label} tone={m.tone}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {m.prefix && <span style={{ fontSize: 14, color: "var(--muted)" }}>{m.prefix}</span>}
                  <input type="number" value={foundersData[m.key] || ""} onChange={e => updateMetric(m.key, parseFloat(e.target.value) || 0)} placeholder="0" style={{ fontSize: 24, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px dashed #3A4558", outline: "none", width: "100%" }} />
                  {m.suffix && <span style={{ fontSize: 14, color: "var(--muted)" }}>{m.suffix}</span>}
                </div>
              </NeonCard>
            ))}
          </div>
          {attioDeals?.data && <div style={{ fontSize: 11, color: "var(--accent)", marginTop: -12, marginBottom: 16, padding: "0 4px" }}>✓ Auto-populated from Attio. Values are still editable.</div>}

          {/* Attio Monthly Revenue */}
          <div style={{ marginBottom: 20, padding: "20px 24px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Monthly Revenue (Attio)</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  All time deal revenue by month
                  {attioDeals?.lastSyncedAt && (() => {
                    const ms = Date.now() - new Date(attioDeals.lastSyncedAt).getTime();
                    const mins = Math.floor(ms / 60000);
                    const hrs = Math.floor(mins / 60);
                    const days = Math.floor(hrs / 24);
                    const label = days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 0 ? `${mins}m ago` : "just now";
                    return <span style={{ marginLeft: 8, color: "var(--accent)" }}>· Cached {label}</span>;
                  })()}
                </div>
              </div>
              <button onClick={syncAttio} style={{ ...BTN, background: "var(--accent)", color: "white", padding: "8px 16px" }}>{attioLoading ? "Syncing..." : "Sync from Attio"}</button>
            </div>
            {attioDeals?.data ? (() => {
              // Monthly won-deal series — shared with the Forecast tab so the two
              // can't drift on "what counts as won revenue" (see src/lib/revenueSeries).
              const { byKey: monthly, sortedDesc: sorted, allTimeTotal, dealCount } = buildMonthlyWonSeries(attioDeals.data);
              const maxRev = Math.max(...sorted.map(([_, m]) => m.revenue), 1);
              const monthlyTarget = (foundersData?.revenueTarget || 0) / 12;
              const chartMax = Math.max(maxRev, monthlyTarget, 1);

              // Current calendar month figures (same keying as the monthly map).
              const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
              const curMonth = monthly[curKey] || { revenue: 0, count: 0 };
              const curLabel = now.toLocaleDateString("en-AU", { month: "long", year: "numeric" });

              return (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>This Month · {curLabel}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                    <NeonCard label="Revenue" tone="green">
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#10B981", textShadow: "0 0 12px rgba(16,185,129,0.4)" }}>{fmtCur(curMonth.revenue)}</div>
                    </NeonCard>
                    <NeonCard label="Deals" tone="blue">
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{curMonth.count}</div>
                    </NeonCard>
                    <NeonCard label="Avg Deal Size" tone="amber">
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{curMonth.count > 0 ? fmtCur(curMonth.revenue / curMonth.count) : "$0"}</div>
                    </NeonCard>
                  </div>

                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>All Time</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
                    <NeonCard label="All Time Revenue" tone="green">
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#10B981", textShadow: "0 0 12px rgba(16,185,129,0.4)" }}>{fmtCur(allTimeTotal)}</div>
                    </NeonCard>
                    <NeonCard label="Total Deals" tone="blue">
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{dealCount}</div>
                    </NeonCard>
                    <NeonCard label="Avg Deal Size" tone="amber">
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{dealCount > 0 ? fmtCur(allTimeTotal / dealCount) : "$0"}</div>
                    </NeonCard>
                  </div>

                  {/* Bar chart — neon glow, hover-to-magnify, popover
                      with month / sales / vs-last-month / YoY deltas. */}
                  {sorted.length > 0 && (
                    <MonthlyRevenueChart
                      chronological={sorted.slice(0, 24).reverse()}
                      monthlyByKey={monthly}
                      now={now}
                      maxRev={chartMax}
                      monthlyTarget={monthlyTarget}
                    />
                  )}

                  {/* Monthly table */}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead><tr>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left" }}>Month</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right" }}>Revenue</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "center" }}>Deals</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right" }}>Avg Deal</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left", width: "40%" }}></th>
                      </tr></thead>
                      <tbody>{(revenueTableExpanded ? sorted : sorted.slice(0, 4)).map(([key, m]) => {
                        const barW = maxRev > 0 ? Math.max((m.revenue / maxRev) * 100, 2) : 0;
                        return (
                          <tr key={key}>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", color: "var(--fg)", fontWeight: 600 }}>{m.label}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#10B981", fontWeight: 700 }}>{fmtCur(m.revenue)}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center", fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{m.count}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "var(--muted)" }}>{fmtCur(m.count > 0 ? m.revenue / m.count : 0)}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}><div style={{ width: `${barW}%`, height: 8, background: "#10B981", borderRadius: 4, opacity: 0.5 }} /></td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                    {sorted.length > 4 && <button onClick={() => setRevenueTableExpanded(!revenueTableExpanded)} style={{ width: "100%", padding: "10px", background: "transparent", border: "none", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>{revenueTableExpanded ? `Show less ▴` : `Show all ${sorted.length} months ▾`}</button>}
                  </div>
                  {attioDeals.data.length > 0 && sorted.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>Deals found but no revenue values detected. Field mapping may need adjusting.</div>}
                </div>
              );
            })() : attioDeals?.error ? (
              <div style={{ padding: "16px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.2)" }}>
                <div style={{ fontSize: 12, color: "#EF4444", fontWeight: 600 }}>Attio connection error</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{attioDeals.error}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Check the api/attio.js serverless function</div>
              </div>
            ) : (
              <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", background: "var(--bg)", borderRadius: 8 }}>
                <div style={{ fontSize: 13 }}>Click "Sync from Attio" to pull monthly revenue data</div>
              </div>
            )}
          </div>

          {/* Trend grid — every logged metric, grouped by category,
              filtered by year/window. Moved here from the Data tab so
              all the visualisations live together on the Dashboard. */}
          <FoundersTrendGrid metrics={foundersMetrics} />
        </>)}

        {foundersTab === "forecast" && <ForecastTab attioDeals={attioDeals} foundersData={foundersData} />}
        {foundersTab === "goals" && <FoundersGoals foundersGoals={foundersGoals} setFoundersGoals={setFoundersGoals} foundersData={foundersData} />}
        {foundersTab === "advisor" && <FoundersAdvisor foundersData={foundersData} foundersMetrics={foundersMetrics} attioDeals={attioDeals} />}
        {foundersTab === "data" && <FoundersData metrics={foundersMetrics} setMetrics={setFoundersMetrics} />}
        {foundersTab === "learnings" && <FoundersLearnings />}
        {foundersTab === "insightsLab" && <TranscriptInsightsLab />}
        {foundersTab === "profitability" && <FoundersProfitability />}
        {foundersTab === "timeLogAnalytics" && <TimeLogAnalytics allTimeLogs={allTimeLogs} projects={projects} />}
        {foundersTab === "thankyou" && <ThankYouEditor saleThankYou={saleThankYou} setSaleThankYou={setSaleThankYou} />}
        {foundersTab === "requests" && <FoundersRequests />}
        {/* Buyer Journey is rendered above the maxWidth wrapper to allow
            full-width horizontal scroll — see top of this component. */}
      </div>
    </>
  );
}

// Sale pricing editor now lives under the Sale tab — see
// src/components/SalePricingEditor.jsx. Moved out of Founders because
// closers / leads benefit from seeing the defaults while creating a
// sale; edit access is still gated to founders only.

// Per-package thank-you content shown on the branded payment page after the
// customer's deposit clears. One shared bookingUrl at the top (same kickoff
// meeting for everyone) + per-tier welcome video URL + next-steps copy.
// Persisted to /saleThankYou in the same bulk-write from App.jsx.
function ThankYouEditor({ saleThankYou, setSaleThankYou }) {
  const ty = saleThankYou || DEFAULT_SALE_THANKYOU;
  const [expanded, setExpanded] = useState(null); // videoType:tier currently open

  const updateBooking = (url) => setSaleThankYou({ ...ty, bookingUrl: url });
  const updateEmbed = (val) => setSaleThankYou({ ...ty, bookingEmbed: !!val });
  const updateSlot = (videoType, tier, field, value) => {
    const packages = ty.packages || {};
    const vtSlot = packages[videoType] || {};
    const tierSlot = vtSlot[tier] || { videoUrl: "", nextStepsCopy: "" };
    setSaleThankYou({
      ...ty,
      packages: {
        ...packages,
        [videoType]: {
          ...vtSlot,
          [tier]: { ...tierSlot, [field]: value },
        },
      },
    });
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)", marginBottom: 4 }}>Thank-You Pages</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>What the customer sees after their deposit clears. Booking link is shared; welcome video + next-steps copy is per-package.</div>
      </div>

      {/* Shared booking URL */}
      <div style={{ marginBottom: 20, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
          Kickoff Booking URL (shared across all packages)
        </label>
        <input type="url" value={ty.bookingUrl || ""} onChange={e => updateBooking(e.target.value)}
          placeholder="https://tidycal.com/... or calendly.com/... or cal.com/..."
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none" }} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 12, color: "var(--fg)", cursor: "pointer" }}>
          <input type="checkbox" checked={ty.bookingEmbed !== false} onChange={e => updateEmbed(e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer" }} />
          <span>
            <strong>Embed calendar inline</strong> on the thank-you page (recommended — higher booking conversion)
          </span>
        </label>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
          Inline embed works with TidyCal, Calendly, Cal.com and SavvyCal. Other providers fall back to a button that opens the URL in a new tab.
        </div>
      </div>

      {/* Per-package accordion */}
      <div style={{ display: "grid", gap: 12 }}>
        {SALE_VIDEO_TYPES.map(vt => (
          <div key={vt.key} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>
              {vt.label}
            </div>
            <div style={{ padding: "8px 0" }}>
              {vt.packages.map(p => {
                const key = `${vt.key}:${p.key}`;
                const isOpen = expanded === key;
                const slot = ty.packages?.[vt.key]?.[p.key] || { videoUrl: "" };
                // hasContent now only tracks videoUrl — the per-tier
                // next-steps copy field was retired.
                const hasContent = !!slot.videoUrl?.trim();
                return (
                  <div key={p.key} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <button
                      onClick={() => setExpanded(isOpen ? null : key)}
                      style={{ width: "100%", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "transparent", border: "none", color: "var(--fg)", cursor: "pointer", textAlign: "left" }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        {p.label}
                        {!hasContent && <span style={{ marginLeft: 8, fontSize: 10, color: "#F59E0B", fontWeight: 700 }}>NOT SET</span>}
                        {hasContent && <span style={{ marginLeft: 8, fontSize: 10, color: "#22C55E", fontWeight: 700 }}>✓</span>}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>{isOpen ? "−" : "+"}</span>
                    </button>
                    {isOpen && (
                      <div style={{ padding: "0 20px 16px" }}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
                          Welcome Video URL (YouTube or Loom)
                        </label>
                        <input type="url" value={slot.videoUrl || ""} onChange={e => updateSlot(vt.key, p.key, "videoUrl", e.target.value)}
                          placeholder="https://www.loom.com/share/... or https://youtu.be/..."
                          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", marginBottom: 12 }} />

                        {/* Per-package "Next Steps Copy" removed — the
                            Studio thank-you page now has a universal
                            "What happens next" block driven by its
                            own hardcoded 3-step sequence, so the
                            founder-editable text per tier isn't used
                            on the live page any more. Existing
                            nextStepsCopy values remain in Firebase
                            for auditability; they just aren't
                            editable or rendered. */}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(0,130,250,0.08)", border: "1px solid rgba(0,130,250,0.25)", borderRadius: 8, fontSize: 12, color: "var(--muted)" }}>
        Changes auto-save. Rendered live on /s/... payment pages once the deposit clears.
      </div>
    </div>
  );
}
