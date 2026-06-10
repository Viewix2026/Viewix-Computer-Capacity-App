// api/transcript-insights.js
// Founder ops for the Transcript Insights Lab: merge two items, archive,
// unarchive. Ingestion is NOT here — the inline extraction pass and the
// self-heal cron own that. This endpoint exists because /transcriptInsights
// is `.write:false` at the RTDB rules layer; ALL mutations go server-side
// through the admin SDK (which bypasses rules).

import { adminGet, runRtdbTransaction } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors, actorFrom } from "./_requireAuth.js";
import { maxSeverity } from "./_transcript-insights.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try {
    // normalizeRole maps legacy "founder" → "manager", so this admits
    // the founders + manager (admin) tier — consistent with the rest of
    // the app's admin gating, and the UI controls live in the
    // founders-only Founders subtab anyway.
    decoded = await requireRole(req, ["founders", "founder"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { action } = req.body || {};
  const now = new Date().toISOString();
  const actor = actorFrom(decoded);

  try {
    if (action === "merge") {
      const { survivorId, loserId } = req.body || {};
      if (!survivorId || !loserId || survivorId === loserId) {
        return res.status(400).json({ error: "merge needs distinct survivorId and loserId" });
      }

      // Archive the loser first and capture its committed snapshot so we
      // fold in exactly the weight/sources it had at archive time.
      const loserRes = await runRtdbTransaction(`/transcriptInsights/items/${loserId}`, (cur) => {
        // Null = the SDK's cold-cache first run; pass it through so the
        // SDK refetches and re-runs with the real record. Aborting here
        // 409s every merge from a fresh lambda. A genuinely-missing item
        // commits null and is caught by the !snapshot check below.
        if (cur === null) return cur;
        if (cur.status !== "active") return undefined;
        return { ...cur, status: "archived", mergedInto: survivorId, archivedAt: now, archivedBy: actor };
      });
      if (!loserRes.committed || !loserRes.snapshot) {
        return res.status(409).json({ error: "loser not found or not active" });
      }
      const loser = loserRes.snapshot || {};

      const survRes = await runRtdbTransaction(`/transcriptInsights/items/${survivorId}`, (cur) => {
        if (cur === null) return cur; // cold-cache first run — see loser tx
        if (cur.status !== "active") return undefined;
        const sources = [...(loser.sources || []), ...(cur.sources || [])]
          .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
          .slice(0, 20);
        return {
          ...cur,
          weight: (cur.weight || 0) + (loser.weight || 0),
          severity: maxSeverity(cur.severity, loser.severity),
          sources,
          mergedFrom: [...(cur.mergedFrom || []), loserId],
          lastSeenAt: now,
        };
      });
      if (!survRes.committed || !survRes.snapshot) {
        // Best-effort rollback so the loser isn't orphaned-archived.
        await runRtdbTransaction(`/transcriptInsights/items/${loserId}`, (cur) =>
          cur === null ? cur : { ...cur, status: "active", mergedInto: null, archivedAt: null, archivedBy: null }
        ).catch(() => {});
        return res.status(409).json({ error: "survivor not found or not active (loser restored)" });
      }
      return res.status(200).json({ ok: true, survivor: survRes.snapshot });
    }

    if (action === "archive" || action === "unarchive") {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      const target = action === "archive" ? "active" : "archived";
      const nextStatus = action === "archive" ? "archived" : "active";
      const r = await runRtdbTransaction(`/transcriptInsights/items/${id}`, (cur) => {
        if (cur === null) return cur; // cold-cache first run — see merge tx
        if (cur.status !== target) return undefined;
        if (action === "archive") {
          return { ...cur, status: "archived", archivedAt: now, archivedBy: actor };
        }
        return { ...cur, status: "active", archivedAt: null, archivedBy: null };
      });
      if (!r.committed || !r.snapshot) {
        return res.status(409).json({ error: `item not found or not ${target}` });
      }
      return res.status(200).json({ ok: true, status: nextStatus, item: r.snapshot });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("transcript-insights ops error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
