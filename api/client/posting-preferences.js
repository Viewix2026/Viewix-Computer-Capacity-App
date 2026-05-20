// api/client/posting-preferences.js
//
// Optional client-facing form, presented as a non-blocking prompt
// the moment the LAST video in a delivery flips to "Approved". Lets
// the client tell us their preferred posting cadence + days + times.
//
//   POST { deliveryId, postingOwner?, preferences? }
//   - postingOwner: "viewix" | "client" (the "Do you want Viewix to
//                   post these for you?" plain-language question).
//   - preferences:  { videosPerWeek, daysOfWeek, times } — optional.
//                   If the client skips the form, only postingOwner
//                   is written.
//
// Approval is INDEPENDENT of preferences — the form is purely
// non-blocking. Skipping it is fine; the producer modal falls back
// to tier defaults.

import { handleOptions, setCors, requireClientOrStaff, sendAuthError } from "../_requireAuth.js";
import { getAdmin } from "../_fb-admin.js";
import { emailKeyFor } from "../auth-google.js";

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let who;
  try { who = await requireClientOrStaff(req); }
  catch (e) { return sendAuthError(res, e); }

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });
  const db = admin.database();

  const body = req.body || {};
  const deliveryId = String(body.deliveryId || "");
  const postingOwner = body.postingOwner ? String(body.postingOwner) : null;
  const preferences = body.preferences || null;
  if (!deliveryId) return res.status(400).json({ error: "deliveryId required" });
  if (postingOwner && postingOwner !== "viewix" && postingOwner !== "client") {
    return res.status(400).json({ error: "postingOwner must be 'viewix' or 'client'" });
  }

  // Scope check — find the project owning this delivery and verify
  // the caller's allowed accountIds include it. Same pattern as
  // api/client/posting-schedule.js.
  let allowed;
  const emailKey = who.email ? emailKeyFor(who.email) : null;
  const reg = emailKey
    ? (await db.ref(`/clientAccess/${emailKey}`).once("value")).val()
    : null;
  if (reg && reg.accountIds) {
    allowed = new Set(Object.keys(reg.accountIds).filter(k => reg.accountIds[k]));
  } else if (who.kind === "staff") {
    const accountId = String(req.query.accountId || "");
    if (!accountId) return res.status(400).json({ error: "Staff support mode requires ?accountId=" });
    allowed = new Set([accountId]);
  } else {
    return res.status(403).json({ error: "No portal access" });
  }

  const projects = (await db.ref("/projects").once("value")).val() || {};
  const project = Object.values(projects).find(p => p && (p.links || {}).deliveryId === deliveryId);
  if (!project) return res.status(404).json({ error: "delivery_not_found_for_caller" });
  const accountId = project?.links?.accountId;
  if (!accountId || !allowed.has(accountId)) return res.status(403).json({ error: "Not your organisation" });

  // Write postingOwner if provided. Producer-side override authority is
  // preserved in the Deliveries detail UI — this endpoint just lets
  // the client express a preference.
  if (postingOwner) {
    await db.ref(`/deliveries/${deliveryId}/postingOwner`).set(postingOwner);

    // Mid-flight ownership change handling — if the client just
    // switched from "client" to "viewix" AND there are already-
    // approved videos, queue asset transfers for any that don't have
    // a /socialAssets row yet. (Codex catch from the planning phase.)
    if (postingOwner === "viewix") {
      const delivery = (await db.ref(`/deliveries/${deliveryId}`).once("value")).val();
      const videos = Array.isArray(delivery?.videos) ? delivery.videos : [];
      for (let idx = 0; idx < videos.length; idx++) {
        const v = videos[idx];
        if (!v) continue;
        const approved = v.revision1 === "Approved" || v.revision2 === "Approved";
        if (!approved) continue;
        const videoId = v.videoId || v.id;
        if (!videoId) continue;
        const assetKey = `${deliveryId}_${videoId}`;
        const existing = (await db.ref(`/socialAssets/${assetKey}`).once("value")).val();
        if (existing) continue;
        let frameioFileId = v.frameioFileId || null;
        if (!frameioFileId && v.link) {
          const m = String(v.link).match(/\/(?:files|reviews)\/([a-z0-9-]{6,})/i);
          if (m) frameioFileId = m[1];
        }
        await db.ref(`/socialAssets/${assetKey}`).set({
          deliveryId, videoId, videoIdx: idx, accountId, frameioFileId,
          status: frameioFileId ? "queued" : "failed",
          attempts: 0, queuedAt: Date.now(),
          queuedBy: "postingOwner-change",
          error: frameioFileId ? null : "No frameioFileId resolvable",
        });
      }
    }
  }

  if (preferences && typeof preferences === "object") {
    // Sanity-clamp the shape so a client can't post junk into our
    // schedule logic.
    const cleaned = {
      videosPerWeek: Number.isFinite(Number(preferences.videosPerWeek)) ? Math.max(1, Math.min(7, Number(preferences.videosPerWeek))) : null,
      daysOfWeek: Array.isArray(preferences.daysOfWeek)
        ? preferences.daysOfWeek.map(String).map(s => s.toLowerCase().slice(0, 3)).filter(d => ["mon","tue","wed","thu","fri","sat","sun"].includes(d))
        : null,
      times: (preferences.times && typeof preferences.times === "object") ? preferences.times : null,
      source: "client",
      confirmedAt: Date.now(),
      confirmedBy: who.email || null,
    };
    await db.ref(`/deliveries/${deliveryId}/postingPreferences`).set(cleaned);
  }

  return res.status(200).json({ ok: true });
}
