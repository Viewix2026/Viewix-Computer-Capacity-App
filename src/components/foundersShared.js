// Shared constants used by both the Founders Dashboard tab (which now
// hosts the Trends grid) and the Founders Data tab (which hosts the
// log form + data table). Originally lived in FoundersData.jsx; moved
// here when the trends grid relocated to the Dashboard so we don't
// have a circular import or duplicate field definitions.
//
// Categories ordered McKinsey-funnel-style: Revenue first (the headline),
// then Conversion (how you turn pipeline into money), then upstream
// Acquisition + Sources (where pipeline comes from), then unit economics
// (LTV+CAC), Retention, Risk, Operations.
//
// Field schema is verbatim from the prior FoundersData.jsx so historical
// /foundersMetrics records continue to read cleanly with no migration.

export const CATEGORIES = [
  { key: "revenue",     label: "Revenue",                blurb: "The money — monthly, recurring, pipeline." },
  { key: "conversion",  label: "Conversion",             blurb: "Mid funnel — calls, close rate, sales cycle." },
  { key: "acquisition", label: "Acquisition",            blurb: "Top of funnel — ad spend, leads, cost per lead." },
  { key: "sources",     label: "Sources (new clients)",  blurb: "New clients acquired this month, broken down by channel." },
  { key: "ltvcac",      label: "LTV + CAC",              blurb: "Efficiency — lifetime value and cost to acquire." },
  { key: "retention",   label: "Retention",              blurb: "The leak — active retainers, churn, NRR." },
  { key: "risk",        label: "Risk / Concentration",   blurb: "Vulnerabilities — top-client dependency and source concentration." },
  { key: "operations",  label: "Operations",             blurb: "Delivery health — active projects, utilisation, margin." },
];

export const CATEGORY_COLORS = {
  revenue:     "#10B981",  // brand green — the headline
  conversion:  "#0082FA",  // Viewix accent blue
  acquisition: "#06B6D4",  // cyan
  sources:     "#14B8A6",  // teal
  ltvcac:      "#8B5CF6",  // violet
  retention:   "#EC4899",  // pink
  risk:        "#EF4444",  // red
  operations:  "#F87700",  // orange
};

export const FIELDS = [
  // ── ACQUISITION ────────────────────────────────────────────────────
  { key: "monthlyAdSpend",            label: "Monthly Ad Spend",             unit: "$",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Total Meta ad spend in the month",                 agg: "sum" },
  { key: "dailyAdSpendGoal",          label: "Daily Ad Spend Goal",          unit: "$",     category: "acquisition", tier: 2, cadence: "quarterly", def: "Target daily spend" },
  { key: "predictedAdSpend",          label: "Predicted Monthly Ad Spend",   unit: "$",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Forecast based on daily goal × 30" },
  { key: "tenMonthAdSpend",           label: "10 Month Ad Spend Forecast",   unit: "$",     category: "acquisition", tier: 3, cadence: "quarterly", def: "Forward projection at current pace" },
  { key: "totalLeads",                label: "Total Leads",                  unit: "count", category: "acquisition", tier: 2, cadence: "monthly",   def: "Tracked leads across all sources",                 agg: "sum" },
  { key: "cpl",                       label: "CPL (blended)",                unit: "$",     category: "acquisition", tier: 1, cadence: "monthly",   def: "Ad spend ÷ leads attributed to ads" },
  { key: "cpm",                       label: "CPM",                          unit: "$",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Cost per 1,000 impressions" },
  { key: "ctr",                       label: "CTR",                          unit: "%",     category: "acquisition", tier: 2, cadence: "monthly",   def: "Link clicks ÷ impressions" },

  // ── SOURCES ────────────────────────────────────────────────────────
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

  // ── REVENUE ────────────────────────────────────────────────────────
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

  // ── LTV + CAC ──────────────────────────────────────────────────────
  { key: "ltv",                       label: "LTV (blended)",                unit: "$",     category: "ltvcac",      tier: 1, cadence: "monthly",   def: "Total revenue ÷ unique clients" },
  { key: "ltvRetainer",               label: "LTV (retainer clients)",       unit: "$",     category: "ltvcac",      tier: 3, cadence: "monthly",   def: "Total revenue ÷ retainer clients" },
  { key: "ltvProject",                label: "LTV (project-only clients)",   unit: "$",     category: "ltvcac",      tier: 3, cadence: "monthly",   def: "Total revenue ÷ project-only clients" },
  { key: "cac",                       label: "CAC (blended)",                unit: "$",     category: "ltvcac",      tier: 1, cadence: "monthly",   def: "Ad spend ÷ ad-sourced clients (paid channel only)" },
  { key: "ltvCacRatio",               label: "LTV : CAC Ratio",              unit: "x",     category: "ltvcac",      tier: 1, cadence: "monthly",   def: "LTV ÷ CAC. Target 3× or higher." },
  { key: "paybackPeriod",             label: "Payback Period",               unit: "months",category: "ltvcac",      tier: 3, cadence: "quarterly", def: "CAC ÷ avg monthly revenue per client" },

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

export const LEGACY_FIELDS = [
  { key: "dailyChurnRate",  label: "Daily Churn Rate",  unit: "%", category: "retention",  tier: 3, cadence: "monthly", def: "Retainer churn expressed daily. Consider using retainerChurnRate instead." },
  { key: "conversionRate",  label: "Conversion Rate",   unit: "%", category: "conversion", tier: 3, cadence: "monthly", def: "Legacy. Use leadToDealRate or closeRateCallToDeal for clarity." },
];

export const ALL_FIELDS = [...FIELDS, ...LEGACY_FIELDS];

export function formatValue(v, unit) {
  if (v === "" || v == null || Number.isNaN(+v)) return "";
  const n = +v;
  if (unit === "$") return `$${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;
  if (unit === "%") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })}%`;
  if (unit === "x") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}×`;
  if (unit === "days") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}d`;
  if (unit === "months") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })}mo`;
  return n.toLocaleString("en-AU", { maximumFractionDigits: 0 });
}
