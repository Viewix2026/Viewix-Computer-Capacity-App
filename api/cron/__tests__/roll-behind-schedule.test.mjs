// Unit tests for the behind-schedule roll-over cron's pure update builder
// (Codex round 2 #3 — the priority bump/move construction was untested).
// Run via:  node api/cron/__tests__/roll-behind-schedule.test.mjs

import assert from "node:assert/strict";
import { buildRollUpdates } from "../roll-behind-schedule.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const NOW = "2026-05-26T00:00:00.000Z";
const move = (projectId, subtaskId, editorId, toDate, fromDate) => ({ projectId, subtaskId, editorId, toDate, fromDate });

test("empty moves → empty object", () => {
  assert.deepEqual(buildRollUpdates([], [], NOW), {});
});

test("single move: 1-day move + priority 1 + flag", () => {
  const u = buildRollUpdates([move("p1", "s1", "ed-a", "2026-05-26", "2026-05-25")], [], NOW);
  assert.equal(u["projects/p1/subtasks/s1/startDate"], "2026-05-26");
  assert.equal(u["projects/p1/subtasks/s1/endDate"], "2026-05-26"); // never widened
  assert.equal(u["projects/p1/subtasks/s1/dayPriority/ed-a|2026-05-26"], 1);
  assert.equal(u["projects/p1/subtasks/s1/behindSchedule"], true);
  assert.equal(u["projects/p1/subtasks/s1/rolledFromDate"], "2026-05-25");
  assert.equal(u["projects/p1/subtasks/s1/updatedAt"], NOW);
});

test("bumps an existing sibling holding #1 down to #2", () => {
  const projects = [{ id: "p1", subtasks: {
    s9: { id: "s9", dayPriority: { "ed-a|2026-05-26": 1 } },
  } }];
  const u = buildRollUpdates([move("p1", "s1", "ed-a", "2026-05-26", "2026-05-25")], projects, NOW);
  assert.equal(u["projects/p1/subtasks/s1/dayPriority/ed-a|2026-05-26"], 1); // rolled edit takes #1
  assert.equal(u["projects/p1/subtasks/s9/dayPriority/ed-a|2026-05-26"], 2); // existing bumped by k=1
});

test("two edits rolled to same editor+day take 1,2; existing #1 bumped to #3", () => {
  const projects = [{ id: "p1", subtasks: {
    s9: { id: "s9", dayPriority: { "ed-a|2026-05-26": 1 } },
  } }];
  const moves = [
    move("p1", "s1", "ed-a", "2026-05-26", "2026-05-24"),
    move("p2", "s2", "ed-a", "2026-05-26", "2026-05-25"),
  ];
  const u = buildRollUpdates(moves, projects, NOW);
  assert.equal(u["projects/p1/subtasks/s1/dayPriority/ed-a|2026-05-26"], 1);
  assert.equal(u["projects/p2/subtasks/s2/dayPriority/ed-a|2026-05-26"], 2);
  assert.equal(u["projects/p1/subtasks/s9/dayPriority/ed-a|2026-05-26"], 3); // bumped by k=2
});

test("does not bump priorities on a different editor/day", () => {
  const projects = [{ id: "p1", subtasks: {
    s9: { id: "s9", dayPriority: { "ed-b|2026-05-26": 1, "ed-a|2026-05-27": 1 } },
  } }];
  const u = buildRollUpdates([move("p1", "s1", "ed-a", "2026-05-26", "2026-05-25")], projects, NOW);
  assert.equal(u["projects/p1/subtasks/s9/dayPriority/ed-b|2026-05-26"], undefined);
  assert.equal(u["projects/p1/subtasks/s9/dayPriority/ed-a|2026-05-27"], undefined);
});

test("does not bump the moved subtask itself", () => {
  // s1 already had a priority on the target day; it should be set to 1
  // (the rolled value), not bumped as a sibling.
  const projects = [{ id: "p1", subtasks: {
    s1: { id: "s1", dayPriority: { "ed-a|2026-05-26": 5 } },
  } }];
  const u = buildRollUpdates([move("p1", "s1", "ed-a", "2026-05-26", "2026-05-25")], projects, NOW);
  assert.equal(u["projects/p1/subtasks/s1/dayPriority/ed-a|2026-05-26"], 1);
});

console.log(`\n${passed} passed`);
