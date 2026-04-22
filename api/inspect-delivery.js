// ONE-SHOT INSPECT ENDPOINT — DELETE AFTER USE.
// Admin-SDK read of /deliveries so we can see exactly what shortIds
// exist and what the "w6mde4" record actually looks like (or doesn't).

import { adminGet, getAdmin } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "inspect-delivery-b82d47e6c15948a1ba9f03c71e6d8a59";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const { err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  try {
    const all = (await adminGet("/deliveries")) || {};
    const list = Object.values(all).filter(d => d && d.id);
    const total = list.length;

    // Exact-match lookup
    const targetShortId = "w6mde4";
    const exactMatch = list.find(d => (d.shortId || "").toLowerCase() === targetShortId);

    // Fuzzy — contains any fragment of the target company/project name
    const matches = list.filter(d => {
      const haystack = `${d.clientName || ""} ${d.projectName || ""} ${d.shortId || ""}`.toLowerCase();
      return haystack.includes("new living") || haystack.includes("badagarang");
    }).map(d => ({
      id: d.id,
      shortId: d.shortId || null,
      clientName: d.clientName || null,
      projectName: d.projectName || null,
      videoCount: Array.isArray(d.videos) ? d.videos.length : 0,
    }));

    // Sample of first 5 shortIds so we can see the shape
    const sample = list.slice(0, 5).map(d => ({
      shortId: d.shortId || null,
      clientName: d.clientName || null,
    }));

    return res.status(200).json({
      ok: true,
      totalDeliveries: total,
      exactMatchForShortId: exactMatch ? {
        id: exactMatch.id,
        shortId: exactMatch.shortId,
        clientName: exactMatch.clientName,
        projectName: exactMatch.projectName,
      } : null,
      fuzzyMatches: matches,
      firstFiveShortIds: sample,
    });
  } catch (e) {
    console.error("inspect-delivery failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
