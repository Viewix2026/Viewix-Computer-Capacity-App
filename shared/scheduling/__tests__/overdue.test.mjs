// Unit tests for Phase 3 overdue / behind-schedule helpers.
// Run via:  node shared/scheduling/__tests__/overdue.test.mjs

import assert from "node:assert/strict";
import {
  effectiveDueDate, isActiveProject, isEditStage,
  isOverdueEdit, isUnfinishedPastEdit, isBehindScheduleFlagged, latestShootDate,
} from "../overdue.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const activeProj = (subtasks, extra = {}) => ({ id: "p1", commissioned: true, status: "active", subtasks, ...extra });

test("effectiveDueDate: manual dueDate wins", () => {
  const p = activeProj({}, { dueDate: "2026-06-30" });
  // even with a shoot, manual wins
  p.subtasks = { s: { id: "s", stage: "shoot", startDate: "2026-05-01" } };
  assert.equal(effectiveDueDate(p), "2026-06-30");
});

test("effectiveDueDate: blank → lastShoot + 14d", () => {
  const p = activeProj({ s: { id: "s", stage: "shoot", startDate: "2026-05-25" } });
  assert.equal(effectiveDueDate(p), "2026-06-08"); // +14 days
});

test("effectiveDueDate: latest of multiple shoots", () => {
  const p = activeProj({
    a: { id: "a", stage: "shoot", startDate: "2026-05-01" },
    b: { id: "b", stage: "shoot", startDate: "2026-05-20" },
  });
  assert.equal(latestShootDate(p), "2026-05-20");
  assert.equal(effectiveDueDate(p), "2026-06-03");
});

test("isActiveProject: commissioned + not done/archived", () => {
  assert.equal(isActiveProject({ commissioned: true, status: "active" }), true);
  assert.equal(isActiveProject({ commissioned: false, status: "active" }), false);
  assert.equal(isActiveProject({ commissioned: true, status: "done" }), false);
  assert.equal(isActiveProject({ commissioned: true, status: "archived" }), false);
  assert.equal(isActiveProject({ status: "active" }), true); // commissioned undefined → active
});

test("isEditStage", () => {
  assert.equal(isEditStage({ stage: "edit" }), true);
  assert.equal(isEditStage({ stage: "shoot" }), false);
  assert.equal(isEditStage({ name: "Edit — Video 1" }), true);
  assert.equal(isEditStage({ name: "Pre Production" }), false);
});

test("isOverdueEdit: edit beyond due date (proactive)", () => {
  const p = activeProj({
    shoot: { id: "shoot", stage: "shoot", startDate: "2026-05-25" }, // due = 2026-06-08
    e1: { id: "e1", stage: "edit", status: "scheduled", startDate: "2026-06-20" }, // past due
    e2: { id: "e2", stage: "edit", status: "scheduled", startDate: "2026-06-01" }, // before due
  });
  assert.equal(isOverdueEdit(p.subtasks.e1, p), true);
  assert.equal(isOverdueEdit(p.subtasks.e2, p), false);
});

test("isOverdueEdit: done edit is never overdue", () => {
  const p = activeProj({
    shoot: { id: "shoot", stage: "shoot", startDate: "2026-05-25" },
    e1: { id: "e1", stage: "edit", status: "done", startDate: "2026-06-20" },
  });
  assert.equal(isOverdueEdit(p.subtasks.e1, p), false);
});

test("isOverdueEdit: inactive project → false", () => {
  const p = { id: "p", commissioned: false, status: "active", subtasks: {
    shoot: { id: "shoot", stage: "shoot", startDate: "2026-05-25" },
    e1: { id: "e1", stage: "edit", status: "scheduled", startDate: "2026-06-20" },
  } };
  assert.equal(isOverdueEdit(p.subtasks.e1, p), false);
});

test("isUnfinishedPastEdit: scheduled/inProgress past today", () => {
  const today = "2026-05-25";
  const p = activeProj({
    a: { id: "a", stage: "edit", status: "scheduled", startDate: "2026-05-24" },   // past
    b: { id: "b", stage: "edit", status: "inProgress", startDate: "2026-05-24" },  // past
    c: { id: "c", stage: "edit", status: "scheduled", startDate: "2026-05-26" },   // future
    d: { id: "d", stage: "edit", status: "stuck", startDate: "2026-05-24" },       // stuck excluded
    e: { id: "e", stage: "edit", status: "onHold", startDate: "2026-05-24" },      // excluded
    f: { id: "f", stage: "edit", status: "waitingClient", startDate: "2026-05-24" },// excluded
    g: { id: "g", stage: "edit", status: "done", startDate: "2026-05-24" },        // done
  });
  assert.equal(isUnfinishedPastEdit(p.subtasks.a, p, today), true);
  assert.equal(isUnfinishedPastEdit(p.subtasks.b, p, today), true);
  assert.equal(isUnfinishedPastEdit(p.subtasks.c, p, today), false);
  assert.equal(isUnfinishedPastEdit(p.subtasks.d, p, today), false);
  assert.equal(isUnfinishedPastEdit(p.subtasks.e, p, today), false);
  assert.equal(isUnfinishedPastEdit(p.subtasks.f, p, today), false);
  assert.equal(isUnfinishedPastEdit(p.subtasks.g, p, today), false);
});

test("isBehindScheduleFlagged: flag + not done", () => {
  assert.equal(isBehindScheduleFlagged({ behindSchedule: true, status: "inProgress" }), true);
  assert.equal(isBehindScheduleFlagged({ behindSchedule: true, status: "done" }), false);
  assert.equal(isBehindScheduleFlagged({ status: "inProgress" }), false);
});

console.log(`\n${passed} passed`);
