// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// Creates the missing "New Living Homes — Badagarang Display Homes"
// delivery with 16 empty video placeholders and a fresh 6-char
// shortId. Returns the new share URL so Jeremy can grab it without
// digging through Firebase.

import { adminSet, getAdmin } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-nlh-delivery-4f8a21c9e6d34b17a8b5f02e16c39d7b";

// Same 32-char alphabet as utils.makeShortId on the frontend, so the
// id this produces looks identical to one the dashboard would mint.
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function makeShortId() {
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const { err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const now = new Date().toISOString();
  const id = `del-${Date.now()}`;
  const shortId = makeShortId();
  const clientName = "New Living Homes";
  const projectName = "1 B - New Living Homes - Badagarang Display Homes - Brand Builder Social Package";
  const videos = Array.from({ length: 16 }, (_, i) => ({
    id: `vid-${Date.now()}-${i}`,
    name: `Video ${i + 1}`,
    link: "",
    viewixStatus: "In Development",
    revision1: "",
    revision2: "",
  }));

  const record = {
    id,
    shortId,
    clientName,
    projectName,
    logoUrl: "",
    notes: "",
    videos,
    createdAt: now,
  };

  try {
    await adminSet(`/deliveries/${id}`, record);

    // Build the same slug + URL shape the frontend would (utils.deliveryShareUrl).
    // Slug = slugify("clientName projectName") lowercased, non-alphanum → hyphens,
    // trimmed to 60 chars. Matches src/utils.js:slugify.
    const slug = `${clientName} ${projectName}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 60);
    const shareUrl = `https://planner.viewix.com.au/d/${shortId}/${slug}`;

    return res.status(200).json({
      ok: true,
      id,
      shortId,
      shareUrl,
      videoCount: videos.length,
    });
  } catch (e) {
    console.error("seed-new-living-homes-delivery failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
