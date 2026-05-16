// api/scheduling-plan-apply.js
//
// Phase 2 v2.0 — applies an approved plan. Two entry points, one core:
//   • Slack approve buttons → slack-interactivity calls applyPlanCore()
//     in-process (HMAC+allowlist already done there).
//   • Team Board v2.1 → this file's default HTTP handler (requireRole).
//
// Idempotent. Reconciliation key is (projectId, stage, _videoIndex) —
// NOT _planGroupId (a re-plan gets a new planGroupId; matching on it
// would duplicate every row). _planGroupId is audit lineage only.
//
// Rules per proposed row:
//   - existing match with startDate (scheduled) → SKIP (don't move
//     work the producer already committed)
//   - existing match unscheduled → UPDATE in place, reuse its id
//   - no match → CREATE
//   - unscheduled revisions: skip if any revisions row already exists
//
// Stale guard: before writing, re-run the Phase 1 checker against the
// plan applied to CURRENT state. If hard violations exist now and the
// approver didn't explicitly approve-anyway, refuse.

import { adminGet, getAdmin } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { detectFlagsForDateRange } from "../shared/scheduling/conflicts.js";
import { hydrateEstHours } from "../shared/scheduling/capacity.js";
import { cachedStatsIsFresh } from "../shared/scheduling/stats.js";
import { todaySydney } from "../shared/scheduling/availability.js";
import { inferStage } from "../shared/scheduling/stages.js";
import { videoIndexOf, partitionFlags } from "../shared/scheduling/planner.js";

export const config = { maxDuration: 30 };

// ─── HTTP entry (Team Board v2.1) ──────────────────────────────────
export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try {
    decoded = await requireRole(req, ["founders", "founder", "lead"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { shortId, approveDespiteViolations = false } = body || {};
  if (!shortId) return res.status(400).json({ error: "shortId required" });

  try {
    const result = await applyPlanCore({
      shortId,
      approveDespiteViolations,
      actor: { id: decoded?.uid || null, name: decoded?.name || decoded?.email || null },
    });
    const code = result.status === "applied" ? 200
      : result.status === "stale" ? 409
      : result.status === "not_pending" ? 410
      : 400;
    return res.status(code).json(result);
  } catch (e) {
    console.error("scheduling-plan-apply error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

// ─── Shared apply core (also called by slack-interactivity) ────────
export async function applyPlanCore({ shortId, approveDespiteViolations = false, actor }) {
  const { db } = getAdmin();
  if (!db) throw new Error("firebase-admin not configured");

  const ref = db.ref(`/scheduling/proposedPlans/${shortId}`);

  // Atomic pending→claimed so double-clicks are idempotent.
  let proposal = null;
  const tx = await ref.transaction(curr => {
    if (!curr) return curr;
    if (curr.status !== "pending") return curr;
    if (Date.now() > (curr.expiresAt || 0)) return curr;
    proposal = curr;
    return { ...curr, status: "claimed", claimedAt: Date.now(),
      claimedBy: actor?.id || null };
  });
  if (!tx.committed) {
    const cur = tx.snapshot?.val();
    if (!cur) return { status: "not_pending", reason: "missing" };
    if (cur.status === "approved") return { status: "applied", reason: "already_applied", shortId };
    if (Date.now() > (cur.expiresAt || 0)) return { status: "not_pending", reason: "expired" };
    return { status: "not_pending", reason: cur.status };
  }

  const projectId = proposal.projectId;
  const proposed = proposal.proposedSubtasks || [];

  // ── Stale guard ────────────────────────────────────────────────
  const [projectsRaw, editorsRaw, weekDataRaw, cachedStatsRec] = await Promise.all([
    adminGet("/projects"),
    adminGet("/editors"),
    adminGet("/weekData"),
    adminGet("/scheduling/cachedStats"),
  ]);
  const projects = projectsRaw || {};
  const editorsList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
  const editors = editorsList.filter(e => e?.id);
  const weekData = weekDataRaw || {};
  const videoTypeStats = cachedStatsIsFresh(cachedStatsRec) ? (cachedStatsRec.stats || {}) : {};
  const today = todaySydney();

  if (!projects[projectId]) {
    await ref.update({ status: "pending" }); // release claim
    return { status: "error", reason: "project_deleted" };
  }

  const hydrated = hydrateEstHours(projects, videoTypeStats);
  const virtual = applyVirtual(hydrated, projectId, proposed);
  const touched = new Set();
  for (const ps of proposed) for (const a of ps.assigneeIds || []) if (a) touched.add(a);
  const window = proposal.input || {};
  const detected = detectFlagsForDateRange({
    startDate: window.rangeStart || today,
    endDate: window.rangeEnd || today,
    projects: virtual,
    editors,
    weekData,
    videoTypeStats,
    loggedHoursBySubtask: {},
    scope: touched.size ? { kind: "actor", personIds: [...touched], today } : { kind: "all" },
  });
  const { hardViolations } = partitionFlags(detected);

  if (hardViolations.length > 0 && !approveDespiteViolations) {
    // Release the claim so the producer can re-review / approve-anyway.
    await ref.update({ status: "pending", lastStaleCheckAt: Date.now() });
    return { status: "stale", hardViolations, shortId };
  }

  // ── Idempotent multi-path write ────────────────────────────────
  const liveSubtasks = (await adminGet(`/projects/${projectId}/subtasks`)) || {};
  // Index existing rows by (stage|videoIndex). Skip archived.
  const byKey = new Map();
  let maxOrder = 0;
  for (const [stid, st] of Object.entries(liveSubtasks)) {
    if (!st || typeof st !== "object") continue;
    maxOrder = Math.max(maxOrder, Number(st.order) || 0);
    if (st.status === "archived") continue;
    const idx = videoIndexOf(st);
    if (idx == null) continue;
    byKey.set(`${inferStage(st)}|${idx}`, { id: st.id || stid, st });
  }

  const nowIso = new Date().toISOString();
  const updates = {};
  const written = [];
  let order = maxOrder;

  for (const ps of proposed) {
    const isRevision = ps.stage === "revisions";
    const key = ps.videoIndex != null ? `${ps.stage}|${ps.videoIndex}` : null;
    const match = key ? byKey.get(key) : null;

    if (match) {
      const m = match.st;
      // Don't move work the producer already scheduled (non-revision).
      if (!isRevision && m.startDate) { written.push({ id: match.id, action: "skip-scheduled" }); continue; }
      // Revisions are create-once; if one exists, leave it.
      if (isRevision) { written.push({ id: match.id, action: "skip-revision-exists" }); continue; }
      // Update the existing (unscheduled) row in place.
      const path = `/projects/${projectId}/subtasks/${match.id}`;
      updates[`${path}/startDate`] = ps.startDate;
      updates[`${path}/endDate`] = ps.endDate || ps.startDate;
      updates[`${path}/startTime`] = ps.startTime || null;
      updates[`${path}/endTime`] = ps.endTime || null;
      updates[`${path}/assigneeIds`] = ps.assigneeIds || [];
      updates[`${path}/assigneeId`] = ps.assigneeId || null;
      updates[`${path}/stage`] = ps.stage;
      updates[`${path}/status`] = m.status && ["inProgress", "done", "waitingClient"].includes(m.status)
        ? m.status : "scheduled";
      updates[`${path}/_videoIndex`] = ps._videoIndex ?? ps.videoIndex ?? null;
      updates[`${path}/_planGroupId`] = proposal.planGroupId;
      updates[`${path}/updatedAt`] = nowIso;
      written.push({ id: match.id, action: "update" });
    } else {
      // Create a fresh row.
      const newRef = db.ref(`/projects/${projectId}/subtasks`).push();
      const id = newRef.key;
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
        _planGroupId: proposal.planGroupId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      written.push({ id, action: "create" });
    }
  }

  // Terminal state for the proposal + audit + history, in the same
  // atomic multi-path update so indexes stay consistent.
  const terminal = {
    ...proposal,
    status: "approved",
    approvedAt: Date.now(),
    approvedBy: actor?.id || null,
    approvedByName: actor?.name || null,
    approvedDespiteViolations: !!approveDespiteViolations,
    appliedWrites: written,
  };
  updates[`/scheduling/planHistory/${shortId}`] = terminal;
  updates[`/scheduling/proposedPlans/${shortId}`] = terminal; // keep visible, terminal status

  await db.ref().update(updates);

  await db.ref("/scheduling/history").push({
    type: "plan_applied",
    ts: nowIso,
    actor: actor?.id || null,
    actorName: actor?.name || null,
    shortId,
    planGroupId: proposal.planGroupId,
    projectId,
    subtaskCount: written.filter(w => w.action === "create" || w.action === "update").length,
    approvedDespiteViolations: !!approveDespiteViolations,
  });

  return {
    status: "applied",
    shortId,
    written,
    counts: {
      created: written.filter(w => w.action === "create").length,
      updated: written.filter(w => w.action === "update").length,
      skipped: written.filter(w => String(w.action).startsWith("skip")).length,
    },
  };
}

// Virtual apply for the stale guard — mirrors planner.js's internal
// helper (only scheduled rows affect date flags; unscheduled revisions
// don't).
function applyVirtual(projects, projectId, proposedSubtasks) {
  const target = projects[projectId];
  if (!target) return projects;
  const subtasks = { ...(target.subtasks || {}) };
  for (const ps of proposedSubtasks) {
    if (!ps.startDate) continue;
    const id = ps.id || `_virtual_${ps.stage}_${ps.videoIndex}`;
    const existing = subtasks[id] || {};
    subtasks[id] = {
      ...existing,
      id,
      stage: ps.stage,
      name: ps.name,
      status: existing.status && existing.status !== "archived" ? existing.status : "scheduled",
      startDate: ps.startDate,
      endDate: ps.endDate || ps.startDate,
      startTime: ps.startTime || null,
      endTime: ps.endTime || null,
      assigneeIds: ps.assigneeIds || [],
      assigneeId: ps.assigneeId || (ps.assigneeIds || [])[0] || null,
      _videoIndex: ps._videoIndex ?? existing._videoIndex,
      _planGroupId: ps._planGroupId,
    };
  }
  return { ...projects, [projectId]: { ...target, subtasks } };
}
