// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// Patches nextStepsCopy across all 11 tier slots without touching
// videoUrl. Uses adminPatch on each tier path so the existing videos
// stay intact.

import { adminPatch } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-nextsteps-5f2e83b4c6a1478d9e3f0b2c58d1a9e6";

const COPY = "We're excited to work with you! If you don't yet have a Pre Production meeting in the calendar please schedule one below.";

const SLOTS = [
  ["metaAds", "starter"],
  ["metaAds", "standard"],
  ["metaAds", "premium"],
  ["metaAds", "deluxe"],
  ["socialPremium", "starter"],
  ["socialPremium", "brandBuilder"],
  ["socialPremium", "marketLeader"],
  ["socialPremium", "marketDominator"],
  ["socialOrganic", "starter"],
  ["socialOrganic", "brandBuilder"],
  ["socialOrganic", "marketLeader"],
  ["socialOrganic", "marketDominator"],
  ["liveAction", "base"],
  ["ninetyDayGp", "base"],
  ["animation", "base"],
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await Promise.all(
      SLOTS.map(([videoType, tier]) =>
        adminPatch(`/saleThankYou/packages/${videoType}/${tier}`, { nextStepsCopy: COPY })
      )
    );
    return res.status(200).json({ ok: true, patched: SLOTS.length });
  } catch (e) {
    console.error("seed-next-steps failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
