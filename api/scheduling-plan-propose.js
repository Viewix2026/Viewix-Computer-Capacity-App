// api/scheduling-plan-propose.js
//
// Phase 6 — HTTP entry for the Team Board "Schedule edits" modal.
// Wraps runPlanProposal() (the I/O orchestrator around the pure
// shared/scheduling/planner.js) so the UI can ask the planner to
// generate a proposal without going through Slack first.
//
// Auth: founders / manager / lead — same roles allowed to apply.
// Returns the persisted proposal record (TTL 1h at /scheduling/
// proposedPlans/{shortId}). Confirm in the UI then POSTs shortId to
// api/scheduling-plan-apply.js which actually writes the subtasks.

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { runPlanProposal } from "./_scheduling-planner.js";

const ALLOWED_ROLES = ["founders", "manager", "lead"];

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  let decoded;
  try { decoded = await requireRole(req, ALLOWED_ROLES); }
  catch (e) { return sendAuthError(res, e); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const projectId = (body?.projectId || "").toString().trim();
  const requestedEditorIds = Array.isArray(body?.requestedEditorIds) ? body.requestedEditorIds.filter(Boolean) : [];
  const anyoneWithCapacity = !!body?.anyoneWithCapacity;
  const deadline = (body?.deadline || "").toString().trim() || null;

  if (!projectId) return res.status(400).json({ ok: false, error: "projectId required" });

  try {
    const { shortId, record, plan, narration } = await runPlanProposal({
      projectId,
      input: { requestedEditorIds, anyoneWithCapacity, deadline },
      triggeredBy: "teamBoard",
      triggeredVia: "manual",
      triggeredByUserId: decoded?.uid || null,
      triggeredByUserName: decoded?.name || decoded?.email || null,
    });
    return res.status(200).json({
      ok: true,
      shortId,
      proposedSubtasks: plan.proposedSubtasks,
      hardViolations: plan.hardViolations,
      warnings: plan.warnings,
      planWindow: plan.planWindow,
      candidateEditorIds: plan.candidateEditorIds,
      videoUnitCount: plan.videoUnitCount,
      narration,
      input: record.input,
      expiresAt: record.expiresAt,
    });
  } catch (e) {
    console.error("scheduling-plan-propose error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
