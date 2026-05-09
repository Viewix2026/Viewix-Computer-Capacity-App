// api/scheduling-brain-check.js
//
// Team-board drag-end → backend conflict check.
// Called from TeamBoard.jsx after the per-leaf fbSet writes commit
// optimistically. Frontend sends the proposed patch; backend applies
// it virtually on top of current Firebase state and runs the
// deterministic checker. If any flags fire, they're returned for the
// inline banner AND a /scheduling/pendingFlags record is upserted with
// notifyAt = now + 3min so the flusher cron can post a Slack message
// later if the flag is still active by then.
//
// Self-fix window: drag again before 3min and we re-evaluate; if the
// conflict is gone the flusher silences the pending entry without
// posting.
//
// No live /timeLogs reads — drag stays cheap. Reads cached stats only.
// Overrun flags don't fire here; that's digest-only.
//
// Auth: requireRole — any authenticated user. Drag actor is resolved
// best-effort by matching Firebase UID against /editors[].id.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { detectFlagsForDateRange, enrichFlagsForDisplay } from "../shared/scheduling/conflicts.js";
import { fingerprintFlag } from "../shared/scheduling/flags.js";
import { cachedStatsIsFresh } from "../shared/scheduling/stats.js";
import { todaySydney } from "../shared/scheduling/availability.js";
import { hashFingerprint, randomShortId } from "./_slack-helpers.js";

export const config = { maxDuration: 30 };

const PENDING_FLAG_DELAY_MS = 3 * 60 * 1000; // 3 minutes
const PENDING_FLAG_TTL_MS = 60 * 60 * 1000;  // 1 hour cap on a single pending entry

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try {
    // Any authenticated user can fire a drag check — same audience that
    // can drag bars on the Team Board (founders / leads / editors etc.).
    decoded = await requireRole(req, []);
  } catch (e) {
    return sendAuthError(res, e);
  }

  let body;
  try { body = req.body || (req.body === undefined ? JSON.parse(await readJson(req)) : {}); }
  catch { return res.status(400).json({ error: "invalid JSON body" }); }
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "invalid JSON body" }); }
  }
  const { trigger = "drag", projectId, subtaskId, affectedDate, proposedPatch } = body || {};
  if (!projectId || !subtaskId) {
    return res.status(400).json({ error: "projectId and subtaskId required" });
  }

  try {
    const result = await runBrainCheck({
      decoded, trigger, projectId, subtaskId, affectedDate, proposedPatch: proposedPatch || {},
    });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error("scheduling-brain-check error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function runBrainCheck({
  decoded, trigger, projectId, subtaskId, affectedDate, proposedPatch,
}) {
  // Read state — NO /timeLogs (drag stays cheap, uses cached stats).
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

  // Apply proposedPatch virtually onto a clone of the projects map.
  // The drag's per-leaf fbSet calls are fire-and-forget — reading
  // /projects directly may return partial state. Trust the patch.
  const virtualProjects = applyVirtualWrite(projects, projectId, subtaskId, proposedPatch);

  // Affected person — best-effort. Use the single assignee on the
  // patch (or current subtask). Date — affectedDate from the drag, or
  // the patch's startDate, or today.
  const targetSubtask = virtualProjects[projectId]?.subtasks?.[subtaskId];
  const personId = (proposedPatch.assigneeIds?.[0]) ||
                   proposedPatch.assigneeId ||
                   (targetSubtask?.assigneeIds?.[0]) ||
                   targetSubtask?.assigneeId ||
                   null;
  const dateISO = affectedDate || proposedPatch.startDate || targetSubtask?.startDate || todaySydney();

  // Run the checker scoped to the affected person/date so the banner
  // doesn't surface unrelated flags from elsewhere.
  const startDate = proposedPatch.startDate || targetSubtask?.startDate || dateISO;
  const endDate = proposedPatch.endDate || targetSubtask?.endDate || startDate;
  const today = todaySydney();
  const rawFlags = detectFlagsForDateRange({
    startDate, endDate,
    projects: virtualProjects,
    editors,
    weekData,
    videoTypeStats,
    loggedHoursBySubtask: {},  // overrun is digest-only
    scope: personId ? { kind: "actor", personId, dateISO, today } : { kind: "all" },
  });
  // Enrich with display-side names (personName, projectName, clientName,
  // subtaskName) so the inline banner can read like a human briefing.
  const flags = enrichFlagsForDisplay(rawFlags, { projects: virtualProjects, editors });

  // Best-effort actor lookup — Firebase UID → editor record →
  // slackUserId. Falls back to anonymous if no match (v1 doesn't
  // require a Firebase-UID ↔ editor-id mapping).
  const editor = editors.find(e => e.id === decoded?.uid);
  const actorSlackUserId = editor?.slackUserId || null;

  // Persist a pendingFlags record so the flusher can post (or silence)
  // 3 minutes from now. Upsert by subjectKey so multiple drags on the
  // same subtask collapse into one record (notifyAt resets each drag).
  if (flags.length > 0) {
    await upsertPendingFlag({
      trigger, projectId, subtaskId,
      actorFirebaseUid: decoded?.uid || null,
      actorSlackUserId,
      flags,
    });
  } else {
    // No flags — silence any pending record for this subjectKey
    // (the user just self-fixed within the window).
    await silencePendingFlagBySubject(`${projectId}:${subtaskId}`);
  }

  return {
    flags,
    actorSlackUserId,
  };
}

// ── Virtual write ─────────────────────────────────────────────────
function applyVirtualWrite(projects, projectId, subtaskId, patch) {
  const targetProject = projects[projectId];
  if (!targetProject) return projects;
  const subtasks = { ...(targetProject.subtasks || {}) };
  const existing = subtasks[subtaskId] || {};
  // Only apply keys that are actually in the patch. Frontend may send
  // a subset (e.g., resize-only sends startDate+endDate).
  const merged = { ...existing, id: subtaskId };
  for (const k of ["startDate", "endDate", "startTime", "endTime",
                   "assigneeIds", "assigneeId", "stage", "name", "status"]) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  subtasks[subtaskId] = merged;
  return {
    ...projects,
    [projectId]: { ...targetProject, subtasks },
  };
}

// ── Pending-flag persistence ──────────────────────────────────────
async function upsertPendingFlag({
  trigger, projectId, subtaskId,
  actorFirebaseUid, actorSlackUserId,
  flags,
}) {
  const { db } = getAdmin();
  if (!db) throw new Error("firebase-admin not configured");

  const subjectKey = `${projectId}:${subtaskId}`;
  const fingerprints = flags.map(fingerprintFlag);
  const now = Date.now();

  // Look for an existing pending record with the same subjectKey.
  const all = (await adminGet("/scheduling/pendingFlags")) || {};
  const existingId = Object.entries(all)
    .find(([, rec]) => rec?.subjectKey === subjectKey)?.[0];

  const record = {
    trigger,
    subjectKey,
    actorFirebaseUid: actorFirebaseUid || null,
    actorSlackUserId: actorSlackUserId || null,
    flags,
    fingerprints,
    createdAt: existingId ? (all[existingId].createdAt || now) : now,
    notifyAt: now + PENDING_FLAG_DELAY_MS,
    expiresAt: now + PENDING_FLAG_TTL_MS,
  };

  if (existingId) {
    await db.ref(`/scheduling/pendingFlags/${existingId}`).set({
      shortId: existingId, ...record,
    });
  } else {
    const shortId = randomShortId();
    await db.ref(`/scheduling/pendingFlags/${shortId}`).set({
      shortId, ...record,
    });
  }
}

async function silencePendingFlagBySubject(subjectKey) {
  const { db } = getAdmin();
  if (!db) return;
  const all = (await adminGet("/scheduling/pendingFlags")) || {};
  for (const [id, rec] of Object.entries(all)) {
    if (rec?.subjectKey === subjectKey) {
      // Move to pendingFlagsDone with status "silenced".
      const moved = { ...rec, status: "silenced", silencedAt: Date.now() };
      await db.ref(`/scheduling/pendingFlagsDone/${id}`).set(moved);
      await db.ref(`/scheduling/pendingFlags/${id}`).remove();
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────
async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
