// shared/scheduling/overdue.js
//
// Phase 3 (#5) — two DISTINCT concepts, both scoped to edit-stage
// subtasks in active-section projects. Pure JS; consumed by the Team
// Board UI (hazard stripes + red badge) and the overnight roll-over cron.
//
//   OVERDUE  — an edit dated BEYOND the project's effective due date.
//              Proactive: shows even if today hasn't reached the due
//              date. Rendered as yellow/black hazard stripes.
//
//   BEHIND   — an edit (status scheduled|inProgress) whose scheduled day
//   SCHEDULE   has passed without Finish. The overnight cron moves it to
//              the assignee's next working day at dayPriority 1 and sets
//              a flag so the priority badge renders red.
//
// "Effective due date" = project.dueDate (Attio/manual, master) else the
// latest shoot date + 14 days. Computed live, never persisted.

import { fmtDate } from "./availability.js";

const lc = (s) => (s || "").toString().trim().toLowerCase();

function isShootStage(st) {
  if (!st) return false;
  if (st.stage === "shoot") return true;
  return lc(st.name).includes("shoot");
}

// edit-stage detection. Mirrors inferStage's "edit"/"timeline" cases but
// kept local so this module has no cross-import beyond availability.
export function isEditStage(st) {
  if (!st) return false;
  // The "Selects timeline + kick off video" task is stage:"edit" but it's
  // LEAD PREP, not a video edit — it must NOT be hazard-striped as overdue
  // or rolled by the behind-schedule cron (Codex safety fix). Exclude it
  // explicitly (the explicit stage==="edit" below would otherwise catch it).
  if (lc(st.name).includes("selects")) return false;
  if (st.stage === "edit") return true;
  const n = lc(st.name);
  if (st.stage) return false; // explicit non-edit stage wins
  return n.includes("edit");
}

export function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// Latest stage==="shoot" startDate for a project (multiple shoots → max).
export function latestShootDate(project) {
  const subs = project?.subtasks ? Object.values(project.subtasks) : [];
  let latest = null;
  for (const st of subs) {
    if (!isShootStage(st) || !st.startDate) continue;
    if (!latest || st.startDate > latest) latest = st.startDate;
  }
  return latest;
}

// Master/Attio dueDate wins; else lastShoot + 14d; else null.
export function effectiveDueDate(project) {
  if (project?.dueDate) return project.dueDate;
  const shoot = latestShootDate(project);
  return shoot ? addDaysISO(shoot, 14) : null;
}

// "Active section" project = commissioned (not the Uncommissioned
// section) AND not done/archived. Project-level, not subtask-level.
export function isActiveProject(project) {
  if (!project) return false;
  if (project.commissioned === false) return false;
  const s = lc(project.status);
  return s !== "done" && s !== "archived";
}

const scheduledDayOf = (st) => st?.endDate || st?.startDate || null;
const isDone = (st) => lc(st?.status) === "done";

// OVERDUE: active project, edit-stage, not done, scheduled beyond the
// effective due date. Proactive (no "today" needed).
export function isOverdueEdit(subtask, project) {
  if (!isActiveProject(project) || !isEditStage(subtask) || isDone(subtask)) return false;
  const due = effectiveDueDate(project);
  if (!due) return false;
  const day = scheduledDayOf(subtask);
  if (!day) return false;
  return day > due;
}

// BEHIND SCHEDULE (cron candidate): active project, edit-stage, status
// scheduled|inProgress, scheduled day strictly before `today`, not done.
// stuck / onHold / waitingClient are deliberately excluded (Codex #4).
export function isUnfinishedPastEdit(subtask, project, today) {
  if (!isActiveProject(project) || !isEditStage(subtask) || isDone(subtask)) return false;
  const status = lc(subtask.status);
  if (status !== "scheduled" && status !== "inprogress") return false;
  const day = scheduledDayOf(subtask);
  if (!day) return false;
  return day < today;
}

// Badge red state — once the cron rolls an edit it stamps behindSchedule;
// the badge stays red until the edit is done.
export function isBehindScheduleFlagged(subtask) {
  return !!subtask?.behindSchedule && !isDone(subtask);
}
