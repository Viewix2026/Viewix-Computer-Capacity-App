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
import { partitionFlags } from "../shared/scheduling/planner.js";
import {
  decideClaimOutcome,
  reconcilePlan,
  writeCounts,
} from "../shared/scheduling/plan-apply-core.js";

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
// Thin I/O wrapper over the pure plan-apply-core. Codex PR #148 fixes:
//   P1 #1 — abort the claim transaction (return undefined) unless
//           decideClaimOutcome says ok; never continue with a null
//           proposal.
//   P1 #2 — every post-claim step is under one try/catch; any throw
//           releases the claim back to pending (safe: the write is a
//           single atomic multi-path update, no partial-write window).
//   P1 #3 — reconcilePlan reports rows that materially changed since
//           proposal time; non-empty → refuse with a real stale,
//           write nothing.
export async function applyPlanCore({ shortId, approveDespiteViolations = false, actor }) {
  const { db } = getAdmin();
  if (!db) throw new Error("firebase-admin not configured");

  const ref = db.ref(`/scheduling/proposedPlans/${shortId}`);

  // P1 #1 — pending→claimed. The updater returns `undefined` (a true
  // abort) unless the claim is allowed; returning the unchanged record
  // would *commit* the transaction and strand proposal === null.
  let proposal = null;
  const tx = await ref.transaction(curr => {
    const d = decideClaimOutcome(curr, Date.now());
    if (!d.ok) return undefined;
    proposal = curr;
    return { ...curr, status: "claimed", claimedAt: Date.now(),
      claimedBy: actor?.id || null };
  });
  if (!tx.committed || !proposal) {
    const d = decideClaimOutcome(tx.snapshot?.val(), Date.now());
    if (d.status === "applied") {
      return { status: "applied", reason: "already_applied", shortId };
    }
    return { status: d.status, reason: d.reason, shortId };
  }

  const projectId = proposal.projectId;
  const proposed = proposal.proposedSubtasks || [];

  // Set once the atomic apply has committed. Its presence is the
  // signal that the claim must never be released again.
  let applied = null;

  // P1 #2 — guard everything after the claim.
  try {
    // ── Stale guard (capacity / conflict drift) ──────────────────
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
      await releaseClaim(ref);
      return { status: "error", reason: "project_deleted", shortId };
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
      await releaseClaim(ref, { lastStaleCheckAt: Date.now() });
      return { status: "stale", reason: "hardViolations", hardViolations, shortId };
    }

    // ── Idempotent reconcile (pure) ──────────────────────────────
    const liveSubtasks = (await adminGet(`/projects/${projectId}/subtasks`)) || {};
    const subtasksRef = db.ref(`/projects/${projectId}/subtasks`);
    const nowIso = new Date().toISOString();
    const { updates, written, diverged } = reconcilePlan({
      projectId,
      proposedSubtasks: proposed,
      liveSubtasks,
      planGroupId: proposal.planGroupId,
      nowIso,
      mkId: () => subtasksRef.push().key,
    });

    // P1 #3 — a keyed row materially changed since proposal → refuse
    // the whole apply (real stale, not a silent partial apply).
    if (diverged.length > 0) {
      await releaseClaim(ref, { lastStaleCheckAt: Date.now() });
      return { status: "stale", reason: "diverged", divergedKeys: diverged, shortId };
    }

    // Terminal state (approved) + the subtask writes go in ONE atomic
    // multi-path update. That update is the point of no return.
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
    updates[`/scheduling/proposedPlans/${shortId}`] = terminal;

    await db.ref().update(updates);

    // Committed. Capture what the post-commit audit needs and break out
    // of the release-on-error try — nothing past this line may ever
    // release the claim (the plan is already written).
    applied = { written, nowIso };
  } catch (e) {
    // P1 #2 — failure BEFORE the atomic apply: release the claim so a
    // retry can succeed. The only mutation is the single atomic
    // db.ref().update(updates); reaching here means it never ran.
    await ref.update({
      status: "pending",
      claimedAt: null,
      claimedBy: null,
      lastError: String(e?.message || e),
      lastErrorAt: Date.now(),
    }).catch(() => {});
    return { status: "error", reason: e?.message || String(e), shortId };
  }

  // ── Past the point of no return ────────────────────────────────
  // Codex PR #148 re-pass P1: the audit push must NOT be able to
  // reopen an already-applied plan. Best-effort, isolated — its
  // failure is logged, never released, never fatal.
  try {
    await db.ref("/scheduling/history").push({
      type: "plan_applied",
      ts: applied.nowIso,
      actor: actor?.id || null,
      actorName: actor?.name || null,
      shortId,
      planGroupId: proposal.planGroupId,
      projectId,
      subtaskCount: applied.written.filter(w => w.action === "create" || w.action === "update").length,
      approvedDespiteViolations: !!approveDespiteViolations,
    });
  } catch (auditErr) {
    console.error(
      "scheduling-plan-apply: audit push failed (non-fatal — plan already applied):",
      auditErr,
    );
  }

  return {
    status: "applied",
    shortId,
    written: applied.written,
    counts: writeCounts(applied.written),
  };
}

// Release a claimed proposal back to pending (clears claim metadata so
// the next attempt sees a clean pending record).
async function releaseClaim(ref, extra = {}) {
  await ref.update({
    status: "pending",
    claimedAt: null,
    claimedBy: null,
    ...extra,
  }).catch(() => {});
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
