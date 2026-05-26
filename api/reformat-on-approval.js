// api/reformat-on-approval.js
//
// Phase 5 (#B) — when a Meta Ads 16:9 MASTER edit is approved in the
// Deliveries tab (its video viewixStatus flips to "Completed"), auto-
// create the separate 9:16 / 1:1 REFORMAT edit subtask on the linked
// project. Fired fire-and-forget from Deliveries.updateVideo; idempotent
// server-side so an overlapping approval / re-approval is harmless.
//
// Scheduling (locked): assign the reformat to the master's editor on
// their next available working day. NOTE: the fuller rule — "if that
// editor is fully stacked, reassign; stack ALL of a project's reformats
// onto one person's day" — needs the Phase 6 capacity grid and is left
// as a follow-up; here we do the simple master's-editor / next-working-
// day placement (unscheduled + stuck if the master had no assignee).
//
// Request (POST JSON): { deliveryId, videoId }
//   200 { ok:true, created|skipped }   200 even on no-op (idempotent)

import { adminGet, adminSet } from "./_fb-admin.js";
import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { nextWorkingDayFor, todaySydney } from "../shared/scheduling/availability.js";

const ALLOWED_ROLES = ["founders", "manager", "lead"];
const pkey = (editorId, dateISO) => `${editorId}|${dateISO}`;

function listProjects(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.entries(raw).map(([id, p]) => (p && typeof p === "object" ? { id, ...p } : null)).filter(Boolean);
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
  const deliveryId = (body.deliveryId || "").toString().trim();
  const videoId = (body.videoId || "").toString().trim();
  if (!deliveryId || !videoId) return res.status(400).json({ ok: false, error: "deliveryId and videoId required" });

  // Re-read the delivery and confirm THIS video is actually Completed —
  // defend against a stale/hostile call (mirrors notifyVideoApproved).
  let delivery;
  try { delivery = await adminGet(`/deliveries/${deliveryId}`); }
  catch (e) { return res.status(500).json({ ok: false, error: `delivery read failed: ${e.message}` }); }
  if (!delivery) return res.status(404).json({ ok: false, error: "delivery_not_found" });
  const vid = (delivery.videos || []).find(v => v && v.videoId === videoId);
  if (!vid) return res.status(200).json({ ok: true, skipped: "video_not_in_delivery" });
  if (vid.viewixStatus !== "Completed") return res.status(200).json({ ok: true, skipped: "not_completed" });

  // Find the linked project (project.links.deliveryId === deliveryId).
  let project = null;
  try {
    const projects = listProjects(await adminGet("/projects"));
    project = projects.find(p => (p.links || {}).deliveryId === deliveryId) || null;
  } catch (e) {
    return res.status(500).json({ ok: false, error: `project lookup failed: ${e.message}` });
  }
  if (!project) return res.status(200).json({ ok: true, skipped: "no_linked_project" });

  const subs = project.subtasks ? Object.values(project.subtasks) : [];
  // The 16:9 master for this video.
  const master = subs.find(s => s && s.videoId === videoId && s.isMasterEdit);
  if (!master) return res.status(200).json({ ok: true, skipped: "no_master_subtask" });
  // Idempotency: a reformat for this video already exists?
  const existingReformat = subs.find(s => s && s.videoId === videoId && s.reformatOfSubtaskId);
  if (existingReformat) return res.status(200).json({ ok: true, skipped: "reformat_exists" });

  // Schedule: master's editor on their next working day (simple version).
  const editorId = (Array.isArray(master.assigneeIds) && master.assigneeIds[0]) || master.assigneeId || null;
  let startDate = null;
  let assigneeIds = [];
  if (editorId) {
    try {
      const editorsRaw = await adminGet("/editors");
      const editors = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
      const editor = editors.find(e => e && e.id === editorId);
      const weekData = (await adminGet("/weekData")) || {};
      if (editor) {
        startDate = nextWorkingDayFor(editor, todaySydney(), weekData);
        assigneeIds = [editorId];
      }
    } catch (e) {
      // Non-fatal: fall back to an unscheduled reformat.
      console.warn("reformat scheduling lookup failed:", e.message);
    }
  }
  const scheduled = !!(startDate && assigneeIds.length);

  const now = new Date().toISOString();
  const baseName = (master.name || "").replace(/\s*—\s*16:9 Edit\s*$/i, "").trim() || `Video`;
  const stId = `st-reformat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const orderBase = subs.reduce((m, s) => Math.max(m, s?.order ?? 0), 0) + 1;

  const reformat = {
    id: stId,
    videoId,                       // same canonical id as the master + delivery video
    reformatOfSubtaskId: master.id, // idempotency marker + link to the master
    name: `${baseName} — Reformat (9:16 / 1:1)`,
    aspectRatio: "9:16 / 1:1",
    isMasterEdit: false,
    creativeFormat: master.creativeFormat || null,
    // Scheduled to the master's editor next working day when we could
    // resolve one; otherwise stuck + unscheduled for the producer.
    status: scheduled ? "scheduled" : "stuck",
    stage: "edit",
    startDate: scheduled ? startDate : null,
    endDate: scheduled ? startDate : null,
    startTime: null, endTime: null,
    assigneeIds, assigneeId: assigneeIds[0] || null,
    source: "reformat",
    order: orderBase,
    createdAt: now, updatedAt: now,
  };
  if (scheduled) reformat.dayPriority = { [pkey(editorId, startDate)]: 1 };

  try {
    await adminSet(`/projects/${project.id}/subtasks/${stId}`, reformat);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `write failed: ${e.message}` });
  }

  return res.status(200).json({ ok: true, created: stId, scheduled, assignedTo: assigneeIds[0] || null, startDate });
}
