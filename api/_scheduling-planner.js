// api/_scheduling-planner.js
//
// Phase 2 v2.0 — the I/O orchestrator that wraps the PURE planner
// (shared/scheduling/planner.js). This module does the Firebase reads,
// generates the real planGroupId / shortId / deterministic id seed,
// runs Opus narration (narrate-only, never generate), and persists the
// proposal at /scheduling/proposedPlans/{shortId}.
//
// NO HTTP between Slack and here — both the /plan slash flow and the
// (v2.1) Team Board HTTP endpoint call runPlanProposal() in-process.
// Auth is done at the entry boundary (Slack HMAC+allowlist, or
// requireRole), never here. Mirrors api/_scheduling-brain-pass.js.

import crypto from "crypto";
import { adminGet, adminSet } from "./_fb-admin.js";
import { buildPlan } from "../shared/scheduling/planner.js";
import { buildAwareness } from "../shared/scheduling/awareness.js";
import { cachedStatsIsFresh } from "../shared/scheduling/stats.js";
import { todaySydney } from "../shared/scheduling/availability.js";
import { narrateBrain } from "./_scheduling-narrate.js";
import { randomShortId } from "./_slack-helpers.js";

const PROPOSAL_TTL_MS = 60 * 60 * 1000; // 1h — mirrors Phase 1 proposals

// Deterministic synthetic id generator seeded by the plan group, so a
// given plan run always produces stable ids (the pure planner stays
// pure — id generation is injected).
function makeIdFor(planGroupId) {
  return (stage, key) => `_plan_${planGroupId}_${stage}_${key}`;
}

export async function runPlanProposal({
  projectId,
  input,                       // { requestedEditorIds, anyoneWithCapacity, deadline, extraShoot }
  triggeredBy = "slack",       // "slack" | "teamBoard"
  triggeredVia = "manual",     // "manual" | "auto"
  triggeredByUserId = null,
  triggeredByUserName = null,
  triggeredByShootSubtaskId = null,
}) {
  if (!projectId) throw new Error("runPlanProposal: projectId required");

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

  const rawProject = projects[projectId];
  if (!rawProject) throw new Error(`runPlanProposal: project ${projectId} not found`);
  const project = { ...rawProject, id: projectId };

  const today = todaySydney();
  const planGroupId = crypto.randomUUID();
  const shortId = randomShortId();
  const idFor = makeIdFor(planGroupId);

  // Resolve the deadline: explicit input wins, else project.dueDate.
  const deadline = input?.deadline || project.dueDate || null;
  const resolvedInput = { ...input, deadline };

  // ── Deterministic plan (pure) ────────────────────────────────────
  const plan = buildPlan({
    project,
    projects,
    editors,
    weekData,
    videoTypeStats,
    input: resolvedInput,
    today,
    planGroupId,
    idFor,
  });

  // ── Opus narration — narrate-only, never generate ────────────────
  const awareness = buildAwareness({
    projects, editors, weekData, videoTypeStats, today,
  });
  const narration = await narrateBrain({
    mode: "plan",
    plan: {
      project: { id: project.id, name: project.projectName, client: project.clientName,
        videoType: project.videoType, numberOfVideos: project.numberOfVideos },
      proposedSubtasks: plan.proposedSubtasks,
      hardViolations: plan.hardViolations,
      warnings: plan.warnings,
      planWindow: plan.planWindow,
      deadline,
    },
    projects,
    editors,
    today,
    awareness,
  });

  // ── Persist the proposal ─────────────────────────────────────────
  const now = Date.now();
  const record = {
    shortId,
    planGroupId,
    projectId,
    triggeredBy,
    triggeredVia,
    triggeredByUserId: triggeredByUserId || null,
    triggeredByUserName: triggeredByUserName || null,
    triggeredByShootSubtaskId: triggeredByShootSubtaskId || null,
    input: {
      requestedEditorIds: resolvedInput.requestedEditorIds || [],
      anyoneWithCapacity: !!resolvedInput.anyoneWithCapacity,
      deadline: deadline || null,
      rangeStart: plan.planWindow.start,
      rangeEnd: plan.planWindow.end,
      extraShoot: resolvedInput.extraShoot || null,
    },
    proposedSubtasks: plan.proposedSubtasks,
    hardViolations: plan.hardViolations,
    warnings: plan.warnings,
    narration,
    candidateEditorIds: plan.candidateEditorIds,
    videoUnitCount: plan.videoUnitCount,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    status: "pending",
    approvedAt: null,
    approvedBy: null,
    approvedDespiteViolations: false,
  };
  await adminSet(`/scheduling/proposedPlans/${shortId}`, record);

  return { shortId, record, plan, narration };
}
