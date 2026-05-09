// api/roll-overdue-edits.js
//
// Vercel Cron: rolls overdue Edit-stage subtasks forward to the
// editor's next working day, so the task stays in their to-do
// queue until they actually click Finish + complete the submit
// flow on the Editors tab.
//
// Spec (per Jeremy): an editor working on a stage="edit" subtask
// must click Finish → fill the Frame.io link → choose review type
// → submit. Until they do, the subtask shouldn't disappear from
// their queue just because its endDate ticked over. So every day
// at 06:00 Sydney (20:00 UTC), this cron scans /projects/*/subtasks/*
// looking for matches and pushes the endDate forward.
//
// Match criteria — ALL must be true:
//   - stage === "edit"
//   - status NOT "done" and NOT "archived"
//   - endDate exists AND is BEFORE today's date (Sydney)
//   - has at least one assignee on /editors
//
// Roll logic:
//   - find the EARLIEST next working day across all assignees,
//     starting from today (inclusive). Availability is read from
//     /weekData (the Capacity → Weekly Schedule grid) first —
//     more granular than the team roster's defaultDays because it
//     captures one-off PTO, shoot days, swap days, etc. Falls
//     back to defaultDays only when no weekData entry exists for
//     the editor that week.
//   - "Working day" for an EDIT subtask = dayVal(cell) === "in".
//     "shoot" cells don't count — the editor's on a shoot, not
//     in the edit suite.
//   - Patch BOTH startDate AND endDate to bestNext (single-day
//     bar at the next-available date). Earlier versions only
//     moved endDate, which made the task STRETCH instead of
//     SLIDE — bar grew by one day per roll. Symptom Jeremy hit:
//     end dates extending weeks into the future on the Team
//     Board for tasks that had been rolling for a while. Bumps
//     updatedAt + tracks autoRolledCount / autoRolledLast so the
//     producer can see how many times a task's been rolled
//     before they intervene.
//
// Idempotent — if the cron runs twice in a day, the second run is
// a no-op since endDate is already >= today after the first.
//
// Vercel auth: Vercel signs cron requests with a header automatically;
// we don't need a secret check here.

import { getAdmin, adminGet, adminPatch } from "./_fb-admin.js";
// Availability helpers extracted to shared/scheduling/availability.js
// so the scheduling brain reuses the same isEditorInOnDate logic.
// Behaviour identical to the inline versions that lived here previously.
import {
  todaySydney,
  fmtDate,
  isEditorInOnDate,
  nextWorkingDayFor,
} from "../shared/scheduling/availability.js";

export default async function handler(req, res) {
  const { err } = getAdmin();
  if (err) {
    return res.status(500).json({ error: "Firebase admin not configured", detail: err.message });
  }

  const today = todaySydney();
  const startedAt = new Date().toISOString();

  // Editors come in either as an array (legacy DEF_EDS shape) or as
  // an object keyed by id. Normalise into a Map so the assignee
  // lookup below is O(1).
  const rawEditors = (await adminGet("/editors")) || [];
  const editorList = Array.isArray(rawEditors) ? rawEditors : Object.values(rawEditors);
  const editorById = new Map();
  for (const e of editorList) {
    if (e?.id) editorById.set(e.id, e);
  }

  // /weekData is the per-week schedule the Capacity → Weekly
  // Schedule grid edits. Keyed by wKey (Monday YYYY-MM-DD), each
  // value is { editors: [...] } where each editor entry has a
  // `days` map. Authoritative source of "is X in the edit suite
  // this week" — preferred over defaultDays per the dashboard's
  // own precedence (see Capacity.jsx line 104).
  const weekData = (await adminGet("/weekData")) || {};

  const projects = (await adminGet("/projects")) || {};
  const rolled = [];
  const skipped = { wrongStage: 0, alreadyDone: 0, notOverdue: 0, noAssignee: 0, noEditorMatch: 0, noWorkingDay: 0 };

  for (const [projectId, project] of Object.entries(projects)) {
    if (!project || typeof project !== "object") continue;
    const subtasks = project.subtasks || {};
    for (const [stId, st] of Object.entries(subtasks)) {
      if (!st || typeof st !== "object") continue;

      // Filter — early returns increment a skip counter so the
      // cron's response body doubles as a sanity-check audit.
      if (st.stage !== "edit") { skipped.wrongStage++; continue; }
      if (st.status === "done" || st.status === "archived") { skipped.alreadyDone++; continue; }
      if (!st.endDate || st.endDate >= today) { skipped.notOverdue++; continue; }
      const assigneeIds = Array.isArray(st.assigneeIds) && st.assigneeIds.length > 0
        ? st.assigneeIds
        : (st.assigneeId ? [st.assigneeId] : []);
      if (assigneeIds.length === 0) { skipped.noAssignee++; continue; }

      // Pick the earliest next-available date across all assignees.
      // Multi-assignee subtasks (shoot crew, occasionally edit
      // pairings) shouldn't sit longer than necessary — the team's
      // earliest working day is when the work can actually resume.
      let bestNext = null;
      let matchedAnyEditor = false;
      for (const aid of assigneeIds) {
        const editor = editorById.get(aid);
        if (!editor) continue;
        matchedAnyEditor = true;
        const next = nextWorkingDayFor(editor, today, weekData);
        if (next && (!bestNext || next < bestNext)) bestNext = next;
      }
      if (!matchedAnyEditor) { skipped.noEditorMatch++; continue; }
      if (!bestNext) { skipped.noWorkingDay++; continue; }

      const now = new Date().toISOString();
      // Collapse to a 1-day bar at bestNext. Patches BOTH start
      // and end so the Gantt bar slides forward instead of
      // stretching. If the producer wanted a multi-day budget
      // they'll re-extend manually after the cron repositions.
      await adminPatch(`/projects/${projectId}/subtasks/${stId}`, {
        startDate: bestNext,
        endDate: bestNext,
        updatedAt: now,
        autoRolledLast: now,
        autoRolledCount: (Number(st.autoRolledCount) || 0) + 1,
      });
      rolled.push({
        projectId,
        subtaskId: stId,
        name: st.name || "(unnamed)",
        // Audit shape captures the full move (both ends) so the
        // cron's response body is useful for debugging stretched
        // bars from older runs.
        fromStart: st.startDate || null,
        fromEnd: st.endDate,
        toStart: bestNext,
        toEnd: bestNext,
        assigneeIds,
        autoRolledCount: (Number(st.autoRolledCount) || 0) + 1,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    today,
    startedAt,
    finishedAt: new Date().toISOString(),
    rolledCount: rolled.length,
    rolled,
    skipped,
  });
}
