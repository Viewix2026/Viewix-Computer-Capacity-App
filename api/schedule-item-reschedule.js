// api/schedule-item-reschedule.js
//
// Move one pending /socialSchedule/{id}/items/{idx} to a new postAt.
// "Post now" is just this endpoint called with newPostAt = now() ISO.
//
// Zernio supports PUT /posts/{postId} for scheduled (not-yet-published)
// posts, so reschedule is a direct edit of `scheduledFor`. We keep a
// cancel + recreate fallback for the case where Zernio rejects the PUT
// (405/501/"not supported") — the recreate uses a fresh requestId so
// the 5-min idempotency window doesn't collide with the cancelled post.
//
// Producer-only for v1. Client portal Posting Schedule tab is
// read-only; clients ask their producer to change the schedule.

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { getAdmin, adminGet } from "./_fb-admin.js";
import { updatePost, cancelPost, createPost, listAccounts, mapPlatformsToAccounts } from "./_zernio.js";

const ALLOWED_ROLES = ["founders", "founder", "manager", "lead", "producer"];

export default async function handler(req, res) {
  if (handleOptions(req, res, "PATCH, POST, OPTIONS")) return;
  setCors(req, res, "PATCH, POST, OPTIONS");
  if (req.method !== "PATCH" && req.method !== "POST") {
    return res.status(405).json({ error: "PATCH or POST only" });
  }

  let actor;
  try {
    actor = await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { scheduleId, itemIdx, newPostAt } = req.body || {};
  if (!scheduleId) return res.status(400).json({ error: "scheduleId required" });
  if (typeof itemIdx !== "number" || itemIdx < 0) {
    return res.status(400).json({ error: "itemIdx (number ≥ 0) required" });
  }
  if (!newPostAt) return res.status(400).json({ error: "newPostAt (ISO string) required" });

  const schedule = await adminGet(`/socialSchedule/${scheduleId}`);
  if (!schedule) return res.status(404).json({ error: "schedule_not_found" });
  const items = Array.isArray(schedule.items) ? schedule.items : [];
  const item = items[itemIdx];
  if (!item) return res.status(404).json({ error: "item_idx_out_of_range" });
  if (item.status !== "pending") {
    return res.status(409).json({
      error: "item_not_pending",
      status: item.status,
      detail: "Only pending items can be rescheduled. Cancelled or posted items are immutable.",
    });
  }

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const profile = await adminGet(`/zernio/profiles/${schedule.accountId}`);
  const profileId = profile?.profileId;
  if (!profileId) {
    return res.status(409).json({ error: "no_zernio_profile" });
  }

  // Try the direct edit first — PUT /posts/{id} { scheduledFor }.
  try {
    await updatePost(item.zernioPostId, { scheduledFor: newPostAt, timezone: "Australia/Sydney" });
    await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
      postAt: newPostAt,
      rescheduledAt: Date.now(),
      rescheduledBy: { uid: actor.uid, email: actor.email || null },
    });
    return res.status(200).json({ ok: true, scheduleId, itemIdx, postAt: newPostAt, method: "update" });
  } catch (e) {
    // If Zernio doesn't support update OR returns a specific "method
    // not supported" code, fall through to cancel+recreate. For any
    // other error, surface up.
    const supportsUpdate = !(e.code === "ZERNIO_405" || e.code === "ZERNIO_501" || /method not allowed|not supported|not implemented/i.test(e.message));
    if (supportsUpdate) {
      console.error("zernio updatePost failed:", e);
      return res.status(502).json({ error: "zernio_update_failed", detail: e.message });
    }
  }

  // Fallback — cancel + recreate. Resolve platform names → Zernio
  // connected-account ids (createPost needs them); reuse the stored
  // resolvedPlatforms if present, else re-fetch.
  try {
    if (item.zernioPostId) await cancelPost(item.zernioPostId);
  } catch (e) {
    // Cancel failure isn't terminal — the old post might already be
    // cancelled, or Zernio may have moved on. Log and continue.
    console.warn("cancel during reschedule failed (continuing):", e.message);
  }

  let resolvedPlatforms = Array.isArray(item.resolvedPlatforms) ? item.resolvedPlatforms : null;
  if (!resolvedPlatforms) {
    try {
      const accountsResp = await listAccounts(profileId);
      const { resolved, missing } = mapPlatformsToAccounts(accountsResp, item.platforms || []);
      if (missing.length > 0) {
        return res.status(409).json({ error: "platform_not_connected", missing });
      }
      resolvedPlatforms = resolved;
    } catch (e) {
      return res.status(502).json({ error: "zernio_list_accounts_failed", detail: e.message });
    }
  }

  // Fresh requestId so the 5-min idempotency window doesn't collide
  // with the just-cancelled post.
  const newRef = `${item.clientReferenceId}::r${Date.now().toString(36)}`;
  let postId;
  try {
    const created = await createPost({
      content: item.caption,
      scheduledFor: newPostAt,
      timezone: "Australia/Sydney",
      platforms: resolvedPlatforms,
      mediaUrl: item.zernioMediaUrl,
      requestId: newRef,
      trialReel: (item.platforms || []).includes("instagram") ? item.trialReel : false,
      tikTokCompliance: (item.platforms || []).includes("tiktok") ? item.tikTokCompliance : undefined,
    });
    postId = created.postId;
  } catch (e) {
    return res.status(502).json({ error: "zernio_recreate_failed", detail: e.message });
  }

  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
    postAt: newPostAt,
    rescheduledAt: Date.now(),
    rescheduledBy: { uid: actor.uid, email: actor.email || null },
    clientReferenceId: newRef,
    resolvedPlatforms,
    zernioPostId: postId || null,
  });
  return res.status(200).json({ ok: true, scheduleId, itemIdx, postAt: newPostAt, method: "cancel-recreate" });
}
