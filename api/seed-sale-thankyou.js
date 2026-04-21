// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
//
// Writes the initial /saleThankYou payload (per-package welcome video URLs)
// to Firebase. Protected by a hardcoded token so arbitrary public callers
// can't hit it. Because the token is committed to git, the safest posture
// is to delete this file in the next commit once the seed runs.
//
// Usage:
//   curl -X POST 'https://planner.viewix.com.au/api/seed-sale-thankyou?token=TOKEN_BELOW'
//
// Returns 200 with { ok: true } on success.

import { adminSet } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-thankyou-a7f3e9c2d4b148208e5f6c9a2f1e3d0b";

const META_ADS_VIDEO        = "https://www.youtube.com/watch?v=LygCf5hQcCk";
const SOCIAL_RETAINER_VIDEO = "https://www.youtube.com/watch?v=-o7QGu3zdAI";
const OTHER_VIDEO           = "https://www.youtube.com/shorts/cF5RO1_0BcI";

const EMPTY_COPY = "";

const PAYLOAD = {
  bookingUrl: "",
  packages: {
    metaAds: {
      starter:  { videoUrl: META_ADS_VIDEO, nextStepsCopy: EMPTY_COPY },
      standard: { videoUrl: META_ADS_VIDEO, nextStepsCopy: EMPTY_COPY },
      premium:  { videoUrl: META_ADS_VIDEO, nextStepsCopy: EMPTY_COPY },
      deluxe:   { videoUrl: META_ADS_VIDEO, nextStepsCopy: EMPTY_COPY },
    },
    socialPremium: {
      starter:         { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
      brandBuilder:    { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
      marketLeader:    { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
      marketDominator: { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
    },
    socialOrganic: {
      starter:         { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
      brandBuilder:    { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
      marketLeader:    { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
      marketDominator: { videoUrl: SOCIAL_RETAINER_VIDEO, nextStepsCopy: EMPTY_COPY },
    },
    liveAction:  { base: { videoUrl: OTHER_VIDEO, nextStepsCopy: EMPTY_COPY } },
    ninetyDayGp: { base: { videoUrl: OTHER_VIDEO, nextStepsCopy: EMPTY_COPY } },
    animation:   { base: { videoUrl: OTHER_VIDEO, nextStepsCopy: EMPTY_COPY } },
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await adminSet("/saleThankYou", PAYLOAD);
    return res.status(200).json({ ok: true, slots: 11 });
  } catch (e) {
    console.error("seed-sale-thankyou failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
