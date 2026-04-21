// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// Overwrites nextStepsCopy on all tier slots with polished formatted copy.

import { adminPatch } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-nextsteps-v2-8e3c47b9a2d54f16a9b0c8f3e7d2a1b5";

const COPY = `**Welcome to the Viewix family. 🎬**

We're genuinely excited to start creating with you.

**Here's what happens next:**

- Watch the short welcome video above if you haven't already
- **Book your Pre-Production meeting below** — this is where we lock in your brief, creative direction, and timelines, so we turn up to the shoot with a clear plan
- You'll hear from the team within 24 hours with a short onboarding pack and next dates

If anything comes up in the meantime, just reply to your payment receipt email.

Talk soon,
The Viewix Team`;

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
      SLOTS.map(([vt, tier]) =>
        adminPatch(`/saleThankYou/packages/${vt}/${tier}`, { nextStepsCopy: COPY })
      )
    );
    return res.status(200).json({ ok: true, patched: SLOTS.length });
  } catch (e) {
    console.error("seed-next-steps-v2 failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
