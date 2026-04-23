// api/seed-founders-metrics.js
// ONE-SHOT — backfill 44 months of historical Founders Data metrics into
// /foundersMetrics. Sourced from Viewix_Monthly_Dashboard_Backfill.xlsx
// (Attio-derived revenue/client/retention data Sep 2022 → Apr 2026,
// plus April 2026's current ad metrics).
//
// Idempotent: a second run overwrites the same records with identical
// data — no duplicates. Delete this file once the dashboard shows the
// full historical series.
//
// Usage: curl -X POST https://planner.viewix.com.au/api/seed-founders-metrics

import { getAdmin } from "./_fb-admin.js";

// Embedded rather than reading from an external file so the endpoint is
// fully self-contained and can't miss data in production.
const BACKFILL = {
  "2022-09": { "date": "2022-09", "monthlyRevenue": 7545, "avgDealSize": 7545, "newClientsAcquired": 1, "newClientRevenue": 7545, "repeatClientRevenue": 0, "pctRevenueFromNew": 100.0, "activeClients": 1, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 7545, "largestSingleClientPct": 100.0, "top5Concentration": 100.0, "retainerChurnRate": 0.0 },
  "2022-10": { "date": "2022-10", "monthlyRevenue": 1555, "avgDealSize": 1555, "newClientsAcquired": 1, "newClientRevenue": 1555, "repeatClientRevenue": 0, "pctRevenueFromNew": 100.0, "activeClients": 2, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 4550, "largestSingleClientPct": 82.91, "top5Concentration": 100.0, "retainerChurnRate": 0.0 },
  "2022-11": { "date": "2022-11", "monthlyRevenue": 4145, "avgDealSize": 4145, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 4145, "pctRevenueFromNew": 0.0, "activeClients": 2, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 6622, "largestSingleClientPct": 56.96, "top5Concentration": 100.0, "retainerChurnRate": 0.0 },
  "2022-12": { "date": "2022-12", "monthlyRevenue": 1100, "avgDealSize": 1100, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 1100, "pctRevenueFromNew": 0.0, "activeClients": 1, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 7172, "largestSingleClientPct": 52.6, "top5Concentration": 100.0, "retainerChurnRate": 0.0 },
  "2023-01": { "date": "2023-01", "monthlyRevenue": 0, "avgDealSize": 0, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 0, "pctRevenueFromNew": 0.0, "activeClients": 1, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 7172, "largestSingleClientPct": 52.6, "top5Concentration": 100.0, "retainerChurnRate": 0.0 },
  "2023-02": { "date": "2023-02", "monthlyRevenue": 5000, "avgDealSize": 5000, "newClientsAcquired": 1, "newClientRevenue": 5000, "repeatClientRevenue": 0, "pctRevenueFromNew": 100.0, "activeClients": 2, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 6448, "largestSingleClientPct": 39.0, "top5Concentration": 100.0, "retainerChurnRate": 0.0 },
  "2023-03": { "date": "2023-03", "monthlyRevenue": 45769, "avgDealSize": 5721, "newClientsAcquired": 5, "newClientRevenue": 44969, "repeatClientRevenue": 800, "pctRevenueFromNew": 98.25, "activeClients": 6, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 8139, "largestSingleClientPct": 33.41, "top5Concentration": 79.64, "retainerChurnRate": 0.0 },
  "2023-04": { "date": "2023-04", "monthlyRevenue": 17909, "avgDealSize": 3582, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 17909, "pctRevenueFromNew": 0.0, "activeClients": 6, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 10378, "largestSingleClientPct": 26.2, "top5Concentration": 75.68, "retainerChurnRate": 0.0 },
  "2023-05": { "date": "2023-05", "monthlyRevenue": 20207, "avgDealSize": 2526, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 20207, "pctRevenueFromNew": 0.0, "activeClients": 7, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 12904, "largestSingleClientPct": 21.07, "top5Concentration": 79.94, "retainerChurnRate": 0.0 },
  "2023-06": { "date": "2023-06", "monthlyRevenue": 51321, "avgDealSize": 7332, "newClientsAcquired": 2, "newClientRevenue": 31293, "repeatClientRevenue": 20028, "pctRevenueFromNew": 60.98, "activeClients": 7, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 15455, "largestSingleClientPct": 19.68, "top5Concentration": 76.08, "retainerChurnRate": 0.0 },
  "2023-07": { "date": "2023-07", "monthlyRevenue": 10904, "avgDealSize": 2726, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 10904, "pctRevenueFromNew": 0.0, "activeClients": 6, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 16545, "largestSingleClientPct": 20.75, "top5Concentration": 76.47, "retainerChurnRate": 0.0 },
  "2023-08": { "date": "2023-08", "monthlyRevenue": 61822, "avgDealSize": 8832, "newClientsAcquired": 3, "newClientRevenue": 40010, "repeatClientRevenue": 21812, "pctRevenueFromNew": 64.72, "activeClients": 8, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 17483, "largestSingleClientPct": 21.35, "top5Concentration": 65.93, "retainerChurnRate": 0.0 },
  "2023-09": { "date": "2023-09", "monthlyRevenue": 5630, "avgDealSize": 2815, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 5630, "pctRevenueFromNew": 0.0, "activeClients": 7, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 17916, "largestSingleClientPct": 20.83, "top5Concentration": 66.7, "retainerChurnRate": 0.0 },
  "2023-10": { "date": "2023-10", "monthlyRevenue": 36111, "avgDealSize": 3009, "newClientsAcquired": 1, "newClientRevenue": 11718, "repeatClientRevenue": 24393, "pctRevenueFromNew": 32.45, "activeClients": 9, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 19216, "largestSingleClientPct": 20.66, "top5Concentration": 64.46, "retainerChurnRate": 0.0 },
  "2023-11": { "date": "2023-11", "monthlyRevenue": 38014, "avgDealSize": 2924, "newClientsAcquired": 2, "newClientRevenue": 9317, "repeatClientRevenue": 28697, "pctRevenueFromNew": 24.51, "activeClients": 9, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 19189, "largestSingleClientPct": 22.43, "top5Concentration": 63.5, "retainerChurnRate": 0.0 },
  "2023-12": { "date": "2023-12", "monthlyRevenue": 10994, "avgDealSize": 3665, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 10994, "pctRevenueFromNew": 0.0, "activeClients": 8, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 19877, "largestSingleClientPct": 21.66, "top5Concentration": 63.85, "retainerChurnRate": 0.0 },
  "2024-01": { "date": "2024-01", "monthlyRevenue": 4906, "avgDealSize": 4906, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 4906, "pctRevenueFromNew": 0.0, "activeClients": 7, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 20183, "largestSingleClientPct": 21.33, "top5Concentration": 62.88, "retainerChurnRate": 0.0 },
  "2024-02": { "date": "2024-02", "monthlyRevenue": 6397, "avgDealSize": 3198, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 6397, "pctRevenueFromNew": 0.0, "activeClients": 3, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 20583, "largestSingleClientPct": 20.91, "top5Concentration": 63.34, "retainerChurnRate": 0.0 },
  "2024-03": { "date": "2024-03", "monthlyRevenue": 69300, "avgDealSize": 7700, "newClientsAcquired": 2, "newClientRevenue": 14632, "repeatClientRevenue": 54668, "pctRevenueFromNew": 21.11, "activeClients": 6, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 22146, "largestSingleClientPct": 18.96, "top5Concentration": 64.48, "retainerChurnRate": 0.0 },
  "2024-04": { "date": "2024-04", "monthlyRevenue": 17454, "avgDealSize": 4364, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 17454, "pctRevenueFromNew": 0.0, "activeClients": 7, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 23116, "largestSingleClientPct": 19.13, "top5Concentration": 65.95, "retainerChurnRate": 0.0 },
  "2024-05": { "date": "2024-05", "monthlyRevenue": 57258, "avgDealSize": 5205, "newClientsAcquired": 2, "newClientRevenue": 27827, "repeatClientRevenue": 29431, "pctRevenueFromNew": 48.6, "activeClients": 9, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 23667, "largestSingleClientPct": 20.14, "top5Concentration": 63.34, "retainerChurnRate": 0.0 },
  "2024-06": { "date": "2024-06", "monthlyRevenue": 37186, "avgDealSize": 7437, "newClientsAcquired": 2, "newClientRevenue": 26717, "repeatClientRevenue": 10469, "pctRevenueFromNew": 71.85, "activeClients": 9, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 23206, "largestSingleClientPct": 18.67, "top5Concentration": 60.78, "retainerChurnRate": 0.0 },
  "2024-07": { "date": "2024-07", "monthlyRevenue": 23326, "avgDealSize": 3888, "newClientsAcquired": 2, "newClientRevenue": 16239, "repeatClientRevenue": 7087, "pctRevenueFromNew": 69.62, "activeClients": 10, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 22244, "largestSingleClientPct": 18.7, "top5Concentration": 59.21, "retainerChurnRate": 0.0 },
  "2024-08": { "date": "2024-08", "monthlyRevenue": 66618, "avgDealSize": 4758, "newClientsAcquired": 3, "newClientRevenue": 7568, "repeatClientRevenue": 59050, "pctRevenueFromNew": 11.36, "activeClients": 11, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 22240, "largestSingleClientPct": 19.31, "top5Concentration": 60.49, "retainerChurnRate": 0.0 },
  "2024-09": { "date": "2024-09", "monthlyRevenue": 45347, "avgDealSize": 3779, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 45347, "pctRevenueFromNew": 0.0, "activeClients": 12, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 23919, "largestSingleClientPct": 19.37, "top5Concentration": 59.45, "retainerChurnRate": 0.0 },
  "2024-10": { "date": "2024-10", "monthlyRevenue": 32325, "avgDealSize": 2487, "newClientsAcquired": 1, "newClientRevenue": 700, "repeatClientRevenue": 31625, "pctRevenueFromNew": 2.17, "activeClients": 13, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 24219, "largestSingleClientPct": 19.49, "top5Concentration": 59.77, "retainerChurnRate": 0.0 },
  "2024-11": { "date": "2024-11", "monthlyRevenue": 89162, "avgDealSize": 4458, "newClientsAcquired": 1, "newClientRevenue": 33679, "repeatClientRevenue": 55483, "pctRevenueFromNew": 37.77, "activeClients": 12, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 26459, "largestSingleClientPct": 18.65, "top5Concentration": 58.03, "retainerChurnRate": 0.0 },
  "2024-12": { "date": "2024-12", "monthlyRevenue": 14628, "avgDealSize": 2438, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 14628, "pctRevenueFromNew": 0.0, "activeClients": 10, "activeRetainers": 0, "mrr": 0, "arrRunRate": 0, "ltv": 26963, "largestSingleClientPct": 18.67, "top5Concentration": 58.49, "retainerChurnRate": 0.0 },
  "2025-01": { "date": "2025-01", "monthlyRevenue": 16879, "avgDealSize": 2411, "newClientsAcquired": 0, "newClientRevenue": 0, "repeatClientRevenue": 16879, "pctRevenueFromNew": 0.0, "activeClients": 9, "activeRetainers": 1, "mrr": 719, "arrRunRate": 8632, "ltv": 27545, "largestSingleClientPct": 18.74, "top5Concentration": 58.55, "retainerChurnRate": 100.0 },
  "2025-02": { "date": "2025-02", "monthlyRevenue": 45601, "avgDealSize": 4146, "newClientsAcquired": 2, "newClientRevenue": 3490, "repeatClientRevenue": 42111, "pctRevenueFromNew": 7.65, "activeClients": 9, "activeRetainers": 1, "mrr": 719, "arrRunRate": 8632, "ltv": 27239, "largestSingleClientPct": 18.68, "top5Concentration": 59.98, "retainerChurnRate": 100.0 },
  "2025-03": { "date": "2025-03", "monthlyRevenue": 51375, "avgDealSize": 3952, "newClientsAcquired": 2, "newClientRevenue": 18335, "repeatClientRevenue": 33040, "pctRevenueFromNew": 35.69, "activeClients": 11, "activeRetainers": 1, "mrr": 719, "arrRunRate": 8632, "ltv": 27145, "largestSingleClientPct": 17.81, "top5Concentration": 58.93, "retainerChurnRate": 100.0 },
  "2025-04": { "date": "2025-04", "monthlyRevenue": 85120, "avgDealSize": 6080, "newClientsAcquired": 3, "newClientRevenue": 32622, "repeatClientRevenue": 52498, "pctRevenueFromNew": 38.32, "activeClients": 16, "activeRetainers": 2, "mrr": 2942, "arrRunRate": 35308, "ltv": 27247, "largestSingleClientPct": 16.27, "top5Concentration": 57.28, "retainerChurnRate": 100.0 },
  "2025-05": { "date": "2025-05", "monthlyRevenue": 41336, "avgDealSize": 3445, "newClientsAcquired": 2, "newClientRevenue": 16609, "repeatClientRevenue": 24727, "pctRevenueFromNew": 40.18, "activeClients": 16, "activeRetainers": 4, "mrr": 8479, "arrRunRate": 101744, "ltv": 26901, "largestSingleClientPct": 16.79, "top5Concentration": 57.13, "retainerChurnRate": 100.0 },
  "2025-06": { "date": "2025-06", "monthlyRevenue": 51158, "avgDealSize": 2842, "newClientsAcquired": 3, "newClientRevenue": 14292, "repeatClientRevenue": 36866, "pctRevenueFromNew": 27.94, "activeClients": 16, "activeRetainers": 3, "mrr": 7759, "arrRunRate": 93112, "ltv": 26181, "largestSingleClientPct": 17.36, "top5Concentration": 57.67, "retainerChurnRate": 100.0 },
  "2025-07": { "date": "2025-07", "monthlyRevenue": 90843, "avgDealSize": 4326, "newClientsAcquired": 1, "newClientRevenue": 10935, "repeatClientRevenue": 79908, "pctRevenueFromNew": 12.04, "activeClients": 14, "activeRetainers": 5, "mrr": 12721, "arrRunRate": 152652, "ltv": 27720, "largestSingleClientPct": 17.05, "top5Concentration": 58.59, "retainerChurnRate": 83.33 },
  "2025-08": { "date": "2025-08", "monthlyRevenue": 119018, "avgDealSize": 6264, "newClientsAcquired": 4, "newClientRevenue": 91320, "repeatClientRevenue": 27698, "pctRevenueFromNew": 76.73, "activeClients": 19, "activeRetainers": 6, "mrr": 39519, "arrRunRate": 474232, "ltv": 27897, "largestSingleClientPct": 15.49, "top5Concentration": 57.12, "retainerChurnRate": 71.43 },
  "2025-09": { "date": "2025-09", "monthlyRevenue": 81683, "avgDealSize": 4538, "newClientsAcquired": 4, "newClientRevenue": 23492, "repeatClientRevenue": 58191, "pctRevenueFromNew": 28.76, "activeClients": 22, "activeRetainers": 6, "mrr": 40028, "arrRunRate": 480336, "ltv": 27299, "largestSingleClientPct": 15.52, "top5Concentration": 54.74, "retainerChurnRate": 77.78 },
  "2025-10": { "date": "2025-10", "monthlyRevenue": 89631, "avgDealSize": 4268, "newClientsAcquired": 4, "newClientRevenue": 37618, "repeatClientRevenue": 52013, "pctRevenueFromNew": 41.97, "activeClients": 25, "activeRetainers": 9, "mrr": 50301, "arrRunRate": 603608, "ltv": 26937, "largestSingleClientPct": 15.3, "top5Concentration": 53.04, "retainerChurnRate": 83.33 },
  "2025-11": { "date": "2025-11", "monthlyRevenue": 107687, "avgDealSize": 4682, "newClientsAcquired": 5, "newClientRevenue": 40595, "repeatClientRevenue": 67092, "pctRevenueFromNew": 37.7, "activeClients": 29, "activeRetainers": 11, "mrr": 57571, "arrRunRate": 690852, "ltv": 26479, "largestSingleClientPct": 14.25, "top5Concentration": 51.7, "retainerChurnRate": 86.67 },
  "2025-12": { "date": "2025-12", "monthlyRevenue": 50574, "avgDealSize": 4598, "newClientsAcquired": 3, "newClientRevenue": 31911, "repeatClientRevenue": 18663, "pctRevenueFromNew": 63.1, "activeClients": 24, "activeRetainers": 11, "mrr": 35620, "arrRunRate": 427440, "ltv": 26014, "largestSingleClientPct": 14.3, "top5Concentration": 50.8, "retainerChurnRate": 88.24 },
  "2026-01": { "date": "2026-01", "monthlyRevenue": 52760, "avgDealSize": 4058, "newClientsAcquired": 3, "newClientRevenue": 29802, "repeatClientRevenue": 22958, "pctRevenueFromNew": 56.49, "activeClients": 20, "activeRetainers": 10, "mrr": 33557, "arrRunRate": 402680, "ltv": 25625, "largestSingleClientPct": 14.15, "top5Concentration": 49.5, "retainerChurnRate": 88.89 },
  "2026-02": { "date": "2026-02", "monthlyRevenue": 157464, "avgDealSize": 6056, "newClientsAcquired": 7, "newClientRevenue": 82523, "repeatClientRevenue": 74941, "pctRevenueFromNew": 52.41, "activeClients": 25, "activeRetainers": 12, "mrr": 49891, "arrRunRate": 598692, "ltv": 25320, "largestSingleClientPct": 13.59, "top5Concentration": 46.98, "retainerChurnRate": 80.0 },
  "2026-03": { "date": "2026-03", "monthlyRevenue": 38904, "avgDealSize": 3242, "newClientsAcquired": 1, "newClientRevenue": 6759, "repeatClientRevenue": 32145, "pctRevenueFromNew": 17.37, "activeClients": 23, "activeRetainers": 9, "mrr": 42619, "arrRunRate": 511424, "ltv": 25506, "largestSingleClientPct": 14.24, "top5Concentration": 47.07, "retainerChurnRate": 75.0 },
  "2026-04": { "date": "2026-04", "monthlyRevenue": 88576, "avgDealSize": 4429, "newClientsAcquired": 6, "newClientRevenue": 48835, "repeatClientRevenue": 39741, "pctRevenueFromNew": 55.13, "activeClients": 27, "activeRetainers": 12, "mrr": 51110, "arrRunRate": 613320, "ltv": 24690, "largestSingleClientPct": 13.93, "top5Concentration": 45.51, "retainerChurnRate": 78.26, "cac": 1248, "cpl": 124, "cpm": 48.64, "dailyAdSpendGoal": 170, "monthlyAdSpend": 5144, "predictedAdSpend": 5100, "tenMonthAdSpend": 51000, "conversionRate": 15, "dailyChurnRate": 0.84, "ltvCacRatio": 19.78 },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { admin, db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  try {
    // Read existing so we can merge instead of clobbering any fields the
    // founder manually added (e.g. Tier-3 quarterly values entered by hand
    // that the backfill sheet doesn't have).
    const existing = (await db.ref("/foundersMetrics").once("value")).val() || {};

    const writes = {};
    let newMonths = 0;
    let updatedMonths = 0;
    for (const [month, payload] of Object.entries(BACKFILL)) {
      const prior = existing[month] || null;
      if (prior) {
        updatedMonths++;
        // Merge — prior non-empty values win on fields the backfill
        // doesn't explicitly set, BUT backfill values always win on
        // fields it DOES set (those are the "ground truth" from the
        // spreadsheet). This way a founder who filled Tier-3 fields
        // manually keeps them; revenue/MRR/etc get corrected.
        writes[month] = { ...prior };
        for (const [k, v] of Object.entries(payload)) {
          // Skip if backfill value is empty/null — don't overwrite
          // manual fills with blanks.
          if (v === "" || v == null) continue;
          writes[month][k] = v;
        }
      } else {
        newMonths++;
        writes[month] = { ...payload };
      }
    }

    // Batched write — one Firebase round-trip instead of 44.
    await db.ref("/foundersMetrics").update(writes);

    const firstMonth = Object.keys(BACKFILL).sort()[0];
    const lastMonth = Object.keys(BACKFILL).sort().pop();

    return res.status(200).json({
      ok: true,
      range: `${firstMonth} → ${lastMonth}`,
      totalMonths: Object.keys(BACKFILL).length,
      newMonths,
      updatedMonths,
    });
  } catch (e) {
    console.error("seed-founders-metrics error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
