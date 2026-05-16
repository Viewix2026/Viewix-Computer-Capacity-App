// shared/scheduling/planner.js
//
// Phase 2 v2.0 — the DETERMINISTIC planner. Given fully-loaded state
// (no I/O here), produce a feasible multi-subtask plan for a project:
// one edit per un-edited video, one unscheduled revision per video,
// plus an optional extra shoot.
//
// Architecture contract (locked design doc):
//   - This module GENERATES the plan. Opus only narrates it later.
//   - Pure JS: no Firebase, no Slack, no Opus, no Date.now(),
//     no Math.random(). `today`, `planGroupId`, and id generation are
//     injected by the caller so the same inputs always produce the
//     same output (testable in isolation).
//   - Builds on Phase 1 primitives — capacity.js, availability.js,
//     conflicts.js — never reimplements capacity/availability math.
//
// Reconciliation identity is (projectId, stage, _videoIndex).
// _planGroupId is audit lineage, NOT identity (a re-plan gets a new
// planGroupId but must still find prior generated rows).
//
// Exports:
//   buildVideoUnits        — canonical "what work does each video need"
//   buildCapacityGrid      — per-editor per-date free EDIT hours
//   planExtraShoot         — constraint-solve one optional extra shoot
//   planEdits              — greedy edit allocation w/ locked tie-break
//   planRevisions          — one unscheduled revision per missing unit
//   partitionFlags         — split detectFlags output hard vs warning
//   buildPlan              — orchestrator tying it all together (pure)

import { CAPACITY_BANDS, FALLBACKS, MIN_SAMPLE_SIZE } from "./constants.js";
import {
  isEditorInOnDate,
  isWorkingOnDate,
  datesInRange,
  fmtDate,
} from "./availability.js";
import { inferStage } from "./stages.js";
import {
  hydrateEstHours,
  plannedHoursForDate,
  hoursForSubtaskOnDateForEditor,
} from "./capacity.js";
import { detectFlagsForDateRange } from "./conflicts.js";

// Flag kinds that BLOCK one-click approve. Everything else is a
// one-click warning. Mirrors the locked design-doc decision.
export const HARD_VIOLATION_KINDS = new Set([
  "fixedTimeConflict",
  "offDayAssigned",
  "dailyHardOverCapacity",
]);

// Planner-emitted infeasibility (distinct from detectFlags output).
// These are ALWAYS hard — the planner couldn't place required work.
const PLAN_INFEASIBLE = "planInfeasible";

// ─── Stage estimate ────────────────────────────────────────────────
// Live videoType+stage average when statistically valid, else the
// Phase 1 fallback. Identical rule to hydrateEstHours so the planner
// and the checker agree on hours.
export function stageEstimate(videoType, stage, videoTypeStats) {
  const s = videoTypeStats?.[videoType]?.[stage];
  if (s && typeof s.avgHours === "number" && s.sampleCount >= MIN_SAMPLE_SIZE) {
    return s.avgHours;
  }
  return FALLBACKS[stage] ?? 0;
}

// ─── Canonical video units ─────────────────────────────────────────
// A subtask "belongs to" video N when it has an explicit _videoIndex,
// OR its name matches "<Edit|Revisions|Shoot> — Video N". Anything
// else is UNINDEXED and the planner never touches it (manually-named
// work stays the producer's).
//
// Returns videoUnits[1..numberOfVideos] = { index, edit, revisions }
// where edit/revisions are the existing subtask object (with its id
// surfaced as ._id) or null.
const NAME_INDEX_RE = /^\s*(edit|revisions?|shoot)\s*[—–-]\s*video\s*(\d+)/i;

export function videoIndexOf(subtask) {
  if (!subtask || typeof subtask !== "object") return null;
  if (Number.isInteger(subtask._videoIndex) && subtask._videoIndex > 0) {
    return subtask._videoIndex;
  }
  const m = NAME_INDEX_RE.exec(subtask.name || "");
  if (m) {
    const n = parseInt(m[2], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export function buildVideoUnits(project) {
  const n = Math.max(0, parseInt(project?.numberOfVideos, 10) || 0);
  const units = [];
  for (let i = 1; i <= n; i++) units.push({ index: i, edit: null, revisions: null });
  const byIndex = new Map(units.map(u => [u.index, u]));

  for (const [stid, st] of Object.entries(project?.subtasks || {})) {
    if (!st || typeof st !== "object") continue;
    if (st.status === "archived") continue; // archived work is gone
    const idx = videoIndexOf(st);
    if (idx == null) continue;              // unindexed → planner ignores
    const unit = byIndex.get(idx);
    if (!unit) continue;                    // index beyond numberOfVideos
    const stage = inferStage(st);
    const withId = { ...st, _id: st.id || stid };
    if (stage === "edit" && !unit.edit) unit.edit = withId;
    else if (stage === "revisions" && !unit.revisions) unit.revisions = withId;
  }
  return units;
}

// A unit "needs an edit scheduled" when it has no edit subtask, or its
// edit subtask is not done/archived and has no startDate. A done edit
// means the video is already cut — leave it.
function unitNeedsEdit(unit) {
  const e = unit.edit;
  if (!e) return true;
  if (e.status === "done" || e.status === "archived") return false;
  return !e.startDate;
}
function unitNeedsRevision(unit) {
  // Revisions are created once, unscheduled. If any revisions subtask
  // exists for the unit (scheduled or not, done or not) we don't add
  // another.
  return !unit.revisions;
}

// ─── Capacity grid ─────────────────────────────────────────────────
// Per candidate editor, per date in the plan window, free EDIT hours.
//
// Uses isEditorInOnDate (NOT isWorkingOnDate): a shoot day is a working
// day but yields zero free *edit* capacity (the editor is on the shoot,
// not at the edit suite). Shoot-day scheduling in planExtraShoot uses
// isWorkingOnDate instead — that distinction is the whole point of the
// two availability functions.
export function buildCapacityGrid({ candidateEditors, projects, weekData, planWindow }) {
  const hydrated = projects; // caller passes already-hydrated projects
  const grid = {};
  for (const ed of candidateEditors) {
    const row = {};
    for (const date of datesInRange(planWindow.start, planWindow.end)) {
      if (!isEditorInOnDate(ed, date, weekData)) { row[date] = 0; continue; }
      const planned = plannedHoursForDate(ed.id, date, hydrated);
      row[date] = Math.max(0, CAPACITY_BANDS.target - planned);
    }
    grid[ed.id] = row;
  }
  return grid;
}

function totalRemaining(gridRow) {
  let t = 0;
  for (const v of Object.values(gridRow || {})) t += v;
  return t;
}

// ─── Candidate editor selection ────────────────────────────────────
// requestedEditorIds → exactly those (role-filtered to editors).
// anyoneWithCapacity → rank ALL editors by per-date feasible-day count
//   (number of plan-window days with >= meanEst free hours — aggregate
//   hours lie, locked decision #2), take the top N, union with any
//   explicitly requested ids.
export function selectCandidateEditors({
  editors, requestedEditorIds, anyoneWithCapacity,
  projects, weekData, planWindow, meanEst, remainingEditCount,
}) {
  const allEditors = (editors || []).filter(e => e && e.id && e.role === "editor");
  const requested = allEditors.filter(e => (requestedEditorIds || []).includes(e.id));

  if (!anyoneWithCapacity) return requested;

  // Build a cheap grid for ALL editors to rank by feasible-day count.
  const grid = buildCapacityGrid({ candidateEditors: allEditors, projects, weekData, planWindow });
  const ranked = allEditors
    .map(e => {
      let feasibleDays = 0;
      for (const v of Object.values(grid[e.id] || {})) if (v >= meanEst) feasibleDays++;
      return { e, feasibleDays };
    })
    .sort((a, b) => b.feasibleDays - a.feasibleDays || (a.e.id < b.e.id ? -1 : 1));

  const n = Math.max(2, Math.ceil((remainingEditCount || 0) / 2));
  const top = ranked.slice(0, n).map(r => r.e);
  // Union: explicitly-requested editors always included.
  const seen = new Set();
  const out = [];
  for (const e of [...requested, ...top]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// ─── Extra shoot ───────────────────────────────────────────────────
// Place ONE optional extra shoot on the first date in its requested
// window where every assignee is working (isWorkingOnDate — crewing IS
// the work on a shoot day) and has no existing timed conflict. Deduct
// the shoot from the assignees' edit grid for that day (they can't also
// edit while shooting).
export function planExtraShoot({
  extraShoot, editors, projects, weekData, grid, planGroupId, idFor,
}) {
  if (!extraShoot) return { shoot: null, violation: null };
  const {
    dateRangeStart, dateRangeEnd, durationHours,
    assigneeIds = [], timesKnown, startTime = null, endTime = null,
  } = extraShoot;

  const crew = (assigneeIds || []).filter(Boolean);
  if (crew.length === 0) {
    return {
      shoot: null,
      violation: { kind: PLAN_INFEASIBLE, subkind: "extraShootNoCrew" },
    };
  }
  const edById = new Map((editors || []).filter(e => e?.id).map(e => [e.id, e]));

  for (const date of datesInRange(dateRangeStart, dateRangeEnd)) {
    let ok = true;
    for (const id of crew) {
      const ed = edById.get(id);
      // Must be a working day for every crew member …
      if (!ed || !isWorkingOnDate(ed, date, weekData)) { ok = false; break; }
      // … and they must not already be on a shoot / timed task that day.
      let busyTimed = 0;
      for (const p of Object.values(projects || {})) {
        for (const st of Object.values(p?.subtasks || {})) {
          if (st?.status === "done" || st?.status === "archived") continue;
          if (inferStage(st) !== "shoot") continue;
          busyTimed += hoursForSubtaskOnDateForEditor(st, date, id);
        }
      }
      if (busyTimed > 0) { ok = false; break; }
    }
    if (!ok) continue;

    // Feasible. Deduct the shoot from every crew member's edit grid for
    // that day (a shoot day yields no free edit hours).
    for (const id of crew) {
      if (grid[id]) grid[id][date] = 0;
    }
    const shoot = {
      mode: "create",
      stage: "shoot",
      videoIndex: null,
      _existingSubtaskId: null,
      _planGroupId: planGroupId,
      _videoIndex: null,
      name: "Shoot — extra",
      startDate: date,
      endDate: date,
      startTime: timesKnown ? startTime : null,
      endTime: timesKnown ? endTime : null,
      assigneeIds: [...crew],
      assigneeId: crew[0],
      id: idFor("shoot", "extra"),
    };
    return { shoot, violation: null };
  }

  return {
    shoot: null,
    violation: {
      kind: PLAN_INFEASIBLE, subkind: "extraShootNoFeasibleDay",
      dateRangeStart, dateRangeEnd, crew,
    },
  };
}

// ─── Edit allocation ───────────────────────────────────────────────
// Greedy, feasibility-first. For each video unit needing an edit, pick
// the editor by the locked 3-tier tie-break:
//   1. explicitly-requested editors before auto-picks
//   2. earliest feasible finish (edits front-load single-day, so this
//      is just the earliest date the editor has >= estHours free)
//   3. most remaining plan-window capacity
//   (stable final tiebreak: editor id ascending — determinism)
export function planEdits({
  videoUnits, candidateEditors, grid, project, videoTypeStats,
  planWindow, today, deadline, requestedEditorIds, planGroupId, idFor,
}) {
  const requested = new Set(requestedEditorIds || []);
  const estHours = stageEstimate(project?.videoType, "edit", videoTypeStats);
  const proposed = [];
  const violations = [];

  const windowEnd = deadline && deadline < planWindow.end ? deadline : planWindow.end;

  for (const unit of videoUnits) {
    if (!unitNeedsEdit(unit)) continue;

    // Earliest feasible date per candidate editor.
    const cands = [];
    for (const ed of candidateEditors) {
      const row = grid[ed.id] || {};
      let earliest = null;
      for (const date of datesInRange(planWindow.start, windowEnd)) {
        if (date < today) continue;
        if ((row[date] || 0) >= estHours) { earliest = date; break; }
      }
      if (earliest) cands.push({ ed, earliest, remaining: totalRemaining(row) });
    }

    if (cands.length === 0) {
      violations.push({
        kind: PLAN_INFEASIBLE, subkind: "noEditCapacity",
        videoIndex: unit.index, estHours,
      });
      continue;
    }

    cands.sort((a, b) => {
      const ar = requested.has(a.ed.id) ? 0 : 1;
      const br = requested.has(b.ed.id) ? 0 : 1;
      if (ar !== br) return ar - br;                       // tier 1
      if (a.earliest !== b.earliest) return a.earliest < b.earliest ? -1 : 1; // tier 2
      if (a.remaining !== b.remaining) return b.remaining - a.remaining;      // tier 3
      return a.ed.id < b.ed.id ? -1 : 1;                   // stable
    });

    const pick = cands[0];
    grid[pick.ed.id][pick.earliest] = (grid[pick.ed.id][pick.earliest] || 0) - estHours;

    const existing = unit.edit;
    proposed.push({
      mode: existing ? "update" : "create",
      stage: "edit",
      videoIndex: unit.index,
      _existingSubtaskId: existing ? existing._id : null,
      _planGroupId: planGroupId,
      _videoIndex: unit.index,
      name: `Edit — Video ${unit.index}`,
      startDate: pick.earliest,
      endDate: pick.earliest,
      startTime: null,
      endTime: null,
      assigneeIds: [pick.ed.id],
      assigneeId: pick.ed.id,
      id: existing ? existing._id : idFor("edit", unit.index),
      _estHours: estHours,
    });
  }
  return { proposed, violations };
}

// ─── Revisions ─────────────────────────────────────────────────────
// One unscheduled revision per video unit that doesn't already have a
// revisions subtask. Client-feedback timing is unknowable, so NO dates.
export function planRevisions({ videoUnits, planGroupId, idFor }) {
  const proposed = [];
  for (const unit of videoUnits) {
    if (!unitNeedsRevision(unit)) continue;
    proposed.push({
      mode: "create",
      stage: "revisions",
      videoIndex: unit.index,
      _existingSubtaskId: null,
      _planGroupId: planGroupId,
      _videoIndex: unit.index,
      name: `Revisions — Video ${unit.index}`,
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      assigneeIds: [],
      assigneeId: null,
      id: idFor("revisions", unit.index),
    });
  }
  return proposed;
}

// ─── Flag partition ────────────────────────────────────────────────
export function partitionFlags(flags) {
  const hardViolations = [];
  const warnings = [];
  for (const f of flags || []) {
    if (HARD_VIOLATION_KINDS.has(f.kind)) hardViolations.push(f);
    else warnings.push(f);
  }
  return { hardViolations, warnings };
}

// ─── Virtual apply ─────────────────────────────────────────────────
// Merge proposed writes onto a projects clone so detectFlags sees the
// post-apply state. Pure — does not mutate the input.
function applyVirtual(projects, projectId, proposedSubtasks) {
  const target = projects[projectId];
  if (!target) return projects;
  const subtasks = { ...(target.subtasks || {}) };
  for (const ps of proposedSubtasks) {
    if (!ps.startDate) continue; // unscheduled revisions don't affect date flags
    const id = ps.id;
    const existing = subtasks[id] || {};
    subtasks[id] = {
      ...existing,
      id,
      stage: ps.stage,
      name: ps.name,
      status: existing.status && existing.status !== "archived" ? existing.status : "scheduled",
      startDate: ps.startDate,
      endDate: ps.endDate || ps.startDate,
      startTime: ps.startTime || null,
      endTime: ps.endTime || null,
      assigneeIds: ps.assigneeIds || [],
      assigneeId: ps.assigneeId || (ps.assigneeIds || [])[0] || null,
      _videoIndex: ps._videoIndex ?? existing._videoIndex,
      _planGroupId: ps._planGroupId,
    };
  }
  return { ...projects, [projectId]: { ...target, subtasks } };
}

// ─── Orchestrator (pure) ───────────────────────────────────────────
// Everything in memory. Caller (api/_scheduling-planner.js) does the
// I/O, generates the real planGroupId, and persists the proposal.
//
// idFor(stage, key) → deterministic synthetic id for new rows. Tests
// pass a pure function; the orchestrator passes one seeded with the
// real planGroupId so synthetic ids are stable per plan run.
export function buildPlan({
  project,                 // the target project (must include id, numberOfVideos, videoType, subtasks)
  projects,                // ALL projects (for capacity math) — raw, un-hydrated
  editors,
  weekData,
  videoTypeStats = {},
  input,                   // { requestedEditorIds, anyoneWithCapacity, deadline, extraShoot }
  today,                   // YYYY-MM-DD (Sydney) — injected
  planGroupId,             // injected (orchestrator: real UUID; tests: fixed string)
  idFor,                   // injected deterministic id generator
  windowWeeks = 6,
}) {
  if (!project || !project.id) throw new Error("buildPlan: project with id required");
  if (!today) throw new Error("buildPlan: today (YYYY-MM-DD) required");
  if (!planGroupId) throw new Error("buildPlan: planGroupId required");
  if (typeof idFor !== "function") throw new Error("buildPlan: idFor function required");

  const deadline = input?.deadline || null;

  // Plan window: today .. min(deadline, today + windowWeeks).
  const startDate = today;
  const horizon = new Date(`${today}T00:00:00`);
  horizon.setDate(horizon.getDate() + windowWeeks * 7);
  let endDate = fmtDate(horizon);
  if (deadline && deadline < endDate) endDate = deadline;
  const planWindow = { start: startDate, end: endDate };

  // Hydrate once — capacity math reads _estHours off the tree.
  const hydratedAll = hydrateEstHours(projects, videoTypeStats);

  const videoUnits = buildVideoUnits(project);
  const unitsNeedingEdit = videoUnits.filter(unitNeedsEdit).length;
  const meanEst = stageEstimate(project.videoType, "edit", videoTypeStats);

  const candidateEditors = selectCandidateEditors({
    editors,
    requestedEditorIds: input?.requestedEditorIds || [],
    anyoneWithCapacity: !!input?.anyoneWithCapacity,
    projects: hydratedAll,
    weekData,
    planWindow,
    meanEst,
    remainingEditCount: unitsNeedingEdit,
  });

  const grid = buildCapacityGrid({
    candidateEditors, projects: hydratedAll, weekData, planWindow,
  });

  const plannerViolations = [];

  // 1. Extra shoot first (it consumes crew days the edits then can't use).
  const { shoot, violation: shootViolation } = planExtraShoot({
    extraShoot: input?.extraShoot || null,
    editors, projects: hydratedAll, weekData, grid, planGroupId, idFor,
  });
  if (shootViolation) plannerViolations.push(shootViolation);

  // 2. Edits.
  const { proposed: editRows, violations: editViolations } = planEdits({
    videoUnits, candidateEditors, grid, project, videoTypeStats,
    planWindow, today, deadline,
    requestedEditorIds: input?.requestedEditorIds || [],
    planGroupId, idFor,
  });
  plannerViolations.push(...editViolations);

  // 3. Revisions (unscheduled).
  const revisionRows = planRevisions({ videoUnits, planGroupId, idFor });

  const proposedSubtasks = [
    ...(shoot ? [shoot] : []),
    ...editRows,
    ...revisionRows,
  ];

  // 4. Run the Phase 1 checker against the virtually-applied plan,
  //    scoped to the people the plan touches over the plan window.
  const virtual = applyVirtual(hydratedAll, project.id, proposedSubtasks);
  const touchedPeople = new Set();
  for (const ps of proposedSubtasks) {
    for (const a of ps.assigneeIds || []) if (a) touchedPeople.add(a);
  }
  const detected = detectFlagsForDateRange({
    startDate: planWindow.start,
    endDate: planWindow.end,
    projects: virtual,
    editors,
    weekData,
    videoTypeStats,
    loggedHoursBySubtask: {}, // overrun is digest-only
    scope: touchedPeople.size
      ? { kind: "actor", personIds: [...touchedPeople], today }
      : { kind: "all" },
  });
  const { hardViolations: detectedHard, warnings } = partitionFlags(detected);

  // Planner infeasibilities are ALWAYS hard.
  const hardViolations = [...plannerViolations, ...detectedHard];

  return {
    planWindow,
    candidateEditorIds: candidateEditors.map(e => e.id),
    videoUnitCount: videoUnits.length,
    proposedSubtasks,
    hardViolations,
    warnings,
  };
}
