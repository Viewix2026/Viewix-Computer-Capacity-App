// Unit tests for the scheduling-brain checker. Run via:
//   node shared/scheduling/__tests__/checker.test.mjs
//
// Pure-Node, no test runner — assertions throw on failure, the script
// prints a green summary on success. Cheap, deterministic, and means
// the build doesn't depend on jest/vitest config.

import assert from "node:assert/strict";
import { detectFlags, detectFlagsForDateRange, enrichFlagsForDisplay } from "../conflicts.js";
import { plannedHoursForDate, hydrateEstHours, diffHours } from "../capacity.js";
import { computeVideoTypeStats, buildLoggedHoursMap } from "../stats.js";
import { fingerprintFlag, FLAG_KINDS } from "../flags.js";
import { isEditorInOnDate, isWorkingOnDate, datesInRange } from "../availability.js";
import { CAPACITY_BANDS, FALLBACKS, MIN_SAMPLE_SIZE, OVERRUN_RATIO } from "../constants.js";

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

const editorAlex = {
  id: "ed-alex",
  name: "Alex",
  role: "editor",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
};
const editorLuke = {
  id: "ed-luke",
  name: "Luke",
  role: "editor",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
};
const crewSteve = {
  id: "ed-steve",
  name: "Steve",
  role: "crew",
  defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
};

const editors = [editorAlex, editorLuke, crewSteve];

// Wednesday May 13, 2026 — picked because it's clearly a weekday.
const today = "2026-05-13";

// Build the projects map. The brain is fed the raw Firebase shape:
// { [projectId]: { videoType, subtasks: { [stid]: {...} } } }.
function project(id, videoType, subtasks) {
  return { id, videoType, projectName: id, clientName: "Acme", subtasks };
}
function subtask(id, partial) {
  return {
    id,
    name: partial.name || "task",
    status: partial.status || "scheduled",
    stage: partial.stage || "edit",
    startDate: partial.startDate || null,
    endDate: partial.endDate || null,
    startTime: partial.startTime || null,
    endTime: partial.endTime || null,
    assigneeIds: partial.assigneeIds || [],
    assigneeId: partial.assigneeId || (partial.assigneeIds || [])[0] || null,
    ...partial,
  };
}

// ─── 1. fingerprintFlag — stable + dedupe-safe ─────────────────────

test("fingerprintFlag is stable across same input", () => {
  const f = { kind: "doubleBookedShoot", personId: "ed-1", date: "2026-05-13", subtasks: [{ subtaskId: "b" }, { subtaskId: "a" }] };
  // doubleBookedShoot doesn't exist in the real flag set; using a real one:
  const real = { kind: "fixedTimeConflict", personId: "ed-1", date: "2026-05-13", subtasks: [{ subtaskId: "b" }, { subtaskId: "a" }] };
  assert.equal(fingerprintFlag(real), fingerprintFlag(real));
  // Subtask order shouldn't matter — fingerprint sorts.
  const swapped = { ...real, subtasks: [{ subtaskId: "a" }, { subtaskId: "b" }] };
  assert.equal(fingerprintFlag(real), fingerprintFlag(swapped));
});

test("fingerprintFlag changes when meaningful fields change", () => {
  const a = { kind: "dailyOverCapacity", personId: "ed-1", date: "2026-05-13", plannedHours: 9 };
  const b = { kind: "dailyOverCapacity", personId: "ed-1", date: "2026-05-14", plannedHours: 9 };
  assert.notEqual(fingerprintFlag(a), fingerprintFlag(b));
});

// ─── 2. plannedHoursForDate — capacity math ─────────────────────────

test("plannedHoursForDate: 3.5h edit Mon front-loaded, 0h Tue/Wed", () => {
  const p = project("p1", "socialOrganic", {
    e1: subtask("e1", {
      stage: "edit",
      startDate: "2026-05-11", // Mon
      endDate: "2026-05-13", // Wed
      assigneeIds: ["ed-alex"],
      _estHours: 3.5,
    }),
  });
  const projects = { p1: p };
  // Front-loaded: Mon = 3.5h, Tue & Wed = 0h.
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-11", projects), 3.5);
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-12", projects), 0);
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-13", projects), 0);
});

test("plannedHoursForDate: shoot uses timed window per assignee", () => {
  const p = project("p2", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: "2026-05-13",
      startTime: "10:00",
      endTime: "14:00",
      assigneeIds: ["ed-alex", "ed-steve"],
    }),
  });
  // 4h shoot, both assignees consume the full window.
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-13", { p2: p }), 4);
  assert.equal(plannedHoursForDate("ed-steve", "2026-05-13", { p2: p }), 4);
});

test("plannedHoursForDate: untimed shoot = 4h presumed", () => {
  const p = project("p3", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: "2026-05-13",
      assigneeIds: ["ed-alex"],
    }),
  });
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-13", { p3: p }), 4);
});

test("plannedHoursForDate: multi-assignee flexible task splits estimate", () => {
  const p = project("p4", "socialOrganic", {
    e1: subtask("e1", {
      stage: "edit",
      startDate: "2026-05-13",
      assigneeIds: ["ed-alex", "ed-luke"],
      _estHours: 3.5,
    }),
  });
  // 3.5h ÷ 2 assignees = 1.75h each.
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-13", { p4: p }), 1.75);
  assert.equal(plannedHoursForDate("ed-luke", "2026-05-13", { p4: p }), 1.75);
});

test("plannedHoursForDate: hold = 0", () => {
  const p = project("p5", "liveAction", {
    h1: subtask("h1", {
      stage: "hold",
      startDate: "2026-05-13",
      assigneeIds: ["ed-alex"],
    }),
  });
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-13", { p5: p }), 0);
});

test("plannedHoursForDate: done subtasks contribute zero", () => {
  const p = project("p6", "socialOrganic", {
    e1: subtask("e1", {
      stage: "edit",
      status: "done",
      startDate: "2026-05-13",
      assigneeIds: ["ed-alex"],
      _estHours: 3.5,
    }),
  });
  assert.equal(plannedHoursForDate("ed-alex", "2026-05-13", { p6: p }), 0);
});

// ─── 3. detectFlags — each kind ────────────────────────────────────

test("detectFlags: fixedTimeConflict fires on overlapping timed shoots", () => {
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      startTime: "10:00",
      endTime: "14:00",
      assigneeIds: ["ed-alex"],
    }),
    s2: subtask("s2", {
      stage: "shoot",
      startDate: today,
      startTime: "12:00",
      endTime: "16:00",
      assigneeIds: ["ed-alex"],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
  });
  const ftc = flags.filter(f => f.kind === "fixedTimeConflict" && f.personId === "ed-alex");
  assert.equal(ftc.length, 1, "expected one fixedTimeConflict for Alex");
});

test("detectFlags: fixedTimeConflict applies to crew (not just editors)", () => {
  // Steve is role:crew. Capacity bands skip crew, but fixed-time
  // conflicts must still fire for them.
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      startTime: "10:00",
      endTime: "14:00",
      assigneeIds: ["ed-steve"],
    }),
    s2: subtask("s2", {
      stage: "shoot",
      startDate: today,
      startTime: "11:00",
      endTime: "15:00",
      assigneeIds: ["ed-steve"],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
  });
  const ftc = flags.find(f => f.kind === "fixedTimeConflict" && f.personId === "ed-steve");
  assert.ok(ftc, "expected crew member's fixed-time conflict to fire");
});

test("detectFlags: multipleUntimedShoots fires on 2 untimed shoots", () => {
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      assigneeIds: ["ed-alex"],
    }),
    s2: subtask("s2", {
      stage: "shoot",
      startDate: today,
      assigneeIds: ["ed-alex"],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
  });
  const m = flags.find(f => f.kind === "multipleUntimedShoots" && f.personId === "ed-alex");
  assert.ok(m, "expected multipleUntimedShoots flag");
});

test("detectFlags: multipleUntimedShoots does NOT fire on 1 untimed shoot", () => {
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      assigneeIds: ["ed-alex"],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
  });
  assert.equal(flags.filter(f => f.kind === "multipleUntimedShoots").length, 0);
});

test("detectFlags: offDayAssigned fires when editor off but assigned", () => {
  // Saturday: weekday Sat is "off" by default (no key).
  const luke = { ...editorLuke, defaultDays: { mon: false, tue: true } };
  const p = project("p", "socialOrganic", {
    e1: subtask("e1", {
      stage: "edit",
      startDate: "2026-05-11", // Monday
      assigneeIds: ["ed-luke"],
      _estHours: 3.5,
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors: [luke], weekData: {}, date: "2026-05-11",
  });
  const oda = flags.find(f => f.kind === "offDayAssigned" && f.personId === "ed-luke");
  assert.ok(oda, "expected offDayAssigned flag for Luke");
});

test("detectFlags: capacity bands fire correctly", () => {
  // Idle: 0h (no subtasks)
  let flags = detectFlags({
    projects: {}, editors: [editorAlex], weekData: {}, date: today,
  });
  assert.ok(flags.find(f => f.kind === "inOfficeIdle" && f.personId === "ed-alex"),
    "expected idle for Alex");

  // Under: 3h (below 4h underMax)
  let p = project("p", "socialOrganic", {
    e1: subtask("e1", {
      stage: "shoot",
      startDate: today,
      startTime: "10:00", endTime: "13:00",
      assigneeIds: ["ed-alex"],
    }),
  });
  flags = detectFlags({ projects: { p }, editors: [editorAlex], weekData: {}, date: today });
  const under = flags.find(f => f.kind === "dailyUnderCapacity" && f.personId === "ed-alex");
  assert.ok(under, "expected dailyUnderCapacity at 3h");
  assert.equal(under.plannedHours, 3);

  // Healthy: 6h (between 4 and 8)
  p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      startTime: "10:00", endTime: "16:00", // 6h
      assigneeIds: ["ed-alex"],
    }),
  });
  flags = detectFlags({ projects: { p }, editors: [editorAlex], weekData: {}, date: today });
  assert.equal(flags.filter(f => f.personId === "ed-alex" && f.kind?.startsWith("daily")).length, 0,
    "no daily flag at healthy 6h");
  assert.equal(flags.filter(f => f.kind === "inOfficeIdle" && f.personId === "ed-alex").length, 0,
    "not idle at healthy 6h");

  // Warning: 9h (between 8 and 10)
  p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      startTime: "08:00", endTime: "17:00", // 9h
      assigneeIds: ["ed-alex"],
    }),
  });
  flags = detectFlags({ projects: { p }, editors: [editorAlex], weekData: {}, date: today });
  assert.ok(flags.find(f => f.kind === "dailyOverCapacity" && f.personId === "ed-alex"),
    "expected dailyOverCapacity at 9h");

  // Hard: 12h (above 10)
  p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      startTime: "06:00", endTime: "18:00", // 12h
      assigneeIds: ["ed-alex"],
    }),
  });
  flags = detectFlags({ projects: { p }, editors: [editorAlex], weekData: {}, date: today });
  assert.ok(flags.find(f => f.kind === "dailyHardOverCapacity" && f.personId === "ed-alex"),
    "expected dailyHardOverCapacity at 12h");
});

test("detectFlags: capacity flags only apply to editors (not crew)", () => {
  // Steve is crew. He has nothing assigned today. Crew should NOT
  // get inOfficeIdle.
  const flags = detectFlags({
    projects: {}, editors: [crewSteve], weekData: {}, date: today,
  });
  assert.equal(flags.filter(f => f.personId === "ed-steve").length, 0,
    "crew should not get capacity flags");
});

test("detectFlags: weekDataMismatch fires bidirectionally", () => {
  // Direction A: weekData says shoot, no shoot subtask.
  const wkKey = "2026-05-11"; // Monday of today's week
  let weekData = {
    [wkKey]: {
      editors: [{ id: "ed-alex", days: { mon: false, tue: false, wed: "shoot" } }],
    },
  };
  let flags = detectFlags({
    projects: {}, editors: [editorAlex], weekData, date: today,
  });
  const aFlag = flags.find(f => f.kind === "weekDataMismatch" && f.subkind === "shootInWeekDataNoSubtask");
  assert.ok(aFlag, "expected shootInWeekDataNoSubtask");
  // Idle should be SUPPRESSED on this person/date because the mismatch took over.
  assert.equal(flags.filter(f => f.kind === "inOfficeIdle" && f.personId === "ed-alex").length, 0,
    "idle must be suppressed when weekData mismatch fires");

  // Direction B: shoot subtask exists but weekData != "shoot".
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      assigneeIds: ["ed-alex"],
    }),
  });
  weekData = {
    [wkKey]: {
      editors: [{ id: "ed-alex", days: { mon: true, tue: true, wed: "in" } }],
    },
  };
  flags = detectFlags({
    projects: { p }, editors: [editorAlex], weekData, date: today,
  });
  const bFlag = flags.find(f => f.kind === "weekDataMismatch" && f.subkind === "shootSubtaskNoWeekData");
  assert.ok(bFlag, "expected shootSubtaskNoWeekData");
});

test("detectFlags: unassignedScheduled fires when no assignees", () => {
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      assigneeIds: [],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
  });
  const u = flags.find(f => f.kind === "unassignedScheduled" && f.subtaskId === "s1");
  assert.ok(u, "expected unassignedScheduled flag");
});

test("detectFlags: editOverrun fires only with sufficient sample size", () => {
  const p = project("p", "socialOrganic", {
    e1: subtask("e1", {
      stage: "edit",
      startDate: today,
      status: "scheduled",
      assigneeIds: ["ed-alex"],
    }),
  });
  // 8 actual hours, average 3h, ratio = 2.67 > 1.5x threshold.
  const loggedHoursBySubtask = { e1: 8 };
  // Not enough samples → no flag.
  let flags = detectFlags({
    projects: { p }, editors: [editorAlex], weekData: {},
    videoTypeStats: { socialOrganic: { edit: { avgHours: 3, sampleCount: 2 } } },
    loggedHoursBySubtask, date: today,
  });
  assert.equal(flags.filter(f => f.kind === "editOverrun").length, 0,
    "no editOverrun with sampleCount < MIN_SAMPLE_SIZE");

  // Enough samples → flag fires.
  flags = detectFlags({
    projects: { p }, editors: [editorAlex], weekData: {},
    videoTypeStats: { socialOrganic: { edit: { avgHours: 3, sampleCount: MIN_SAMPLE_SIZE } } },
    loggedHoursBySubtask, date: today,
  });
  const eor = flags.find(f => f.kind === "editOverrun" && f.subtaskId === "e1");
  assert.ok(eor, "expected editOverrun");
  assert.ok(eor.ratio > OVERRUN_RATIO);
});

// ─── 4. detectFlagsForDateRange — dedupes across days ──────────────

test("detectFlagsForDateRange: dedupes same flag across days", () => {
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: "2026-05-11",
      endDate: "2026-05-12",
      assigneeIds: ["ed-alex"],
    }),
  });
  const flags = detectFlagsForDateRange({
    startDate: "2026-05-11", endDate: "2026-05-12",
    projects: { p }, editors: [editorAlex], weekData: {},
  });
  // The unassignedScheduled flag (if any) is non-day-scoped — should
  // dedupe to a single entry across the range.
  const u = flags.filter(f => f.kind === "unassignedScheduled");
  assert.ok(u.length <= 1, "unassignedScheduled should dedupe across range");
});

// ─── 5. computeVideoTypeStats — sample-size + completed-only ───────

test("computeVideoTypeStats: only counts done subtasks", () => {
  const projects = {
    p1: project("p1", "socialOrganic", {
      e1: subtask("e1", { stage: "edit", status: "done" }),
      e2: subtask("e2", { stage: "edit", status: "done" }),
      e3: subtask("e3", { stage: "edit", status: "done" }),
      e4: subtask("e4", { stage: "edit", status: "scheduled" }), // NOT done
    }),
  };
  const timeLogs = {
    "ed-alex": {
      "2026-05-01": {
        e1: { secs: 3 * 3600, stage: "edit" },
        e2: { secs: 4 * 3600, stage: "edit" },
        e3: { secs: 2 * 3600, stage: "edit" },
        e4: { secs: 10 * 3600, stage: "edit" }, // 10h on in-progress, must not count
      },
    },
  };
  const stats = computeVideoTypeStats(projects, timeLogs);
  // Average over 3 done subtasks: (3+4+2)/3 = 3h.
  assert.ok(stats.socialOrganic, "expected socialOrganic bucket");
  assert.equal(stats.socialOrganic.edit.sampleCount, 3);
  assert.equal(stats.socialOrganic.edit.avgHours, 3);
});

test("computeVideoTypeStats: omits stages below MIN_SAMPLE_SIZE", () => {
  const projects = {
    p1: project("p1", "metaAds", {
      e1: subtask("e1", { stage: "edit", status: "done" }),
      e2: subtask("e2", { stage: "edit", status: "done" }), // only 2 — under threshold
    }),
  };
  const timeLogs = {
    "ed-x": {
      "2026-05-01": {
        e1: { secs: 3600, stage: "edit" },
        e2: { secs: 7200, stage: "edit" },
      },
    },
  };
  const stats = computeVideoTypeStats(projects, timeLogs);
  // metaAds.edit should be absent (only 2 samples < MIN_SAMPLE_SIZE=3)
  assert.equal(stats.metaAds?.edit, undefined,
    "edit should be omitted with insufficient samples");
});

test("computeVideoTypeStats: per-stage sample count, not per-videoType", () => {
  // 5 done revisions, 1 done edit — only revisions should be valid.
  const projects = {
    p1: project("p1", "metaAds", {
      r1: subtask("r1", { stage: "revisions", status: "done" }),
      r2: subtask("r2", { stage: "revisions", status: "done" }),
      r3: subtask("r3", { stage: "revisions", status: "done" }),
      r4: subtask("r4", { stage: "revisions", status: "done" }),
      r5: subtask("r5", { stage: "revisions", status: "done" }),
      e1: subtask("e1", { stage: "edit", status: "done" }), // only 1 edit
    }),
  };
  const timeLogs = {
    "ed-x": {
      "2026-05-01": {
        r1: { secs: 3600, stage: "revisions" },
        r2: { secs: 3600, stage: "revisions" },
        r3: { secs: 3600, stage: "revisions" },
        r4: { secs: 3600, stage: "revisions" },
        r5: { secs: 3600, stage: "revisions" },
        e1: { secs: 5 * 3600, stage: "edit" },
      },
    },
  };
  const stats = computeVideoTypeStats(projects, timeLogs);
  assert.ok(stats.metaAds.revisions, "revisions should be present");
  assert.equal(stats.metaAds.edit, undefined, "edit should be absent");
});

// ─── 6. availability helpers ──────────────────────────────────────

test("isEditorInOnDate: defaultDays Mon-Fri", () => {
  const ed = { id: "x", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
  assert.equal(isEditorInOnDate(ed, new Date("2026-05-11"), {}), true); // Mon
  assert.equal(isEditorInOnDate(ed, new Date("2026-05-16"), {}), false); // Sat
});

test("isEditorInOnDate: weekData overrides defaultDays", () => {
  const ed = { id: "x", defaultDays: { mon: true } };
  const weekData = {
    "2026-05-11": { editors: [{ id: "x", days: { mon: false } }] },
  };
  assert.equal(isEditorInOnDate(ed, new Date("2026-05-11"), weekData), false);
});

test("isWorkingOnDate: shoot counts as working", () => {
  const ed = { id: "x", defaultDays: {} };
  const weekData = {
    "2026-05-11": { editors: [{ id: "x", days: { mon: "shoot" } }] },
  };
  assert.equal(isWorkingOnDate(ed, new Date("2026-05-11"), weekData), true);
  // But isEditorInOnDate (strict "in") returns false.
  assert.equal(isEditorInOnDate(ed, new Date("2026-05-11"), weekData), false);
});

test("datesInRange yields each day inclusive", () => {
  const days = [...datesInRange("2026-05-11", "2026-05-13")];
  assert.deepEqual(days, ["2026-05-11", "2026-05-12", "2026-05-13"]);
});

// ─── 7. diffHours sanity ──────────────────────────────────────────

test("diffHours: simple cases", () => {
  assert.equal(diffHours("10:00", "14:00"), 4);
  assert.equal(diffHours("09:30", "10:00"), 0.5);
  assert.equal(diffHours("14:00", "10:00"), 0); // negative -> 0
  assert.equal(diffHours("bad", "10:00"), 0);
});

// ─── 8. Actor-scope drag filter (the banner fixes from May 9 feedback) ─

test("detectFlags actor scope: drops unassignedScheduled flags", () => {
  // Project-wide unassigned subtasks are noise on a drag — they belong
  // on the daily digest, not the inline banner.
  const p = project("p", "liveAction", {
    s1: subtask("s1", { stage: "shoot", startDate: today, assigneeIds: [] }),
  });
  // Without scope: unassigned fires.
  let flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
  });
  assert.ok(flags.find(f => f.kind === "unassignedScheduled"),
    "unassignedScheduled should fire in 'all' scope");

  // With actor scope: dropped.
  flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
    scope: { kind: "actor", personId: "ed-alex", dateISO: today },
  });
  assert.equal(flags.filter(f => f.kind === "unassignedScheduled").length, 0,
    "unassignedScheduled should be dropped in actor scope");
});

test("detectFlags actor scope: drops past-date capacity flags", () => {
  // Capacity flags about yesterday aren't actionable. Drop them in
  // actor scope so producers don't get scolded about historical days.
  const yesterday = "2026-05-08";
  const p = project("p", "liveAction", {
    // 12h shoot on yesterday for Alex → would normally fire
    // dailyHardOverCapacity for Alex on 2026-05-08.
    s1: subtask("s1", {
      stage: "shoot",
      startDate: yesterday,
      startTime: "06:00",
      endTime: "18:00",
      assigneeIds: ["ed-alex"],
    }),
  });

  // Without actor scope: capacity flag fires.
  let flags = detectFlags({
    projects: { p }, editors: [editorAlex], weekData: {}, date: yesterday,
  });
  assert.ok(flags.find(f => f.kind === "dailyHardOverCapacity" && f.personId === "ed-alex"),
    "should fire without actor scope");

  // With actor scope + today=2026-05-09: dropped.
  flags = detectFlags({
    projects: { p }, editors: [editorAlex], weekData: {}, date: yesterday,
    scope: { kind: "actor", personId: "ed-alex", dateISO: yesterday, today: "2026-05-09" },
  });
  assert.equal(flags.filter(f => f.kind === "dailyHardOverCapacity").length, 0,
    "past-date capacity flag should be dropped in actor scope");
});

test("detectFlags actor scope: keeps capacity flags for today + future", () => {
  // Sanity check the date filter: TODAY's over-capacity still fires.
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot",
      startDate: today,
      startTime: "06:00",
      endTime: "18:00", // 12h
      assigneeIds: ["ed-alex"],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors: [editorAlex], weekData: {}, date: today,
    scope: { kind: "actor", personId: "ed-alex", dateISO: today, today },
  });
  assert.ok(flags.find(f => f.kind === "dailyHardOverCapacity"),
    "today's over-capacity should still fire in actor scope");
});

test("detectFlags actor scope: personIds[] surfaces conflicts on every assignee", () => {
  // Codex P1 #4 — multi-assignee shoots need every crew member's
  // conflicts surfaced. Steve (assignee #2) is double-booked; the drag
  // check used to scope to assigneeIds[0] only and would miss this.
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot", startDate: today,
      startTime: "09:00", endTime: "12:00",
      assigneeIds: ["ed-alex", "ed-steve"],
    }),
    s2: subtask("s2", {
      stage: "shoot", startDate: today,
      startTime: "10:00", endTime: "13:00",
      assigneeIds: ["ed-steve"], // Steve overlaps with himself
    }),
  });

  // Single-personId scope (legacy, primary assignee only) → misses
  // Steve's conflict.
  const aliceOnly = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
    scope: { kind: "actor", personId: "ed-alex", dateISO: today, today },
  });
  assert.equal(
    aliceOnly.filter(f => f.kind === "fixedTimeConflict" && f.personId === "ed-steve").length,
    0,
    "single-personId scope should not surface Steve's conflict",
  );

  // personIds[] scope (multi-assignee) → catches Steve.
  const both = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
    scope: { kind: "actor", personIds: ["ed-alex", "ed-steve"], dateISO: today, today },
  });
  assert.ok(
    both.find(f => f.kind === "fixedTimeConflict" && f.personId === "ed-steve"),
    "personIds[] scope should surface Steve's overlap",
  );
});

test("detectFlags actor scope: personIds[] still drops unrelated people", () => {
  // The scope filter must remain restrictive — flags about people NOT
  // in the personIds list should still be dropped.
  const p = project("p", "liveAction", {
    s1: subtask("s1", {
      stage: "shoot", startDate: today,
      startTime: "09:00", endTime: "12:00",
      assigneeIds: ["ed-luke"],
    }),
    s2: subtask("s2", {
      stage: "shoot", startDate: today,
      startTime: "10:00", endTime: "13:00",
      assigneeIds: ["ed-luke"],
    }),
  });
  const flags = detectFlags({
    projects: { p }, editors, weekData: {}, date: today,
    scope: { kind: "actor", personIds: ["ed-alex", "ed-steve"], dateISO: today, today },
  });
  assert.equal(
    flags.filter(f => f.personId === "ed-luke").length,
    0,
    "Luke's conflicts should be filtered out when personIds is [alex, steve]",
  );
});

// ─── 9. enrichFlagsForDisplay ─────────────────────────────────────

test("enrichFlagsForDisplay adds personName / projectName / clientName / subtaskName", () => {
  const projects = {
    "proj-1": {
      projectName: "Q3 Brand Refresh",
      clientName: "Emesent",
      subtasks: {
        "st-shoot": { id: "st-shoot", name: "Shoot", stage: "shoot" },
      },
    },
  };
  const editorsRich = [{ id: "ed-alex", name: "Alex", role: "editor", defaultDays: {} }];

  const rawFlags = [
    {
      kind: "fixedTimeConflict",
      personId: "ed-alex",
      date: "2026-05-13",
      subtasks: [{ subtaskId: "st-shoot", name: "Shoot" }],
    },
    { kind: "dailyHardOverCapacity", personId: "ed-alex", date: "2026-05-13", plannedHours: 12 },
    { kind: "unassignedScheduled", projectId: "proj-1", subtaskId: "st-shoot", startDate: "2026-05-13", stage: "shoot" },
  ];

  const enriched = enrichFlagsForDisplay(rawFlags, { projects, editors: editorsRich });

  assert.equal(enriched[0].personName, "Alex", "personName resolved");
  assert.equal(enriched[0].subtasks[0].clientName, "Emesent", "subtask client name");
  assert.equal(enriched[0].subtasks[0].projectName, "Q3 Brand Refresh", "subtask project name");
  assert.equal(enriched[0].subtasks[0].subtaskName, "Shoot", "subtask name");

  assert.equal(enriched[1].personName, "Alex");
  assert.ok(!enriched[1].projectName, "no project on a person-only flag");

  assert.equal(enriched[2].clientName, "Emesent");
  assert.equal(enriched[2].projectName, "Q3 Brand Refresh");
  assert.equal(enriched[2].subtaskName, "Shoot");
});

test("enrichFlagsForDisplay falls back gracefully when names missing", () => {
  // Stale flag pointing at a deleted project / unknown editor — no crash.
  const enriched = enrichFlagsForDisplay(
    [{ kind: "inOfficeIdle", personId: "ed-ghost", date: "2026-05-13" }],
    { projects: {}, editors: [] },
  );
  assert.equal(enriched[0].personName, "ed-ghost", "falls back to id when no editor record");
});

test("enrichFlagsForDisplay doesn't change fingerprint", () => {
  // Adding presentational fields must not affect dedup keys.
  const flag = { kind: "inOfficeIdle", personId: "ed-alex", date: "2026-05-13" };
  const beforeFp = fingerprintFlag(flag);
  const enriched = enrichFlagsForDisplay([flag], { projects: {}, editors: [editorAlex] });
  const afterFp = fingerprintFlag(enriched[0]);
  assert.equal(beforeFp, afterFp, "fingerprint unchanged after enrichment");
});

console.log(`\n${passed} tests passed`);
