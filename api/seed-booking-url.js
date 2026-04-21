// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// Patches only bookingUrl + bookingEmbed on /saleThankYou so the existing
// per-package video URLs stay intact (uses adminPatch, not adminSet).

import { adminPatch } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-booking-b82f1c47e5a949f7b6d3a0c48e21f7d9";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await adminPatch("/saleThankYou", {
      bookingUrl: "https://tidycal.com/jeremyfarrugia/preproduction",
      bookingEmbed: true,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("seed-booking-url failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
