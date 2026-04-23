// api/seed-additional-metrics.js
// ONE-SHOT — backfill the 10 additional fields from the xlsx
// "Additional Metrics" sheet across 44 months. Covers the Tier-3
// / quarterly fields previously empty in the dashboard:
//
//   avgDealSizeProject, avgDealSizeRetainer, ltvRetainer, ltvProject,
//   paybackPeriod, retainerRenewalRate, allClientChurnYoY,
//   avgDaysBetweenRepeatDeals, netRevenueRetention, pctRevenueFromTopSource
//
// Merge semantics: skips fields that already exist on the record,
// so manual corrections persist. Idempotent; safe to re-run.
//
// Usage: curl -X POST https://planner.viewix.com.au/api/seed-additional-metrics
//
// Delete after confirming the dashboard fills in.

import { getAdmin } from "./_fb-admin.js";

const BACKFILL = {
  "2022-09": { "avgDealSizeProject": 7545, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 7545, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 0, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 100.0 },
  "2022-10": { "avgDealSizeProject": 1555, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 4550, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 0, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 82.91 },
  "2022-11": { "avgDealSizeProject": 4145, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 6622, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 56.96 },
  "2022-12": { "avgDealSizeProject": 1100, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 7172, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 22, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 52.6 },
  "2023-01": { "avgDealSizeProject": 0, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 7172, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 22, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 52.6 },
  "2023-02": { "avgDealSizeProject": 5000, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 6448, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 22, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 39.0 },
  "2023-03": { "avgDealSizeProject": 5721, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 8139, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 54.21 },
  "2023-04": { "avgDealSizeProject": 3582, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 10378, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 14, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 42.52 },
  "2023-05": { "avgDealSizeProject": 2526, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 12904, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 47.59 },
  "2023-06": { "avgDealSizeProject": 7332, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 15455, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 44.74 },
  "2023-07": { "avgDealSizeProject": 2726, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 16545, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 47.21 },
  "2023-08": { "avgDealSizeProject": 8832, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 17483, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 43.96 },
  "2023-09": { "avgDealSizeProject": 2815, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 17916, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 0.0, "avgDaysBetweenRepeatDeals": 17, "netRevenueRetention": 0.0, "pctRevenueFromTopSource": 42.9 },
  "2023-10": { "avgDealSizeProject": 3009, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 19216, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 16, "netRevenueRetention": 137.62, "pctRevenueFromTopSource": 44.41 },
  "2023-11": { "avgDealSizeProject": 2924, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 19189, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 65.15, "pctRevenueFromTopSource": 45.62 },
  "2023-12": { "avgDealSizeProject": 3665, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 19877, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 52.48, "pctRevenueFromTopSource": 46.6 },
  "2024-01": { "avgDealSizeProject": 4906, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 20183, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 52.48, "pctRevenueFromTopSource": 45.89 },
  "2024-02": { "avgDealSizeProject": 3198, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 20583, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 33.33, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 77.68, "pctRevenueFromTopSource": 46.68 },
  "2024-03": { "avgDealSizeProject": 7700, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 22146, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 37.5, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 257.1, "pctRevenueFromTopSource": 42.75 },
  "2024-04": { "avgDealSizeProject": 4364, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 23116, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 37.5, "avgDaysBetweenRepeatDeals": 15, "netRevenueRetention": 185.93, "pctRevenueFromTopSource": 42.12 },
  "2024-05": { "avgDealSizeProject": 5205, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 23667, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 16, "netRevenueRetention": 153.44, "pctRevenueFromTopSource": 42.15 },
  "2024-06": { "avgDealSizeProject": 7437, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 23206, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 16, "netRevenueRetention": 94.4, "pctRevenueFromTopSource": 39.47 },
  "2024-07": { "avgDealSizeProject": 3888, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 22244, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 17, "netRevenueRetention": 84.32, "pctRevenueFromTopSource": 38.6 },
  "2024-08": { "avgDealSizeProject": 4758, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 22240, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 53.85, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 77.67, "pctRevenueFromTopSource": 41.47 },
  "2024-09": { "avgDealSizeProject": 3779, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 23919, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 50.0, "avgDaysBetweenRepeatDeals": 20, "netRevenueRetention": 82.33, "pctRevenueFromTopSource": 40.77 },
  "2024-10": { "avgDealSizeProject": 2487, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 24219, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 46.15, "avgDaysBetweenRepeatDeals": 20, "netRevenueRetention": 74.38, "pctRevenueFromTopSource": 39.86 },
  "2024-11": { "avgDealSizeProject": 4458, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 26459, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 46.67, "avgDaysBetweenRepeatDeals": 20, "netRevenueRetention": 99.77, "pctRevenueFromTopSource": 39.02 },
  "2024-12": { "avgDealSizeProject": 2438, "avgDealSizeRetainer": 0, "ltvRetainer": 0, "ltvProject": 26963, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 46.67, "avgDaysBetweenRepeatDeals": 20, "netRevenueRetention": 94.7, "pctRevenueFromTopSource": 38.79 },
  "2025-01": { "avgDealSizeProject": 2454, "avgDealSizeRetainer": 2158, "ltvRetainer": 2158, "ltvProject": 24564, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 46.67, "avgDaysBetweenRepeatDeals": 21, "netRevenueRetention": 93.52, "pctRevenueFromTopSource": 38.44 },
  "2025-02": { "avgDealSizeProject": 4146, "avgDealSizeRetainer": 0, "ltvRetainer": 2158, "ltvProject": 23924, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 53.33, "avgDaysBetweenRepeatDeals": 20, "netRevenueRetention": 98.69, "pctRevenueFromTopSource": 37.32 },
  "2025-03": { "avgDealSizeProject": 3952, "avgDealSizeRetainer": 0, "ltvRetainer": 2158, "ltvProject": 24035, "paybackPeriod": 0.0, "retainerRenewalRate": 0.0, "allClientChurnYoY": 53.33, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 77.17, "pctRevenueFromTopSource": 35.86 },
  "2025-04": { "avgDealSizeProject": 6035, "avgDealSizeRetainer": 6669, "ltvRetainer": 4414, "ltvProject": 24765, "paybackPeriod": 0.14, "retainerRenewalRate": 0.0, "allClientChurnYoY": 60.0, "avgDaysBetweenRepeatDeals": 19, "netRevenueRetention": 73.7, "pctRevenueFromTopSource": 38.03 },
  "2025-05": { "avgDealSizeProject": 2473, "avgDealSizeRetainer": 8304, "ltvRetainer": 6359, "ltvProject": 25414, "paybackPeriod": 0.15, "retainerRenewalRate": 0.0, "allClientChurnYoY": 56.25, "avgDaysBetweenRepeatDeals": 19, "netRevenueRetention": 68.22, "pctRevenueFromTopSource": 37.48 },
  "2025-06": { "avgDealSizeProject": 2842, "avgDealSizeRetainer": 0, "ltvRetainer": 6359, "ltvProject": 24440, "paybackPeriod": 0.15, "retainerRenewalRate": 0.0, "allClientChurnYoY": 52.94, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 81.38, "pctRevenueFromTopSource": 39.08 },
  "2025-07": { "avgDealSizeProject": 3849, "avgDealSizeRetainer": 7185, "ltvRetainer": 7832, "ltvProject": 25966, "paybackPeriod": 0.19, "retainerRenewalRate": 16.67, "allClientChurnYoY": 47.37, "avgDaysBetweenRepeatDeals": 17, "netRevenueRetention": 90.06, "pctRevenueFromTopSource": 40.94 },
  "2025-08": { "avgDealSizeProject": 2040, "avgDealSizeRetainer": 42172, "ltvRetainer": 18762, "ltvProject": 24825, "paybackPeriod": 0.19, "retainerRenewalRate": 28.57, "allClientChurnYoY": 45.0, "avgDaysBetweenRepeatDeals": 17, "netRevenueRetention": 76.58, "pctRevenueFromTopSource": 38.35 },
  "2025-09": { "avgDealSizeProject": 3947, "avgDealSizeRetainer": 7493, "ltvRetainer": 17091, "ltvProject": 24633, "paybackPeriod": 0.17, "retainerRenewalRate": 22.22, "allClientChurnYoY": 45.0, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 69.05, "pctRevenueFromTopSource": 36.61 },
  "2025-10": { "avgDealSizeProject": 3267, "avgDealSizeRetainer": 10273, "ltvRetainer": 15386, "ltvProject": 25447, "paybackPeriod": 0.17, "retainerRenewalRate": 16.67, "allClientChurnYoY": 42.86, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 71.19, "pctRevenueFromTopSource": 36.41 },
  "2025-11": { "avgDealSizeProject": 3593, "avgDealSizeRetainer": 9854, "ltvRetainer": 14937, "ltvProject": 24656, "paybackPeriod": 0.19, "retainerRenewalRate": 13.33, "allClientChurnYoY": 42.86, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 93.71, "pctRevenueFromTopSource": 38.65 },
  "2025-12": { "avgDealSizeProject": 3214, "avgDealSizeRetainer": 10824, "ltvRetainer": 14453, "ltvProject": 24736, "paybackPeriod": 0.19, "retainerRenewalRate": 11.76, "allClientChurnYoY": 42.86, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 92.34, "pctRevenueFromTopSource": 38.54 },
  "2026-01": { "avgDealSizeProject": 3664, "avgDealSizeRetainer": 8790, "ltvRetainer": 14138, "ltvProject": 24282, "paybackPeriod": 0.18, "retainerRenewalRate": 11.11, "allClientChurnYoY": 42.86, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 91.87, "pctRevenueFromTopSource": 39.01 },
  "2026-02": { "avgDealSizeProject": 3216, "avgDealSizeRetainer": 17984, "ltvRetainer": 16400, "ltvProject": 23374, "paybackPeriod": 0.19, "retainerRenewalRate": 20.0, "allClientChurnYoY": 40.91, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 83.68, "pctRevenueFromTopSource": 37.01 },
  "2026-03": { "avgDealSizeProject": 2855, "avgDealSizeRetainer": 7500, "ltvRetainer": 16757, "ltvProject": 23528, "paybackPeriod": 0.19, "retainerRenewalRate": 25.0, "allClientChurnYoY": 36.36, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 88.87, "pctRevenueFromTopSource": 37.34 },
  "2026-04": { "avgDealSizeProject": 2764, "avgDealSizeRetainer": 9424, "ltvRetainer": 15961, "ltvProject": 23043, "paybackPeriod": 0.2, "retainerRenewalRate": 21.74, "allClientChurnYoY": 37.5, "avgDaysBetweenRepeatDeals": 18, "netRevenueRetention": 72.42, "pctRevenueFromTopSource": 36.49 },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { admin, db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  try {
    const existing = (await db.ref("/foundersMetrics").once("value")).val() || {};

    const writes = {};
    let monthsPatched = 0;
    let fieldsWritten = 0;
    let fieldsSkipped = 0;
    for (const [month, payload] of Object.entries(BACKFILL)) {
      const prior = existing[month] || { date: month };
      const merged = { ...prior };
      let added = 0;
      for (const [k, v] of Object.entries(payload)) {
        // Skip if the field already exists on the record AND has a
        // non-empty value — preserves manual entries. Zeros count as
        // populated since the spreadsheet deliberately set them.
        if (merged[k] !== undefined && merged[k] !== "" && merged[k] !== null) {
          fieldsSkipped++;
          continue;
        }
        merged[k] = v;
        added++;
      }
      if (added > 0) {
        writes[month] = merged;
        monthsPatched++;
        fieldsWritten += added;
      }
    }

    if (Object.keys(writes).length > 0) {
      await db.ref("/foundersMetrics").update(writes);
    }

    return res.status(200).json({
      ok: true,
      monthsPatched,
      fieldsWritten,
      fieldsSkipped,
      totalMonthsInBackfill: Object.keys(BACKFILL).length,
    });
  } catch (e) {
    console.error("seed-additional-metrics error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
