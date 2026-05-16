// shared/scheduling/plan-apply-core.js
//
// Pure decision logic extracted out of api/scheduling-plan-apply.js so
// the blast-radius path (claim state machine + idempotent reconcile +
// divergence detection) is unit-testable in isolation — same
// discipline as shared/scheduling/planner.js. No Firebase, no I/O,
// no Date.now() (the caller injects `now` / `nowIso` / `mkId`).
//
// Codex audit (PR #148) fixes live here:
//   P1 #1 — decideClaimOutcome: the I/O wrapper aborts the RTDB
//           transaction unless this returns { ok: true }.
//   P1 #3 — reconcilePlan: detects rows that materially changed since
//           proposal time and reports them as `diverged` so the
//           wrapper can refuse with a real stale 409 instead of a
//           silent partial apply.

import { inferStage } from "./stages.js";
import { videoIndexOf } from "./planner.js";

// Statuses we never regress when updating an existing subtask in place.
const PRESERVE_STATUSES = new Set(["inProgress", "done", "waitingClient"]);

// ─── Claim state machine (P1 #1) ───────────────────────────────────
// Decides whether a pending→claimed transition is allowed. The I/O
// wrapper calls this inside the RTDB transaction updater; on { ok:false }
// it returns `undefined` (a true abort — returning the unchanged record
// would *commit* the transaction and strand `proposal === null`).
//
// Also called post-transaction against the snapshot to map the current
// server state to a typed response.
export function decideClaimOutcome(record, now) {
  if (!record || typeof record !== "object") {
    return { ok: false, status: "not_pending", reason: "missing" };
  }
  const status = record.status || "";
  // Already applied wins even if also expired — report it as applied so
  // a double-click reads as success, not an error.
  if (status === "approved") {
    return { ok: false, status: "applied", reason: "already_applied" };
  }
  const expiresAt = Number(record.expiresAt) || 0;
  const expired = expiresAt > 0 && now > expiresAt;
  if (status === "pending") {
    if (expired) return { ok: false, status: "not_pending", reason: "expired" };
    return { ok: true };
  }
  // Any other status (claimed / cancelled / stale / error / unknown).
  if (expired) return { ok: false, status: "not_pending", reason: "expired" };
  return { ok: false, status: "not_pending", reason: status || "not_pending" };
}

// Status to write when updating an existing subtask in place.
function nextStatus(current) {
  return current && PRESERVE_STATUSES.has(current) ? current : "scheduled";
}

// ─── Idempotent reconcile + divergence (P1 #3) ─────────────────────
// Pure. Returns { updates, written, diverged }.
//   updates  — RTDB multi-path object the caller atomically writes
//   written  — [{ id, action }] audit of what each row did
//   diverged — [{ key, reason }] rows that materially changed since
//              proposal time; non-empty → caller refuses (stale)
//
// Reconciliation key is (stage, _videoIndex). _planGroupId is audit
// lineage, never identity. mkId() yields a fresh unique id for CREATE
// rows (caller injects: prod = RTDB push key, tests = deterministic).
export function reconcilePlan({
  projectId,
  proposedSubtasks,
  liveSubtasks,
  planGroupId,
  nowIso,
  mkId,
}) {
  if (!projectId) throw new Error("reconcilePlan: projectId required");
  if (typeof mkId !== "function") throw new Error("reconcilePlan: mkId required");

  // Index live rows by (stage|videoIndex); skip archived. Track the
  // max order so new rows append after existing ones.
  const byKey = new Map();
  let maxOrder = 0;
  for (const [stid, st] of Object.entries(liveSubtasks || {})) {
    if (!st || typeof st !== "object") continue;
    maxOrder = Math.max(maxOrder, Number(st.order) || 0);
    if (st.status === "archived") continue;
    const idx = videoIndexOf(st);
    if (idx == null) continue; // unindexed / manual → planner never touches
    byKey.set(`${inferStage(st)}|${idx}`, { id: st.id || stid, st });
  }

  const updates = {};
  const written = [];
  const diverged = [];
  let order = maxOrder;

  for (const ps of proposedSubtasks || []) {
    const isRevision = ps.stage === "revisions";
    const key = ps.videoIndex != null ? `${ps.stage}|${ps.videoIndex}` : null;
    const match = key ? byKey.get(key) : null;

    // ── Divergence: did this video's row materially change since the
    //    proposal was generated? If so, refuse the whole apply.
    if (!isRevision && match) {
      const live = match.st;
      if (ps.mode === "create" && live.startDate) {
        // Nothing existed at propose time; now there's a scheduled row.
        diverged.push({ key, reason: "create_target_now_scheduled", id: match.id });
        continue;
      }
      if (ps.mode === "update") {
        const sameRow = ps._existingSubtaskId && match.id === ps._existingSubtaskId;
        if (!sameRow) {
          // The keyed slot is now a different subtask than the one we
          // intended to update.
          diverged.push({ key, reason: "update_target_replaced", id: match.id });
          continue;
        }
        if (live.startDate) {
          // The row we meant to schedule was scheduled by someone else.
          diverged.push({ key, reason: "update_target_now_scheduled", id: match.id });
          continue;
        }
      }
    }

    // ── Reconcile (no divergence) ──────────────────────────────────
    if (isRevision && match) {
      // Revisions are create-once + unscheduled by design. One exists →
      // leave it.
      written.push({ id: match.id, action: "skip-revision-exists" });
      continue;
    }

    if (match) {
      // Non-diverged match is, by construction above, an unscheduled
      // row we own → update in place, reuse its id.
      const path = `/projects/${projectId}/subtasks/${match.id}`;
      updates[`${path}/startDate`] = ps.startDate || null;
      updates[`${path}/endDate`] = ps.startDate ? (ps.endDate || ps.startDate) : null;
      updates[`${path}/startTime`] = ps.startTime || null;
      updates[`${path}/endTime`] = ps.endTime || null;
      updates[`${path}/assigneeIds`] = ps.assigneeIds || [];
      updates[`${path}/assigneeId`] = ps.assigneeId || null;
      updates[`${path}/stage`] = ps.stage;
      updates[`${path}/status`] = nextStatus(match.st.status);
      updates[`${path}/_videoIndex`] = ps._videoIndex ?? ps.videoIndex ?? null;
      updates[`${path}/_planGroupId`] = planGroupId;
      updates[`${path}/updatedAt`] = nowIso;
      written.push({ id: match.id, action: "update" });
      continue;
    }

    // No match → create.
    const id = mkId(ps.stage, ps.videoIndex ?? "x");
    order += 1;
    updates[`/projects/${projectId}/subtasks/${id}`] = {
      id,
      name: ps.name,
      status: "scheduled",
      stage: ps.stage,
      startDate: ps.startDate || null,
      endDate: ps.startDate ? (ps.endDate || ps.startDate) : null,
      startTime: ps.startTime || null,
      endTime: ps.endTime || null,
      assigneeIds: ps.assigneeIds || [],
      assigneeId: ps.assigneeId || null,
      source: "slack-plan",
      order,
      _videoIndex: ps._videoIndex ?? ps.videoIndex ?? null,
      _planGroupId: planGroupId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    written.push({ id, action: "create" });
  }

  return { updates, written, diverged };
}

// Count of meaningful writes (for the applied-card summary / audit).
export function writeCounts(written) {
  return {
    created: written.filter(w => w.action === "create").length,
    updated: written.filter(w => w.action === "update").length,
    skipped: written.filter(w => String(w.action).startsWith("skip")).length,
  };
}
