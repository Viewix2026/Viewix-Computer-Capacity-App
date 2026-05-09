// shared/scheduling/capacity.js
//
// Capacity-hours math: "how much of editor X's day does this task
// consume?" + per-day load aggregation. Pure JS.
//
// Front-loading rule (Jeremy's intent): a flexible task with a bar
// spanning Mon–Wed loads its full estimate onto day 1 only. Days 2+
// contribute 0h. The bar stays visible because the editor "owns" it
// and may pick it up again after feedback, but the brain doesn't
// double-count.
//
// Multi-assignee split: shoots and timed pre-pro consume the full
// timed window per assignee (everyone on the shoot is occupied).
// Flexible tasks split the estimate across assignees. Edge case;
// the normal pattern is single-assignee.

import { inferStage, FLEXIBLE_STAGES } from "./stages.js";
import { UNTIMED_SHOOT_HOURS, FALLBACKS, MIN_SAMPLE_SIZE } from "./constants.js";

// Parse "HH:MM" → minutes since midnight. Returns null on bad input.
function parseHHMM(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Hours between two HH:MM strings on the same day. Negative or
// invalid → 0 (the brain treats this as "we don't know the duration").
export function diffHours(start, end) {
  const a = parseHHMM(start);
  const b = parseHHMM(end);
  if (a == null || b == null) return 0;
  if (b <= a) return 0;
  return (b - a) / 60;
}

// Clamp obviously-bad durations. A 26-hour subtask is data error.
function clampHours(h) {
  if (!Number.isFinite(h) || h < 0) return 0;
  if (h > 16) return 16;
  return h;
}

// Does the subtask overlap a given YYYY-MM-DD?
// Treats missing endDate as a single-day bar at startDate.
function dateOverlaps(st, dateISO) {
  if (!st || !st.startDate) return false;
  const start = st.startDate;
  const end = st.endDate || st.startDate;
  return dateISO >= start && dateISO <= end;
}

// Is the editor in this subtask's assignees? Handles both the array
// (assigneeIds) and singular (assigneeId) shapes the dashboard writes.
function includesAssignee(st, editorId) {
  if (!st || !editorId) return false;
  if (Array.isArray(st.assigneeIds) && st.assigneeIds.includes(editorId)) return true;
  if (st.assigneeId === editorId) return true;
  return false;
}

// Per-subtask per-date per-editor hour estimate. The single source
// of truth for "how much of THIS person's day does this task
// consume?".
//
// Caller must hydrate `st._estHours` from videoTypeStats / FALLBACKS
// before calling. Use hydrateEstHours() below for the canonical path.
export function hoursForSubtaskOnDateForEditor(st, dateISO, editorId) {
  if (!st || !includesAssignee(st, editorId)) return 0;
  if (!dateOverlaps(st, dateISO)) return 0;
  if (st.status === "done" || st.status === "archived") return 0;

  const stage = inferStage(st);

  // Hold = 0 by definition (it's a placeholder/block, not work).
  if (stage === "hold") return 0;

  // Fixed-time tasks: full timed window per assignee.
  if (stage === "shoot") {
    if (st.startTime && st.endTime) return clampHours(diffHours(st.startTime, st.endTime));
    return UNTIMED_SHOOT_HOURS;
  }
  if (stage === "preProduction" && st.startTime && st.endTime) {
    return clampHours(diffHours(st.startTime, st.endTime));
  }

  // Flexible task — front-load on day 1 of the bar.
  // A 3.5h edit Mon–Wed = 3.5h on Mon, 0h on Tue/Wed (the editor "owns"
  // the bar but the planned estimate doesn't multiply across days).
  if (FLEXIBLE_STAGES.has(stage)) {
    if (dateISO !== st.startDate) return 0;
    const assigneeCount = Math.max(1, (st.assigneeIds || []).length);
    const estimate = st._estHours ?? FALLBACKS[stage] ?? 0;
    return estimate / assigneeCount;
  }

  return 0;
}

// Sum planned hours for an editor on a given date across all projects.
// Caller must hydrate the projects before calling (see hydrateEstHours).
export function plannedHoursForDate(editorId, dateISO, projects) {
  let total = 0;
  for (const p of Object.values(projects || {})) {
    if (!p || typeof p !== "object") continue;
    for (const st of Object.values(p.subtasks || {})) {
      total += hoursForSubtaskOnDateForEditor(st, dateISO, editorId);
    }
  }
  return total;
}

// Hydrate `_estHours` on every flexible-stage subtask so capacity
// calc can read it directly. Pure — returns a new projects object,
// doesn't mutate the input.
//
// Stats shape: { [videoType]: { [stage]: { avgHours, sampleCount } } }
// — only entries with sampleCount >= MIN_SAMPLE_SIZE are present;
// missing entries fall through to FALLBACKS[stage].
export function hydrateEstHours(projects, videoTypeStats) {
  const out = {};
  for (const [pid, p] of Object.entries(projects || {})) {
    if (!p || typeof p !== "object") {
      out[pid] = p;
      continue;
    }
    const vt = p.videoType;
    const subtasks = {};
    for (const [stid, st] of Object.entries(p.subtasks || {})) {
      if (!st || typeof st !== "object") {
        subtasks[stid] = st;
        continue;
      }
      const stage = inferStage(st);
      const stageStats = videoTypeStats?.[vt]?.[stage];
      // Only use the live average when we have a statistically valid
      // sample. Otherwise fall back to FALLBACKS[stage].
      const estHours = (stageStats && stageStats.sampleCount >= MIN_SAMPLE_SIZE)
        ? stageStats.avgHours
        : (FALLBACKS[stage] ?? 0);
      subtasks[stid] = { ...st, _estHours: estHours, _videoType: vt };
    }
    out[pid] = { ...p, subtasks };
  }
  return out;
}
