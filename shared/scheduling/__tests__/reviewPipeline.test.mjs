// Unit tests for the internal-review pipeline helpers (Phase 4).
// Run via:  node shared/scheduling/__tests__/reviewPipeline.test.mjs
// 2026-05-25 = Monday, 2026-05-30/31 = Sat/Sun, 2026-06-01 = Monday.

import assert from "node:assert/strict";
import { isVideoEditSubtask, projectEditsAllFinished, earliestCommonAvailableDay } from "../reviewPipeline.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
}

test("isVideoEditSubtask: needs videoId + edit + not reformat", () => {
  assert.equal(isVideoEditSubtask({ videoId: "v1", stage: "edit" }), true);
  assert.equal(isVideoEditSubtask({ videoId: "v1", name: "Edit" }), true); // legacy no-stage
  assert.equal(isVideoEditSubtask({ stage: "edit" }), false);              // no videoId
  assert.equal(isVideoEditSubtask({ videoId: "v1", stage: "shoot" }), false);
  assert.equal(isVideoEditSubtask({ videoId: "v1", stage: "edit", reformatOfSubtaskId: "m1" }), false); // reformat
});

test("projectEditsAllFinished: all video edits done", () => {
  const p = { subtasks: {
    a: { id: "a", videoId: "v1", stage: "edit", status: "done" },
    b: { id: "b", videoId: "v2", stage: "edit", status: "done" },
    pre: { id: "pre", stage: "preProduction", status: "stuck" }, // ignored (not video edit)
  } };
  assert.equal(projectEditsAllFinished(p), true);
});

test("projectEditsAllFinished: false if any video edit not done", () => {
  const p = { subtasks: {
    a: { id: "a", videoId: "v1", stage: "edit", status: "done" },
    b: { id: "b", videoId: "v2", stage: "edit", status: "inProgress" },
  } };
  assert.equal(projectEditsAllFinished(p), false);
});

test("projectEditsAllFinished: false with zero video edits", () => {
  const p = { subtasks: { pre: { id: "pre", stage: "preProduction", status: "done" } } };
  assert.equal(projectEditsAllFinished(p), false);
});

test("projectEditsAllFinished: reformats don't gate the review", () => {
  const p = { subtasks: {
    a: { id: "a", videoId: "v1", stage: "edit", status: "done" },
    r: { id: "r", videoId: "v1", stage: "edit", status: "stuck", reformatOfSubtaskId: "a" }, // reformat, ignored
  } };
  assert.equal(projectEditsAllFinished(p), true);
});

const ed = (id, days) => ({ id, name: id, defaultDays: days });
const allWeek = { mon: true, tue: true, wed: true, thu: true, fri: true };

test("earliestCommonAvailableDay: all working same weekday", () => {
  const editors = [ed("a", allWeek), ed("b", allWeek)];
  // from Mon 2026-05-25 → all work Monday → 2026-05-25
  assert.equal(earliestCommonAvailableDay(["a", "b"], editors, {}, "2026-05-25"), "2026-05-25");
});

test("earliestCommonAvailableDay: skips a day someone's off", () => {
  const editors = [ed("a", allWeek), ed("b", { mon: false, tue: true, wed: true, thu: true, fri: true })];
  // b off Monday → first common day is Tue 2026-05-26
  assert.equal(earliestCommonAvailableDay(["a", "b"], editors, {}, "2026-05-25"), "2026-05-26");
});

test("earliestCommonAvailableDay: skips weekend to Monday", () => {
  const editors = [ed("a", allWeek), ed("b", allWeek)];
  // from Fri 2026-05-29: Fri works → returns Fri (everyone in). Use Sat start to test skip.
  assert.equal(earliestCommonAvailableDay(["a", "b"], editors, {}, "2026-05-30"), "2026-06-01");
});

test("earliestCommonAvailableDay: empty attendees → null", () => {
  assert.equal(earliestCommonAvailableDay([], [ed("a", allWeek)], {}, "2026-05-25"), null);
});

test("earliestCommonAvailableDay: skips a SHOOT day (don't book over a shoot)", () => {
  const editors = [ed("a", allWeek), ed("b", allWeek)];
  // weekData marks editor a as on a SHOOT Monday 2026-05-25 → that day is
  // not "in", so the helper must skip to Tue 2026-05-26. (A weekData entry
  // is authoritative for the whole week, so set every weekday.)
  const weekData = { "2026-05-25": { editors: [{ id: "a", days: { mon: "shoot", tue: "in", wed: "in", thu: "in", fri: "in" } }] } };
  assert.equal(earliestCommonAvailableDay(["a", "b"], editors, weekData, "2026-05-25"), "2026-05-26");
});

console.log(`\n${passed} passed`);
