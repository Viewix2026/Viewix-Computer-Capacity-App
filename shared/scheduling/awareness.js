// shared/scheduling/awareness.js
//
// Phase 1A — passive awareness for the brain narration. Pure JS,
// importable by both /api and /src.
//
// Builds two side-channel context payloads narration can reference
// when relevant:
//
//   1. Per-project unscheduled-edit context — "Acme has 4 unscheduled
//      edits, deadline May 30." Used so the brain can suggest pulling
//      forward backlog work to fill someone's idle/under-capacity day.
//   2. Per-editor free-capacity-over-window — "Luke has 14h free over
//      the next 14 days." Used so the brain can name a specific
//      editor when suggesting reassignments.
//
// Both are PASSIVE — they're only context for narration, never inputs
// to flag detection. Narration prompt is constrained to use the data
// only when it's there (no fabrication).

import { inferStage, FLEXIBLE_STAGES } from "./stages.js";
import { isEditorInOnDate, datesInRange, fmtDate } from "./availability.js";
import { plannedHoursForDate, hydrateEstHours } from "./capacity.js";
import { CAPACITY_BANDS, FREE_CAPACITY_WINDOW_DAYS } from "./constants.js";

// Top-level entry. Callers pass in the same state as for detectFlags
// plus the videoTypeStats they already have.
export function buildAwareness({ projects, editors, weekData, videoTypeStats, today }) {
  return {
    unscheduledByProject: collectUnscheduledByProject(projects, today),
    editorFreeCapacity: collectEditorFreeCapacity({
      projects, editors, weekData, videoTypeStats, today,
    }),
  };
}

// For each active project (commissioned !== false, not done/archived),
// list its unscheduled flexible-stage subtasks (no startDate, status
// not done/archived). Include the project's dueDate-derived
// daysToDeadline if available.
function collectUnscheduledByProject(projects, today) {
  const out = [];
  for (const [pid, p] of Object.entries(projects || {})) {
    if (!p || typeof p !== "object") continue;
    if (p.commissioned === false) continue;
    if (p.status === "archived" || p.status === "done") continue;

    const unscheduledStages = [];
    for (const st of Object.values(p.subtasks || {})) {
      if (!st || typeof st !== "object") continue;
      if (st.startDate) continue;
      if (st.status === "done" || st.status === "archived") continue;
      const stage = inferStage(st);
      if (!FLEXIBLE_STAGES.has(stage)) continue;
      unscheduledStages.push(stage);
    }
    if (unscheduledStages.length === 0) continue;

    out.push({
      projectId: pid,
      projectName: p.projectName || "(untitled)",
      clientName: p.clientName || "",
      unscheduledStages,
      daysToDeadline: daysFromTodayTo(today, p.dueDate),
    });
  }
  // Sort by deadline urgency (soonest first; no-deadline at the end).
  out.sort((a, b) => {
    const aD = a.daysToDeadline ?? Infinity;
    const bD = b.daysToDeadline ?? Infinity;
    return aD - bD;
  });
  return out;
}

function daysFromTodayTo(today, target) {
  if (!target || typeof target !== "string") return null;
  const t0 = new Date(`${today}T00:00:00`);
  const t1 = new Date(`${target}T00:00:00`);
  if (isNaN(t0) || isNaN(t1)) return null;
  return Math.round((t1 - t0) / (24 * 60 * 60 * 1000));
}

// For each editor (role=editor), compute free capacity across the next
// FREE_CAPACITY_WINDOW_DAYS days.
//
// Free hours = sum over edit-suite-days in window of (target - planned),
// floored at 0 per day so over-loaded days don't contribute "negative"
// capacity (those are already flagged separately).
//
// IMPORTANT: we use isEditorInOnDate (strict "in"), not isWorkingOnDate.
// "shoot" days mean the editor is working but NOT available to take on
// additional flexible edit work — counting their shoot day as free
// capacity would tell Opus to "pull Charlie's edit forward to Luke's
// Wed shoot day", which is wrong.
function collectEditorFreeCapacity({ projects, editors, weekData, videoTypeStats, today }) {
  const hydrated = hydrateEstHours(projects, videoTypeStats);
  const targetHours = CAPACITY_BANDS.target;

  const startDate = today;
  const endDate = addDaysISO(today, FREE_CAPACITY_WINDOW_DAYS - 1);

  const out = [];
  for (const ed of editors || []) {
    if (ed?.role !== "editor") continue;
    let free = 0;
    for (const dateISO of datesInRange(startDate, endDate)) {
      const dateObj = new Date(`${dateISO}T00:00:00`);
      if (!isEditorInOnDate(ed, dateObj, weekData)) continue;
      const planned = plannedHoursForDate(ed.id, dateISO, hydrated);
      free += Math.max(0, targetHours - planned);
    }
    out.push({
      editorId: ed.id,
      name: ed.name || ed.id,
      freeHoursNext2Weeks: Math.round(free * 2) / 2, // half-hour resolution
    });
  }
  // Sort by most-free first.
  out.sort((a, b) => b.freeHoursNext2Weeks - a.freeHoursNext2Weeks);
  return out;
}

function addDaysISO(yyyymmdd, n) {
  const d = new Date(`${yyyymmdd}T00:00:00`);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
