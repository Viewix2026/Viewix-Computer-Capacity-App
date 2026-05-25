// shared/scheduling/selects.js
//
// One source of truth for the "Selects timeline + kick off video"
// automation (Phase 2 / feature #3). Pure JS — no React, no fbSet — so
// both the UI (Team Board drag, Projects date edit) and any server/Slack
// scheduling path can call it and get the SAME writes. Callers apply the
// returned leaf writes themselves (UI: optimistic setProjects + fbSet;
// server: atomic fbSet/update).
//
// Rule (locked with Jeremy):
//   - When a project's shoot date is set/changed, the Selects subtask is
//     dated to shoot + 1 day, assigned to the Project Lead, flipped to
//     "scheduled", and made that day's top priority (dayPriority = 1).
//   - If shoot+1 is a weekend, push to the lead's next working day (no
//     modal — that's automatic).
//   - The lead is "unavailable" only if it's a weekday OFF for them OR
//     they already have ANOTHER shoot that day. Then the caller should
//     open a picker modal (needsPicker = true) so the scheduler chooses
//     someone else. Otherwise assign silently.
//   - Auto-sync wins: re-running this overwrites a prior auto/manual
//     value — EXCEPT never move a Selects subtask that's already "done".
//   - Provenance is stamped so the auto-management is debuggable.

import {
  fmtDate,
  weekDataStatusForEditorOnDate,
  nextWorkingDayFor,
} from "./availability.js";

// dayPriority composite key — mirrors TeamBoard.pkey. Kept local so this
// module has no UI dependency.
export const selectsPkey = (editorId, dateISO) => `${editorId}|${dateISO}`;

// Match the Selects subtask by name (robust to minor label drift).
export function isSelectsSubtask(st) {
  return !!st && (st.name || "").toLowerCase().includes("selects");
}

function isShootSubtask(st) {
  if (!st) return false;
  if (st.stage === "shoot") return true;
  return (st.name || "").toLowerCase().includes("shoot");
}

function getAssigneeIds(st) {
  if (Array.isArray(st?.assigneeIds)) return st.assigneeIds.filter(Boolean);
  return st?.assigneeId ? [st.assigneeId] : [];
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function isWeekendISO(iso) {
  const dow = new Date(`${iso}T00:00:00`).getDay(); // 0 Sun .. 6 Sat
  return dow === 0 || dow === 6;
}

// The project's canonical shoot date = the LATEST stage==="shoot" subtask
// startDate (a project can have multiple shoots).
export function latestShootDate(project) {
  const subs = project?.subtasks ? Object.values(project.subtasks) : [];
  let latest = null;
  let shootId = null;
  for (const st of subs) {
    if (!isShootSubtask(st) || !st.startDate) continue;
    if (!latest || st.startDate > latest) { latest = st.startDate; shootId = st.id; }
  }
  return { date: latest, shootId };
}

// Does this editor already have a DIFFERENT shoot on `dateISO` (across all
// projects)? Used to decide lead availability for the Selects day.
function editorHasShootOn(editorId, dateISO, allProjects, ignoreShootId) {
  for (const p of (allProjects || [])) {
    const subs = p?.subtasks ? Object.values(p.subtasks) : [];
    for (const st of subs) {
      if (!isShootSubtask(st)) continue;
      if (ignoreShootId && st.id === ignoreShootId) continue;
      if (st.startDate !== dateISO) continue;
      if (getAssigneeIds(st).includes(editorId)) return true;
    }
  }
  return false;
}

// Compute the writes needed to bring a project's Selects subtask in line
// with its shoot date. Pure: returns a plan; the caller applies it.
//
//   project      — the target project (must include subtasks)
//   ctx = {
//     allProjects,   // all projects (for cross-project shoot conflict)
//     editors,       // roster
//     weekData,      // weekData-by-Monday-key
//     leadId,        // pre-resolved Project Lead editor id (or null)
//     overrideAssigneeId, // optional — when the picker modal chose someone
//   }
//
// Returns one of:
//   { noop: true, reason }                          nothing to do
//   { needsPicker: true, selectsId, selectsDate, leadId, candidates, reason }
//   { writes: [{ path, value }], selectsId, assigneeId, selectsDate, status }
export function computeSelectsTimelineWrites(project, ctx = {}) {
  const { allProjects = [], editors = [], weekData = {}, leadId = null, overrideAssigneeId = null } = ctx;
  if (!project?.id || !project.subtasks) return { noop: true, reason: "no_project" };

  const { date: shootDate, shootId } = latestShootDate(project);
  if (!shootDate) return { noop: true, reason: "no_shoot_date" };

  const selects = Object.values(project.subtasks).find(isSelectsSubtask);
  if (!selects) return { noop: true, reason: "no_selects_subtask" };
  if (selects.status === "done") return { noop: true, reason: "selects_done" };

  // Resolve the assignee + the editor record we test availability against.
  const editorById = new Map((editors || []).map(e => [e.id, e]));
  const leadEditor = leadId ? editorById.get(leadId) : null;

  // selectsDate = shoot + 1; if weekend, push to the lead's next working
  // day (fall back to the next non-weekend calendar day if no lead).
  let selectsDate = addDaysISO(shootDate, 1);
  if (isWeekendISO(selectsDate)) {
    const pushed = leadEditor ? nextWorkingDayFor(leadEditor, selectsDate, weekData) : null;
    selectsDate = pushed || (() => {
      let d = selectsDate;
      while (isWeekendISO(d)) d = addDaysISO(d, 1);
      return d;
    })();
  }

  // Determine the assignee. An explicit override (from the picker modal)
  // wins. Otherwise default to the lead, but flag for the picker if the
  // lead is unavailable on the Selects day.
  let assigneeId = overrideAssigneeId || leadId || null;
  let needsPicker = false;
  let reason = "auto_lead";

  if (!overrideAssigneeId) {
    if (!leadId || !leadEditor) {
      needsPicker = true;
      reason = "no_lead";
    } else {
      const status = weekDataStatusForEditorOnDate(leadEditor, selectsDate, weekData); // "in"|"shoot"|"off"
      const leadOff = status === "off"; // weekday off / not-in (weekends already pushed away)
      const leadBusyShoot = editorHasShootOn(leadId, selectsDate, allProjects, shootId);
      if (leadOff || leadBusyShoot) {
        needsPicker = true;
        reason = leadOff ? "lead_off" : "lead_has_shoot";
      }
    }
  }

  if (needsPicker) {
    // Candidates = editors working that day with no shoot clash. The UI
    // surfaces these in the modal; we don't write anything yet.
    const candidates = (editors || [])
      .filter(e => weekDataStatusForEditorOnDate(e, selectsDate, weekData) === "in"
        && !editorHasShootOn(e.id, selectsDate, allProjects, shootId))
      .map(e => e.id);
    return { needsPicker: true, selectsId: selects.id, selectsDate, leadId, candidates, reason };
  }

  // Build the writes. All under /projects/{id}/subtasks/{selectsId}.
  const base = `/projects/${project.id}/subtasks/${selects.id}`;
  const now = new Date().toISOString();
  const writes = [
    { path: `${base}/startDate`, value: selectsDate },
    { path: `${base}/endDate`, value: selectsDate },
    { path: `${base}/assigneeIds`, value: assigneeId ? [assigneeId] : [] },
    { path: `${base}/assigneeId`, value: assigneeId || null },
    { path: `${base}/status`, value: "scheduled" },
    // Top priority for that editor on that day (Phase #179 dayPriority).
    { path: `${base}/dayPriority/${selectsPkey(assigneeId, selectsDate)}`, value: 1 },
    // Provenance so the auto-management is debuggable later.
    { path: `${base}/selectsAutoManaged`, value: true },
    { path: `${base}/selectsGeneratedFromShootId`, value: shootId || null },
    { path: `${base}/selectsLinkedShootDate`, value: shootDate },
    { path: `${base}/updatedAt`, value: now },
  ];

  return { writes, selectsId: selects.id, assigneeId, selectsDate, status: "scheduled", reason };
}
