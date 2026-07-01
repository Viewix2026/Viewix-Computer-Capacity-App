// Pure revenue forecasting for the Founders Forecast subtab.
//
// One compounding model, three scenarios that differ ONLY by growth rate g:
//   Flat   (g = 0)        — provably equals the dashboard card's projection
//   Trend  (g = derived)  — half-window CAGR off the actual monthly history
//   Custom (g = user)     — the founder dials the monthly growth %
//
// Hard rules baked in (from the Codex plan review):
//  · YTD truth = the headline `currentRevenue`; the deal series only derives a
//    UNITLESS growth rate, never a second YTD number.            (Codex #8)
//  · Flat is anchored to the card via `projectedFlat - currentRevenue`, so g=0
//    lands EXACTLY on the card — no current-month double-count.  (Codex B2)
//  · `projectedFlat` / `yearProgress` are PASSED IN from the card, never
//    recomputed with a different formula.                        (Codex B7)
//  · Growth window includes zero months (no survivorship bias)   (Codex #1)
//    and uses MEDIAN levels (one whale deal can't dominate).     (Codex #3)
//  · Raw g is always shown; the projection clamps to ±30% and flags it.  (#4/B5)

export function median(nums) {
  const xs = nums.filter(n => typeof n === "number" && !isNaN(n)).slice().sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const GROWTH_CLAMP = 0.30; // ±30%/mo projection ceiling (display shows raw)
const clampG = g => Math.max(-GROWTH_CLAMP, Math.min(GROWTH_CLAMP, g));

// Revenue for a given calendar month, 0 if no deals closed that month.
const revAt = (byKey, year, monthIdx) =>
  byKey[`${year}-${String(monthIdx + 1).padStart(2, "0")}`]?.revenue || 0;

// forward[i] = startMonthly * (1+g)^i  for i in 0..count-1
function project(startMonthly, g, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(startMonthly * Math.pow(1 + g, i));
  return out;
}

// params:
//   byKey          monthly series (from buildMonthlyWonSeries)
//   currentRevenue headline YTD (foundersData.currentRevenue)
//   projectedFlat  card's projectedRevenue = currentRevenue / yearProgress
//   target         revenue target ($2M)
//   now            Date
//   horizonYear    selected chart end year (>= targetYear)
//   customGrowthPct user growth % for the Custom scenario (e.g. 5 => +5%/mo)
//   forwardBaseline cumulative $ at "today" the forward lines extend from — the
//                   ALL-TIME total (prior years' won + this year's headline YTD).
//                   Defaults to currentRevenue so the annual-only math is unchanged.
export function computeForecast({
  byKey = {}, currentRevenue = 0, projectedFlat = 0, target = 0,
  forwardBaseline = currentRevenue,
  now, horizonYear, customGrowthPct = 0,
}) {
  const targetYear = now.getFullYear();
  const curMonth = now.getMonth();          // 0-11
  const cm = curMonth;                        // completed months this year
  const monthsRemaining = 12 - curMonth;      // current partial month counts as remaining
  horizonYear = Math.max(targetYear, horizonYear || targetYear);
  const horizonMonths = (horizonYear - targetYear) * 12 + monthsRemaining;

  if (!(currentRevenue > 0) || !(projectedFlat > 0)) {
    return { available: false, reason: "No revenue booked yet this year — sync from Attio.", targetYear };
  }

  // Flat envelope, anchored to the card (Codex B2/B7).
  const flatForwardTotal = Math.max(0, projectedFlat - currentRevenue);
  const startMonthly = monthsRemaining > 0 ? flatForwardTotal / monthsRemaining : 0;

  // ── Trend growth rate g (half-window CAGR, median, zero-inclusive) ──
  const W = Math.min(6, cm);
  let trend = { enabled: false, reason: "", rawG: null, projectedG: null, isCapped: false, window: [], outlierHeavy: false, windowLabel: "" };
  if (cm < 4) {
    trend.reason = "Trend needs ≥4 completed months this year.";
  } else {
    // Last W completed calendar months of this year (zero-inclusive).
    const window = [];
    for (let m = cm - W; m < cm; m++) window.push({ monthIdx: m, revenue: revAt(byKey, targetYear, m) });
    const half = Math.floor(W / 2);
    const early = window.slice(0, half).map(x => x.revenue);
    const late = window.slice(W - half).map(x => x.revenue);   // middle month skipped when W is odd
    const earlyLevel = median(early);
    const lateLevel = median(late);
    if (earlyLevel <= 0) {
      trend.reason = "Trend baseline is zero (too many empty early months).";
    } else {
      const monthsApart = W - half;
      const rawG = lateLevel <= 0 ? -1 : Math.pow(lateLevel / earlyLevel, 1 / monthsApart) - 1;
      const projectedG = clampG(rawG);
      const total = window.reduce((s, x) => s + x.revenue, 0);
      const outlierHeavy = total > 0 && window.some(x => x.revenue > 0.5 * total);
      trend = {
        enabled: true, reason: "",
        rawG, projectedG, isCapped: Math.abs(projectedG - rawG) > 1e-9,
        window, outlierHeavy,
        windowLabel: `last ${W} months`,
      };
    }
  }

  // ── Scenarios ──
  const makeScenario = (g) => {
    const forward = project(startMonthly, g, horizonMonths);
    const sumTo = (n) => forward.slice(0, n).reduce((s, v) => s + v, 0);
    return {
      g,
      forwardMonthly: forward,
      landing: forwardBaseline + sumTo(horizonMonths),         // all-time cumulative at chosen horizon
      // gap is only meaningful with a real target; null hides the UI (Codex #3)
      gapToTarget: target > 0 ? (currentRevenue + sumTo(monthsRemaining)) - target : null, // always at end-of-target-year
    };
  };

  const flat = makeScenario(0);
  const trendScenario = trend.enabled ? makeScenario(trend.projectedG) : null;
  const customG = clampG((Number(customGrowthPct) || 0) / 100);
  const custom = makeScenario(customG);

  return {
    available: true,
    targetYear, horizonYear, horizonMonths, monthsRemaining, cm,
    currentRevenue, projectedFlat, target, startMonthly, customG, forwardBaseline,
    requiredMonthly: target > 0 ? Math.max(0, (target - currentRevenue) / monthsRemaining) : null,
    trend,
    scenarios: { flat, trend: trendScenario, custom },
  };
}

// ── Trailing-twelve-month revenue (rolling 12-mo won-deal sum) ──────
// A lumpy-business-honest "annual run rate" / size metric that ignores the
// calendar-year reset and seasonality. Deal-based (the deal series is the only
// monthly-resolution source for past years); independent of the headline-YTD
// anchoring used by the scenarios. Excludes the current partial month so a
// half-finished month never understates the figure.
export function computeTTM(byKey = {}, now) {
  const keys = Object.keys(byKey).filter(k => byKey[k].revenue > 0).sort();
  if (!keys.length) return { available: false, points: [] };
  const ord = (y, m) => y * 12 + m;                // absolute month ordinal
  const ymOf = o => [Math.floor(o / 12), ((o % 12) + 12) % 12];
  const ttmEndingAt = (o) => {
    let sum = 0;
    for (let i = 0; i < 12; i++) { const [y, m] = ymOf(o - i); sum += revAt(byKey, y, m); }
    return sum;
  };
  const [fy, fm] = keys[0].split("-").map(Number);
  const firstOrd = ord(fy, fm - 1);
  const lastCompletedOrd = ord(now.getFullYear(), now.getMonth()) - 1; // exclude partial month
  if (lastCompletedOrd < firstOrd) return { available: false, points: [] };

  // Trajectory points only where a full 12-month window exists.
  const firstFullOrd = firstOrd + 11;
  const points = [];
  for (let o = firstFullOrd; o <= lastCompletedOrd; o++) {
    const [y, m] = ymOf(o);
    points.push({ year: y, monthIdx: m, value: ttmEndingAt(o) });
  }
  const current = ttmEndingAt(lastCompletedOrd);
  const yearAgoOrd = lastCompletedOrd - 12;
  const yearAgo = yearAgoOrd >= firstOrd ? ttmEndingAt(yearAgoOrd) : null;
  const yoy = yearAgo && yearAgo > 0 ? current / yearAgo - 1 : null;
  const [lcY, lcM] = ymOf(lastCompletedOrd);
  return {
    available: current > 0,
    current,
    yoy,
    points,
    youngHistory: (lastCompletedOrd - firstOrd + 1) < 12,
    currentEndLabel: `${lcY}-${String(lcM + 1).padStart(2, "0")}`,
  };
}
