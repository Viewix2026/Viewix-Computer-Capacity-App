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

// Formatted currency strings ("3,695.00", "A$3,695.00") parse as 3 / 0
// with naive parseFloat — strip everything non-numeric first. Mirrors
// toMoney in shared/attio-extract.js.
function toMoney(n) {
  if (typeof n === "number") return Number.isFinite(n) ? n : 0;
  if (typeof n === "string") {
    const f = parseFloat(n.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(f) ? f : 0;
  }
  return 0;
}

// Field extractors — Attio's schema nests values in arrays of objects
// with either `value` or `currency_value`, and different orgs label
// fields differently, so we fall back through a candidate list.
export function extractVal(d) {
  const v = d?.values || {};
  const candidates = [v.deal_value, v.amount, v.value, v.revenue, v.contract_value];
  for (const c of candidates) {
    if (c?.[0] != null) {
      const n = c[0].currency_value ?? c[0].value;
      if (n != null) return toMoney(n);
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

// The linked company's record_id, NOT a display name. In Attio a deal's
// client is the `associated_company` record-reference (target_record_id);
// the company NAME is not present in the deal payload. The old extractor
// fell through a candidate list to `values.name`, which is the DEAL TITLE,
// so every deal looked like a brand-new client and activeClients counted
// deal titles instead of clients. Mirrors shared/attio-extract.js
// extractDealCompanyId so the manual sync, webhook and this calculator all
// agree on what "one client" is. Returns null when no company is linked.
export function extractCompanyId(d) {
  const ref = d?.values?.associated_company;
  const cell = Array.isArray(ref) ? ref[0] : ref;
  return cell?.target_record_id || cell?.record_id || null;
}

// NB: no bare "closed" keyword. "closed".includes-matching a stage named
// "Closed Lost" would flag a LOST deal as won and inflate activeClients,
// ytdRevenue and closingRate. "Closed Won" is still caught by "won".
const WON_KEYWORDS  = ["won", "closed won", "completed", "signed"];
const LOST_KEYWORDS = ["lost", "closed lost", "rejected", "cancelled"];

// `n` calendar months before `now`, clamped against month-end overflow.
// A naive setMonth(getMonth()-n) rolls e.g. (May 31 -> Feb 31) forward to
// Mar 3, which would drop late-February wins from a "last 3 months" window
// on ~6 month-end days a year. Pin to day 1 before subtracting, then restore
// the day clamped to the target month's length. Time-of-day is preserved.
export function monthsAgo(now, n) {
  const day = now.getDate();
  const d = new Date(now);
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

export function computeFoundersMetrics(deals, now = new Date()) {
  const dealList = Array.isArray(deals) ? deals : [];
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth();
  const threeMonthsAgo = monthsAgo(now, 3);

  let ytdRevenue = 0;
  let currentMonthRevenue = 0;
  // Active clients = DISTINCT companies (by linked company id) with a Won
  // deal in the last 3 calendar months (the same `threeMonthsAgo` cutoff
  // closingRate uses). Deduped by company so two deals from the same client
  // count once, and scoped to recent wins so this tracks paying clients, not
  // the whole pipeline. A Won deal with no linked company is skipped rather
  // than counted under its (unique) deal title; with ~5% of deals unlinked
  // in Attio this makes activeClients a slight undercount, not an overcount.
  const activeClientCompanies = new Set();
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
    const isWon = WON_KEYWORDS.some(k => stage.includes(k));
    const isLost = LOST_KEYWORDS.some(k => stage.includes(k));
    const isOpen = !isWon && !isLost;

    if (isWon || isLost) totalClosed++;
    if (isWon) wonCount++;

    if ((isWon || isLost) && dateStr) {
      const dt = new Date(dateStr);
      if (!isNaN(dt) && dt >= threeMonthsAgo) {
        recentClosed++;
        if (isWon) {
          recentWon++;
          const companyId = extractCompanyId(d);
          if (companyId) activeClientCompanies.add(companyId);
        }
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
    }
    if (isWon && val > 0) { activeRetainerTotal += val; activeRetainerCount++; }
  }

  const closingRate = recentClosed > 0 ? Math.round((recentWon / recentClosed) * 100) : 0;
  const avgRetainerValue = activeRetainerCount > 0 ? Math.round(activeRetainerTotal / activeRetainerCount) : 0;

  return {
    ytdRevenue,
    monthlyRevenue: currentMonthRevenue,
    activeClients: activeClientCompanies.size,
    avgRetainerValue,
    leadPipelineValue: pipelineValue,
    closingRate,
  };
}
