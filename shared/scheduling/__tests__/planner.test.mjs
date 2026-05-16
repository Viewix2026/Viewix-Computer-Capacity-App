// Ugly-cases unit tests for the Phase 2 deterministic planner.
// Run via:  node shared/scheduling/__tests__/planner.test.mjs
//
// Same pattern as checker.test.mjs — pure Node, no test runner,
// assertions throw on failure, green summary on success. The point of
// this suite is to break the planner in isolation BEFORE any Slack /
// Opus code exists (locked build order).

import assert from "node:assert/strict";
import {
  buildPlan,
  buildVideoUnits,
  videoIndexOf,
  buildCapacityGrid,
  planExtraShoot,
  planEdits,
  planRevisions,
  partitionFlags,
  stageEstimate,
  selectCandidateEditors,
  HARD_VIOLATION_KINDS,
} from "../planner.js";
import { FALLBACKS, CAPACITY_BANDS } from "../constants.js";

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

// ─── Fixtures ───────────────────────────────────────────────────────

const editorAlex = { id: "ed-alex", name: "Alex", role: "editor",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
const editorLuke = { id: "ed-luke", name: "Luke", role: "editor",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
const editorMona = { id: "ed-mona", name: "Mona", role: "editor",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
const crewSteve = { id: "ed-steve", name: "Steve", role: "crew",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
const editors = [editorAlex, editorLuke, editorMona, crewSteve];

const today = "2026-05-13"; // Wed
const PG = "PG-TEST";
const idFor = (stage, key) => `_plan_${stage}_${key}`;

function subtask(id, partial = {}) {
  return {
    id,
    name: partial.name || "task",
    status: partial.status || "scheduled",
    stage: partial.stage || null,
    startDate: partial.startDate || null,
    endDate: partial.endDate || null,
    startTime: partial.startTime || null,
    endTime: partial.endTime || null,
    assigneeIds: partial.assigneeIds || [],
    assigneeId: partial.assigneeId || (partial.assigneeIds || [])[0] || null,
    ...partial,
  };
}
function project(id, numberOfVideos, subtasks = {}, extra = {}) {
  return { id, projectName: id, clientName: "Acme", videoType: "liveAction",
    numberOfVideos, subtasks, ...extra };
}

// ─── 1. videoIndexOf + buildVideoUnits ─────────────────────────────

test("videoIndexOf: explicit _videoIndex wins over name", () => {
  assert.equal(videoIndexOf({ _videoIndex: 4, name: "random" }), 4);
});
test("videoIndexOf: name pattern Edit — Video N", () => {
  assert.equal(videoIndexOf({ name: "Edit — Video 3" }), 3);
  assert.equal(videoIndexOf({ name: "Revisions - Video 12" }), 12);
  assert.equal(videoIndexOf({ name: "Shoot – Video 2" }), 2);
});
test("videoIndexOf: unindexed manual subtask → null", () => {
  assert.equal(videoIndexOf({ name: "Director's cut pass" }), null);
  assert.equal(videoIndexOf({ name: "Edit" }), null); // no video number
});

test("buildVideoUnits: empty 5-video project → 5 empty units", () => {
  const units = buildVideoUnits(project("p", 5));
  assert.equal(units.length, 5);
  assert.ok(units.every(u => u.edit === null && u.revisions === null));
  assert.deepEqual(units.map(u => u.index), [1, 2, 3, 4, 5]);
});

test("buildVideoUnits: attaches existing edits/revisions by index", () => {
  const p = project("p", 3, {
    s1: subtask("s1", { name: "Edit — Video 1", stage: "edit", startDate: today }),
    s2: subtask("s2", { name: "Revisions — Video 2", stage: "revisions" }),
    s3: subtask("s3", { _videoIndex: 3, name: "weird name", stage: "edit" }),
    s4: subtask("s4", { name: "Director cut", stage: "edit" }), // unindexed → ignored
    s5: subtask("s5", { name: "Edit — Video 9", stage: "edit" }), // beyond count → ignored
    s6: subtask("s6", { name: "Edit — Video 1", stage: "edit", status: "archived" }), // archived ignored
  });
  const units = buildVideoUnits(p);
  assert.equal(units[0].edit?._id, "s1");
  assert.equal(units[1].revisions?._id, "s2");
  assert.equal(units[2].edit?._id, "s3");
  assert.equal(units[0].revisions, null);
});

// ─── 2. stageEstimate ──────────────────────────────────────────────

test("stageEstimate: fallback when no stats / low sample", () => {
  assert.equal(stageEstimate("liveAction", "edit", {}), FALLBACKS.edit);
  assert.equal(
    stageEstimate("liveAction", "edit", { liveAction: { edit: { avgHours: 9, sampleCount: 2 } } }),
    FALLBACKS.edit,
  );
});
test("stageEstimate: live avg when sample >= MIN_SAMPLE_SIZE", () => {
  assert.equal(
    stageEstimate("liveAction", "edit", { liveAction: { edit: { avgHours: 6, sampleCount: 3 } } }),
    6,
  );
});

// ─── 3. buildCapacityGrid ──────────────────────────────────────────

test("buildCapacityGrid: shoot day → 0 edit capacity; in-office → target", () => {
  // weekData: Alex on a SHOOT Wed 2026-05-13 (Monday key = 2026-05-11).
  // NOTE: a weekData record is a FULL override of the editor's week
  // (Phase 1 semantics) — unspecified days read as "off", they do NOT
  // fall back to defaultDays. So we must spell the whole week out.
  const weekData = {
    "2026-05-11": { editors: [{ id: "ed-alex",
      days: { mon: "in", tue: "in", wed: "shoot", thu: "in", fri: "in" } }] },
  };
  const grid = buildCapacityGrid({
    candidateEditors: [editorAlex],
    projects: {},
    weekData,
    planWindow: { start: "2026-05-13", end: "2026-05-14" },
  });
  assert.equal(grid["ed-alex"]["2026-05-13"], 0, "shoot day → 0 edit hours");
  assert.equal(grid["ed-alex"]["2026-05-14"], CAPACITY_BANDS.target, "in-office → full target");
});

test("buildCapacityGrid: existing flexible work reduces free hours", () => {
  const projects = {
    p: project("p", 1, {
      e1: subtask("e1", { stage: "edit", startDate: "2026-05-14",
        assigneeIds: ["ed-alex"], _estHours: 3.5 }),
    }),
  };
  const grid = buildCapacityGrid({
    candidateEditors: [editorAlex], projects, weekData: {},
    planWindow: { start: "2026-05-14", end: "2026-05-14" },
  });
  assert.equal(grid["ed-alex"]["2026-05-14"], CAPACITY_BANDS.target - 3.5);
});

// ─── 4. planEdits ──────────────────────────────────────────────────

test("planEdits: 5 edits across 2 requested editors, none over target", () => {
  const p = project("p", 5);
  const units = buildVideoUnits(p);
  const grid = buildCapacityGrid({
    candidateEditors: [editorAlex, editorLuke], projects: {}, weekData: {},
    planWindow: { start: today, end: "2026-06-30" },
  });
  const { proposed, violations } = planEdits({
    videoUnits: units, candidateEditors: [editorAlex, editorLuke], grid,
    project: p, videoTypeStats: {}, planWindow: { start: today, end: "2026-06-30" },
    today, deadline: "2026-06-30", requestedEditorIds: ["ed-alex", "ed-luke"],
    planGroupId: PG, idFor,
  });
  assert.equal(violations.length, 0, "5 edits all placeable");
  assert.equal(proposed.length, 5);
  // No single editor-day should exceed target from planner writes alone.
  const load = {};
  for (const r of proposed) {
    const k = `${r.assigneeId}|${r.startDate}`;
    load[k] = (load[k] || 0) + r._estHours;
  }
  for (const [k, h] of Object.entries(load)) {
    assert.ok(h <= CAPACITY_BANDS.target + 1e-9, `${k} = ${h}h exceeds target`);
  }
  assert.ok(proposed.every(r => r.mode === "create" && r.stage === "edit"));
  assert.ok(proposed.every(r => r._planGroupId === PG));
});

test("planEdits: deadline too tight → planInfeasible noEditCapacity", () => {
  const p = project("p", 3);
  const units = buildVideoUnits(p);
  // Only ONE working day in window, one editor → 8h / 3.5h = 2 edits fit,
  // third has no capacity.
  const grid = buildCapacityGrid({
    candidateEditors: [editorAlex], projects: {}, weekData: {},
    planWindow: { start: today, end: today },
  });
  const { proposed, violations } = planEdits({
    videoUnits: units, candidateEditors: [editorAlex], grid, project: p,
    videoTypeStats: {}, planWindow: { start: today, end: today },
    today, deadline: today, requestedEditorIds: ["ed-alex"],
    planGroupId: PG, idFor,
  });
  assert.equal(proposed.length, 2, "two edits fit in one 8h day");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "planInfeasible");
  assert.equal(violations[0].subkind, "noEditCapacity");
  assert.equal(violations[0].videoIndex, 3);
});

test("planEdits: zero-capacity editor → all infeasible", () => {
  const p = project("p", 2);
  const units = buildVideoUnits(p);
  const weekData = { "2026-05-11": { editors: [{ id: "ed-alex",
    days: { wed: "off", thu: "off", fri: "off" } }] } };
  const grid = buildCapacityGrid({
    candidateEditors: [editorAlex], projects: {}, weekData,
    planWindow: { start: "2026-05-13", end: "2026-05-15" },
  });
  const { proposed, violations } = planEdits({
    videoUnits: units, candidateEditors: [editorAlex], grid, project: p,
    videoTypeStats: {}, planWindow: { start: "2026-05-13", end: "2026-05-15" },
    today: "2026-05-13", deadline: "2026-05-15", requestedEditorIds: ["ed-alex"],
    planGroupId: PG, idFor,
  });
  assert.equal(proposed.length, 0);
  assert.equal(violations.length, 2);
  assert.ok(violations.every(v => v.subkind === "noEditCapacity"));
});

test("planEdits tie-break: requested editor beats auto-pick on equal earliest", () => {
  const p = project("p", 1);
  const units = buildVideoUnits(p);
  const cands = [editorAlex, editorLuke]; // both feasible same day
  const grid = buildCapacityGrid({
    candidateEditors: cands, projects: {}, weekData: {},
    planWindow: { start: today, end: today },
  });
  const { proposed } = planEdits({
    videoUnits: units, candidateEditors: cands, grid, project: p,
    videoTypeStats: {}, planWindow: { start: today, end: today },
    today, deadline: today,
    requestedEditorIds: ["ed-luke"], // Luke explicitly requested
    planGroupId: PG, idFor,
  });
  assert.equal(proposed[0].assigneeId, "ed-luke",
    "explicitly-requested editor wins tier 1 even though ed-alex sorts first by id");
});

// ─── 5. planExtraShoot ─────────────────────────────────────────────

test("planExtraShoot: places on first feasible day, zeroes crew edit grid", () => {
  const grid = {
    "ed-steve": { "2026-05-13": 8, "2026-05-14": 8 },
    "ed-alex": { "2026-05-13": 8, "2026-05-14": 8 },
  };
  const { shoot, violation } = planExtraShoot({
    extraShoot: { dateRangeStart: "2026-05-13", dateRangeEnd: "2026-05-15",
      durationHours: 5, assigneeIds: ["ed-steve", "ed-alex"], timesKnown: true,
      startTime: "09:00", endTime: "14:00" },
    editors, projects: {}, weekData: {}, grid, planGroupId: PG, idFor,
  });
  assert.equal(violation, null);
  assert.equal(shoot.stage, "shoot");
  assert.equal(shoot.startDate, "2026-05-13");
  assert.equal(shoot.startTime, "09:00");
  assert.deepEqual(shoot.assigneeIds, ["ed-steve", "ed-alex"]);
  assert.equal(grid["ed-steve"]["2026-05-13"], 0, "crew edit grid zeroed on shoot day");
  assert.equal(grid["ed-alex"]["2026-05-13"], 0);
});

test("planExtraShoot: no crew → extraShootNoCrew violation", () => {
  const { shoot, violation } = planExtraShoot({
    extraShoot: { dateRangeStart: today, dateRangeEnd: today, durationHours: 4,
      assigneeIds: [] },
    editors, projects: {}, weekData: {}, grid: {}, planGroupId: PG, idFor,
  });
  assert.equal(shoot, null);
  assert.equal(violation.subkind, "extraShootNoCrew");
});

test("planExtraShoot: existing shoot on candidate day → skip to next free day", () => {
  // Steve already on a timed shoot Wed 2026-05-13. Window 13–14.
  const projects = {
    other: project("other", 1, {
      sh: subtask("sh", { stage: "shoot", startDate: "2026-05-13",
        startTime: "08:00", endTime: "16:00", assigneeIds: ["ed-steve"] }),
    }),
  };
  const grid = { "ed-steve": { "2026-05-13": 0, "2026-05-14": 8 } };
  const { shoot, violation } = planExtraShoot({
    extraShoot: { dateRangeStart: "2026-05-13", dateRangeEnd: "2026-05-14",
      durationHours: 4, assigneeIds: ["ed-steve"] },
    editors, projects, weekData: {}, grid, planGroupId: PG, idFor,
  });
  assert.equal(violation, null);
  assert.equal(shoot.startDate, "2026-05-14", "skipped the day Steve was already shooting");
});

test("planExtraShoot: no feasible day in window → infeasible", () => {
  const projects = {
    other: project("other", 1, {
      sh: subtask("sh", { stage: "shoot", startDate: "2026-05-13",
        startTime: "08:00", endTime: "16:00", assigneeIds: ["ed-steve"] }),
    }),
  };
  const grid = { "ed-steve": { "2026-05-13": 0 } };
  const { shoot, violation } = planExtraShoot({
    extraShoot: { dateRangeStart: "2026-05-13", dateRangeEnd: "2026-05-13",
      durationHours: 4, assigneeIds: ["ed-steve"] },
    editors, projects, weekData: {}, grid, planGroupId: PG, idFor,
  });
  assert.equal(shoot, null);
  assert.equal(violation.subkind, "extraShootNoFeasibleDay");
});

// ─── 6. planRevisions ──────────────────────────────────────────────

test("planRevisions: one unscheduled revision per missing unit", () => {
  const p = project("p", 3, {
    r2: subtask("r2", { name: "Revisions — Video 2", stage: "revisions" }),
  });
  const units = buildVideoUnits(p);
  const rows = planRevisions({ videoUnits: units, planGroupId: PG, idFor });
  assert.equal(rows.length, 2, "units 1 and 3 need revisions; unit 2 already has one");
  assert.ok(rows.every(r => r.startDate === null && r.stage === "revisions"));
  assert.ok(rows.every(r => r._planGroupId === PG));
  assert.deepEqual(rows.map(r => r._videoIndex).sort(), [1, 3]);
});

// ─── 7. partitionFlags ─────────────────────────────────────────────

test("partitionFlags: hard kinds vs warnings", () => {
  const flags = [
    { kind: "fixedTimeConflict" },
    { kind: "offDayAssigned" },
    { kind: "dailyHardOverCapacity" },
    { kind: "dailyOverCapacity" },
    { kind: "multipleUntimedShoots" },
    { kind: "inOfficeIdle" },
  ];
  const { hardViolations, warnings } = partitionFlags(flags);
  assert.equal(hardViolations.length, 3);
  assert.equal(warnings.length, 3);
  assert.ok(hardViolations.every(f => HARD_VIOLATION_KINDS.has(f.kind)));
});

// ─── 8. buildPlan — end to end ─────────────────────────────────────

test("buildPlan: clean 5-video → 5 edits + 5 revisions, 0 hard violations", () => {
  const p = project("p", 5);
  const out = buildPlan({
    project: p, projects: { p }, editors, weekData: {}, videoTypeStats: {},
    input: { requestedEditorIds: ["ed-alex", "ed-luke"], anyoneWithCapacity: false,
      deadline: "2026-06-30", extraShoot: null },
    today, planGroupId: PG, idFor,
  });
  const edits = out.proposedSubtasks.filter(s => s.stage === "edit");
  const revs = out.proposedSubtasks.filter(s => s.stage === "revisions");
  assert.equal(edits.length, 5);
  assert.equal(revs.length, 5);
  assert.equal(out.hardViolations.length, 0, "feasible plan must have zero hard violations");
  assert.ok(edits.every(e => e.startDate >= today && e.startDate <= "2026-06-30"));
  assert.ok(revs.every(r => r.startDate === null));
});

test("buildPlan: idempotent — prior scheduled edits+revs present → no new writes", () => {
  const subtasks = {};
  for (let i = 1; i <= 3; i++) {
    subtasks[`e${i}`] = subtask(`e${i}`, { name: `Edit — Video ${i}`, stage: "edit",
      startDate: "2026-05-20", _videoIndex: i, assigneeIds: ["ed-alex"] });
    subtasks[`r${i}`] = subtask(`r${i}`, { name: `Revisions — Video ${i}`,
      stage: "revisions", _videoIndex: i });
  }
  const p = project("p", 3, subtasks);
  const out = buildPlan({
    project: p, projects: { p }, editors, weekData: {}, videoTypeStats: {},
    input: { requestedEditorIds: ["ed-alex"], deadline: "2026-06-30" },
    today, planGroupId: PG, idFor,
  });
  assert.equal(out.proposedSubtasks.length, 0,
    "every video already has a scheduled edit + a revision → nothing to write");
});

test("buildPlan: existing UNSCHEDULED edit → mode update, reuses id (no duplicate)", () => {
  const p = project("p", 2, {
    "old-edit-1": subtask("old-edit-1", { name: "Edit — Video 1", stage: "edit",
      _videoIndex: 1 }), // unscheduled
  });
  const out = buildPlan({
    project: p, projects: { p }, editors, weekData: {}, videoTypeStats: {},
    input: { requestedEditorIds: ["ed-alex"], deadline: "2026-06-30" },
    today, planGroupId: PG, idFor,
  });
  const edits = out.proposedSubtasks.filter(s => s.stage === "edit");
  assert.equal(edits.length, 2);
  const v1 = edits.find(e => e._videoIndex === 1);
  assert.equal(v1.mode, "update", "existing unscheduled edit is updated, not duplicated");
  assert.equal(v1.id, "old-edit-1", "reuses the existing subtask id");
  assert.equal(v1._existingSubtaskId, "old-edit-1");
  const v2 = edits.find(e => e._videoIndex === 2);
  assert.equal(v2.mode, "create");
});

test("buildPlan: deterministic — same inputs produce identical output", () => {
  const p = project("p", 4);
  const args = {
    project: p, projects: { p }, editors, weekData: {}, videoTypeStats: {},
    input: { requestedEditorIds: ["ed-alex", "ed-luke"], deadline: "2026-06-30" },
    today, planGroupId: PG, idFor,
  };
  const a = buildPlan(args);
  const b = buildPlan(args);
  assert.equal(JSON.stringify(a), JSON.stringify(b),
    "planner must be pure/deterministic — no Date.now / Math.random leakage");
});

test("buildPlan: window capped at today + 6 weeks when deadline is far", () => {
  const p = project("p", 1);
  const out = buildPlan({
    project: p, projects: { p }, editors, weekData: {}, videoTypeStats: {},
    input: { requestedEditorIds: ["ed-alex"], deadline: "2027-01-01" },
    today, planGroupId: PG, idFor,
  });
  // today 2026-05-13 + 42 days = 2026-06-24.
  assert.equal(out.planWindow.end, "2026-06-24",
    "far deadline → window capped at today + 6 weeks");
});

test("buildPlan: anyoneWithCapacity widens the pool beyond requested", () => {
  const p = project("p", 6);
  const out = buildPlan({
    project: p, projects: { p }, editors, weekData: {}, videoTypeStats: {},
    input: { requestedEditorIds: [], anyoneWithCapacity: true, deadline: "2026-06-30" },
    today, planGroupId: PG, idFor,
  });
  // With no explicit editors but anyoneWithCapacity, candidate pool must
  // be non-empty (top-N of role==="editor"); crew is excluded.
  assert.ok(out.candidateEditorIds.length >= 2);
  assert.ok(!out.candidateEditorIds.includes("ed-steve"), "crew excluded from edit pool");
  assert.equal(out.proposedSubtasks.filter(s => s.stage === "edit").length, 6);
});

test("buildPlan: extra shoot infeasible surfaces as a hard violation", () => {
  const p = project("p", 1);
  const projects = {
    p,
    busy: project("busy", 1, {
      sh: subtask("sh", { stage: "shoot", startDate: "2026-05-13",
        startTime: "08:00", endTime: "18:00", assigneeIds: ["ed-steve"] }),
    }),
  };
  const out = buildPlan({
    project: p, projects, editors, weekData: {}, videoTypeStats: {},
    input: {
      requestedEditorIds: ["ed-alex"], deadline: "2026-06-30",
      extraShoot: { dateRangeStart: "2026-05-13", dateRangeEnd: "2026-05-13",
        durationHours: 6, assigneeIds: ["ed-steve"] },
    },
    today, planGroupId: PG, idFor,
  });
  assert.ok(
    out.hardViolations.some(v => v.kind === "planInfeasible" &&
      v.subkind === "extraShootNoFeasibleDay"),
    "Steve already shooting that day → extra shoot infeasible → hard violation",
  );
});

console.log(`\n${passed} tests passed`);
