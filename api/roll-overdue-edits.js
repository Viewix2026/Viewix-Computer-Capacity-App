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

// Day keys match the schema used everywhere else in the codebase
// (see config.js DEF_EDS — { mon, tue, wed, thu, fri }). The
// JS Date.getDay() index is 0=Sun..6=Sat, so we map to keys via
// this array. Sat / Sun aren't in the editor schema — those days
// always read as "off" since no key matches.
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Compute today's date string in Sydney time (YYYY-MM-DD). The
// dashboard stores all subtask dates in this format, so the
// cron's "today" needs to match. Sydney is UTC+10/+11; we convert
// via the Intl API to dodge DST math by hand.
function todaySydney() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

// Format a Date as YYYY-MM-DD via en-CA (no leading-zero faff).
function fmtDate(d) {
  return new Intl.DateTimeFormat("en-CA").format(d);
}

// Mirror src/utils.js getMonday — JS-Date in, JS-Date out, time
// snapped to 00:00 local. Sunday rolls back to the prior week's
// Monday (matches the rest of the codebase's "weeks start Monday"
// convention). Used to derive the wKey for weekData lookups.
function getMonday(d) {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day + (day === 0 ? -6 : 1));
  x.setHours(0, 0, 0, 0);
  return x;
}

// Mirror src/utils.js dayVal — collapses the {true | "in" |
// "shoot" | false | undefined | null} cell value down to one of
// "in" / "shoot" / "off". For Edit-stage rolling we treat "shoot"
// as "off" (the editor's on a shoot, not in the edit suite, so
// they can't pick up an edit task that day).
function dayVal(v) {
  if (v === true || v === "in") return "in";
  if (v === "shoot") return "shoot";
  return "off";
}

// Resolve "is editor X in the edit suite on date D" using the
// same precedence the Capacity dashboard renders:
//   1. weekData[wkKey].editors → find the entry for this editor
//      → check `days[dayKey]`. If the week record exists, it's
//      authoritative.
//   2. Fall back to editor.defaultDays[dayKey].
// "In" only — `dayVal === "in"`. "shoot" doesn't count for an
// edit subtask; the editor's busy elsewhere.
function isEditorInOnDate(editor, date, weekDataByKey) {
  if (!editor) return false;
  const dayKey = DAY_KEYS[date.getDay()];
  if (!dayKey || dayKey === "sat" || dayKey === "sun") return false;
  const wkKey = fmtDate(getMonday(date));
  const weekRec = weekDataByKey?.[wkKey];
  // weekData[wk].editors is stored as an ARRAY of editor objects
  // each with their own `days` cell map (NOT a map keyed by id —
  // see Capacity.jsx line 104, ".editors || scheduleEditors.map").
  // Find by id; fall back to defaultDays if not represented in
  // this week (the dashboard does the same fallback).
  if (weekRec?.editors && Array.isArray(weekRec.editors)) {
    const wkEditor = weekRec.editors.find(e => e?.id === editor.id);
    if (wkEditor && wkEditor.days) {
      return dayVal(wkEditor.days[dayKey]) === "in";
    }
  }
  // Default-roster fallback. defaultDays only stores `true` for
  // working days; absence is "off".
  return editor.defaultDays?.[dayKey] === true;
}

// Walk forward from `fromDate` (YYYY-MM-DD, inclusive) up to a
// safety cap of 21 days. Returns the first date isEditorInOnDate
// returns true for. Null if no match within the cap.
function nextWorkingDayFor(editor, fromDate, weekDataByKey) {
  const start = new Date(`${fromDate}T00:00:00`);
  for (let i = 0; i <= 21; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (isEditorInOnDate(editor, d, weekDataByKey)) {
      return fmtDate(d);
    }
  }
  return null;
}

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
