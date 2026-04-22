// ONE-SHOT SEED ENDPOINT — DELETE AFTER USE.
// Writes Vish Peiris's Google Drive photo URL onto his roster entry.
// /editors is stored as an array (Firebase's array-ish object shape),
// keyed by positional index — we look up the index of the "Vish..."
// entry then write the avatarUrl leaf.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "seed-vish-avatar-e4b7c921a5d346f8ba9103e572c84f1d";

// Drive share URL from Jeremy. normaliseImageUrl on the frontend
// converts /file/d/.../view to /thumbnail?id=... at render time, so
// we can store the original share URL here and let the normaliser
// handle it. Either form works — producers pasting into the roster
// don't need to know about the conversion.
const VISH_PHOTO_URL = "https://drive.google.com/file/d/16ITrH4NuhHNi68FAyRVrR2PnD53vORH1/view?usp=sharing";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const { err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  try {
    const editors = (await adminGet("/editors")) || [];
    const list = Array.isArray(editors) ? editors : Object.values(editors);
    const idx = list.findIndex(e => e && (e.name || "").toLowerCase().startsWith("vish"));
    if (idx < 0) {
      return res.status(404).json({ error: "No roster entry starting with 'Vish' — check Capacity > Team Roster.", rosterNames: list.map(e => e?.name).filter(Boolean) });
    }
    await adminSet(`/editors/${idx}/avatarUrl`, VISH_PHOTO_URL);
    return res.status(200).json({
      ok: true,
      editorIndex: idx,
      editorName: list[idx].name,
      avatarUrl: VISH_PHOTO_URL,
      note: "Pasted as Drive share URL; frontend normaliseImageUrl converts to /thumbnail at render time.",
    });
  } catch (e) {
    console.error("seed-vish-avatar failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
