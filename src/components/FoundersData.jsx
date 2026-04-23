// Founders Data — tiered metrics dashboard for the founder-level view.
//
// 47 potential fields across 7 categories, organised into 3 tiers by how
// often the founder looks at them:
//
//   Tier 1 — the "at a glance" view. Weekly / monthly. 12 fields.
//   Tier 2 — the monthly review. Adds ~15 fields so you see the full
//            month of acquisition, conversion, and revenue.
//   Tier 3 — the quarterly audit. Adds the remaining fields for deep
//            concentration + retention analysis + operations margin.
//
// Each tier shows the fields from its tier PLUS any lower tier — so
// Tier 2 shows Tier 1 + Tier 2, Tier 3 shows everything. Matches how
// founders actually use it: headline view for quick pulse, layered
// view for monthly review, full audit for quarterly.
//
// Fields with "by source" / "by campaign" / "by product" breakdowns
// are deferred until we have a breakdown data model (array of
// {label, value} tuples per field). Those 10-odd breakdown fields
// are noted in comments below but not yet enterable here.
//
// Data shape on disk (Firebase /foundersMetrics):
//   {
//     "2026-04": {
//       date: "2026-04",
//       <fieldKey>: <number or "">,
//       ...
//     },
//     "2026-03": { ... }
//   }
// Legacy keys (cac, ltv, cpl, cpm, monthlyAdSpend, predictedAdSpend,
// tenMonthAdSpend, dailyAdSpendGoal, dailyChurnRate, showRate,
// conversionRate) keep working because the new config re-uses those
// keys where semantics match.

import { useState } from "react";
import { BTN } from "../config";

// ─── Categories ───────────────────────────────────────────────────────
const CATEGORIES = [
  { key: "acquisition", label: "Acquisition",        blurb: "Top of funnel — ad spend, leads, cost per lead." },
  { key: "sources",     label: "Sources (new clients)", blurb: "New clients acquired this month, broken down by channel." },
  { key: "conversion",  label: "Conversion",         blurb: "Mid funnel — calls, close rate, sales cycle." },
  { key: "revenue",     label: "Revenue",            blurb: "The money — monthly, recurring, pipeline." },
  { key: "ltvcac",      label: "LTV + CAC",          blurb: "Efficiency — lifetime value and cost to acquire." },
  { key: "retention",   label: "Retention",          blurb: "The leak — active retainers, churn, NRR." },
  { key: "risk",        label: "Risk / Concentration", blurb: "Vulnerabilities — top-client dependency and source concentration." },
  { key: "operations",  label: "Operations",         blurb: "Delivery health — active projects, utilisation, margin." },
];

// ─── Fields ────────────────────────────────────────────────────────────
// Each field: key, label, unit ($ / % / count / days / months / x),
// category (matches above), tier (1 / 2 / 3), cadence (how often to
// update), def (one-line definition, shows as tooltip / helper text).
//
// Key stability — where possible, keys match the previous config so
// historical data stays intact. New keys added for new fields.
const FIELDS = [
  // ── ACQUISITION ────────────────────────────────────────────────────
  // `agg`: "sum" for flow metrics (cumulative across the window);
  // "latest" (default) for stock/ratio metrics (point-in-time).
  { key: "monthlyAdSpend",            label: "Monthly Ad Spend",             unit: "$",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Total Meta ad spend in the month",                 agg: "sum" },
  { key: "dailyAdSpendGoal",          label: "Daily Ad Spend Goal",          unit: "$",     category: "acquisition", tier: 2, cadence: "quarterly", def: "Target daily spend" },
  { key: "predictedAdSpend",          label: "Predicted Monthly Ad Spend",   unit: "$",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Forecast based on daily goal × 30" },
  { key: "tenMonthAdSpend",           label: "10 Month Ad Spend Forecast",   unit: "$",     category: "acquisition", tier: 3, cadence: "quarterly", def: "Forward projection at current pace" },
  { key: "totalLeads",                label: "Total Leads",                  unit: "count", category: "acquisition", tier: 2, cadence: "monthly",   def: "Tracked leads across all sources",                 agg: "sum" },
  { key: "cpl",                       label: "CPL (blended)",                unit: "$",     category: "acquisition", tier: 1, cadence: "monthly",   def: "Ad spend ÷ leads attributed to ads" },
  { key: "cpm",                       label: "CPM",                          unit: "$",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Cost per 1,000 impressions" },
  { key: "ctr",                       label: "CTR",                          unit: "%",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Link clicks ÷ impressions" },
  // Deferred (need breakdown-field model): CPL by Campaign, New Leads by Source.

  // ── SOURCES (new clients per channel, this month) ──────────────────
  // Sourced from the xlsx "New Clients by Source" sheet. Every new
  // client is tagged against exactly one acquisition source, so the
  // sum of these should equal newClientsAcquired (same column in the
  // Conversion section, kept as the blended total for consistency).
  { key: "newClientsReferral",        label: "New Clients — Referral",       unit: "count", category: "sources",     tier: 2, cadence: "monthly",   def: "New clients acquired via referral",                                 agg: "sum" },
  { key: "newClientsAdvertising",     label: "New Clients — Advertising",    unit: "count", category: "sources",     tier: 2, cadence: "monthly",   def: "New clients acquired via paid ads",                                 agg: "sum" },
  { key: "newClientsLinkedIn",        label: "New Clients — LinkedIn",       unit: "count", category: "sources",     tier: 2, cadence: "monthly",   def: "New clients acquired via LinkedIn outreach",                        agg: "sum" },
  { key: "newClientsSEO",             label: "New Clients — SEO",            unit: "count", category: "sources",     tier: 3, cadence: "monthly",   def: "New clients acquired via organic search",                           agg: "sum" },
  { key: "newClientsConference",      label: "New Clients — Conference",     unit: "count", category: "sources",     tier: 3, cadence: "monthly",   def: "New clients acquired via conferences / events",                     agg: "sum" },
  { key: "newClientsColdEmail",       label: "New Clients — Cold Email",     unit: "count", category: "sources",     tier: 3, cadence: "monthly",   def: "New clients acquired via cold outbound",                            agg: "sum" },
  { key: "newClientsRepeat",          label: "New Clients — Repeat (untagged)", unit: "count", category: "sources",  tier: 3, cadence: "monthly",   def: "Pre-existing clients reactivated but not tagged to a specific source", agg: "sum" },
  { key: "newClientsOther",           label: "New Clients — Other",          unit: "count", category: "sources",     tier: 3, cadence: "monthly",   def: "New clients whose source isn't tracked in Attio",                   agg: "sum" },

  // ── CONVERSION ─────────────────────────────────────────────────────
  { key: "callsBooked",               label: "Calls Booked",                 unit: "count", category: "conversion",  tier: 2, cadence: "monthly",   def: "Discovery calls scheduled",                                         agg: "sum" },
  { key: "showRate",                  label: "Show Rate",                    unit: "%",     category: "conversion",  tier: 2, cadence: "monthly",   def: "Calls attended ÷ calls booked" },
  { key: "closeRateCallToDeal",       label: "Close Rate (call → deal)",     unit: "%",     category: "conversion",  tier: 2, cadence: "monthly",   def: "Deals won ÷ calls attended" },
  { key: "leadToDealRate",            label: "Lead to Deal Rate",            unit: "%",     category: "conversion",  tier: 2, cadence: "monthly",   def: "Deals won ÷ leads generated (lagged)" },
  { key: "avgSalesCycle",             label: "Avg Sales Cycle",              unit: "days",  category: "conversion",  tier: 2, cadence: "monthly",   def: "Created at → Close Date. Blocked until deal creation hygiene is clean." },
  { key: "newClientsAcquired",        label: "New Clients Acquired",         unit: "count", category: "conversion",  tier: 1, cadence: "monthly",   def: "First time clients in the month",                                   agg: "sum" },
  // Deferred: Lead→Deal Rate by Source, Sales Cycle by Source, New Clients by Source.

  // ── REVENUE ─────────────────────────────────────────────────────────
  { key: "monthlyRevenue",            label: "Monthly Revenue",              unit: "$",     category: "revenue",     tier: 1, cadence: "monthly",   def: "Total deal value closed in the month",                agg: "sum" },
  { key: "newClientRevenue",          label: "New Client Revenue",           unit: "$",     category: "revenue",     tier: 2, cadence: "monthly",   def: "Revenue from clients whose first deal was this month", agg: "sum" },
  { key: "repeatClientRevenue",       label: "Repeat Client Revenue",        unit: "$",     category: "revenue",     tier: 2, cadence: "monthly",   def: "Revenue from existing clients",                       agg: "sum" },
  { key: "pctRevenueFromNew",         label: "% Revenue from New Clients",   unit: "%",     category: "revenue",     tier: 1, cadence: "monthly",   def: "New ÷ total monthly revenue" },
  { key: "mrr",                       label: "MRR",                          unit: "$",     category: "revenue",     tier: 1, cadence: "monthly",   def: "Monthly recurring revenue from active retainers" },
  { key: "arrRunRate",                label: "ARR Run Rate",                 unit: "$",     category: "revenue",     tier: 2, cadence: "monthly",   def: "MRR × 12" },
  { key: "avgDealSize",               label: "Avg Deal Size",                unit: "$",     category: "revenue",     tier: 2, cadence: "monthly",   def: "Mean of all deals closed" },
  { key: "avgDealSizeProject",        label: "Avg Deal Size — Project",      unit: "$",     category: "revenue",     tier: 3, cadence: "monthly",   def: "Mean deal size for project-type deals" },
  { key: "avgDealSizeRetainer",       label: "Avg Deal Size — Retainer",     unit: "$",     category: "revenue",     tier: 3, cadence: "monthly",   def: "Mean deal size for retainer-type deals" },
  { key: "pipelineValue",             label: "Pipeline Value",               unit: "$",     category: "revenue",     tier: 1, cadence: "weekly",    def: "Open (not yet won) deals in Attio" },
  // Deferred: Revenue by Source.

  // ── LTV + CAC ──────────────────────────────────────────────────────
  { key: "ltv",                       label: "LTV (blended)",                unit: "$",     category: "ltvcac",      tier: 1, cadence: "monthly",   def: "Total revenue ÷ unique clients" },
  { key: "ltvRetainer",               label: "LTV (retainer clients)",       unit: "$",     category: "ltvcac",      tier: 3, cadence: "monthly",   def: "Total revenue ÷ retainer clients" },
  { key: "ltvProject",                label: "LTV (project-only clients)",   unit: "$",     category: "ltvcac",      tier: 3, cadence: "monthly",   def: "Total revenue ÷ project-only clients" },
  { key: "cac",                       label: "CAC (blended)",                unit: "$",     category: "ltvcac",      tier: 1, cadence: "monthly",   def: "Ad spend ÷ ad-sourced clients (paid channel only)" },
  { key: "ltvCacRatio",               label: "LTV : CAC Ratio",              unit: "x",     category: "ltvcac",      tier: 1, cadence: "monthly",   def: "LTV ÷ CAC. Target 3× or higher." },
  { key: "paybackPeriod",             label: "Payback Period",               unit: "months",category: "ltvcac",      tier: 3, cadence: "quarterly", def: "CAC ÷ avg monthly revenue per client" },
  // Deferred: LTV by Source.

  // ── RETENTION ──────────────────────────────────────────────────────
  { key: "activeClients",             label: "Active Clients",               unit: "count", category: "retention",   tier: 2, cadence: "monthly",   def: "Clients with any deal in last 90 days" },
  { key: "activeRetainers",           label: "Active Retainers",             unit: "count", category: "retention",   tier: 1, cadence: "monthly",   def: "Retainers signed in last 120 days (or contract length)" },
  { key: "retainerRenewalRate",       label: "Retainer Renewal Rate",        unit: "%",     category: "retention",   tier: 2, cadence: "monthly",   def: "Retainers that signed a 2nd contract ÷ total retainers signed" },
  { key: "retainerChurnRate",         label: "Retainer Churn Rate",          unit: "%",     category: "retention",   tier: 1, cadence: "monthly",   def: "1 − renewal rate" },
  { key: "allClientChurnYoY",         label: "All Client Churn (YoY)",       unit: "%",     category: "retention",   tier: 3, cadence: "quarterly", def: "Clients active 12-24mo ago who didn't return in last 12mo" },
  { key: "avgDaysBetweenRepeatDeals", label: "Avg Days Between Repeat Deals",unit: "days",  category: "retention",   tier: 2, cadence: "monthly",   def: "For top 10 clients — predicts next purchase" },
  { key: "netRevenueRetention",       label: "Net Revenue Retention",        unit: "%",     category: "retention",   tier: 3, cadence: "quarterly", def: "Revenue this year from cohort N ÷ same cohort last year. Target 100%+" },

  // ── RISK / CONCENTRATION ───────────────────────────────────────────
  { key: "top5Concentration",         label: "Top 5 Clients % of Revenue",   unit: "%",     category: "risk",        tier: 1, cadence: "monthly",   def: "Single biggest dependency metric" },
  { key: "top10Concentration",        label: "Top 10 Clients % of Revenue",  unit: "%",     category: "risk",        tier: 2, cadence: "monthly",   def: "Broader concentration view" },
  { key: "largestSingleClientPct",    label: "Largest Single Client %",      unit: "%",     category: "risk",        tier: 2, cadence: "monthly",   def: "The % of revenue from your biggest client" },
  { key: "pctRevenueFromTopSource",   label: "% Revenue from Top Source",    unit: "%",     category: "risk",        tier: 3, cadence: "quarterly", def: "How concentrated is your acquisition mix? E.g. Referral at 36%." },

  // ── OPERATIONS ─────────────────────────────────────────────────────
  { key: "activeProjects",            label: "Active Projects in Production",unit: "count", category: "operations",  tier: 3, cadence: "weekly",    def: "Pulled from Monday board 1884080816" },
  { key: "teamCapacityUtilisation",   label: "Team Capacity Utilisation",    unit: "%",     category: "operations",  tier: 3, cadence: "weekly",    def: "From your Capacity Planner" },
  { key: "timeToFirstDelivery",       label: "Time to First Delivery",       unit: "days",  category: "operations",  tier: 3, cadence: "monthly",   def: "Deal close → first content delivered. Predicts retainer churn." },
  { key: "avgProjectGrossMargin",     label: "Avg Project Gross Margin",     unit: "%",     category: "operations",  tier: 3, cadence: "quarterly", def: "Revenue − direct cost ÷ revenue" },
];

// Legacy rate metrics kept so the existing dashboard still renders
// prior data. Grouped into a virtual "rate" mini-category under
// Operations so they don't disappear from the UI. Can be deprecated
// once the founder has stopped logging them.
const LEGACY_FIELDS = [
  { key: "dailyChurnRate",  label: "Daily Churn Rate",  unit: "%", category: "retention",  tier: 3, cadence: "monthly", def: "Retainer churn expressed daily. Consider using retainerChurnRate instead." },
  { key: "conversionRate",  label: "Conversion Rate",   unit: "%", category: "conversion", tier: 3, cadence: "monthly", def: "Legacy. Use leadToDealRate or closeRateCallToDeal for clarity." },
];

const ALL_FIELDS = [...FIELDS, ...LEGACY_FIELDS];

// ─── Helpers ──────────────────────────────────────────────────────────
// Fields visible at a given tier cap. Tier 2 means "show tier 1 and 2".
function fieldsForTier(tierCap) {
  return ALL_FIELDS.filter(f => f.tier <= tierCap);
}

function formatValue(v, unit) {
  if (v === "" || v == null || Number.isNaN(+v)) return "";
  const n = +v;
  if (unit === "$") return `$${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;
  if (unit === "%") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })}%`;
  if (unit === "x") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}×`;
  if (unit === "days") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}d`;
  if (unit === "months") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })}mo`;
  // "count" and fallback
  return n.toLocaleString("en-AU", { maximumFractionDigits: 0 });
}

const CATEGORY_COLORS = {
  acquisition: "#0082FA",
  sources:     "#14B8A6",   // teal — distinct from Acquisition's blue
  conversion:  "#10B981",
  revenue:     "#F87700",
  ltvcac:      "#8B5CF6",
  retention:   "#EC4899",
  risk:        "#EF4444",
  operations:  "#06B6D4",
};

// ─── SparkChart — one field per chart, small-multiples layout ────────
// Each chart is self-contained: own Y-axis scaled to the field's range,
// minimal X-axis labels (first / middle / last so it doesn't crowd).
// Hover shows the value at each point. Much easier to scan than the
// previous all-fields-overlaid chart that muddled 9 lines in the same
// viewport.
function SparkChart({ entries, field, latest }) {
  if (!entries || entries.length < 2) return null;
  const W = 280, H = 110, PAD = { t: 14, r: 10, b: 22, l: 36 };
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;

  const color = CATEGORY_COLORS[field.category] || "#8B5CF6";

  // Pull (value, date) pairs in the filtered window so we can show a
  // single-value card when the field only has one data point in scope.
  const pairs = entries
    .map(e => ({ v: parseFloat(e[field.key]), date: e.date }))
    .filter(p => !Number.isNaN(p.v));
  const vals = pairs.map(p => p.v);

  // Zero-data state — the filter window has nothing to show. Surface
  // the total-across-all-time so the producer knows the field HAS
  // data, just not in the current window.
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

  // Single-data-point state — can't draw a line, but we CAN show the
  // value + the month. Big number centred, coloured by category.
  if (vals.length < 2) {
    const single = pairs[0];
    const fmtDateSingle = (iso) => {
      if (!iso) return "";
      const [y, m] = iso.split("-");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${months[parseInt(m) - 1] || m} '${y?.slice(2)}`;
    };
    return (
      <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, minHeight: H + 38, display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>{field.label}</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: color, fontFamily: "'JetBrains Mono',monospace" }}>
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
  // Pad the range a touch so the line doesn't kiss the top/bottom edge.
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

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  // Soft area fill under the line for scannability.
  const areaD = `${d} L${points[points.length - 1].x},${PAD.t + ch} L${points[0].x},${PAD.t + ch} Z`;

  // Y-axis: just min / max ticks (no clutter).
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

  // X labels: first and last date only.
  const fmtDate = (iso) => {
    if (!iso) return "";
    const [y, m] = iso.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m) - 1] || m} '${y?.slice(2)}`;
  };

  // Top-right number — aggregation depends on the field type:
  //   `agg: "sum"`    (flow metrics)  → sum of all values in window
  //                                      e.g. New Clients Acquired in
  //                                      2026 = Jan(3)+Feb(7)+Mar(1)
  //                                      +Apr(6) = 17
  //   `agg: "latest"` (stock/ratio)    → last non-empty value, walks
  //                                      backward to skip missing data.
  //                                      Default.
  //
  // Flow fields get a "· {window} total" suffix so the number reads as
  // "17 · 2026 total" instead of ambiguously "17".
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
    // "latest" — walk backward to find the most recent non-empty value.
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
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={field.label}>
          {field.label}
        </div>
        {formatted && (
          <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'JetBrains Mono',monospace", flexShrink: 0, textAlign: "right" }}>
            {formatted}
            {displaySuffix && (
              <div style={{ fontSize: 9, fontWeight: 500, color: "var(--muted)", marginTop: -1 }}>{displaySuffix}</div>
            )}
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        <defs>
          <linearGradient id={`grad-${field.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Min / max Y-axis ticks */}
        <text x={PAD.l - 4} y={PAD.t + 4} fill="#5A6B85" fontSize={8} textAnchor="end" fontFamily="'JetBrains Mono',monospace">{yTick(yMax)}</text>
        <text x={PAD.l - 4} y={PAD.t + ch} fill="#5A6B85" fontSize={8} textAnchor="end" fontFamily="'JetBrains Mono',monospace">{yTick(yMin)}</text>
        <line x1={PAD.l} y1={PAD.t + ch} x2={W - PAD.r} y2={PAD.t + ch} stroke="#1E2A3A" strokeWidth={1} />
        {/* Soft area fill */}
        <path d={areaD} fill={`url(#grad-${field.key})`} />
        {/* Main line */}
        <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        {/* Latest point dot */}
        {points.length > 0 && (
          <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={3} fill={color} stroke="#0B0F1A" strokeWidth={1.5} />
        )}
        {/* X-axis: first + last month */}
        <text x={PAD.l} y={H - 6} fill="#5A6B85" fontSize={8} textAnchor="start" fontFamily="'JetBrains Mono',monospace">
          {fmtDate(entries[0].date)}
        </text>
        <text x={W - PAD.r} y={H - 6} fill="#5A6B85" fontSize={8} textAnchor="end" fontFamily="'JetBrains Mono',monospace">
          {fmtDate(entries[entries.length - 1].date)}
        </text>
      </svg>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────
export function FoundersData({ metrics, setMetrics }) {
  const [tierCap, setTierCap] = useState(1);   // 1 | 2 | 3
  const [editDate, setEditDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [editVals, setEditVals] = useState({});
  const [openCategories, setOpenCategories] = useState({ acquisition: true, sources: true, conversion: true, revenue: true, ltvcac: true, retention: true, risk: true, operations: false });
  const [visibleChartCategories, setVisibleChartCategories] = useState(
    Object.fromEntries(CATEGORIES.map(c => [c.key, true]))
  );
  // Year filter: "all" | "last12" | "2022" | "2023" | "2024" | "2025" | "2026"
  // Default to "last12" — most useful window for a founder reviewing
  // trends; full range still available for the "look back at the arc"
  // review.
  const [yearFilter, setYearFilter] = useState("last12");

  const activeFields = fieldsForTier(tierCap);

  const entries = Object.values(metrics || {}).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const entryLabels = entries.map(e => {
    const [y, m] = (e.date || "").split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return { ...e, label: `${months[parseInt(m) - 1] || m} ${y?.slice(2)}` };
  });

  const existing = metrics?.[editDate];
  const formVal = key => editVals[key] !== undefined ? editVals[key] : (existing?.[key] ?? "");

  const saveEntry = () => {
    const entry = { date: editDate };
    // Preserve untouched fields from the existing entry so we don't
    // overwrite historical data when a founder fills in just one
    // category. Only active fields (at current tier cap) are
    // considered — Tier-3 fields you haven't unlocked stay intact.
    if (existing) {
      for (const k of Object.keys(existing)) entry[k] = existing[k];
    }
    activeFields.forEach(f => {
      const raw = editVals[f.key] !== undefined ? editVals[f.key] : (existing?.[f.key] ?? "");
      entry[f.key] = raw === "" ? "" : (parseFloat(raw) || 0);
    });
    setMetrics(prev => ({ ...prev, [editDate]: entry }));
    setEditVals({});
  };

  const deleteEntry = (date) => {
    if (!confirm(`Delete data for ${date}?`)) return;
    setMetrics(prev => {
      const next = { ...prev };
      delete next[date];
      return next;
    });
  };

  const loadEntry = (date) => { setEditDate(date); setEditVals({}); };

  const toggleCategory = key => setOpenCategories(p => ({ ...p, [key]: !p[key] }));
  const toggleChartCategory = key => setVisibleChartCategories(p => ({ ...p, [key]: !p[key] }));

  const inputSt = {
    padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none",
    fontFamily: "'DM Sans',sans-serif", width: "100%",
  };

  return (<>
    {/* Tier selector */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Founders Data</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Three tiers — pick the depth you want. Each tier layers on top of the ones before it.
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", borderRadius: 8, padding: 4 }}>
          {[
            { tier: 1, label: "Tier 1 — Glance", count: fieldsForTier(1).length, blurb: "Weekly / monthly pulse" },
            { tier: 2, label: "Tier 2 — Monthly", count: fieldsForTier(2).length, blurb: "Full monthly review" },
            { tier: 3, label: "Tier 3 — Quarterly", count: fieldsForTier(3).length, blurb: "All fields, quarterly audit" },
          ].map(t => (
            <button key={t.tier} onClick={() => setTierCap(t.tier)}
              title={t.blurb}
              style={{
                padding: "8px 14px", borderRadius: 6, border: "none",
                background: tierCap === t.tier ? "var(--accent)" : "transparent",
                color: tierCap === t.tier ? "#fff" : "var(--muted)",
                fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                minWidth: 130,
              }}>
              <span>{t.label}</span>
              <span style={{ fontSize: 10, opacity: 0.75, fontFamily: "'JetBrains Mono',monospace" }}>{t.count} fields</span>
            </button>
          ))}
        </div>
      </div>
    </div>

    {/* Entry Form */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Log Monthly Data</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="month" value={editDate} onChange={e => { setEditDate(e.target.value); setEditVals({}); }} style={{ ...inputSt, width: 160 }} />
          <button onClick={saveEntry} style={{ ...BTN, background: "var(--accent)", color: "white", fontSize: 12, padding: "6px 16px" }}>{existing ? "Update" : "Save"}</button>
        </div>
      </div>
      {existing && <div style={{ fontSize: 11, color: "#F59E0B", marginBottom: 12 }}>Editing existing entry for {editDate}. Save will overwrite the values shown.</div>}

      <div style={{ display: "grid", gap: 10 }}>
        {CATEGORIES.map(cat => {
          const catFields = activeFields.filter(f => f.category === cat.key);
          if (!catFields.length) return null;
          const isOpen = !!openCategories[cat.key];
          const dot = CATEGORY_COLORS[cat.key];
          return (
            <div key={cat.key} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 }}>
              <button
                onClick={() => toggleCategory(cat.key)}
                style={{
                  width: "100%", padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                  fontFamily: "inherit",
                }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>{cat.label}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>{cat.blurb}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>{catFields.length} field{catFields.length === 1 ? "" : "s"}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen && (
                <div style={{ padding: "0 14px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                  {catFields.map(f => (
                    <div key={f.key}>
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                        <span style={{ color: "var(--fg)", fontWeight: 600 }}>{f.label}</span>
                        <span style={{ color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>({f.unit})</span>
                        <span title={`Tier ${f.tier} · ${f.cadence}`} style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>T{f.tier}</span>
                      </label>
                      <input type="number" step="any"
                        value={formVal(f.key)}
                        onChange={e => setEditVals(p => ({ ...p, [f.key]: e.target.value }))}
                        style={inputSt}
                        placeholder={f.def ? f.def.slice(0, 40) + (f.def.length > 40 ? "…" : "") : "0"}
                        title={f.def}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>

    {/* Trends — small multiples. One chart per field, grouped by
        category. Each chart is self-scaled so the shape is always
        readable regardless of the field's magnitude. Year filter
        narrows the X axis. */}
    {entryLabels.length >= 2 && (() => {
      // Apply year filter to build the chart's entry set without
      // mutating entryLabels (the data table still shows all months).
      const filtered = entryLabels.filter(e => {
        if (!yearFilter || yearFilter === "all") return true;
        if (yearFilter === "last12") {
          // Last 12 months from the most recent entry's date.
          const latest = entryLabels[entryLabels.length - 1]?.date;
          if (!latest) return true;
          const [ly, lm] = latest.split("-").map(Number);
          const cutoff = new Date(ly, lm - 12, 1);
          const [ey, em] = e.date.split("-").map(Number);
          return new Date(ey, em - 1, 1) >= cutoff;
        }
        return e.date.startsWith(yearFilter);
      });
      // Latest = last entry IN THE FILTERED WINDOW, not all-time.
      // Fixes the "top-right number stays on April 2026 even when I
      // filter to 2023" bug — the number now tracks the filter.
      const latest = filtered[filtered.length - 1] || null;

      // Collect every year in the data so the filter chips are
      // auto-populated (no hard-coded years that need updating).
      const years = Array.from(new Set(entryLabels.map(e => e.date.split("-")[0]))).sort();

      const filterChips = [
        { key: "last12", label: "Last 12 months" },
        { key: "all",    label: "All time" },
        ...years.map(y => ({ key: y, label: y })),
      ];

      return (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Trends</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>One line per field. Each chart is scaled to its own range so the shape is always readable. Latest value in the top right.</div>
            </div>
          </div>

          {/* Year / window filter */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
            {filterChips.map(f => {
              const active = yearFilter === f.key;
              return (
                <button key={f.key} onClick={() => setYearFilter(f.key)}
                  style={{
                    padding: "5px 12px", borderRadius: 4, border: "none",
                    background: active ? "var(--accent)" : "var(--bg)",
                    color: active ? "#fff" : "var(--muted)",
                    fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  }}>
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* Category toggle chips */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
            {CATEGORIES.map(cat => {
              const catFields = activeFields.filter(f => f.category === cat.key);
              if (!catFields.length) return null;
              const active = !!visibleChartCategories[cat.key];
              const color = CATEGORY_COLORS[cat.key];
              return (
                <button key={cat.key} onClick={() => toggleChartCategory(cat.key)}
                  style={{
                    padding: "4px 10px", borderRadius: 4, border: "none",
                    background: active ? `${color}20` : "var(--bg)",
                    color: active ? color : "var(--muted)",
                    fontSize: 10, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit",
                  }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? color : "var(--muted)", opacity: active ? 1 : 0.3 }} />
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
                if (!visibleChartCategories[cat.key]) return null;
                const catFields = activeFields.filter(f => f.category === cat.key);
                if (!catFields.length) return null;
                return (
                  <div key={cat.key}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: CATEGORY_COLORS[cat.key], textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
                      {cat.label}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                      {catFields.map(f => (
                        <SparkChart key={f.key} entries={filtered} field={f} latest={latest} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    })()}

    {/* Data Table */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Logged Data</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{entries.length} month{entries.length === 1 ? "" : "s"} logged · showing {activeFields.length} field{activeFields.length === 1 ? "" : "s"}</div>
      </div>
      {entries.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          No data logged yet. Use the form above to add your first month.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left", position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>Month</th>
                {activeFields.map(f => (
                  <th key={f.key} style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: CATEGORY_COLORS[f.category], textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right", whiteSpace: "nowrap" }} title={f.def}>
                    {f.label}
                  </th>
                ))}
                <th style={{ padding: "8px 10px", borderBottom: "2px solid var(--border)" }} />
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.date} style={{ cursor: "pointer" }} onClick={() => loadEntry(e.date)}>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--fg)", position: "sticky", left: 0, background: "var(--card)", zIndex: 1, fontFamily: "'JetBrains Mono',monospace" }}>{e.date}</td>
                  {activeFields.map(f => (
                    <td key={f.key} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)", whiteSpace: "nowrap" }}>
                      {formatValue(e[f.key], f.unit)}
                    </td>
                  ))}
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)" }}>
                    <button onClick={ev => { ev.stopPropagation(); deleteEntry(e.date); }}
                      title="Delete this month's entry"
                      style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12, cursor: "pointer", padding: "2px 6px" }}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </>);
}
