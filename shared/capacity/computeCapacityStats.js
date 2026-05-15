// shared/capacity/computeCapacityStats.js
//
// Pure compute for the three auto-owned Capacity Planner inputs:
//   - currentActiveProjects   (commissioned + non-done/archived)
//   - newProjectsPerWeek      (deal inflow over the last 28 days)
//   - avgEditHoursPerProject  (edit-stage logged hours / active
//                              project-weeks across the window)
//
// No I/O. Takes raw `/projects` and `/timeLogs` blobs, returns
// { patch, computed }. The cron handler does Firebase reads + writes
// and calls this; tests exercise it directly with hand-built fixtures.
//
// Why "insufficient_data" instead of writing 0:
//   A zero would silently pin Real Utilisation at 0% on the dashboard,
//   which is worse than manual drift because it looks precise while
//   being wrong. Returning patch with no `avgEditHoursPerProject` key
//   means the cron's adminPatch leaves that leaf untouched in Firebase
//   and the dashboard keeps showing the previous number.

import { isActiveStatus } from "../projects/status.js";
import { inferStage } from "../scheduling/stages.js";

// Edit-hour averaging keeps a 4-week window: editing rhythm is lumpy
// (revisions land in batches), so a 2-week window would over-react to
// any single quiet stretch. The project-weeks denominator caps on the
// same window.
const EDIT_HOURS_WINDOW_DAYS = 28;
// "New Projects / Week" uses a SHORTER 2-week window because the
// dashboard is recent enough that legacy projects all carry a
// near-now createdAt (import-timestamp, not deal-won-date). A 4-week
// window swept up the entire backfill and reported absurd inflow
// rates (107.5/week). Two weeks lets the fresh webhook-deal-won
// writes dominate without dragging the backfill in.
const NEW_PROJECTS_WINDOW_DAYS = 14;
const EDIT_HOURS_WINDOW_MS = EDIT_HOURS_WINDOW_DAYS * 24 * 3600 * 1000;
const NEW_PROJECTS_WINDOW_MS = NEW_PROJECTS_WINDOW_DAYS * 24 * 3600 * 1000;
const MIN_LOG_SAMPLES = 5;

function round1(n) {
  return Math.round(n * 10) / 10;
}

// /timeLogs date keys are written by EditorDashboardViewix.jsx using
// the browser's *local* date (toISO() at line 20-25 there reads
// d.getFullYear / getMonth / getDate, not the UTC equivalents). For
// Viewix that's Sydney time. The cron fires at 18:30 UTC which is
// 04:30 Sydney — different calendar day from UTC — so the cutoff
// computed in UTC would include one extra calendar day of logs.
//
// Use Intl.DateTimeFormat with timeZone "Australia/Sydney" to get
// the Sydney YYYY-MM-DD for any epoch ms. Pure formatting, no I/O.
const SYDNEY_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function sydneyDate(ms) {
  const parts = SYDNEY_DATE_PARTS.formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function toProjectArray(projects) {
  if (!projects) return [];
  if (Array.isArray(projects)) return projects.filter(Boolean);
  return Object.values(projects).filter(Boolean);
}

export function computeCapacityStats({
  projects,
  timeLogs,
  now = Date.now(),
  prevAvgEditHours = null,
}) {
  const projectsArr = toProjectArray(projects);

  // ─── 1. Active counts ──────────────────────────────────────────
  const isCommissionedActive = (p) =>
    p && p.commissioned !== false && isActiveStatus(p.status);
  const isUncommissionedActive = (p) =>
    p && p.commissioned === false && isActiveStatus(p.status);

  const commissionedActive = projectsArr.filter(isCommissionedActive);
  const currentActiveProjects = commissionedActive.length;
  const pipelineProjectsCount = projectsArr.filter(isUncommissionedActive).length;

  // ─── 2. New projects per week (broad — deal inflow) ────────────
  // Counts every project created in the last 14 days regardless of
  // commissioned/active/done state. Measures how fast deals are
  // landing in the pipeline, NOT current scheduled workload. Uses a
  // 2-week window (not 4) because legacy /projects records carry
  // import-timestamp createdAt, not real deal-won-date — a 4-week
  // window swept the entire backfill and reported ~107/week.
  const newProjectsCutoffMs = now - NEW_PROJECTS_WINDOW_MS;
  const newCount = projectsArr.filter((p) => {
    const t = Date.parse(p?.createdAt || "");
    return Number.isFinite(t) && t >= newProjectsCutoffMs;
  }).length;
  const newProjectsPerWeek = round1(newCount / (NEW_PROJECTS_WINDOW_DAYS / 7));

  // ─── 3. Avg edit hrs / project / wk ────────────────────────────
  // Both numerator and denominator scope to currently-active
  // (commissioned) projects so the ratio answers "what's the
  // ongoing per-project edit load?", not "what was the historic
  // edit load on projects that are now done?". Logs on done
  // projects in the window are excluded — they'd inflate the
  // numerator without contributing project-weeks.
  const activeIds = new Set(commissionedActive.map((p) => p?.id).filter(Boolean));

  // Index subtasks of active projects → resolved stage. The subtask
  // stage (via inferStage) is the authority — log.stage can drift
  // (case mismatches, stale values after a subtask was re-tagged)
  // so we deliberately don't trust it for filtering.
  const subtaskIndex = new Map(); // taskId → { projectId, stage }
  for (const p of commissionedActive) {
    if (!p?.subtasks) continue;
    for (const s of Object.values(p.subtasks)) {
      if (!s?.id) continue;
      subtaskIndex.set(s.id, { projectId: p.id, stage: inferStage(s) });
    }
  }

  const editHoursCutoffMs = now - EDIT_HOURS_WINDOW_MS;
  const cutoffDate = sydneyDate(editHoursCutoffMs);
  let editSecs = 0;
  let logSampleCount = 0;
  for (const byDate of Object.values(timeLogs || {})) {
    if (!byDate || typeof byDate !== "object") continue;
    for (const [date, byTask] of Object.entries(byDate)) {
      if (!date || date < cutoffDate) continue; // window filter (inclusive)
      if (!byTask || typeof byTask !== "object") continue;
      for (const [taskId, log] of Object.entries(byTask)) {
        if (taskId === "_running") continue; // skip live timer sentinel
        if (!log || typeof log !== "object") continue;
        const secs = Number(log.secs) || 0;
        if (secs <= 0) continue;
        const meta = subtaskIndex.get(taskId);
        if (!meta) continue; // unresolved task OR subtask of done/archived project
        if (meta.stage !== "edit") continue; // edit-stage only; authority = subtask
        editSecs += secs;
        logSampleCount += 1;
      }
    }
  }

  // Total active project-weeks: each currently-active project
  // contributes min(28, daysSinceCreated)/7. A project created 10
  // days ago has only been generating edit hours for 10 days, so it
  // contributes 10/7 weeks — not the full 4 weeks of the window.
  // Without this correction, recently-won projects would deflate
  // the per-project average.
  let projectWeeks = 0;
  for (const p of commissionedActive) {
    const created = Date.parse(p?.createdAt || "");
    const ageDays = Number.isFinite(created)
      ? Math.max(0, (now - created) / (24 * 3600 * 1000))
      : EDIT_HOURS_WINDOW_DAYS; // unknown createdAt → assume full window
    projectWeeks += Math.min(EDIT_HOURS_WINDOW_DAYS, ageDays) / 7;
  }

  const hasEnoughData = logSampleCount >= MIN_LOG_SAMPLES && projectWeeks > 0;
  const avgEditHoursPerProject = hasEnoughData
    ? round1(editSecs / 3600 / projectWeeks)
    : null;

  // ─── 4. Build patch + computed metadata ────────────────────────
  const computed = {
    source: "capacity-stats-cron",
    computedAt: now,
    windowDays: {
      newProjects: NEW_PROJECTS_WINDOW_DAYS,
      editHours: EDIT_HOURS_WINDOW_DAYS,
    },
    activeProjects: {
      value: currentActiveProjects,
      sampleSize: projectsArr.length,
    },
    pipelineProjects: { value: pipelineProjectsCount },
    newProjectsPerWeek: { value: newProjectsPerWeek, sampleSize: newCount },
    avgEditHoursPerProject: hasEnoughData
      ? {
          value: avgEditHoursPerProject,
          status: "ok",
          logSampleCount,
          projectWeeks: round1(projectWeeks),
        }
      : {
          status: "insufficient_data",
          logSampleCount,
          projectWeeks: round1(projectWeeks),
          previousValue: prevAvgEditHours ?? null,
        },
  };

  // Patch shape: explicit named keys only — never include the four
  // manual keys (totalSuites, hoursPerSuitePerDay, avgProjectDuration,
  // targetUtilisation). adminPatch then leaves them untouched.
  const patch = {
    currentActiveProjects,
    newProjectsPerWeek,
    _computed: computed,
  };
  if (hasEnoughData) patch.avgEditHoursPerProject = avgEditHoursPerProject;

  return { patch, computed };
}
