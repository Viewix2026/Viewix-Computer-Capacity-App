// shared/scheduling/stats.js
//
// videoTypeStats — average hours per (videoType, stage) computed from
// /timeLogs joined to /projects, completed subtasks only.
//
// Two functions:
//   1. computeVideoTypeStats — heavy. Reads full /timeLogs. Called by
//      the daily digest only. Writes /scheduling/cachedStats.
//   2. buildLoggedHoursMap — also from full /timeLogs. Used by the
//      digest to feed editOverrun detection (per-subtask total hours).
//
// The drag check + Slack scheduling read /scheduling/cachedStats
// instead — see api side for the readCachedStats helper.

import { MIN_SAMPLE_SIZE } from "./constants.js";

// Build an index of taskId → { project, subtask } for fast joining
// /timeLogs to /projects without iterating every log entry × every
// subtask.
function indexSubtasksByProject(projects) {
  const idx = new Map();
  for (const p of Object.values(projects || {})) {
    if (!p || typeof p !== "object") continue;
    for (const [stid, st] of Object.entries(p.subtasks || {})) {
      idx.set(stid, { project: p, subtask: st });
    }
  }
  return idx;
}

// Heavy version, digest-only. Builds averages from completed subtasks
// only — in-progress logs DO contribute toward the per-subtask "actual
// hours" when checking overrun, but they're excluded from the average
// divisor (they aren't yet "average examples").
//
// Output shape:
//   { [videoType]: { [stage]: { avgHours, sampleCount } } }
// — entries are emitted only when sampleCount >= MIN_SAMPLE_SIZE.
//
// Per-stage sample counts (not per-videoType): a videoType with 5 done
// revisions but only 1 done edit must NOT show edits as statistically
// valid.
export function computeVideoTypeStats(projects, timeLogs) {
  const subtaskIndex = indexSubtasksByProject(projects);
  // buckets[videoType][stage] = { hoursByDoneTask: Map<taskId, hours> }
  const buckets = {};

  for (const [editorId, byDate] of Object.entries(timeLogs || {})) {
    if (!byDate || typeof byDate !== "object") continue;
    for (const [date, byTask] of Object.entries(byDate)) {
      if (!byTask || typeof byTask !== "object") continue;
      for (const [taskId, log] of Object.entries(byTask)) {
        if (!log || typeof log !== "object") continue;
        const meta = subtaskIndex.get(taskId);
        if (!meta) continue;
        const project = meta.project;
        const subtask = meta.subtask;
        const vt = project?.videoType;
        const stage = log.stage || subtask?.stage;
        if (!vt || !stage) continue;

        const stageBucket = ((buckets[vt] ||= {})[stage] ||= {
          hoursByDoneTask: new Map(),
        });

        // Only count toward the average when the subtask is done.
        if (subtask?.status === "done") {
          const hours = (Number(log.secs) || 0) / 3600;
          const prev = stageBucket.hoursByDoneTask.get(taskId) || 0;
          stageBucket.hoursByDoneTask.set(taskId, prev + hours);
        }
      }
    }
  }

  const out = {};
  for (const [vt, stages] of Object.entries(buckets)) {
    out[vt] = {};
    for (const [stage, b] of Object.entries(stages)) {
      const sampleCount = b.hoursByDoneTask.size;
      if (sampleCount < MIN_SAMPLE_SIZE) continue;
      let total = 0;
      for (const h of b.hoursByDoneTask.values()) total += h;
      out[vt][stage] = {
        avgHours: total / sampleCount,
        sampleCount,
      };
    }
  }
  return out;
}

// Per-subtask total logged hours, summed across all editors and dates.
// Used for editOverrun in detectFlags. Includes in-progress subtasks.
export function buildLoggedHoursMap(timeLogs) {
  const out = {};
  for (const byDate of Object.values(timeLogs || {})) {
    if (!byDate || typeof byDate !== "object") continue;
    for (const byTask of Object.values(byDate)) {
      if (!byTask || typeof byTask !== "object") continue;
      for (const [taskId, log] of Object.entries(byTask)) {
        if (!log || typeof log !== "object") continue;
        const hours = (Number(log.secs) || 0) / 3600;
        out[taskId] = (out[taskId] || 0) + hours;
      }
    }
  }
  return out;
}

// Helper: is the cached stats blob fresh enough to use?
// Stale beyond 48h (digest runs daily — 48h is ~2 missed runs of cushion).
export function cachedStatsIsFresh(cached) {
  if (!cached || typeof cached !== "object") return false;
  const computedAt = Number(cached.computedAt);
  if (!Number.isFinite(computedAt)) return false;
  return (Date.now() - computedAt) < (48 * 60 * 60 * 1000);
}
