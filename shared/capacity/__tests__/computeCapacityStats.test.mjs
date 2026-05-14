// Unit tests for computeCapacityStats. Run via:
//   node shared/capacity/__tests__/computeCapacityStats.test.mjs
//
// Pattern matches shared/scheduling/__tests__/checker.test.mjs — pure
// Node, no test runner. Assertions throw on failure, the script prints
// a green summary on success.

import assert from "node:assert/strict";
import { computeCapacityStats } from "../computeCapacityStats.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// Fixed reference "now" so the suite is deterministic regardless of
// when it runs. Chosen as a midnight UTC for clean date arithmetic.
const NOW = Date.parse("2026-05-14T00:00:00.000Z");
const DAY = 24 * 3600 * 1000;
const isoMinus = (days) => new Date(NOW - days * DAY).toISOString();
const isoDateMinus = (days) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

// Helper to build a project quickly.
function proj({ id, status = "inProgress", commissioned = true, createdAt = isoMinus(60), subtasks = {} }) {
  return { id, status, commissioned, createdAt, subtasks };
}

// Helper to build a subtask. Use `stage` directly to control what
// inferStage returns (it short-circuits on a valid stage key).
function sub({ id, stage = "edit" }) {
  return { id, name: id, stage };
}

// Helper to build a timeLogs blob. Shape: { editorId: { date: { taskId: { secs, stage? } } } }
function logs(entries) {
  const out = {};
  for (const e of entries) {
    const editor = e.editorId || "ed1";
    out[editor] ||= {};
    out[editor][e.date] ||= {};
    out[editor][e.date][e.taskId] = { secs: e.secs, ...(e.stage ? { stage: e.stage } : {}) };
  }
  return out;
}

// ─── currentActiveProjects + pipelineProjects ─────────────────────

test("project with status:done + commissioned:true → excluded from active and pipeline", () => {
  const projects = [proj({ id: "p1", status: "done" })];
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  assert.equal(patch.currentActiveProjects, 0);
  assert.equal(computed.pipelineProjects.value, 0);
});

test("project with status:archived → excluded from active and pipeline", () => {
  const projects = [proj({ id: "p1", status: "archived" })];
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  assert.equal(patch.currentActiveProjects, 0);
  assert.equal(computed.pipelineProjects.value, 0);
});

test("commissioned:false + status:inProgress → excluded from currentActiveProjects, counted in pipelineProjects", () => {
  const projects = [proj({ id: "p1", status: "inProgress", commissioned: false })];
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  assert.equal(patch.currentActiveProjects, 0);
  assert.equal(computed.pipelineProjects.value, 1);
});

test('legacy "active" status normalises to inProgress → included in currentActiveProjects', () => {
  const projects = [proj({ id: "p1", status: "active" })];
  const { patch } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  assert.equal(patch.currentActiveProjects, 1);
});

test("currentActiveProjects = 0 is honestly written (not preserved)", () => {
  const { patch } = computeCapacityStats({ projects: [], timeLogs: {}, now: NOW });
  assert.equal(patch.currentActiveProjects, 0);
  // newProjectsPerWeek likewise honest
  assert.equal(patch.newProjectsPerWeek, 0);
});

// ─── newProjectsPerWeek (broad — deal inflow) ─────────────────────

test("newProjectsPerWeek counts projects regardless of done/archived state", () => {
  const projects = [
    proj({ id: "p1", status: "done", createdAt: isoMinus(5) }),
    proj({ id: "p2", status: "archived", createdAt: isoMinus(10) }),
    proj({ id: "p3", status: "inProgress", createdAt: isoMinus(15) }),
    proj({ id: "p4", status: "inProgress", commissioned: false, createdAt: isoMinus(20) }),
  ];
  // 4 created in last 28 days, /4 weeks = 1.0
  const { patch } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  assert.equal(patch.newProjectsPerWeek, 1.0);
});

test("newProjectsPerWeek excludes projects created >28 days ago", () => {
  const projects = [
    proj({ id: "p1", createdAt: isoMinus(40) }),
    proj({ id: "p2", createdAt: isoMinus(10) }),
  ];
  const { patch } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  // Only p2 counts → 1/4 = 0.25
  assert.equal(patch.newProjectsPerWeek, 0.3); // 0.25 rounded to 1dp = 0.3
});

test("project with malformed createdAt is silently skipped in newProjectsPerWeek", () => {
  const projects = [
    proj({ id: "p1", createdAt: "not a date" }),
    proj({ id: "p2", createdAt: "" }),
    proj({ id: "p3", createdAt: isoMinus(5) }),
  ];
  const { patch } = computeCapacityStats({ projects, timeLogs: {}, now: NOW });
  assert.equal(patch.newProjectsPerWeek, 0.3); // only p3 counts
});

// ─── project-weeks denominator ────────────────────────────────────

test("project created 10 days ago contributes 10/7 project-weeks (not 4)", () => {
  const projects = [proj({ id: "p1", createdAt: isoMinus(10), subtasks: { s1: sub({ id: "s1", stage: "edit" }) } })];
  // 5 edit logs at 1h each on s1 → 5h numerator, projectWeeks = 10/7 ≈ 1.4286
  // expected avg = 5 / 1.4286 ≈ 3.5
  const tl = logs([
    { date: isoDateMinus(1), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(2), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(3), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(4), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(5), taskId: "s1", secs: 3600 },
  ]);
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.projectWeeks, 1.4);
  assert.equal(patch.avgEditHoursPerProject, 3.5);
});

test("project created 200 days ago contributes 4 project-weeks (capped at window)", () => {
  const projects = [proj({ id: "p1", createdAt: isoMinus(200), subtasks: { s1: sub({ id: "s1", stage: "edit" }) } })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(2), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(3), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(4), taskId: "s1", secs: 3600 },
    { date: isoDateMinus(5), taskId: "s1", secs: 3600 },
  ]);
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.projectWeeks, 4.0);
  // 5h / 4 weeks = 1.25 → round to 1.3
  assert.equal(patch.avgEditHoursPerProject, 1.3);
});

// ─── stage-filter authority ───────────────────────────────────────

test("log on preprod-stage subtask → excluded from edit-hour sum", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sPre: sub({ id: "sPre", stage: "preProduction" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "sPre", secs: 7200 },
    { date: isoDateMinus(2), taskId: "sPre", secs: 7200 },
    { date: isoDateMinus(3), taskId: "sPre", secs: 7200 },
    { date: isoDateMinus(4), taskId: "sPre", secs: 7200 },
    { date: isoDateMinus(5), taskId: "sPre", secs: 7200 },
  ]);
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  // No edit logs → insufficient_data
  assert.equal(patch.avgEditHoursPerProject, undefined);
  assert.equal(computed.avgEditHoursPerProject.status, "insufficient_data");
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 0);
});

test('log.stage:"Edit" (wrong case) on subtask that inferStage resolves to "edit" → INCLUDED', () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "sEdit", secs: 3600, stage: "Edit" },
    { date: isoDateMinus(2), taskId: "sEdit", secs: 3600, stage: "Edit" },
    { date: isoDateMinus(3), taskId: "sEdit", secs: 3600, stage: "Edit" },
    { date: isoDateMinus(4), taskId: "sEdit", secs: 3600, stage: "Edit" },
    { date: isoDateMinus(5), taskId: "sEdit", secs: 3600, stage: "Edit" },
  ]);
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  // Subtask is the authority — its stage is "edit" (lower-case key), so all 5 logs count.
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 5);
  assert.equal(computed.avgEditHoursPerProject.status, "ok");
  assert.ok(patch.avgEditHoursPerProject > 0);
});

test('log.stage:"edit" on subtask that inferStage resolves to "revisions" → EXCLUDED', () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sRev: sub({ id: "sRev", stage: "revisions" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "sRev", secs: 3600, stage: "edit" },
    { date: isoDateMinus(2), taskId: "sRev", secs: 3600, stage: "edit" },
    { date: isoDateMinus(3), taskId: "sRev", secs: 3600, stage: "edit" },
    { date: isoDateMinus(4), taskId: "sRev", secs: 3600, stage: "edit" },
    { date: isoDateMinus(5), taskId: "sRev", secs: 3600, stage: "edit" },
  ]);
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  // Subtask says "revisions" — wins over log.stage="edit". All excluded.
  assert.equal(patch.avgEditHoursPerProject, undefined);
  assert.equal(computed.avgEditHoursPerProject.status, "insufficient_data");
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 0);
});

// ─── exclusion edge cases ─────────────────────────────────────────

test("log under _running key → excluded", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = {
    ed1: {
      [isoDateMinus(1)]: {
        _running: { taskId: "sEdit", startedAt: NOW - 1000 },
        sEdit: { secs: 3600 },
        sEdit2: { secs: 3600 },
        sEdit3: { secs: 3600 },
        sEdit4: { secs: 3600 },
        sEdit5: { secs: 3600 },
      },
    },
  };
  // Only sEdit resolves (others have no matching subtask) → 1 log counted, below MIN_LOG_SAMPLES floor
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 1);
  assert.equal(computed.avgEditHoursPerProject.status, "insufficient_data");
});

test("log with secs:0 or missing → excluded", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = {
    ed1: {
      [isoDateMinus(1)]: { sEdit: { secs: 0 } },
      [isoDateMinus(2)]: { sEdit: { secs: null } },
      [isoDateMinus(3)]: { sEdit: {} },
    },
  };
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 0);
});

test("log on subtask of done project → excluded", () => {
  const projects = [
    proj({ id: "pDone", status: "done", createdAt: isoMinus(28),
           subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) } }),
  ];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(2), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(3), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(4), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(5), taskId: "sEdit", secs: 3600 },
  ]);
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  // pDone is not in activeIds → subtask isn't indexed → all logs unresolved
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 0);
  assert.equal(computed.avgEditHoursPerProject.status, "insufficient_data");
});

test("log on unresolved taskId → excluded", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "nonexistent", secs: 7200 },
  ]);
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 0);
});

test("log dated exactly now-28d → INCLUDED (window edge)", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(60),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(28), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(27), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(26), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(25), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(24), taskId: "sEdit", secs: 3600 },
  ]);
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 5);
});

test("Sydney timezone: cutoff uses Sydney date, not UTC", () => {
  // Cron fires at 18:30 UTC = 04:30 next-day Sydney AEST.
  //   now (UTC)         = 2026-05-14T18:30:00Z
  //   Sydney date of now = 2026-05-15
  //   now - 28d (UTC)    = 2026-04-16T18:30:00Z
  //   Sydney date of that = 2026-04-17  ← correct cutoff
  // Under the old UTC code the cutoff was "2026-04-16", which
  // incorrectly included one extra Sydney-local day of logs.
  const cronFireUtc = Date.parse("2026-05-14T18:30:00.000Z");
  const projects = [proj({
    id: "p1",
    createdAt: "2026-01-01T00:00:00Z", // way old → contributes the full 4 weeks
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  // 6 logs spanning the boundary. Apr 16 must be EXCLUDED (it's 29
  // Sydney-days before the cron fire date 2026-05-15). Apr 17–21 stay.
  const tl = logs([
    { date: "2026-04-16", taskId: "sEdit", secs: 7200 },
    { date: "2026-04-17", taskId: "sEdit", secs: 7200 },
    { date: "2026-04-18", taskId: "sEdit", secs: 7200 },
    { date: "2026-04-19", taskId: "sEdit", secs: 7200 },
    { date: "2026-04-20", taskId: "sEdit", secs: 7200 },
    { date: "2026-04-21", taskId: "sEdit", secs: 7200 },
  ]);
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: cronFireUtc });
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 5);
});

test("log dated 29 days ago → EXCLUDED", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(60),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(29), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(30), taskId: "sEdit", secs: 3600 },
  ]);
  const { computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 0);
});

// ─── insufficient_data path ───────────────────────────────────────

test("insufficient data: zero log samples → no avg key in patch, previousValue carried through", () => {
  const projects = [proj({ id: "p1", createdAt: isoMinus(28) })];
  const { patch, computed } = computeCapacityStats({
    projects,
    timeLogs: {},
    now: NOW,
    prevAvgEditHours: 6.5,
  });
  assert.equal(patch.avgEditHoursPerProject, undefined);
  assert.equal(computed.avgEditHoursPerProject.status, "insufficient_data");
  assert.equal(computed.avgEditHoursPerProject.previousValue, 6.5);
});

test("insufficient data: 4 log samples (below MIN_LOG_SAMPLES=5) → insufficient_data", () => {
  const projects = [proj({
    id: "p1",
    createdAt: isoMinus(28),
    subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) },
  })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(2), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(3), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(4), taskId: "sEdit", secs: 3600 },
  ]);
  const { patch, computed } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  assert.equal(patch.avgEditHoursPerProject, undefined);
  assert.equal(computed.avgEditHoursPerProject.status, "insufficient_data");
  assert.equal(computed.avgEditHoursPerProject.logSampleCount, 4);
});

// ─── patch shape guardrail ────────────────────────────────────────

test("patch never contains manual keys (totalSuites, hoursPerSuitePerDay, avgProjectDuration, targetUtilisation)", () => {
  const projects = [proj({ id: "p1", createdAt: isoMinus(10),
                           subtasks: { sEdit: sub({ id: "sEdit", stage: "edit" }) } })];
  const tl = logs([
    { date: isoDateMinus(1), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(2), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(3), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(4), taskId: "sEdit", secs: 3600 },
    { date: isoDateMinus(5), taskId: "sEdit", secs: 3600 },
  ]);
  const { patch } = computeCapacityStats({ projects, timeLogs: tl, now: NOW });
  const manualKeys = ["totalSuites", "hoursPerSuitePerDay", "avgProjectDuration", "targetUtilisation"];
  for (const k of manualKeys) {
    assert.ok(!(k in patch), `patch leaked manual key: ${k}`);
  }
  // Auto keys present
  assert.ok("currentActiveProjects" in patch);
  assert.ok("newProjectsPerWeek" in patch);
  assert.ok("avgEditHoursPerProject" in patch);
  assert.ok("_computed" in patch);
});

test("_computed always carries source + computedAt + windowDays", () => {
  const { computed } = computeCapacityStats({ projects: [], timeLogs: {}, now: NOW });
  assert.equal(computed.source, "capacity-stats-cron");
  assert.equal(computed.computedAt, NOW);
  assert.equal(computed.windowDays, 28);
});

// ─── done ──────────────────────────────────────────────────────────

console.log(`\n${passed} tests passed.`);
