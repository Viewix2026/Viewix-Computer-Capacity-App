// Unit tests for the Selects-timeline automation (Phase 2 / feature #3).
// Run via:  node shared/scheduling/__tests__/selects.test.mjs
// Pure Node, no test runner — assertions throw, green summary on success.
//
// Calendar anchors (verified): 2026-05-25 = Monday, 2026-05-29 = Friday,
// 2026-06-01 = Monday.

import assert from "node:assert/strict";
import { computeSelectsTimelineWrites, isSelectsSubtask } from "../selects.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const lead = { id: "ed-lead", name: "Lead", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
const other = { id: "ed-other", name: "Other", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } };
const editors = [lead, other];

function projectWith(shootDate, selectsExtra = {}, shootExtra = {}) {
  return {
    id: "p1",
    subtasks: {
      "s-shoot": { id: "s-shoot", name: "Shoot", stage: "shoot", startDate: shootDate, ...shootExtra },
      "s-sel": { id: "s-sel", name: "Selects timeline + kick off video", stage: "edit", status: "stuck", ...selectsExtra },
    },
  };
}
const findWrite = (writes, suffix) => writes.find(w => w.path.endsWith(suffix))?.value;

test("isSelectsSubtask matches by name", () => {
  assert.equal(isSelectsSubtask({ name: "Selects timeline + kick off video" }), true);
  assert.equal(isSelectsSubtask({ name: "Edit" }), false);
});

test("no shoot date → noop", () => {
  const r = computeSelectsTimelineWrites(projectWith(null), { editors, leadId: "ed-lead" });
  assert.equal(r.noop, true);
  assert.equal(r.reason, "no_shoot_date");
});

test("selects already done → noop", () => {
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25", { status: "done" }), { editors, leadId: "ed-lead" });
  assert.equal(r.noop, true);
  assert.equal(r.reason, "selects_done");
});

test("weekday happy path → shoot+1, lead-assigned, scheduled, priority 1", () => {
  // Shoot Mon 2026-05-25 → Selects Tue 2026-05-26.
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors, weekData: {}, leadId: "ed-lead", allProjects: [] });
  assert.ok(r.writes, "expected writes");
  assert.equal(r.selectsDate, "2026-05-26");
  assert.equal(r.assigneeId, "ed-lead");
  assert.equal(findWrite(r.writes, "/startDate"), "2026-05-26");
  assert.equal(findWrite(r.writes, "/endDate"), "2026-05-26");
  assert.equal(findWrite(r.writes, "/status"), "scheduled");
  assert.deepEqual(findWrite(r.writes, "/assigneeIds"), ["ed-lead"]);
  assert.equal(findWrite(r.writes, `/dayPriority/ed-lead|2026-05-26`), 1);
  assert.equal(findWrite(r.writes, "/selectsAutoManaged"), true);
  assert.equal(findWrite(r.writes, "/selectsLinkedShootDate"), "2026-05-25");
});

test("weekend push → shoot Fri, Selects skips Sat to Mon", () => {
  // Shoot Fri 2026-05-29 → +1 = Sat → push to Mon 2026-06-01.
  const r = computeSelectsTimelineWrites(projectWith("2026-05-29"), { editors, weekData: {}, leadId: "ed-lead", allProjects: [] });
  assert.ok(r.writes, "expected writes");
  assert.equal(r.selectsDate, "2026-06-01");
});

test("lead off that day → needsPicker with candidates", () => {
  const leadOffTue = { id: "ed-lead", name: "Lead", defaultDays: { mon: true, tue: false, wed: true, thu: true, fri: true } };
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors: [leadOffTue, other], weekData: {}, leadId: "ed-lead", allProjects: [] });
  assert.equal(r.needsPicker, true);
  assert.equal(r.reason, "lead_off");
  assert.ok(r.candidates.includes("ed-other"), "other (working Tue) should be a candidate");
  assert.ok(!r.candidates.includes("ed-lead"), "lead (off Tue) should not be a candidate");
});

test("lead has another shoot that day → needsPicker", () => {
  const otherProject = {
    id: "p2",
    subtasks: { x: { id: "x", stage: "shoot", startDate: "2026-05-26", assigneeIds: ["ed-lead"] } },
  };
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors, weekData: {}, leadId: "ed-lead", allProjects: [otherProject] });
  assert.equal(r.needsPicker, true);
  assert.equal(r.reason, "lead_has_shoot");
});

test("override assignee (picker choice) → writes to that person", () => {
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors, weekData: {}, leadId: "ed-lead", overrideAssigneeId: "ed-other", allProjects: [] });
  assert.ok(r.writes, "expected writes");
  assert.equal(r.assigneeId, "ed-other");
  assert.equal(findWrite(r.writes, `/dayPriority/ed-other|2026-05-26`), 1);
});

test("no lead resolvable → needsPicker", () => {
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors, weekData: {}, leadId: null, allProjects: [] });
  assert.equal(r.needsPicker, true);
  assert.equal(r.reason, "no_lead");
});

test("priority: takes #1 when the day is free", () => {
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors, weekData: {}, leadId: "ed-lead", allProjects: [] });
  assert.equal(findWrite(r.writes, `/dayPriority/ed-lead|2026-05-26`), 1);
});

test("priority: appends (max+1) when something already holds #1", () => {
  const sibling = { id: "p9", subtasks: {
    a: { id: "a", dayPriority: { "ed-lead|2026-05-26": 1 } },
    b: { id: "b", dayPriority: { "ed-lead|2026-05-26": 2 } },
  } };
  const r = computeSelectsTimelineWrites(projectWith("2026-05-25"), { editors, weekData: {}, leadId: "ed-lead", allProjects: [sibling] });
  assert.ok(r.writes, "expected writes");
  assert.equal(findWrite(r.writes, `/dayPriority/ed-lead|2026-05-26`), 3); // max(2)+1, does not displace #1
});

console.log(`\n${passed} passed`);
