// api/_scheduling-brain-pass.js
//
// Shared "brain pass" used by Slack scheduling. Given a proposed
// subtask write (mode + fields + assignees), it:
//
//  1. Loads current Firebase state (projects, editors, weekData,
//     cachedStats — never /timeLogs, that's digest-only).
//  2. Builds a virtual projects clone with the proposed write applied.
//  3. Runs detectFlagsForDateRange scoped to the proposal's date range
//     AND to the proposed assignees so unrelated flags don't leak in.
//  4. Filters to scheduling-card-relevant kinds (under-capacity / idle
//     / overrun stay digest-only).
//  5. Phase 1A awareness payload + Opus narration when flags exist.
//  6. Returns { flags, narration } — empty arrays/null when no flags.
//
// Used by:
//   - api/slack-schedule-listener.js (clean-path confirm card render)
//   - api/slack-interactivity.js (clarification-resolution path —
//     Codex P1 #3)
//
// Codex audit (2026-05-10) flagged two issues this fix addresses:
//   P1 #2 — flags weren't scoped to proposed assignees, so confirm
//           cards surfaced unrelated conflicts elsewhere on the board
//   P1 #3 — clarification path bypassed the brain entirely; clarified
//           requests could create silent conflicts

import { adminGet } from "./_fb-admin.js";
import { detectFlagsForDateRange } from "../shared/scheduling/conflicts.js";
import { SCHEDULING_CARD_KINDS } from "../shared/scheduling/flags.js";
import { cachedStatsIsFresh } from "../shared/scheduling/stats.js";
import { buildAwareness } from "../shared/scheduling/awareness.js";
import { narrateBrain } from "./_scheduling-narrate.js";

// Apply the proposed write virtually onto a copy of the projects map.
// Pure — doesn't mutate the input. Used for the "if I commit this,
// what'll be wrong?" eval.
function applyVirtualWrite(projects, { projectId, subtaskId, mode, fields }) {
  const targetProject = projects[projectId];
  if (!targetProject) return projects;
  const subtasks = { ...(targetProject.subtasks || {}) };
  if (mode === "update" && subtaskId) {
    const existing = subtasks[subtaskId] || {};
    subtasks[subtaskId] = { ...existing, ...fields, id: subtaskId };
  } else if (mode === "create") {
    const newId = `_virtual_${Date.now()}`;
    subtasks[newId] = { ...fields, id: newId };
  }
  return {
    ...projects,
    [projectId]: { ...targetProject, subtasks },
  };
}

export async function runBrainPassForScheduling({
  projectId,
  targetSubtaskId,   // null when mode === "create"
  targetMode,        // "create" | "update"
  fields,            // resolvedPatch.fields — startDate, endDate, assigneeIds, etc.
  today,             // Sydney YYYY-MM-DD
}) {
  // Load state — NO /timeLogs (Slack scheduling stays cheap, uses
  // cached stats).
  const [projectsRaw, editorsRaw, weekData, cachedStatsRec] = await Promise.all([
    adminGet("/projects"),
    adminGet("/editors"),
    adminGet("/weekData"),
    adminGet("/scheduling/cachedStats"),
  ]);
  const projects = projectsRaw || {};
  const editorsList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
  const editors = editorsList.filter(e => e?.id);
  const weekDataMap = weekData || {};
  const videoTypeStats = cachedStatsIsFresh(cachedStatsRec) ? (cachedStatsRec.stats || {}) : {};

  // Apply the proposed write virtually so the checker sees the
  // post-confirm state.
  const virtualProjects = applyVirtualWrite(projects, {
    projectId,
    subtaskId: targetSubtaskId,
    mode: targetMode,
    fields,
  });

  // Date range for the proposal — single-day default.
  const startDate = fields.startDate;
  const endDate = fields.endDate || fields.startDate;

  // Codex P1 #2 fix — scope to the FULL list of proposed assignees so
  // multi-assignee shoots get every conflict surfaced, AND so flags
  // about unrelated people on the same date stay out of the confirm
  // card.
  const proposedAssignees = Array.isArray(fields.assigneeIds) && fields.assigneeIds.length
    ? fields.assigneeIds
    : (fields.assigneeId ? [fields.assigneeId] : []);

  const allFlags = detectFlagsForDateRange({
    startDate, endDate,
    projects: virtualProjects,
    editors,
    weekData: weekDataMap,
    videoTypeStats,
    loggedHoursBySubtask: {}, // overrun is digest-only
    scope: proposedAssignees.length
      ? { kind: "actor", personIds: proposedAssignees, today }
      : { kind: "all" },
  });

  // Filter to scheduling-card-relevant kinds.
  const flags = allFlags.filter(f => SCHEDULING_CARD_KINDS.has(f.kind));
  if (flags.length === 0) return { flags: [], narration: null };

  // Phase 1A awareness — gives the narration access to unscheduled
  // edits + editor free-capacity so it can suggest concrete fixes.
  const awareness = buildAwareness({
    projects: virtualProjects, editors, weekData: weekDataMap,
    videoTypeStats, today,
  });

  // Narrate.
  const narration = await narrateBrain({
    flags,
    projects: virtualProjects,
    editors,
    today,
    mode: "scheduling",
    awareness,
  });
  return { flags, narration };
}
