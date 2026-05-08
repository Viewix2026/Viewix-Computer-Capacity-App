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
//   - has at least one assignee on /editors with a defaultDays config
//
// Roll logic:
//   - find the EARLIEST next working day across all assignees,
//     starting from today (inclusive). "Working day" = the editor's
//     defaultDays[dayKey] is true.
//   - Patch /projects/{id}/subtasks/{stId} with the new endDate +
//     bumped updatedAt. Tracks autoRolledCount + autoRolledLast on
//     the subtask so the producer can see how many times it's been
//     rolled before they intervene.
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
// this array. Sat / Sun aren't in the editor schema (no editor
// works weekends by default) — those days get skipped.
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Compute today's date string in Sydney time (YYYY-MM-DD). The
// dashboard stores all subtask dates in this format, so the
// cron's "today" needs to match. Sydney is UTC+10/+11; we convert
// via the Intl API to dodge DST math by hand.
function todaySydney() {
  // en-CA gives YYYY-MM-DD natively; pinning to Australia/Sydney
  // gives the correct local date even when this Vercel function
  // is running on UTC infra.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

// Walk forward from `fromDate` (YYYY-MM-DD, inclusive) up to a
// safety cap of 21 days. Returns the first date the editor's
// defaultDays says they're in. Null if no match within the cap
// (shouldn't happen for a real editor — Sat/Sun fail but Mon-Fri
// at minimum is one of them, and editor records always have at
// least one true day).
function nextWorkingDayFor(editor, fromDate) {
  if (!editor?.defaultDays) return null;
  // Parse as local date; offset doesn't matter as we only output
  // YYYY-MM-DD strings, never timestamps.
  const start = new Date(`${fromDate}T00:00:00`);
  for (let i = 0; i <= 21; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dayKey = DAY_KEYS[d.getDay()];
    if (editor.defaultDays[dayKey]) {
      // Format as YYYY-MM-DD via en-CA (no leading-zero faff).
      return new Intl.DateTimeFormat("en-CA").format(d);
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
        const next = nextWorkingDayFor(editor, today);
        if (next && (!bestNext || next < bestNext)) bestNext = next;
      }
      if (!matchedAnyEditor) { skipped.noEditorMatch++; continue; }
      if (!bestNext) { skipped.noWorkingDay++; continue; }

      const now = new Date().toISOString();
      await adminPatch(`/projects/${projectId}/subtasks/${stId}`, {
        endDate: bestNext,
        updatedAt: now,
        autoRolledLast: now,
        autoRolledCount: (Number(st.autoRolledCount) || 0) + 1,
      });
      rolled.push({
        projectId,
        subtaskId: stId,
        name: st.name || "(unnamed)",
        from: st.endDate,
        to: bestNext,
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
