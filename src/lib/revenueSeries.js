// Shared Attio won-deal → monthly revenue series.
//
// Lifted VERBATIM from the Founders Data tab's render IIFE so the Data tab
// and the Forecast tab can never drift on "what counts as won revenue".
// Both call buildMonthlyWonSeries(); the Data tab keeps deriving maxRev /
// labels from the returned artifacts exactly as before.
//
// NOTE on timezones (Codex #11): month bucketing uses `new Date(dateStr)`
// + local `getMonth()`, identical to the original Data-tab behaviour. This
// is deliberately NOT "fixed" — changing it would silently shift the Data
// tab's existing numbers. A deal whose close date lands near a month
// boundary is bucketed by the runtime's local timezone.

const extractVal = d => {
  const v = d.values;
  const candidates = [v?.deal_value, v?.amount, v?.value, v?.revenue, v?.contract_value];
  for (const c of candidates) {
    if (c?.[0] != null) {
      const n = c[0].currency_value ?? c[0].value;
      if (n != null) return typeof n === "number" ? n : parseFloat(n) || 0;
    }
  }
  return 0;
};

const extractDate = d => {
  const v = d.values;
  const candidates = [v?.close_date, v?.closed_at, v?.won_date, v?.created_at];
  for (const c of candidates) {
    if (c?.[0]?.value) return c[0].value;
  }
  return d.created_at || null;
};

const extractStage = d => {
  const v = d.values;
  const candidates = [v?.stage, v?.status, v?.deal_stage, v?.pipeline_stage];
  for (const c of candidates) {
    const t = c?.[0]?.status?.title || c?.[0]?.value;
    if (t) return (typeof t === "string" ? t : "").toLowerCase();
  }
  return "";
};

const WON_KW = ["won", "closed won", "closed-won", "completed", "signed", "active"];
// Exclude negative stages first — `stage.includes("won")` would otherwise count
// "Not Won" / "Closed Lost" as won revenue (pre-existing bug, fixed 2026-06-30).
const NOT_WON_RE = /\b(not\s*won|lost|closed[\s-]*lost)\b/;

// Returns:
//   byKey:      { "YYYY-MM": { revenue, count, label } }
//   sortedDesc: [ ["YYYY-MM", {...}], ... ]  newest first (Data tab order)
//   sortedAsc:  [ ... ]                       chronological
//   allTimeTotal, dealCount
export function buildMonthlyWonSeries(deals = []) {
  const byKey = {};
  let allTimeTotal = 0;
  let dealCount = 0;

  deals.forEach(d => {
    const val = extractVal(d);
    const dateStr = extractDate(d);
    const stage = extractStage(d);
    const isWon = !NOT_WON_RE.test(stage) && WON_KW.some(k => stage.includes(k));
    if (val > 0 && dateStr && isWon) {
      const dt = new Date(dateStr);
      if (!isNaN(dt)) {
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
        if (!byKey[key]) byKey[key] = { revenue: 0, count: 0, label: dt.toLocaleDateString("en-AU", { month: "short", year: "numeric" }) };
        byKey[key].revenue += val;
        byKey[key].count += 1;
        allTimeTotal += val;
        dealCount += 1;
      }
    }
  });

  const sortedDesc = Object.entries(byKey).sort((a, b) => b[0].localeCompare(a[0]));
  const sortedAsc = [...sortedDesc].reverse();
  return { byKey, sortedDesc, sortedAsc, allTimeTotal, dealCount };
}
