import { useState, useEffect, useMemo, Fragment } from "react";
import { Logo } from "./Logo";
import { CSS, BTN, TH } from "../config";
import { fmtCur } from "../utils";

/* ============================================================
   Funnel definitions — mirror the Viewix Master ROAS sheet.
   Each funnel has an interleaved `sections` layout: inputs and
   calculated stages appear in the order they flow in the xlsx.
   ============================================================ */

const UNIVERSAL_INPUTS = [
  { key: "dailyBudget",  label: "Daily Ad Budget", kind: "cur", hint: "Your daily ad spend" },
  { key: "productPrice", label: "Product Price",   kind: "cur", hint: "Average order / deal value" },
];

const FUNNELS = {
  meta1: {
    id: "meta1",
    label: "1-Step Funnel (Meta)",
    // Industry-standard defaults for a Meta B2C direct-response funnel
    defaults: {
      dailyBudget: 525, productPrice: 380,
      cpm: 25, ctr: 0.015, optIn: 0.10, contactRate: 0.70, closeRate: 0.20,
    },
    sections: [
      { name: "Clicks", rows: [
        { type: "stage", key: "spend",       label: "Ad Spend",       kind: "cur" },
        { type: "input", key: "cpm",         label: "CPM",            kind: "cur", hint: "Cost per 1,000 impressions. B2C $20-$30, B2B $30-$40" },
        { type: "stage", key: "impressions", label: "Impressions",    kind: "int" },
        { type: "input", key: "ctr",         label: "CTR",            kind: "pct", hint: "<1% weak, 1-2% good, 2-4% great" },
        { type: "stage", key: "clicks",      label: "Clicks",         kind: "int", costFrom: "spend" },
      ]},
      { name: "Conversions", rows: [
        { type: "input", key: "optIn",       label: "Opt-In %",       kind: "pct", hint: "10% average, 40% great" },
        { type: "stage", key: "leads",       label: "Leads Captured", kind: "int", costFrom: "spend" },
        { type: "input", key: "contactRate", label: "Contact Rate",   kind: "pct", hint: "Of 10 leads, how many answer" },
        { type: "stage", key: "qualified",   label: "Qualified Leads",kind: "int" },
      ]},
      { name: "Close", rows: [
        { type: "input", key: "closeRate",   label: "Close Rate",     kind: "pct", hint: "Of 10 contacted, how many buy" },
        { type: "stage", key: "deals",       label: "Deals",          kind: "int", costFrom: "spend" },
        { type: "stage", key: "revenue",     label: "Revenue",        kind: "cur" },
      ]},
    ],
    calc: i => {
      const spend       = { monthly: i.dailyBudget*30, annual: i.dailyBudget*365 };
      const impressions = { monthly: i.cpm>0?1000*(spend.monthly/i.cpm):0, annual: i.cpm>0?1000*(spend.annual/i.cpm):0 };
      const clicks      = { monthly: impressions.monthly*i.ctr, annual: impressions.annual*i.ctr };
      const leads       = { monthly: clicks.monthly*i.optIn, annual: clicks.annual*i.optIn };
      const qualified   = { monthly: leads.monthly*i.contactRate, annual: leads.annual*i.contactRate };
      const deals       = { monthly: Math.round(qualified.monthly*i.closeRate), annual: Math.round(qualified.annual*i.closeRate) };
      const revenue     = { monthly: deals.monthly*i.productPrice, annual: deals.annual*i.productPrice };
      return { spend, impressions, clicks, leads, qualified, deals, revenue };
    },
  },
  meta2: {
    id: "meta2",
    label: "2-Step Funnel (Meta)",
    // Industry-standard defaults for a Meta lead-magnet → booking → show → close funnel
    defaults: {
      dailyBudget: 120, productPrice: 340,
      cpm: 25, ctr: 0.015, optIn: 0.25, bookingRate: 0.20, showRate: 0.60, closeRate: 0.25,
    },
    sections: [
      { name: "Clicks", rows: [
        { type: "stage", key: "spend",       label: "Ad Spend",       kind: "cur" },
        { type: "input", key: "cpm",         label: "CPM",            kind: "cur", hint: "Cost per 1,000 impressions. B2C $20-$30, B2B $30-$40" },
        { type: "stage", key: "impressions", label: "Impressions",    kind: "int" },
        { type: "input", key: "ctr",         label: "CTR",            kind: "pct", hint: "<1% weak, 1-2% good, 2-4% great" },
        { type: "stage", key: "clicks",      label: "Clicks",         kind: "int", costFrom: "spend" },
      ]},
      { name: "Conversions", rows: [
        { type: "input", key: "optIn",       label: "Opt-In %",       kind: "pct", hint: "20% avg for a lead magnet, 40% great" },
        { type: "stage", key: "leads",       label: "Leads Captured", kind: "int", costFrom: "spend" },
        { type: "input", key: "bookingRate", label: "Booking %",      kind: "pct", hint: "10% average, 30% great" },
        { type: "stage", key: "bookings",    label: "Bookings",       kind: "int", costFrom: "spend" },
      ]},
      { name: "Close", rows: [
        { type: "input", key: "showRate",    label: "Show Rate",      kind: "pct", hint: "30% bad, up to 75% achievable" },
        { type: "stage", key: "showed",      label: "Showed Leads",   kind: "int", costFrom: "spend" },
        { type: "input", key: "closeRate",   label: "Close Rate",     kind: "pct", hint: "Of 10 who show, how many buy" },
        { type: "stage", key: "deals",       label: "Deals",          kind: "int", costFrom: "spend" },
        { type: "stage", key: "revenue",     label: "Revenue",        kind: "cur" },
      ]},
    ],
    calc: i => {
      const spend       = { monthly: i.dailyBudget*30, annual: i.dailyBudget*365 };
      const impressions = { monthly: i.cpm>0?1000*(spend.monthly/i.cpm):0, annual: i.cpm>0?1000*(spend.annual/i.cpm):0 };
      const clicks      = { monthly: impressions.monthly*i.ctr, annual: impressions.annual*i.ctr };
      const leads       = { monthly: clicks.monthly*i.optIn, annual: clicks.annual*i.optIn };
      const bookings    = { monthly: leads.monthly*i.bookingRate, annual: leads.annual*i.bookingRate };
      const showed      = { monthly: bookings.monthly*i.showRate, annual: bookings.annual*i.showRate };
      const deals       = { monthly: Math.round(showed.monthly*i.closeRate), annual: Math.round(showed.annual*i.closeRate) };
      const revenue     = { monthly: deals.monthly*i.productPrice, annual: deals.annual*i.productPrice };
      return { spend, impressions, clicks, leads, bookings, showed, deals, revenue };
    },
  },
  google1: {
    id: "google1",
    label: "1-Step Funnel (Google)",
    defaults: {
      dailyBudget: 30, productPrice: 1000,
      cpc: 4, optIn: 0.10, contactRate: 0.70, closeRate: 0.20,
    },
    sections: [
      { name: "Clicks", rows: [
        { type: "stage", key: "spend",  label: "Ad Spend", kind: "cur" },
        { type: "input", key: "cpc",    label: "Avg CPC",  kind: "cur", hint: "Use Google Keyword Planner to estimate" },
        { type: "stage", key: "clicks", label: "Clicks",   kind: "int" },
      ]},
      { name: "Conversions", rows: [
        { type: "input", key: "optIn",       label: "Opt-In %",        kind: "pct", hint: "10% average, 40% great" },
        { type: "stage", key: "leads",       label: "Leads Captured",  kind: "int", costFrom: "spend" },
        { type: "input", key: "contactRate", label: "Contact Rate",    kind: "pct", hint: "Of 10 leads, how many answer" },
        { type: "stage", key: "qualified",   label: "Qualified Leads", kind: "int" },
      ]},
      { name: "Close", rows: [
        { type: "input", key: "closeRate", label: "Close Rate", kind: "pct", hint: "Of 10 contacted, how many buy" },
        { type: "stage", key: "deals",     label: "Deals",      kind: "int", costFrom: "spend" },
        { type: "stage", key: "revenue",   label: "Revenue",    kind: "cur" },
      ]},
    ],
    calc: i => {
      const spend     = { monthly: i.dailyBudget*30, annual: i.dailyBudget*365 };
      const clicks    = { monthly: i.cpc>0?spend.monthly/i.cpc:0, annual: i.cpc>0?spend.annual/i.cpc:0 };
      const leads     = { monthly: clicks.monthly*i.optIn, annual: clicks.annual*i.optIn };
      const qualified = { monthly: leads.monthly*i.contactRate, annual: leads.annual*i.contactRate };
      const deals     = { monthly: Math.round(qualified.monthly*i.closeRate), annual: Math.round(qualified.annual*i.closeRate) };
      const revenue   = { monthly: deals.monthly*i.productPrice, annual: deals.annual*i.productPrice };
      return { spend, clicks, leads, qualified, deals, revenue };
    },
  },
};

function computeResult(funnelId, inputs) {
  const f = FUNNELS[funnelId];
  const stages = f.calc(inputs);
  const summary = {
    monthlyRevenue: stages.revenue.monthly,
    annualRevenue:  stages.revenue.annual,
    monthlySpend:   stages.spend.monthly,
    annualSpend:    stages.spend.annual,
    monthlyProfit:  stages.revenue.monthly - stages.spend.monthly,
    annualProfit:   stages.revenue.annual  - stages.spend.annual,
    roas:           stages.spend.annual > 0 ? stages.revenue.annual / stages.spend.annual : 0,
    deals:          stages.deals.annual,
  };
  return { stages, summary };
}

/* ============================================================
   URL-hash state sharing (encode/decode)
   ============================================================ */

function encodeState(state){
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(state)))); }
  catch { return ""; }
}
function decodeState(hash){
  try {
    if (!hash) return null;
    const clean = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!clean) return null;
    const obj = JSON.parse(decodeURIComponent(escape(atob(clean))));
    if (!obj || !obj.funnel || !obj.inputs || !FUNNELS[obj.funnel]) return null;
    return obj;
  } catch { return null; }
}

/* ============================================================
   Formatting
   ============================================================ */

const fmtInt = v => {
  if (!isFinite(v) || v === 0) return "0";
  if (v >= 1000) return Math.round(v).toLocaleString("en-AU");
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
};
const fmtVal = (v, kind) => kind === "cur" ? fmtCur(v || 0) : fmtInt(v || 0);
const fmtCost = v => {
  if (!isFinite(v) || v <= 0) return "-";
  if (v >= 100) return fmtCur(v);
  return v.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/* ============================================================
   ROAS Tachometer Gauge (SVG)
   ============================================================ */

function RoasGauge({ roas }) {
  const MAX = 10;
  const safeRoas = isFinite(roas) ? Math.max(roas, 0) : 0;
  const clamped = Math.min(safeRoas, MAX);
  const pinned = safeRoas > MAX;

  // Geometry: semi-circle from left (-90°) through top (0°) to right (+90°)
  const cx = 160, cy = 150, r = 108;
  const START = -90, END = 90;
  const sweep = END - START;
  const valueToAngle = v => START + (v / MAX) * sweep;

  // Polar (angle 0 = up, positive = clockwise) → cartesian
  const polar = (angle, radius = r) => {
    const rad = (angle - 90) * Math.PI / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  };

  const arcPath = (a1, a2, radius = r) => {
    const [x1, y1] = polar(a1, radius);
    const [x2, y2] = polar(a2, radius);
    const largeArc = Math.abs(a2 - a1) > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
  };

  const zones = [
    { from: 0, to: 1,  color: "#EF4444" }, // losing money
    { from: 1, to: 2,  color: "#F59E0B" }, // break-even / poor
    { from: 2, to: 4,  color: "#EAB308" }, // acceptable
    { from: 4, to: 10, color: "#10B981" }, // good / great
  ];
  const ticks = [0, 1, 2, 4, 10];

  const needleAngle = valueToAngle(clamped);
  const needleColor =
    clamped >= 4 ? "#10B981" :
    clamped >= 2 ? "#EAB308" :
    clamped >= 1 ? "#F59E0B" : "#EF4444";

  return (
    <svg viewBox="0 0 320 220" style={{ width: "100%", maxWidth: 360, display: "block" }}>
      {/* Background arc */}
      <path d={arcPath(START, END)} fill="none" stroke="#1A2030" strokeWidth={26} strokeLinecap="butt" />

      {/* Colored zones */}
      {zones.map((z, i) => (
        <path
          key={i}
          d={arcPath(valueToAngle(z.from), valueToAngle(z.to))}
          fill="none"
          stroke={z.color}
          strokeWidth={24}
          strokeLinecap="butt"
          opacity={0.92}
        />
      ))}

      {/* Ticks + labels */}
      {ticks.map(t => {
        const a = valueToAngle(t);
        const [x1, y1] = polar(a, r - 16);
        const [x2, y2] = polar(a, r + 16);
        const [lx, ly] = polar(a, r + 30);
        return (
          <g key={t}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#E8ECF4" strokeWidth={2.5} />
            <text x={lx} y={ly} fill="#9CA3AF" fontSize={12} fontWeight={700} textAnchor="middle" dominantBaseline="middle" fontFamily="'JetBrains Mono',monospace">{t}x</text>
          </g>
        );
      })}

      {/* Needle — pivots at center with smooth transition */}
      <g style={{ transition: "transform 0.45s cubic-bezier(0.34, 1.3, 0.64, 1)", transformOrigin: `${cx}px ${cy}px`, transform: `rotate(${needleAngle}deg)` }}>
        <line x1={cx} y1={cy + 10} x2={cx} y2={cy - r * 0.88} stroke={needleColor} strokeWidth={5} strokeLinecap="round" />
        <circle cx={cx} cy={cy - r * 0.88} r={4} fill={needleColor} />
      </g>

      {/* Center hub */}
      <circle cx={cx} cy={cy} r={13} fill="#0B0F1A" stroke={needleColor} strokeWidth={3} />
      <circle cx={cx} cy={cy} r={4} fill={needleColor} />

      {/* Digital readout */}
      <text x={cx} y={cy + 52} fill={needleColor} fontSize={30} fontWeight={800} textAnchor="middle" fontFamily="'JetBrains Mono',monospace">
        {safeRoas.toFixed(2)}x
      </text>
      <text x={cx} y={cy + 72} fill="#5A6B85" fontSize={10} fontWeight={700} textAnchor="middle" letterSpacing="0.15em">
        {pinned ? "ROAS · OFF CHART" : "ROAS"}
      </text>
    </svg>
  );
}

/* ============================================================
   Main Calculator Component
   ============================================================ */

const StatBlock = ({ label, value, sub, color }) => (
  <div>
    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: color || "var(--fg)", lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 5, fontFamily: "'JetBrains Mono',monospace" }}>{sub}</div>}
  </div>
);

const inputBase = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid rgba(245,158,11,0.3)",
  background: "rgba(245,158,11,0.08)",
  color: "#F59E0B", fontSize: 14,
  fontFamily: "'JetBrains Mono',monospace", outline: "none",
  textAlign: "right", fontWeight: 700,
};

export function RoasCalculator({ embedded = false }) {
  // Try to restore state from URL hash on first load
  const initial = useMemo(() => {
    const decoded = typeof window !== "undefined" ? decodeState(window.location.hash) : null;
    if (decoded) return decoded;
    return { funnel: "meta1", inputs: { ...FUNNELS.meta1.defaults } };
  }, []);

  const [funnel, setFunnel] = useState(initial.funnel);
  const [allInputs, setAllInputs] = useState(() => ({
    meta1:   initial.funnel === "meta1"   ? { ...FUNNELS.meta1.defaults,   ...initial.inputs } : { ...FUNNELS.meta1.defaults },
    meta2:   initial.funnel === "meta2"   ? { ...FUNNELS.meta2.defaults,   ...initial.inputs } : { ...FUNNELS.meta2.defaults },
    google1: initial.funnel === "google1" ? { ...FUNNELS.google1.defaults, ...initial.inputs } : { ...FUNNELS.google1.defaults },
  }));
  const [copied, setCopied] = useState(false);

  const funnelDef = FUNNELS[funnel];
  const inputs = allInputs[funnel];
  const setInputs = patch => setAllInputs(prev => ({ ...prev, [funnel]: { ...prev[funnel], ...patch } }));
  const resetDefaults = () => setAllInputs(prev => ({ ...prev, [funnel]: { ...FUNNELS[funnel].defaults } }));

  // Sync state → URL hash (so share links preserve the scenario)
  useEffect(() => {
    const hash = "#" + encodeState({ funnel, inputs });
    if (typeof window !== "undefined" && window.location.hash !== hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search + hash);
    }
  }, [funnel, inputs]);

  const { stages, summary } = computeResult(funnel, inputs);

  const shareLink = () => {
    const base = `${window.location.origin}${window.location.pathname}?roas=1`;
    const url = base + "#" + encodeState({ funnel, inputs });
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const pctVal = v => isNaN(v) ? 0 : +(v * 100).toFixed(2);

  const renderInputCell = (row) => (
    <div style={{ position: "relative", display: "inline-block", width: 130 }}>
      {row.kind === "cur" && <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#F59E0B", fontFamily: "'JetBrains Mono',monospace", pointerEvents: "none", fontWeight: 700 }}>$</span>}
      <input
        type="number"
        value={row.kind === "pct" ? pctVal(inputs[row.key]) : (inputs[row.key] ?? "")}
        onChange={e => {
          const v = parseFloat(e.target.value);
          if (isNaN(v)) { setInputs({ [row.key]: 0 }); return; }
          setInputs({ [row.key]: row.kind === "pct" ? v / 100 : v });
        }}
        min={0}
        step={row.kind === "pct" ? 0.5 : row.kind === "cur" ? 1 : 0.1}
        style={{
          ...inputBase,
          width: "100%",
          paddingLeft:  row.kind === "cur" ? 22 : 10,
          paddingRight: row.kind === "pct" ? 24 : 10,
        }}
      />
      {row.kind === "pct" && <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#F59E0B", fontFamily: "'JetBrains Mono',monospace", pointerEvents: "none", fontWeight: 700 }}>%</span>}
    </div>
  );

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: embedded ? "24px 28px 60px" : "24px 20px 60px" }}>
      <style>{`
        @media (max-width: 820px) {
          .roas-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .roas-hero { flex-direction: column !important; align-items: stretch !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg)" }}>ROAS Calculator</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            Forecast revenue, deals and return on ad spend across your funnel.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={resetDefaults} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Reset</button>
          <button onClick={shareLink} style={{ ...BTN, background: "var(--accent)", color: "white" }}>
            {copied ? "Link Copied!" : "Copy Share Link"}
          </button>
        </div>
      </div>

      {/* Funnel tab selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 4, flexWrap: "wrap" }}>
        {Object.values(FUNNELS).map(f => (
          <button key={f.id} onClick={() => setFunnel(f.id)} style={{
            flex: 1, minWidth: 180, padding: "10px 14px", borderRadius: 8, border: "none",
            background: funnel === f.id ? "var(--accent-soft)" : "transparent",
            color: funnel === f.id ? "var(--accent)" : "var(--muted)",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>{f.label}</button>
        ))}
      </div>

      {/* Hero: big numbers on the left, tachometer gauge on the right */}
      <div className="roas-hero" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, marginBottom: 18, display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 22 }}>
          <StatBlock
            label="Annual Revenue"
            value={fmtCur(summary.annualRevenue)}
            sub={`${fmtCur(summary.monthlyRevenue)} / month`}
            color="#10B981"
          />
          <StatBlock
            label="Annual Profit"
            value={fmtCur(summary.annualProfit)}
            sub="Revenue − Ad Spend"
            color={summary.annualProfit >= 0 ? "var(--fg)" : "#EF4444"}
          />
          <StatBlock
            label="Annual Deals"
            value={summary.deals.toLocaleString("en-AU")}
            sub={`${fmtCur(summary.annualSpend)} ad spend`}
          />
        </div>
        <div style={{ flex: "0 0 auto", width: "100%", maxWidth: 360 }}>
          <RoasGauge roas={summary.roas} />
        </div>
      </div>

      {/* Inputs sidebar + Flow table */}
      <div className="roas-grid" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 280px) minmax(0, 1fr)", gap: 16, marginBottom: 18 }}>

        {/* Your Inputs (universal) */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, alignSelf: "start" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14 }}>Your Inputs</div>
          {UNIVERSAL_INPUTS.map(f => (
            <div key={f.key} style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>{f.label}</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#F59E0B", fontFamily: "'JetBrains Mono',monospace", pointerEvents: "none", fontWeight: 700 }}>$</span>
                <input
                  type="number"
                  value={inputs[f.key] ?? ""}
                  onChange={e => setInputs({ [f.key]: parseFloat(e.target.value) || 0 })}
                  min={0}
                  style={{ ...inputBase, width: "100%", paddingLeft: 22 }}
                />
              </div>
              <div style={{ fontSize: 10, color: "#3A4558", marginTop: 3, fontStyle: "italic" }}>{f.hint}</div>
            </div>
          ))}
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)", fontSize: 10, color: "#3A4558", lineHeight: 1.6 }}>
            <span style={{ color: "#F59E0B", fontWeight: 700 }}>Orange values</span> are editable. Adjust any field to see the funnel recalculate instantly.
          </div>
        </div>

        {/* Flow table */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Funnel Flow</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{funnelDef.label}</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: "left",  padding: "10px 16px", paddingLeft: 24, width: 180 }}>Stage</th>
                  <th style={{ ...TH, textAlign: "right", padding: "10px 12px" }}>Monthly</th>
                  <th style={{ ...TH, textAlign: "right", padding: "10px 12px" }}>Annual</th>
                  <th style={{ ...TH, textAlign: "right", padding: "10px 16px", width: 80 }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {funnelDef.sections.map(section => (
                  <Fragment key={section.name}>
                    <tr>
                      <td colSpan={4} style={{ padding: "7px 16px", background: "var(--bg)", fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.08em", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
                        {section.name}
                      </td>
                    </tr>
                    {section.rows.map(row => {
                      if (row.type === "input") {
                        return (
                          <tr key={row.key} style={{ background: "rgba(245,158,11,0.04)", borderLeft: "3px solid #F59E0B" }}>
                            <td colSpan={4} style={{ padding: "8px 16px", paddingLeft: 21 /* 24 - 3px border */ }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                                {renderInputCell(row)}
                                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                                  <div style={{ color: "#F59E0B", fontWeight: 700, fontSize: 12 }}>{row.label}</div>
                                  <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2, fontStyle: "italic", fontWeight: 400 }}>{row.hint}</div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      }
                      const stage = stages[row.key];
                      if (!stage) return null;
                      const isRevenue = row.label === "Revenue";
                      const isSpend   = row.label === "Ad Spend";
                      const costVal = row.costFrom && stage.annual > 0 ? stages[row.costFrom].annual / stage.annual : null;
                      const textColor = isRevenue ? "#10B981" : "var(--fg)";
                      return (
                        <tr key={row.key} style={{ background: isRevenue ? "rgba(16,185,129,0.08)" : "transparent", borderBottom: "1px solid var(--border-light)" }}>
                          <td style={{ padding: "10px 16px", paddingLeft: 24, fontWeight: isRevenue || isSpend ? 700 : 500, color: textColor, fontSize: 13 }}>
                            {row.label}
                          </td>
                          <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: textColor, fontSize: 13 }}>
                            {fmtVal(stage.monthly, row.kind)}
                          </td>
                          <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: textColor, fontSize: 13 }}>
                            {fmtVal(stage.annual, row.kind)}
                          </td>
                          <td style={{ padding: "10px 16px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "var(--muted)" }}>
                            {costVal != null ? fmtCost(costVal) : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Instructions */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>How to use this</div>
        <ol style={{ paddingLeft: 20, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
          <li>Adjust your daily ad budget and average product price in the sidebar</li>
          {funnel !== "google1" ? (
            <>
              <li>Set your CPM — B2C roughly $20-$30, B2B $30-$40</li>
              <li>Set your CTR — under 1% is weak, 1-2% is good, 2-4% is great</li>
            </>
          ) : (
            <li>Set your average CPC — use Google Keyword Planner to estimate by industry</li>
          )}
          <li>Opt-in rate — 10% is average (20% for a 2-step lead magnet), 40% is great</li>
          {funnel === "meta2" && <>
            <li>Booking rate — 10% average, 30% great</li>
            <li>Show rate — 30% is poor, 75% is achievable with good reminders</li>
          </>}
          {funnel !== "meta2" && <li>Contact rate — of 10 leads you call, how many answer</li>}
          <li>Close rate — of 10 people you speak with, how many buy</li>
        </ol>
        <div style={{ fontSize: 11, color: "#3A4558", marginTop: 14, fontStyle: "italic" }}>
          Tip: Copy the share link to send this exact scenario to a client — the URL preserves all your inputs.
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Public standalone wrapper (used by ?roas=1 URL route)
   ============================================================ */

export function RoasCalculatorPublicView() {
  useEffect(() => { document.title = "Viewix - ROAS Calculator"; }, []);
  return (
    <div style={{ fontFamily: "'DM Sans',-apple-system,sans-serif", background: "var(--bg)", color: "var(--fg)", minHeight: "100vh" }}>
      <style>{CSS}</style>
      <div style={{ padding: "20px 28px", borderBottom: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Logo h={24} />
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>ROAS Calculator</div>
      </div>
      <RoasCalculator />
    </div>
  );
}
