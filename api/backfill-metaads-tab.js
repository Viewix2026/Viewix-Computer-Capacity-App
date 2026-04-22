// api/backfill-metaads-tab.js
// ONE-SHOT — stamp `tab: "brandTruth"` on every /preproduction/metaAds
// project that's missing the field. Without `tab`, the Preproduction
// component falls through to the legacy single-page view instead of
// the new 6-tab Meta Ads Research flow. Manually-created projects
// weren't getting the field set; this backfill lights them all up.
//
// Delete this file once the dashboard shows tabs on every existing
// metaAds project.
//
// Usage: curl -X POST https://planner.viewix.com.au/api/backfill-metaads-tab

import { adminGet, adminPatch } from "./_fb-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const all = await adminGet("/preproduction/metaAds");
    if (!all) return res.status(200).json({ ok: true, message: "No metaAds projects found", patched: 0 });

    const patches = [];
    const skipped = [];
    for (const [id, proj] of Object.entries(all)) {
      if (!proj || typeof proj !== "object") continue;
      if (proj.tab) {
        skipped.push({ id, existing: proj.tab });
        continue;
      }
      await adminPatch(`/preproduction/metaAds/${id}`, { tab: "brandTruth" });
      patches.push({ id, company: proj.companyName || "?" });
    }

    res.status(200).json({
      ok: true,
      patched: patches.length,
      patches,
      skipped_count: skipped.length,
      skipped,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
