// api/reformat-on-approval.js
//
// Phase 5 (#B) — when a Meta Ads 16:9 MASTER edit is approved in the
// Deliveries tab (its video viewixStatus flips to "Completed"), auto-
// create the separate 9:16 / 1:1 REFORMAT edit subtask on the linked
// project. Fired fire-and-forget from Deliveries.updateVideo; idempotent
// server-side so an overlapping approval / re-approval is harmless.
//
// Scheduling (locked, Phase 6): assign the reformat to the master's
// editor on their next available working day, BUT:
//   - Stack ALL of this project's reformats onto the same editor's day
//     (so they flow through the resizes in one sitting); and
//   - If the master's editor is "fully stacked" (≥ FULLY_STACKED_THRESHOLD
//     non-done subtasks already pinned on that date across ALL projects),
//     reassign the reformat to another editor whose next-working-day is
//     less stacked. Same-project stacking wins over reassignment — once
//     one of this project's reformats is committed to an editor's day,
//     subsequent reformats join that day rather than scattering.
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
  // Keep the full list — dayPriority is per editor|date ACROSS ALL
  // projects, so the priority-append below must scan all of them.
  let project = null;
  let allProjectsList = [];
  try {
    allProjectsList = listProjects(await adminGet("/projects"));
    project = allProjectsList.find(p => (p.links || {}).deliveryId === deliveryId) || null;
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

  // "Fully stacked" threshold — once an editor has 3+ non-done subtasks
  // pinned to a date across ALL projects, taking on another item there
  // pushes them into context-switching hell. The reformat is reassigned
  // to the next editor with capacity instead of piled higher.
  const FULLY_STACKED_THRESHOLD = 3;
  const stackCountForEditorOnDate = (edId, date) => {
    let n = 0;
    for (const p of allProjectsList) {
      const psubs = p?.subtasks ? Object.values(p.subtasks) : [];
      for (const s of psubs) {
        if (!s || s.status === "done" || s.status === "archived") continue;
        if (s.startDate !== date) continue;
        const ids = Array.isArray(s.assigneeIds) ? s.assigneeIds : (s.assigneeId ? [s.assigneeId] : []);
        if (ids.includes(edId)) n += 1;
      }
    }
    return n;
  };

  const masterEditorId = (Array.isArray(master.assigneeIds) && master.assigneeIds[0]) || master.assigneeId || null;
  let editorId = masterEditorId;
  let startDate = null;
  let assigneeIds = [];
  let reassignReason = null;
  if (editorId) {
    try {
      const editorsRaw = await adminGet("/editors");
      const editors = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
      const editor = editors.find(e => e && e.id === editorId);
      const weekData = (await adminGet("/weekData")) || {};
      if (editor) {
        // Same-project stacking: if a sibling reformat is already on
        // the master's editor, land on its date. Stacking wins over the
        // fully-stacked reassign — once the editor's committed to this
        // project's reformat day, sibling reformats join them.
        const sameEditorReformats = subs.filter(s =>
          s && s.reformatOfSubtaskId && s.startDate &&
          ((Array.isArray(s.assigneeIds) && s.assigneeIds.includes(editorId)) || s.assigneeId === editorId)
        );
        if (sameEditorReformats.length > 0) {
          sameEditorReformats.sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
          startDate = sameEditorReformats[sameEditorReformats.length - 1].startDate;
        } else {
          startDate = nextWorkingDayFor(editor, todaySydney(), weekData);
          // Fully-stacked cold-start: if this would be the FIRST reformat
          // and the master's editor is already maxed on that date, hand
          // the reformat to another editor whose next-working-day is
          // less stacked. Deterministic ordering for replay-safe scheduling.
          if (startDate && stackCountForEditorOnDate(editorId, startDate) >= FULLY_STACKED_THRESHOLD) {
            const others = editors
              .filter(e => e && e.id && e.role === "editor" && e.id !== editorId)
              .sort((a, b) => (a.id < b.id ? -1 : 1));
            for (const cand of others) {
              const candDate = nextWorkingDayFor(cand, todaySydney(), weekData);
              if (!candDate) continue;
              if (stackCountForEditorOnDate(cand.id, candDate) < FULLY_STACKED_THRESHOLD) {
                editorId = cand.id;
                startDate = candDate;
                reassignReason = `master-editor-fully-stacked`;
                break;
              }
            }
          }
        }
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
  if (reassignReason) {
    reformat.reassignedFromEditorId = masterEditorId;
    reformat.reassignReason = reassignReason;
  }
  if (scheduled) {
    // Append at the END of that editor+day rather than a raw =1 that would
    // collide with existing priorities. dayPriority is per editor|date
    // ACROSS ALL projects (the Team Board stacks an editor's whole day),
    // so scan EVERY project's subtasks for the key — not just this one
    // (Codex P1: a different project can already hold #1 that day).
    const key = pkey(editorId, startDate);
    let maxP = 0;
    for (const p of allProjectsList) {
      const psubs = p?.subtasks ? Object.values(p.subtasks) : [];
      for (const s of psubs) {
        const v = s?.dayPriority?.[key];
        if (Number.isFinite(v) && v > maxP) maxP = v;
      }
    }
    reformat.dayPriority = { [key]: maxP + 1 };
  }

  try {
    await adminSet(`/projects/${project.id}/subtasks/${stId}`, reformat);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `write failed: ${e.message}` });
  }

  return res.status(200).json({
    ok: true, created: stId, scheduled,
    assignedTo: assigneeIds[0] || null,
    startDate,
    reassignedFromEditorId: reassignReason ? masterEditorId : null,
    reassignReason: reassignReason || null,
  });
}
