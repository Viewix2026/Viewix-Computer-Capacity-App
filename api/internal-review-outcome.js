// api/internal-review-outcome.js
//
// Phase 4 (#C/#D) — sets the outcome on a booked Internal Review subtask
// from EITHER the dashboard UI OR the Slack thread. The Slack action
// handler in slack-interactivity.js delegates here (dynamic import) so
// there's a single source of truth for what "Approve" / "Needs changes"
// actually does:
//   approve        → subtask done, internalReview.state=approved,
//                    fire client-ready alert (idempotent, AM-only).
//   needsChanges   → subtask done, internalReview.state=needsChanges,
//                    spawn "Internal Changes" subtask on the project
//                    lead's next working day at dayPriority 1 (cross-
//                    project max+1, mirrors the reformat priority rule).
//
// Request (POST JSON): { projectId, subtaskId, outcome: "approve"|"needsChanges", actor? }
//   200 { ok:true, state, spawnedSubtaskId? }
// The `actor` field is optional (Slack user id or dashboard editor id)
// and is stamped onto internalReview.outcomeBy for audit.

import { adminGet, adminSet, adminPatch } from "./_fb-admin.js";
import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { nextWorkingDayFor, todaySydney } from "../shared/scheduling/availability.js";

const ALLOWED_ROLES = ["founders", "manager", "lead", "editor"];

// Pure-ish outcome applier — does all the writes, returns a small
// summary. Throws on hard failure (read fail / not-found / wrong-state)
// so the HTTP handler can map to 4xx/5xx. The Slack handler catches +
// reports.
export async function applyReviewOutcome({ projectId, subtaskId, outcome, actor }) {
  if (!projectId || !subtaskId) throw new Error("projectId + subtaskId required");
  if (outcome !== "approve" && outcome !== "needsChanges") throw new Error("outcome must be approve|needsChanges");

  const project = await adminGet(`/projects/${projectId}`);
  if (!project) throw new Error("project_not_found");
  const subtask = (project.subtasks || {})[subtaskId];
  if (!subtask || !subtask.isInternalReview) throw new Error("subtask_not_internal_review");
  const ir = subtask.internalReview || {};
  if (ir.state !== "booked") {
    // Idempotent: if it's already approved / needsChanges, return the existing state.
    if (ir.state === "approved" || ir.state === "needsChanges") {
      return { ok: true, alreadySet: true, state: ir.state };
    }
    throw new Error(`internal_review_not_booked (state=${ir.state || "unset"})`);
  }

  const now = new Date().toISOString();

  if (outcome === "approve") {
    await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}`, { status: "done", updatedAt: now });
    await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}/internalReview`, {
      state: "approved",
      outcomeBy: actor || null,
      outcomeAt: now,
    });
    // Fire client-ready alert (idempotent, AM-only).
    try {
      const { fireClientReady } = await import("./notify-client-ready.js");
      await fireClientReady({ projectId });
    } catch (e) {
      console.warn("applyReviewOutcome: client-ready fan-out failed:", e.message);
    }
    return { ok: true, state: "approved" };
  }

  // needsChanges → spawn an Internal Changes subtask on the lead's next
  // working day at dayPriority 1 (cross-project max+1).
  let editors = [];
  try {
    const raw = await adminGet("/editors");
    editors = Array.isArray(raw) ? raw : Object.values(raw || {});
  } catch (e) { console.warn("applyReviewOutcome: editor lookup failed:", e.message); }
  const leadEditor = editors.find(e => e && (e.name || "").trim().toLowerCase() === (project.projectLead || "").trim().toLowerCase()) || null;
  const weekData = (await adminGet("/weekData")) || {};
  const startDate = leadEditor ? nextWorkingDayFor(leadEditor, todaySydney(), weekData) : null;
  const stId = `st-internal-changes-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const subs = project.subtasks ? Object.values(project.subtasks) : [];
  const orderBase = subs.reduce((m, s) => Math.max(m, s?.order ?? 0), 0) + 1;
  const assigneeIds = leadEditor ? [leadEditor.id] : [];

  // dayPriority = max+1 scoped across ALL projects for this editor+date
  // (mirrors the reformat priority rule shipped in #203 — avoids cross-
  // project badge collisions).
  let dayPriority = null;
  if (leadEditor && startDate) {
    const pkey = `${leadEditor.id}|${startDate}`;
    let maxP = 0;
    try {
      const projectsRaw = (await adminGet("/projects")) || {};
      const all = Array.isArray(projectsRaw) ? projectsRaw : Object.values(projectsRaw);
      for (const p of all) {
        const psubs = p?.subtasks ? Object.values(p.subtasks) : [];
        for (const s of psubs) {
          const v = s?.dayPriority?.[pkey];
          if (Number.isFinite(v) && v > maxP) maxP = v;
        }
      }
    } catch (e) { console.warn("dayPriority scan failed:", e.message); }
    dayPriority = { [pkey]: maxP + 1 };
  }

  const changes = {
    id: stId,
    name: "Internal Changes",
    stage: "revisions",
    status: (assigneeIds.length && startDate) ? "scheduled" : "stuck",
    startDate, endDate: startDate, startTime: null, endTime: null,
    assigneeIds, assigneeId: assigneeIds[0] || null,
    source: "internal-changes",
    fromInternalReviewSubtaskId: subtaskId,
    order: orderBase,
    createdAt: now, updatedAt: now,
  };
  if (dayPriority) changes.dayPriority = dayPriority;
  await adminSet(`/projects/${projectId}/subtasks/${stId}`, changes);

  await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}`, { status: "done", updatedAt: now });
  await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}/internalReview`, {
    state: "needsChanges",
    outcomeBy: actor || null,
    outcomeAt: now,
    spawnedSubtaskId: stId,
  });
  return { ok: true, state: "needsChanges", spawnedSubtaskId: stId };
}

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  let body;
  try {
    body = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  const projectId = (body.projectId || "").toString().trim();
  const subtaskId = (body.subtaskId || "").toString().trim();
  const outcome = (body.outcome || "").toString().trim();
  const actor = (body.actor || "").toString().trim() || null;

  try {
    const r = await applyReviewOutcome({ projectId, subtaskId, outcome, actor });
    return res.status(200).json(r);
  } catch (e) {
    const msg = String(e.message || e);
    const status = /project_not_found|subtask_not_internal_review|internal_review_not_booked/.test(msg) ? 409 : /required/.test(msg) ? 400 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
}
