// api/seed-source-breakdown.js
// ONE-SHOT — backfill per-source new-client counts into /foundersMetrics.
// Sourced from the "New Clients by Source" sheet in
// Viewix_Monthly_Dashboard_Backfill.xlsx. Stamps 8 fields per month
// (newClientsReferral / Advertising / LinkedIn / SEO / Conference /
// ColdEmail / Repeat / Other) onto each existing foundersMetrics row.
//
// Merge semantics: only writes fields that aren't already present on
// the existing record — preserves any manual source-split edits the
// founder might have made. Idempotent; running twice is safe.
//
// Usage: curl -X POST https://planner.viewix.com.au/api/seed-source-breakdown
//
// Delete after confirming the Sources category fills in on the
// Founders → Data tab.

import { getAdmin } from "./_fb-admin.js";

const BACKFILL = {
  "2022-09": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 1, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2022-10": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 1 },
  "2022-11": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2022-12": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-01": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-02": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-03": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 2, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 2, "newClientsOther": 1 },
  "2023-04": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-05": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-06": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 1, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-07": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-08": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 2, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-09": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-10": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 1, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-11": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 1, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2023-12": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-01": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-02": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-03": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 1, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-04": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-05": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 2, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-06": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 1, "newClientsSEO": 0, "newClientsConference": 1, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-07": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 1, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-08": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 1, "newClientsRepeat": 0, "newClientsOther": 1 },
  "2024-09": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-10": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 1, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-11": { "newClientsReferral": 1, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2024-12": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-01": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-02": { "newClientsReferral": 2, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-03": { "newClientsReferral": 2, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-04": { "newClientsReferral": 1, "newClientsAdvertising": 2, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-05": { "newClientsReferral": 0, "newClientsAdvertising": 2, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-06": { "newClientsReferral": 3, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-07": { "newClientsReferral": 0, "newClientsAdvertising": 1, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2025-08": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 2, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 2, "newClientsOther": 0 },
  "2025-09": { "newClientsReferral": 0, "newClientsAdvertising": 2, "newClientsLinkedIn": 1, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 1, "newClientsOther": 0 },
  "2025-10": { "newClientsReferral": 0, "newClientsAdvertising": 3, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 1, "newClientsOther": 0 },
  "2025-11": { "newClientsReferral": 1, "newClientsAdvertising": 3, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 1, "newClientsOther": 0 },
  "2025-12": { "newClientsReferral": 0, "newClientsAdvertising": 2, "newClientsLinkedIn": 0, "newClientsSEO": 1, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2026-01": { "newClientsReferral": 1, "newClientsAdvertising": 2, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
  "2026-02": { "newClientsReferral": 0, "newClientsAdvertising": 4, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 1, "newClientsColdEmail": 0, "newClientsRepeat": 2, "newClientsOther": 0 },
  "2026-03": { "newClientsReferral": 0, "newClientsAdvertising": 0, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 0, "newClientsColdEmail": 0, "newClientsRepeat": 1, "newClientsOther": 0 },
  "2026-04": { "newClientsReferral": 2, "newClientsAdvertising": 3, "newClientsLinkedIn": 0, "newClientsSEO": 0, "newClientsConference": 1, "newClientsColdEmail": 0, "newClientsRepeat": 0, "newClientsOther": 0 },
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
    for (const [month, sourceRow] of Object.entries(BACKFILL)) {
      const prior = existing[month] || { date: month };
      // Preserve every existing field. Only fill source fields that
      // aren't already set — means if the founder hand-entered a
      // correction for one month it won't get stomped.
      const merged = { ...prior };
      let added = 0;
      for (const [k, v] of Object.entries(sourceRow)) {
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
    console.error("seed-source-breakdown error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
