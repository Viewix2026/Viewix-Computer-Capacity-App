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

import { adminGet, adminSet } from "../_fb-admin.js";
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

  const now = new Date().toISOString();
  let written = 0;
  for (const m of moves) {
    const base = `/projects/${m.projectId}/subtasks/${m.subtaskId}`;
    try {
      // Clean 1-day move — NEVER widen the span (PR#84 regression guard).
      await adminSet(`${base}/startDate`, m.toDate);
      await adminSet(`${base}/endDate`, m.toDate);
      await adminSet(`${base}/dayPriority/${pkey(m.editorId, m.toDate)}`, 1);
      await adminSet(`${base}/behindSchedule`, true);
      await adminSet(`${base}/rolledFromDate`, m.fromDate);
      await adminSet(`${base}/updatedAt`, now);
      written += 1;
    } catch (e) {
      skipped.push({ projectId: m.projectId, subtaskId: m.subtaskId, reason: `write_failed: ${e.message}` });
    }
  }

  return res.status(200).json({ ok: true, today, moved: written, skipped });
}
