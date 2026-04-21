// api/_attio-metrics.js
// Shared Attio-deals → Founders-tab metric calculation.
//
// One source of truth for how a list of Attio deal records becomes the
// north-star KPIs shown on the Founders dashboard. Used by:
//   - Founders.jsx syncAttio (manual refresh)
//   - api/webhook-deal-won.js (auto-populate on each won deal)
// When both sides use the same code, the manual button and the webhook
// can't drift in what they compute.
//
// Inputs: Attio-shaped deal records (the .data array from the Attio
// objects/deals/records/query endpoint).
//
// Output: { ytdRevenue, monthlyRevenue, activeClients, avgRetainerValue,
//           leadPipelineValue, closingRate } — the same fields
// foundersData expects. Numeric fields default to 0; closingRate to 0.
//
// The caller decides whether to overwrite existing foundersData values
// (typical pattern: `newVal || existingVal` to avoid zeroing-out a real
// figure when a sync returns no deals).

// Field extractors — Attio's schema nests values in arrays of objects
// with either `value` or `currency_value`, and different orgs label
// fields differently, so we fall back through a candidate list.
export function extractVal(d) {
  const v = d?.values || {};
  const candidates = [v.deal_value, v.amount, v.value, v.revenue, v.contract_value];
  for (const c of candidates) {
    if (c?.[0] != null) {
      const n = c[0].currency_value ?? c[0].value;
      if (n != null) return typeof n === "number" ? n : parseFloat(n) || 0;
    }
  }
  return 0;
}

export function extractDate(d) {
  const v = d?.values || {};
  const candidates = [v.close_date, v.closed_at, v.won_date, v.created_at];
  for (const c of candidates) {
    if (c?.[0]?.value) return c[0].value;
  }
  return d?.created_at || null;
}

export function extractStage(d) {
  const v = d?.values || {};
  const candidates = [v.stage, v.status, v.deal_stage, v.pipeline_stage];
  for (const c of candidates) {
    const t = c?.[0]?.status?.title || c?.[0]?.value;
    if (t) return (typeof t === "string" ? t : "").toLowerCase();
  }
  return "";
}

export function extractCompany(d) {
  const v = d?.values || {};
  const candidates = [v.company, v.client, v.account, v.organisation, v.name, v.deal_name];
  for (const c of candidates) {
    const t = c?.[0]?.value;
    if (t) {
      if (typeof t === "string") return t;
      if (t?.name) return t.name;
    }
  }
  return null;
}

const WON_KEYWORDS  = ["won", "closed won", "closed", "completed", "signed"];
const LOST_KEYWORDS = ["lost", "closed lost", "rejected", "cancelled"];

export function computeFoundersMetrics(deals, now = new Date()) {
  const dealList = Array.isArray(deals) ? deals : [];
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth();
  const threeMonthsAgo = new Date(now); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  let ytdRevenue = 0;
  let currentMonthRevenue = 0;
  const activeCompanies = new Set();
  let pipelineValue = 0;
  let wonCount = 0;
  let totalClosed = 0;
  let activeRetainerTotal = 0;
  let activeRetainerCount = 0;
  let recentWon = 0;
  let recentClosed = 0;

  for (const d of dealList) {
    const val = extractVal(d);
    const dateStr = extractDate(d);
    const stage = extractStage(d);
    const company = extractCompany(d);
    const isWon = WON_KEYWORDS.some(k => stage.includes(k));
    const isLost = LOST_KEYWORDS.some(k => stage.includes(k));
    const isOpen = !isWon && !isLost;

    if (isWon || isLost) totalClosed++;
    if (isWon) wonCount++;

    if ((isWon || isLost) && dateStr) {
      const dt = new Date(dateStr);
      if (!isNaN(dt) && dt >= threeMonthsAgo) {
        recentClosed++;
        if (isWon) recentWon++;
      }
    }

    if (isWon && dateStr) {
      const dt = new Date(dateStr);
      if (!isNaN(dt)) {
        if (dt.getFullYear() === thisYear) ytdRevenue += val;
        if (dt.getFullYear() === thisYear && dt.getMonth() === thisMonth) currentMonthRevenue += val;
      }
    }
    if (isOpen) {
      pipelineValue += val;
      if (company) activeCompanies.add(company);
    }
    if (isWon && val > 0) { activeRetainerTotal += val; activeRetainerCount++; }
  }

  const closingRate = recentClosed > 0 ? Math.round((recentWon / recentClosed) * 100) : 0;
  const avgRetainerValue = activeRetainerCount > 0 ? Math.round(activeRetainerTotal / activeRetainerCount) : 0;

  return {
    ytdRevenue,
    monthlyRevenue: currentMonthRevenue,
    activeClients: activeCompanies.size,
    avgRetainerValue,
    leadPipelineValue: pipelineValue,
    closingRate,
  };
}
