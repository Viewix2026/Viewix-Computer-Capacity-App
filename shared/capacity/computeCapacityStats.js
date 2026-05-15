// shared/capacity/computeCapacityStats.js
//
// Pure compute for the auto-owned Capacity Planner inputs:
//   - currentActiveProjects       (commissioned + non-done/archived)
//   - newProjectsPerWeek          (deal inflow, by closeDate, 2-week rolling)
//   - avgEditHoursPerProject      (edit-stage logged hours / active
//                                  project-weeks across 4-week window)
//   - avgProjectDuration          (weeks between closeDate and last
//                                  subtask endDate for recently-done projects)
// And _computed metadata used by the dashboard to derive:
//   - actualAvgUtilisation        (4-week measured util, divided
//                                  client-side using current capacity)
//
// No I/O. Takes raw `/projects` and `/timeLogs` blobs, returns
// { patch, computed }. The cron handler does Firebase reads + writes
// and calls this; tests exercise it directly with hand-built fixtures.
//
// Why "insufficient_data" instead of writing 0:
//   A zero would silently pin downstream stats at 0, which is worse
//   than manual drift because it looks precise while being wrong.
//   Returning a patch with no value key means adminPatch leaves the
//   leaf untouched and the dashboard keeps showing the previous number.

import { isActiveStatus, normaliseStatus } from "../projects/status.js";
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
// Avg project duration averages across done projects whose last
// subtask wrapped in the last 90 days. Older done projects are
// excluded because Viewix's process has evolved — averaging in
// pre-process completion times would over-smooth the signal.
const DURATION_WINDOW_DAYS = 90;
const EDIT_HOURS_WINDOW_MS = EDIT_HOURS_WINDOW_DAYS * 24 * 3600 * 1000;
const NEW_PROJECTS_WINDOW_MS = NEW_PROJECTS_WINDOW_DAYS * 24 * 3600 * 1000;
const DURATION_WINDOW_MS = DURATION_WINDOW_DAYS * 24 * 3600 * 1000;
const MIN_LOG_SAMPLES = 5;
const MIN_DURATION_SAMPLES = 3;

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
  prevAvgProjectDuration = null,
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
  // Sources from `closeDate` (the Attio deal-close date that ships
  // with each project via the webhook). `createdAt` was unusable
  // because legacy /projects records carry an import-timestamp, not
  // the real deal-won-date — the 4-week window swept the entire
  // backfill and reported ~107/week even after we shrank to 2 weeks.
  // closeDate is set by the webhook (api/webhook-deal-won.js) and by
  // Attio backfills, so it reflects when the deal actually closed.
  // Projects without a closeDate are skipped (UI-created drafts that
  // never moved through Attio — rare, and they aren't "new deals"
  // in the inflow sense we're measuring).
  const newProjectsCutoffMs = now - NEW_PROJECTS_WINDOW_MS;
  const newCount = projectsArr.filter((p) => {
    const t = Date.parse(p?.closeDate || "");
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

  // Index ALL subtasks → resolved stage. We need two views:
  //   - editSecsActive: hours on currently-active projects (for the
  //     per-project average — projects that have since wrapped would
  //     distort the per-active-project denominator)
  //   - editSecsAll: hours across every project including completed
  //     (for the 4-week actual-utilisation metric — work done is
  //     work done, regardless of whether the project later finished)
  // The subtask stage (via inferStage) is the authority — log.stage
  // can drift (case mismatches, stale values after a subtask was
  // re-tagged) so we deliberately don't trust it for filtering.
  const subtaskAll = new Map(); // taskId → { projectId, stage }
  for (const p of projectsArr) {
    if (!p?.subtasks) continue;
    for (const s of Object.values(p.subtasks)) {
      if (!s?.id) continue;
      subtaskAll.set(s.id, { projectId: p.id, stage: inferStage(s) });
    }
  }

  const editHoursCutoffMs = now - EDIT_HOURS_WINDOW_MS;
  const cutoffDate = sydneyDate(editHoursCutoffMs);
  let editSecsActive = 0;
  let editSecsAll = 0;
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
        const meta = subtaskAll.get(taskId);
        if (!meta) continue; // unresolved task — no parent project anywhere
        if (meta.stage !== "edit") continue; // edit-stage only; authority = subtask
        editSecsAll += secs;
        if (activeIds.has(meta.projectId)) {
          editSecsActive += secs;
          logSampleCount += 1;
        }
      }
    }
  }
  // legacy name kept for the per-project average; this is the
  // active-only sum that the avgEditHoursPerProject calc uses.
  const editSecs = editSecsActive;

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

  // ─── 4. Avg project duration (weeks, from done projects) ───────
  // Computes (latest_subtask_endDate − closeDate) / 7 across done
  // projects whose endDate landed in the last 90 days. Older done
  // projects are excluded because Viewix's process has evolved —
  // ancient completions would over-smooth the signal. Falls back to
  // the project's updatedAt when no subtask carries an endDate.
  // Insufficient samples (<3) → status: insufficient_data + preserve
  // the previous /inputs/avgProjectDuration value, same pattern as
  // avgEditHoursPerProject.
  const durationCutoffMs = now - DURATION_WINDOW_MS;
  const durationDaysSamples = [];
  for (const p of projectsArr) {
    if (normaliseStatus(p?.status) !== "done") continue;
    const closeMs = Date.parse(p?.closeDate || "");
    if (!Number.isFinite(closeMs)) continue;
    // End = latest subtask endDate. Fall back to project.updatedAt
    // (≈ when the project auto-rolled to done — see Projects.jsx
    // auto-roll logic). Skip if neither is parseable.
    let endMs = null;
    if (p?.subtasks) {
      for (const s of Object.values(p.subtasks)) {
        const sEnd = Date.parse(s?.endDate || "");
        if (Number.isFinite(sEnd) && (endMs == null || sEnd > endMs)) endMs = sEnd;
      }
    }
    if (endMs == null) {
      const u = Date.parse(p?.updatedAt || "");
      if (Number.isFinite(u)) endMs = u;
    }
    if (endMs == null) continue;
    if (endMs < durationCutoffMs) continue; // recency filter on completion date
    if (endMs <= closeMs) continue; // sanity: end must come after start
    durationDaysSamples.push((endMs - closeMs) / (24 * 3600 * 1000));
  }
  const hasDurationData = durationDaysSamples.length >= MIN_DURATION_SAMPLES;
  const avgProjectDuration = hasDurationData
    ? round1((durationDaysSamples.reduce((a, b) => a + b, 0) / durationDaysSamples.length) / 7)
    : null;

  // ─── 5. Build patch + computed metadata ────────────────────────
  const computed = {
    source: "capacity-stats-cron",
    computedAt: now,
    windowDays: {
      newProjects: NEW_PROJECTS_WINDOW_DAYS,
      editHours: EDIT_HOURS_WINDOW_DAYS,
      duration: DURATION_WINDOW_DAYS,
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
    avgProjectDuration: hasDurationData
      ? {
          value: avgProjectDuration,
          status: "ok",
          sampleSize: durationDaysSamples.length,
        }
      : {
          status: "insufficient_data",
          sampleSize: durationDaysSamples.length,
          previousValue: prevAvgProjectDuration ?? null,
        },
    // Raw 4-week edit-stage hours summed across ALL projects (active
    // + completed). The dashboard divides this by (4 × this-week's
    // realCapacity) to derive a 4-week actual-utilisation percentage.
    // Keeping the division client-side lets the metric "live update"
    // when the user adjusts hoursPerSuitePerDay or week navigation.
    totalEditHoursLogged4wk: { value: round1(editSecsAll / 3600) },
  };

  // Patch shape: explicit named keys only — never include the three
  // remaining manual keys (totalSuites, hoursPerSuitePerDay,
  // targetUtilisation). adminPatch then leaves them untouched.
  const patch = {
    currentActiveProjects,
    newProjectsPerWeek,
    _computed: computed,
  };
  if (hasEnoughData) patch.avgEditHoursPerProject = avgEditHoursPerProject;
  if (hasDurationData) patch.avgProjectDuration = avgProjectDuration;

  return { patch, computed };
}
