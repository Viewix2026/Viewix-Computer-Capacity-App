// api/schedule-item-cancel.js
//
// Cancel one pending /socialSchedule/{id}/items/{idx}. Calls Zernio's
// DELETE /posts/{id}, then flips status to "cancelled" locally.
//
// Items already in `posted` or `failed` are immutable — return 409.
// Producer-only for v1.

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { getAdmin, adminGet } from "./_fb-admin.js";
import { cancelPost } from "./_zernio.js";

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

  const { scheduleId, itemIdx } = req.body || {};
  if (!scheduleId) return res.status(400).json({ error: "scheduleId required" });
  if (typeof itemIdx !== "number" || itemIdx < 0) {
    return res.status(400).json({ error: "itemIdx (number ≥ 0) required" });
  }

  const schedule = await adminGet(`/socialSchedule/${scheduleId}`);
  if (!schedule) return res.status(404).json({ error: "schedule_not_found" });
  const items = Array.isArray(schedule.items) ? schedule.items : [];
  const item = items[itemIdx];
  if (!item) return res.status(404).json({ error: "item_idx_out_of_range" });
  if (item.status !== "pending") {
    return res.status(409).json({
      error: "item_not_pending",
      status: item.status,
    });
  }

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  if (item.zernioPostId) {
    try {
      await cancelPost(item.zernioPostId);
    } catch (e) {
      // 404 on Zernio = already cancelled / never existed — fine.
      if (e.status !== 404) {
        return res.status(502).json({ error: "zernio_cancel_failed", detail: e.message });
      }
    }
  }

  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
    status: "cancelled",
    cancelledAt: Date.now(),
    cancelledBy: { uid: actor.uid, email: actor.email || null },
  });

  return res.status(200).json({ ok: true, scheduleId, itemIdx });
}
