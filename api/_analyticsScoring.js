// api/_analyticsScoring.js — single source of truth for everything
// derived from raw analytics data.
//
// Per the plan, ALL scoring logic lives here:
//   - baselines (medians, follower count)
//   - per-video scoring (overperformance, repeatability, engagement
//     vs baseline)
//   - status badge + momentum score (with explainable reason line)
//   - decay alerts
//
// Phase 2 status: `recomputeClientAnalytics(clientId)` is a stub
// that just records `lastRecomputeAt`. Phase 3 fills in the real
// scoring math. This file ships in Phase 2 so the webhook + cron
// + manual refresh paths all wire to a single function from day
// one — when Phase 3 lands the math, no callers change.
//
// Boundary: this module is API-only. The frontend never imports it
// or any subset of it. Frontend renders precomputed truth from
// /analytics/clients/{id}/... and /analytics/videos/.../scoring.

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/**
 * recomputeClientAnalytics(clientId)
 *
 * Single source of truth for everything derived from raw analytics
 * data. Called by:
 *   - the analytics webhook after ingest writes complete
 *   - the cron handler after a scheduled refresh batch
 *   - the manual refresh action after a user-triggered ingest
 *
 * No hidden cascades. One function, one path, deterministic, safe
 * to call multiple times (idempotent within the same data state).
 *
 * Phase 2 stub: writes lastRecomputeAt + a placeholder status.
 * Phase 3 fills in the real fixed-order computation:
 *   1. Recompute baselines (medians, follower count)
 *   2. Recompute per-video scoring (rule-based, no AI)
 *   3. Recompute status badge + momentum (with reasonLine)
 *   4. Recompute decay alerts
 *   5. Mark insights stale so cron regenerates AI takes
 */
export async function recomputeClientAnalytics(clientId) {
  if (!clientId) throw new Error("recomputeClientAnalytics: missing clientId");

  // Phase 3 will replace this stub with the real computation.
  // The stub still writes the timestamp so callers + the UI can
  // confirm the recompute path fired, even if no scoring landed.
  await fbPatch(`/analytics/clients/${clientId}`, {
    lastRecomputeAt: new Date().toISOString(),
  });

  // Status defaults to "insufficient" until Phase 3 computes a real
  // one — this prevents a stale "growing" badge from a future Phase 3
  // deploy on data that hasn't been re-scored yet.
  await fbPatch(`/analytics/clients/${clientId}/status`, {
    state: "insufficient",
    reason: "Phase 3 scoring not yet implemented",
    computedAt: new Date().toISOString(),
  });

  return { ok: true, phase: 2, clientId };
}

// Re-export Firebase helpers so the webhook can use them without
// duplicating the admin/REST fallback dance.
export const _fb = { fbGet, fbSet, fbPatch };
