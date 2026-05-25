// api/cron/roll-behind-schedule.js
//
// Phase 3 (#5) — "behind schedule" overnight roll-over.
//
// Finds edit-stage subtasks in ACTIVE-section projects whose scheduled
// day has passed without Finish (status scheduled|inProgress, day <
// today) and rolls each to the assignee's NEXT WORKING DAY as that day's
// top priority (dayPriority = 1), flagging behindSchedule so the Team
// Board priority badge renders red until the edit is done.
//
// ⚠️ This deliberately does a CLEAN 1-DAY MOVE (startDate === endDate ===
// newDay). The previous auto-roll cron (api/roll-overdue-edits.js,
// deleted in PR #84) STRETCHED bars by only moving endDate — do not
// regress to that.
//
// Schedule: vercel.json sets two entries (19:00 + 20:00 UTC) so one lands
// at 06:00 Sydney across DST; the handler bails unless the Sydney hour is
// 6 (or &force=1 with a valid ?secret).
//
// Auth: x-vercel-cron header OR ?secret=$CRON_TEST_SECRET (see _cronAuth).
// Test overrides (valid secret only): &force=1, &today=YYYY-MM-DD,
// &dryRunReport=1 (compute the moves, write nothing).

import { adminGet, adminPatch } from "../_fb-admin.js";
import { isAuthorizedCron } from "../_cronAuth.js";
import { nowInSydney, todaySydney, nextWorkingDayFor } from "../../shared/scheduling/availability.js";
import { isActiveProject, isUnfinishedPastEdit } from "../../shared/scheduling/overdue.js";

const pkey = (editorId, dateISO) => `${editorId}|${dateISO}`;
const assigneeOf = (st) => (Array.isArray(st?.assigneeIds) && st.assigneeIds[0]) || st?.assigneeId || null;

function listProjects(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.entries(raw).map(([id, p]) => (p && typeof p === "object" ? { id, ...p } : null)).filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const auth = isAuthorizedCron(req);
  if (!auth.ok) return res.status(401).json({ error: "Cron header or valid ?secret required" });
  const secretValid = !!auth.secretValid;

  const url = new URL(req.url, "http://x");
  const force = secretValid && url.searchParams.get("force") === "1";
  const todayOverride = secretValid ? (url.searchParams.get("today") || "") : "";
  const dryRunReport = secretValid && url.searchParams.get("dryRunReport") === "1";

  if (!force) {
    const { hour } = nowInSydney();
    if (hour !== 6) return res.status(200).json({ ok: true, skipped: "wrong_hour", sydneyHour: hour });
  }

  const today = todayOverride || todaySydney();

  let projectsRaw, editorsRaw, weekData;
  try {
    [projectsRaw, editorsRaw, weekData] = await Promise.all([
      adminGet("/projects"),
      adminGet("/editors"),
      adminGet("/weekData"),
    ]);
  } catch (e) {
    return res.status(500).json({ error: `read failed: ${e.message}` });
  }

  const projects = listProjects(projectsRaw);
  const editorById = new Map((Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {}))
    .filter(Boolean).map(e => [e.id, e]));

  const moves = [];
  const skipped = [];

  for (const project of projects) {
    if (!isActiveProject(project)) continue;
    const subs = project.subtasks ? Object.values(project.subtasks) : [];
    for (const st of subs) {
      if (!isUnfinishedPastEdit(st, project, today)) continue;
      const editorId = assigneeOf(st);
      const editor = editorId ? editorById.get(editorId) : null;
      if (!editor) { skipped.push({ projectId: project.id, subtaskId: st.id, reason: "no_assignee_or_editor" }); continue; }
      const newDay = nextWorkingDayFor(editor, today, weekData || {});
      if (!newDay) { skipped.push({ projectId: project.id, subtaskId: st.id, reason: "no_working_day" }); continue; }
      moves.push({
        projectId: project.id, subtaskId: st.id, editorId,
        fromDate: st.startDate || st.endDate || null, toDate: newDay,
      });
    }
  }

  if (dryRunReport) {
    return res.status(200).json({ ok: true, dryRun: true, today, moveCount: moves.length, moves, skipped });
  }

  if (moves.length === 0) return res.status(200).json({ ok: true, today, moved: 0, skipped });

  // Build ONE atomic multi-location update (Codex #4 — sequential writes
  // could leave a task moved without its flag/priority). Keys are paths
  // from root; Firebase update() applies them all-or-nothing.
  const now = new Date().toISOString();
  const updates = {};
  const movedIds = new Set(moves.map(m => m.subtaskId));

  // Group by editor+day so rolled edits insert at the FRONT (priorities
  // 1..k in their existing order) and pre-existing work on that day is
  // bumped down by k — the locked "bump existing priorities" rule, not a
  // raw dayPriority=1 that collides (Codex #3).
  const groups = new Map();
  for (const m of moves) {
    const gk = pkey(m.editorId, m.toDate);
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(m);
  }

  for (const [, groupMoves] of groups) {
    const editorId = groupMoves[0].editorId;
    const toDate = groupMoves[0].toDate;
    const key = pkey(editorId, toDate);
    const k = groupMoves.length;

    groupMoves.forEach((m, idx) => {
      const base = `projects/${m.projectId}/subtasks/${m.subtaskId}`;
      // Clean 1-day move — NEVER widen the span (PR#84 regression guard).
      updates[`${base}/startDate`] = m.toDate;
      updates[`${base}/endDate`] = m.toDate;
      updates[`${base}/dayPriority/${key}`] = idx + 1; // rolled edits take the front
      updates[`${base}/behindSchedule`] = true;
      updates[`${base}/rolledFromDate`] = m.fromDate;
      updates[`${base}/updatedAt`] = now;
    });

    // Bump existing siblings on this editor+day (anything not being rolled
    // that already holds a priority) down by k so the rolled edits sit ahead.
    for (const p of projects) {
      const subs = p.subtasks ? Object.values(p.subtasks) : [];
      for (const st of subs) {
        if (movedIds.has(st.id)) continue;
        const v = st?.dayPriority?.[key];
        if (Number.isFinite(v)) {
          updates[`projects/${p.id}/subtasks/${st.id}/dayPriority/${key}`] = v + k;
        }
      }
    }
  }

  try {
    await adminPatch("/", updates); // atomic: all moves + bumps, or none
  } catch (e) {
    return res.status(500).json({ ok: false, error: `atomic write failed: ${e.message}`, attempted: moves.length });
  }

  return res.status(200).json({ ok: true, today, moved: moves.length, skipped });
}
