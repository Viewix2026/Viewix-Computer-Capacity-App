// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// Creates the "Hormozi" entry in the Meta Ads half of the Format Library.
// Captures the framework the current Meta Ads preproduction flow is
// already built around (motivator types × audience awareness × a
// columnar script structure) so Phase 2+ of the Meta Ads rebuild can
// select this format from the library like any other.

import { adminSet, adminGet, getAdmin } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-hormozi-a6c1f4b9d7e24d83bc9f01e253c87f4a";

const FORMAT = {
  id: "fmt_hormozi_metaads_seed",
  formatType: "metaAds",
  name: "Hormozi",
  videoAnalysis: "Direct-response Meta ad framework Viewix has used for every Meta Ads package since 2024. Built around Alex Hormozi's motivator taxonomy (Toward / Away From / Tried Before) crossed with audience-awareness stages (Problem Aware, and at Deluxe tier also Problem Unaware). Each script leads with an aggressive interrupt hook, names the pain in one line, paints the aspirational outcome, then hands over to the offer — designed to feel like a mate explaining something, not a brand pitching.",
  filmingInstructions: "Direct-to-camera, single presenter (the client or a founder), minimal props. Locations must be repeatable across dozens of ads in one day — typically 2-3 indoor angles plus one outdoor if applicable. Hook scene visually interesting but re-shootable (whiteboard, product in hand, desk setup). Tight framing, shallow depth of field, handheld-feel camera movement. Avoid heavy set dressing — the pattern interrupt lives in the line delivery, not the backdrop.",
  structureInstructions: "Seven-column script blueprint, played back to back within one 30-60s video:\n\n1. Hook — one or two sentences, pattern-interrupt line that challenges a belief, names a mistake, or raises stakes. Default slightly more aggressive than safe. Speak directly (\"you\"), lead with tension not explanation. Match brand personality (Challenger / Authoritative / Refined / Friendly / Playful).\n\n2. Explain the Pain — one sentence only. Core frustration captured through a metaphor, physical detail, or telling moment. Name it and move on.\n\n3. Results — one sentence only. Aspirational outcome from the viewer's POV. Do NOT pitch the product or name the client's company. Must bridge from Pain (feel like continuation, not a reset).\n\n4. The Offer — two sentences max. Opens with \"At {company}, we...\" Spoken, natural language, accurate to what was discussed in the onboarding call. Focus on what the client receives, not on how it's made.\n\n5. Why the Offer — one or two short sentences. Emotional reason to want the product. Not a logical summary — the feeling behind the decision.\n\n6. Call to Action — one short sentence, always uses \"tap\" (never click). Relates directly to the pain raised at the top.\n\n7. Meta Ad Headline + Ad Copy (written beats, not spoken). Headline hard limit 35 characters. Ad copy 60-120 words, written like a person explaining to a mate — no em dashes, no AI-sounding corporate voice, one idea per ad (Pain → Insight → Outcome → Simple action).\n\nAd count per package (drives total script rows in generation):\n- Starter: 6 ads · 2 motivators per type · Problem Aware only\n- Standard: 9 ads · 3 motivators per type · Problem Aware only\n- Premium: 15 ads · 5 motivators per type · Problem Aware only\n- Deluxe: 30 ads · 5 motivators per type · Problem Aware + Problem Unaware (doubles the rows)\n\nVideo naming convention: {number}_{motivator_initials}_{topic}_{audience_initials}\nE.g. 01_TM_YourDesign_PA, 14_AF_BurnBudget_PA, 23_TB_HiredAgency_PU.\nTM = Toward Motivator · AF = Away From · TB = Tried Before · PA = Problem Aware · PU = Problem Unaware.",
  tags: ["direct-to-camera", "direct-response", "problem-aware", "motivator-based", "hormozi", "meta-ads-default"],
  examples: [],
  sourceProjectId: null,
  sourceClient: "Viewix house format",
  createdAt: new Date().toISOString(),
  createdBy: "seed",
  usageCount: 0,
  archived: false,
  updatedAt: new Date().toISOString(),
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const { err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  try {
    const existing = await adminGet(`/formatLibrary/${FORMAT.id}`);
    if (existing) {
      return res.status(200).json({ ok: true, action: "skipped", reason: "already exists", id: FORMAT.id });
    }
    await adminSet(`/formatLibrary/${FORMAT.id}`, FORMAT);
    return res.status(200).json({ ok: true, action: "created", id: FORMAT.id });
  } catch (e) {
    console.error("seed-hormozi-format failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
