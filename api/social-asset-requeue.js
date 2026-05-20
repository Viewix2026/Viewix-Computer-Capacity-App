// api/social-asset-requeue.js
//
// Producer-side endpoint that manually resets a failed or stale
// /socialAssets/{key} row back to status:"queued". The Mac Mini worker
// picks it up on its next scan (within 15s).
//
// Used when:
//  • The worker has flagged a row "failed" after 3 retries (Slack ping
//    fires when this happens).
//  • The worker has flagged a row "stale" because the producer
//    changed the underlying Frame.io file. The producer hits this
//    endpoint AFTER updating the link in Deliveries.
//
// Founder/Lead gated. Producers can re-queue their own work without a
// founder hand-hold, but it's still a privileged operation (writes to
// /socialAssets, which is admin-SDK-only at the rules layer).

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { getAdmin } from "./_fb-admin.js";

const ALLOWED_ROLES = ["founders", "founder", "manager", "lead", "producer"];

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let actor;
  try {
    actor = await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { assetKey, deliveryId, videoId } = req.body || {};
  // Accept either an explicit assetKey (preferred) or the
  // (deliveryId, videoId) pair which is what the Deliveries UI has on
  // hand. We compose the key the same way the on-video-approved hook
  // does: `${deliveryId}_${videoId}`.
  const key = String(assetKey || (deliveryId && videoId ? `${deliveryId}_${videoId}` : ""));
  if (!key) {
    return res.status(400).json({ error: "Either assetKey or (deliveryId, videoId) required" });
  }

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const ref = db.ref(`/socialAssets/${key}`);
  const snap = await ref.once("value");
  const row = snap.val();
  if (!row) {
    return res.status(404).json({ error: "asset_not_found", key });
  }
  if (row.status === "queued" || row.status === "claimed" || row.status === "transferring") {
    return res.status(409).json({
      error: "already_in_progress",
      status: row.status,
      key,
    });
  }

  await ref.update({
    status: "queued",
    error: null,
    attempts: 0,
    requeuedAt: Date.now(),
    requeuedBy: { uid: actor.uid, email: actor.email || null },
    // Clear the prior media url so the modal doesn't silently use a
    // stale Zernio public url while the worker is mid-transfer of the
    // new bytes. The mirror on /deliveries/{id}/videos/{idx}.zernioMediaUrl
    // is cleared by the worker on successful re-transfer.
    zernioMediaUrl: null,
  });

  return res.status(200).json({ ok: true, key, requeued: true });
}
