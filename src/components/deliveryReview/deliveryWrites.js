// Shared delivery review write logic. Single source of truth for the
// revision1/2/posted leaf writes + the batched revision-notify, used by
// BOTH the legacy tokenless /d/ public view (DeliveryPublicView.jsx)
// and the authed client portal Deliveries tab. Neutral location (not
// under portal/) because the public view consumes it too — so the
// behavior cannot drift between the two renderers.
//
// Firebase rules only allow anonymous/any-auth writes to the specific
// leaves .../videos/{idx}/{revision1|revision2|posted} — never the
// whole delivery object. Keep writes leaf-scoped.
import { fbSetAsync } from "../../firebase";

export const DELIVERY_LEAF_FIELDS = ["revision1", "revision2", "posted"];

export function deliveryLeafPath(deliveryId, videoIndex, field) {
  return `/deliveries/${deliveryId}/videos/${videoIndex}/${field}`;
}

// Side-effect POST fired immediately when a revision1/revision2 leaf
// write resolves with value "Approved". Triggers the Phase 2B caption
// snapshot + Phase 2A asset-transfer queue. Fire-and-forget: if the
// POST fails (Vercel hiccup, user closed tab mid-fetch), the daily
// reconcile cron (api/cron/social-asset-reconcile.js) catches the
// missed approval the next day.
//
// Exported so callers can fire explicitly if they ever need to
// (e.g. backfilling old deliveries). Auto-called by writeDeliveryLeaf
// below when field/value match an approval transition.
export function notifyVideoApproved(deliveryId, videoIndex) {
  if (!deliveryId || typeof videoIndex !== "number" || videoIndex < 0) return;
  // No await — fire-and-forget. The endpoint is idempotent at the
  // server (skips if /socialAssets/{deliveryId}_{videoId} already
  // exists), so a duplicate fire is harmless. Logging an error here
  // is purely for dev visibility; production traffic relies on the
  // daily reconcile cron for self-heal.
  fetch("/api/on-video-approved", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliveryId, videoIdx: videoIndex }),
  }).catch(e => console.warn("notifyVideoApproved failed:", e?.message || e));
}

// Write one editable leaf. Returns the fbSetAsync promise so callers can
// surface failures.
//
// As a side effect, when this write LANDS revision1 or revision2 as
// "Approved", we POST to /api/on-video-approved (Phase 2B). The leaf
// write is the source of truth — this side-effect fires only AFTER
// it resolves, so we never queue an asset transfer for a write that
// later failed.
export function writeDeliveryLeaf(deliveryId, videoIndex, field, value) {
  if (!deliveryId || videoIndex < 0 || !DELIVERY_LEAF_FIELDS.includes(field)) {
    return Promise.reject(new Error(`Refusing unsafe delivery write: ${field}@${videoIndex}`));
  }
  const path = deliveryLeafPath(deliveryId, videoIndex, field);
  return fbSetAsync(path, value)
    .then(() => {
      if ((field === "revision1" || field === "revision2") && value === "Approved") {
        notifyVideoApproved(deliveryId, videoIndex);
      }
    })
    .catch(e => {
      console.error("delivery leaf write failed", { path, field, value, e });
      throw e;
    });
}

// Batched revision-change notifier. Mirrors the legacy public view: a
// 120s debounce, a 200-entry cap, and a final flush on dispose so
// navigating away doesn't drop or duplicate the producer Slack ping.
export function createRevisionNotifier({ getClientName, getDeliveryId }) {
  let pending = [];
  let timer = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const changes = pending;
    pending = [];
    const clientName = (getClientName && getClientName()) || "Unknown Client";
    const deliveryId = getDeliveryId && getDeliveryId();
    fetch("/api/notify-revision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientName, deliveryId, changes }),
    }).catch(e => console.error("Notification error:", e));
  };

  const queue = (change) => {
    pending.push(change);
    if (pending.length > 200) pending.shift();
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 120000);
  };

  const dispose = () => { if (timer) { clearTimeout(timer); timer = null; } };

  return { queue, flush, dispose };
}
