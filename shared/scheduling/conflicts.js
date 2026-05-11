// shared/scheduling/conflicts.js
//
// detectFlags() — the deterministic checker. Pure function: given the
// team-board state, returns a typed Flag[] for a given date.
// detectFlagsForDateRange() — same, but for a date range, dedupes
// per-fingerprint across the days.
//
// Pure JS. Imported by both /api/* and /src/*. No Firebase, no LLM,
// no I/O.

import {
  CAPACITY_BANDS,
  FALLBACKS,
  MIN_SAMPLE_SIZE,
  OVERRUN_RATIO,
} from "./constants.js";
import {
  isWorkingOnDate,
  weekDataStatusForEditorOnDate,
  datesInRange,
  todaySydney,
} from "./availability.js";
import { inferStage } from "./stages.js";
import { plannedHoursForDate, hydrateEstHours, diffHours } from "./capacity.js";
import { fingerprintFlag } from "./flags.js";

// Capacity-band kinds — flagged per editor per day. We skip these in
// drag scope when the date is in the past (can't act on yesterday).
const CAPACITY_KINDS = new Set([
  "inOfficeIdle",
  "dailyUnderCapacity",
  "dailyOverCapacity",
  "dailyHardOverCapacity",
]);

// ─── Helpers ────────────────────────────────────────────────────────

// Walk every (project, subtask) pair. Yields { project, subtaskId, st }.
function* iterAllSubtasks(projects) {
  for (const [pid, p] of Object.entries(projects || {})) {
    if (!p || typeof p !== "object") continue;
    for (const [stid, st] of Object.entries(p.subtasks || {})) {
      if (!st || typeof st !== "object") continue;
      yield { project: { ...p, id: pid }, subtaskId: stid, st };
    }
  }
}

// Includes assignee + active (not done/archived) + date overlap.
function isAssignedAndActiveOn(st, editorId, dateISO) {
  if (!st) return false;
  if (st.status === "done" || st.status === "archived") return false;
  const inIds = Array.isArray(st.assigneeIds) && st.assigneeIds.includes(editorId);
  const isAssignee = inIds || st.assigneeId === editorId;
  if (!isAssignee) return false;
  if (!st.startDate) return false;
  const end = st.endDate || st.startDate;
  return dateISO >= st.startDate && dateISO <= end;
}

// All people referenced as assignees on any active subtask.
// Includes editors + crew + founders (anyone in the editor roster).
function collectAllAssignedPeople(projects) {
  const ids = new Set();
  for (const { st } of iterAllSubtasks(projects)) {
    if (st.status === "done" || st.status === "archived") continue;
    if (Array.isArray(st.assigneeIds)) {
      for (const id of st.assigneeIds) if (id) ids.add(id);
    }
    if (st.assigneeId) ids.add(st.assigneeId);
  }
  return [...ids];
}

// Subtasks for a person on a date that have explicit start+end times.
function collectTimedSubtasksFor(personId, dateISO, projects) {
  const out = [];
  for (const { project, subtaskId, st } of iterAllSubtasks(projects)) {
    if (!isAssignedAndActiveOn(st, personId, dateISO)) continue;
    if (!st.startTime || !st.endTime) continue;
    out.push({
      projectId: project.id,
      subtaskId,
      name: st.name || "(unnamed)",
      stage: inferStage(st),
      startTime: st.startTime,
      endTime: st.endTime,
    });
  }
  return out;
}

// Pairs of timed subtasks whose [startTime, endTime) windows overlap.
// Returns [[a, b], ...]; emits each pair once.
function findTimeOverlaps(timed) {
  const out = [];
  const toMin = s => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i];
    const aStart = toMin(a.startTime);
    const aEnd = toMin(a.endTime);
    if (aStart == null || aEnd == null || aEnd <= aStart) continue;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j];
      const bStart = toMin(b.startTime);
      const bEnd = toMin(b.endTime);
      if (bStart == null || bEnd == null || bEnd <= bStart) continue;
      // Overlap when aStart < bEnd && bStart < aEnd.
      if (aStart < bEnd && bStart < aEnd) out.push([a, b]);
    }
  }
  return out;
}

// Untimed shoots for a person on a date.
function collectUntimedShootsFor(personId, dateISO, projects) {
  const out = [];
  for (const { project, subtaskId, st } of iterAllSubtasks(projects)) {
    if (!isAssignedAndActiveOn(st, personId, dateISO)) continue;
    if (inferStage(st) !== "shoot") continue;
    if (st.startTime && st.endTime) continue; // it IS timed
    out.push({
      projectId: project.id,
      subtaskId,
      name: st.name || "Shoot",
    });
  }
  return out;
}

// Subtasks overlapping date for an editor (any stage).
function subtasksOverlapping(editorId, dateISO, projects) {
  const out = [];
  for (const { project, subtaskId, st } of iterAllSubtasks(projects)) {
    if (!isAssignedAndActiveOn(st, editorId, dateISO)) continue;
    out.push({
      projectId: project.id,
      subtaskId,
      name: st.name || "(unnamed)",
      stage: inferStage(st),
    });
  }
  return out;
}

// Edit subtasks an editor is currently assigned to (active, edit stage).
// Used for editOverrun.
function editSubtasksFor(editorId, projects) {
  const out = [];
  for (const { project, subtaskId, st } of iterAllSubtasks(projects)) {
    if (st.status === "done" || st.status === "archived") continue;
    if (inferStage(st) !== "edit") continue;
    const inIds = Array.isArray(st.assigneeIds) && st.assigneeIds.includes(editorId);
    if (!inIds && st.assigneeId !== editorId) continue;
    out.push({
      projectId: project.id,
      id: subtaskId,
      name: st.name || "Edit",
      stage: "edit",
      _videoType: project.videoType,
    });
  }
  return out;
}

function hasShootSubtaskOn(personId, dateISO, projects) {
  for (const { st } of iterAllSubtasks(projects)) {
    if (!isAssignedAndActiveOn(st, personId, dateISO)) continue;
    if (inferStage(st) === "shoot") return true;
  }
  return false;
}

function retractFlag(flags, predicate) {
  for (let i = flags.length - 1; i >= 0; i--) {
    if (predicate(flags[i])) flags.splice(i, 1);
  }
}

// ─── detectFlags — main entry ───────────────────────────────────────

export function detectFlags({
  projects,
  editors,
  weekData,
  videoTypeStats = {},
  loggedHoursBySubtask = {},
  date,
  scope = { kind: "all" },
}) {
  // Hydrate _estHours on every subtask once. Capacity / overrun /
  // mismatch logic all reads the hydrated tree.
  const hydratedProjects = hydrateEstHours(projects, videoTypeStats);

  const flags = [];
  const editorList = (editors || []).filter(e => e && e.id);

  // 1. Fixed-time conflicts apply to ALL assignees, regardless of role.
  //    A double-booked shoot crew is a real conflict even though
  //    capacity bands don't apply to crew.
  const allAssignedPeople = collectAllAssignedPeople(hydratedProjects);
  for (const personId of allAssignedPeople) {
    const timed = collectTimedSubtasksFor(personId, date, hydratedProjects);
    for (const [a, b] of findTimeOverlaps(timed)) {
      flags.push({
        kind: "fixedTimeConflict",
        personId,
        date,
        subtasks: [a, b],
      });
    }
    // Two untimed shoots same person same day = warning (not hard).
    const untimedShoots = collectUntimedShootsFor(personId, date, hydratedProjects);
    if (untimedShoots.length >= 2) {
      flags.push({
        kind: "multipleUntimedShoots",
        personId,
        date,
        subtasks: untimedShoots,
      });
    }
  }

  // 2-5. Editor-scoped flags.
  for (const ed of editorList.filter(e => e.role === "editor")) {
    const dateISO = date;

    // 2. Off-day assigned (defaultDays / weekData says off, but tasks exist)
    if (!isWorkingOnDate(ed, dateISO, weekData)) {
      const assignedToday = subtasksOverlapping(ed.id, dateISO, hydratedProjects);
      if (assignedToday.length > 0) {
        flags.push({
          kind: "offDayAssigned",
          personId: ed.id,
          date: dateISO,
          subtasks: assignedToday,
        });
      }
      continue; // off-day: skip capacity bands
    }

    // 3. Daily capacity bands. 8h target.
    const planned = plannedHoursForDate(ed.id, dateISO, hydratedProjects);
    if (planned === 0) {
      flags.push({ kind: "inOfficeIdle", personId: ed.id, date: dateISO });
    } else if (planned < CAPACITY_BANDS.underMax) {
      flags.push({
        kind: "dailyUnderCapacity",
        personId: ed.id,
        date: dateISO,
        plannedHours: planned,
        capacityHours: CAPACITY_BANDS.target,
      });
    } else if (planned > CAPACITY_BANDS.hardMin) {
      flags.push({
        kind: "dailyHardOverCapacity",
        personId: ed.id,
        date: dateISO,
        plannedHours: planned,
      });
    } else if (planned > CAPACITY_BANDS.warningMin) {
      flags.push({
        kind: "dailyOverCapacity",
        personId: ed.id,
        date: dateISO,
        plannedHours: planned,
      });
    }
    // 4-8h is healthy — no flag.

    // 4. Edit overrun — only when caller passed loggedHoursBySubtask.
    //    Uses live averages only (no fallback fudging) and requires
    //    statistical sample size.
    if (loggedHoursBySubtask && Object.keys(loggedHoursBySubtask).length) {
      for (const st of editSubtasksFor(ed.id, hydratedProjects)) {
        const actual = loggedHoursBySubtask[st.id] || 0;
        const stageStats = videoTypeStats?.[st._videoType]?.[st.stage];
        if (!stageStats || stageStats.sampleCount < MIN_SAMPLE_SIZE) continue;
        const ratio = stageStats.avgHours > 0 ? actual / stageStats.avgHours : 0;
        if (ratio > OVERRUN_RATIO) {
          flags.push({
            kind: "editOverrun",
            projectId: st.projectId,
            subtaskId: st.id,
            actualHours: actual,
            avgHours: stageStats.avgHours,
            ratio,
            videoType: st._videoType,
          });
        }
      }
    }

    // 5. WeekData/subtask sync mismatch — bidirectional.
    //    When weekData says "shoot" but no shoot subtask covers the day,
    //    suppress idle AND under-capacity for that person/date so we
    //    don't double-flag. The mismatch is the more informative one.
    const wkStatus = weekDataStatusForEditorOnDate(ed, dateISO, weekData);
    const hasShoot = hasShootSubtaskOn(ed.id, dateISO, hydratedProjects);
    if (wkStatus === "shoot" && !hasShoot) {
      flags.push({
        kind: "weekDataMismatch",
        personId: ed.id,
        date: dateISO,
        subkind: "shootInWeekDataNoSubtask",
      });
      retractFlag(flags, f =>
        (f.kind === "inOfficeIdle" || f.kind === "dailyUnderCapacity") &&
        f.personId === ed.id && f.date === dateISO);
    } else if (hasShoot && wkStatus !== "shoot") {
      flags.push({
        kind: "weekDataMismatch",
        personId: ed.id,
        date: dateISO,
        subkind: "shootSubtaskNoWeekData",
      });
    }
  }

  // 6. Unassigned scheduled subtasks (not editor-scoped — every project
  //    surface gets checked).
  for (const { project, subtaskId, st } of iterAllSubtasks(hydratedProjects)) {
    if (!st.startDate) continue;
    if (st.status === "done" || st.status === "archived") continue;
    const hasAssignees = Array.isArray(st.assigneeIds) && st.assigneeIds.length > 0;
    if (hasAssignees) continue;
    if (st.assigneeId) continue;
    flags.push({
      kind: "unassignedScheduled",
      projectId: project.id,
      subtaskId,
      startDate: st.startDate,
      stage: inferStage(st),
    });
  }

  // Scope filter: when called from a drag check or Slack scheduling
  // pass, restrict to flags involving the changed person(s) / date so
  // the banner stays focused on what the action actually affected.
  //
  // Drops applied for actor scope:
  //   1. unassignedScheduled — project-wide flag with no personId/date,
  //      so the person filter doesn't catch it. On a drag, the 5+
  //      stale "unassigned subtask scheduled for 2026-01-23" flags are
  //      pure noise; they belong on the digest's "Needs an assignee"
  //      section, not the drag banner.
  //   2. Capacity flags for past dates — can't act on yesterday's
  //      over-capacity. Producer acting today doesn't need to be
  //      told a past day was overloaded.
  //   3. Person filter (kept) — drops flags about OTHER people. Accepts
  //      either `scope.personId` (single — legacy) or
  //      `scope.personIds` (array — for multi-assignee shoots /
  //      Slack scheduling proposals).
  //   4. Date filter (kept) — drops flags about OTHER days when
  //      `scope.dateISO` is set.
  if (scope?.kind === "actor") {
    const today = scope.today || todaySydney();
    const allowedIds = Array.isArray(scope.personIds) && scope.personIds.length
      ? new Set(scope.personIds.filter(Boolean))
      : (scope.personId ? new Set([scope.personId]) : null);
    return flags.filter(f => {
      if (f.kind === "unassignedScheduled") return false;
      if (CAPACITY_KINDS.has(f.kind) && f.date && f.date < today) return false;
      if (allowedIds && f.personId && !allowedIds.has(f.personId)) return false;
      if (f.date && scope.dateISO && f.date !== scope.dateISO) return false;
      return true;
    });
  }
  return flags;
}

// Range version — Slack scheduling proposes a startDate..endDate, not
// a single day. Loops day-by-day, dedupes by fingerprint.
export function detectFlagsForDateRange({ startDate, endDate, ...rest }) {
  const seen = new Map();
  const end = endDate || startDate;
  for (const date of datesInRange(startDate, end)) {
    for (const flag of detectFlags({ ...rest, date })) {
      const fp = fingerprintFlag(flag);
      if (!seen.has(fp)) seen.set(fp, flag);
    }
  }
  return [...seen.values()];
}

// Re-export for convenience so consumers only import from one path.
export { fingerprintFlag };

// Enrich flags for display surfaces (TeamBoard banner, scheduling-card
// heads-up, drag-flush Slack post). Adds presentational fields
// (personName, projectName, clientName, subtaskName) so consumers can
// write "Emesent — Shoot · Sam stretched on Wed" instead of bare ids.
//
// Pure: doesn't mutate input flags. The original `kind` / fingerprint
// fields are preserved unchanged so dedup keys stay stable.
export function enrichFlagsForDisplay(flags, { projects, editors }) {
  const editorById = new Map();
  for (const e of editors || []) {
    if (e?.id) editorById.set(e.id, e);
  }
  const projectById = new Map(Object.entries(projects || {}));
  // Index every subtask by id so we can look up name/projectId quickly.
  const subtaskIndex = new Map();
  for (const [pid, p] of projectById) {
    if (!p?.subtasks) continue;
    for (const [stid, st] of Object.entries(p.subtasks)) {
      if (st?.id || stid) subtaskIndex.set(st?.id || stid, { project: p, subtask: st, projectId: pid });
    }
  }

  return (flags || []).map(f => enrichOne(f, { editorById, projectById, subtaskIndex }));
}

function enrichOne(f, { editorById, projectById, subtaskIndex }) {
  const out = { ...f };
  // Person name — from /editors lookup. Falls back to id so the banner
  // never shows "undefined".
  if (f.personId) {
    const ed = editorById.get(f.personId);
    out.personName = ed?.name || f.personId;
  }
  // Project + client + subtask names for flags that reference a
  // specific subtask (or list of subtasks).
  if (f.projectId) {
    const p = projectById.get(f.projectId);
    out.projectName = p?.projectName || f.projectId;
    out.clientName = p?.clientName || "";
  }
  if (f.subtaskId) {
    const meta = subtaskIndex.get(f.subtaskId);
    if (meta) {
      out.projectName = out.projectName || meta.project?.projectName || meta.projectId;
      out.clientName = out.clientName || meta.project?.clientName || "";
      out.subtaskName = meta.subtask?.name || meta.subtask?.id || "";
    }
  }
  // Multi-subtask flags (fixedTimeConflict, multipleUntimedShoots,
  // offDayAssigned) — annotate each entry with its project + client.
  if (Array.isArray(f.subtasks)) {
    out.subtasks = f.subtasks.map(s => {
      const meta = subtaskIndex.get(s.subtaskId);
      return {
        ...s,
        projectName: meta?.project?.projectName || s.projectId || "",
        clientName: meta?.project?.clientName || "",
        subtaskName: meta?.subtask?.name || s.name || "",
      };
    });
  }
  return out;
}
