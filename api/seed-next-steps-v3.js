// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// v3 tweaks: regular hyphens instead of em dashes, shorter copy, softer
// contact line that points customers to their Viewix contact directly.

import { adminPatch } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-nextsteps-v3-d19f6a07b5e84c2bac8e03f47195d2c1";

const COPY = `**Welcome to the Viewix family. 🎬**

We're genuinely excited to start creating with you.

**Here's what happens next:**

- Watch the short welcome video above if you haven't already
- **Book your Pre-Production meeting below** if you haven't already - this is where we lock in your brief, creative direction, and timelines

If anything comes up in the meantime, please reach out to your Viewix contact directly.

Talk soon,
The Viewix Team`;

const SLOTS = [
  ["metaAds", "starter"], ["metaAds", "standard"], ["metaAds", "premium"], ["metaAds", "deluxe"],
  ["socialPremium", "starter"], ["socialPremium", "brandBuilder"], ["socialPremium", "marketLeader"], ["socialPremium", "marketDominator"],
  ["socialOrganic", "starter"], ["socialOrganic", "brandBuilder"], ["socialOrganic", "marketLeader"], ["socialOrganic", "marketDominator"],
  ["liveAction", "base"], ["ninetyDayGp", "base"], ["animation", "base"],
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) return res.status(403).json({ error: "Forbidden" });
  try {
    await Promise.all(SLOTS.map(([vt, tier]) =>
      adminPatch(`/saleThankYou/packages/${vt}/${tier}`, { nextStepsCopy: COPY })
    ));
    return res.status(200).json({ ok: true, patched: SLOTS.length });
  } catch (e) {
    console.error("seed-next-steps-v3 failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
