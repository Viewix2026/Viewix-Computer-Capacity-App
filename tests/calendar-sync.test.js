// tests/calendar-sync.test.js
// Pure-function unit tests for the calendar sync utilities.
// Run with `npm test` — uses Node's built-in `node:test`, no
// external runner needed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  eventIdFor,
  combineDateTimeSydney,
  compareSydneyDateTimes,
  computeBackoff,
  getCalendarSyncDecision,
} from "../api/_calendar-utils.js";

// ─── eventIdFor ────────────────────────────────────────────────────

test("eventIdFor is deterministic for the same inputs", () => {
  const a = eventIdFor("proj-1", "sub-1");
  const b = eventIdFor("proj-1", "sub-1");
  assert.equal(a, b);
});

test("eventIdFor returns valid base32hex 26 chars", () => {
  const id = eventIdFor("proj-1", "sub-1");
  assert.equal(id.length, 26);
  // Google's base32hex alphabet: 0-9 and a-v only.
  assert.match(id, /^[0-9a-v]{26}$/);
});

test("eventIdFor differs across inputs", () => {
  const a = eventIdFor("proj-1", "sub-1");
  const b = eventIdFor("proj-1", "sub-2");
  const c = eventIdFor("proj-2", "sub-1");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

// ─── combineDateTimeSydney ─────────────────────────────────────────

test("combineDateTimeSydney returns the canonical wall-clock string", () => {
  assert.equal(combineDateTimeSydney("2026-06-01", "09:00"), "2026-06-01T09:00:00");
  assert.equal(combineDateTimeSydney("2026-12-25", "17:30"), "2026-12-25T17:30:00");
});

test("combineDateTimeSydney accepts HH:MM:SS but normalises seconds to :00", () => {
  assert.equal(combineDateTimeSydney("2026-06-01", "09:00:45"), "2026-06-01T09:00:00");
});

test("combineDateTimeSydney returns null for invalid inputs", () => {
  assert.equal(combineDateTimeSydney("", "09:00"), null);
  assert.equal(combineDateTimeSydney("2026-06-01", ""), null);
  assert.equal(combineDateTimeSydney("2026/06/01", "09:00"), null);
  assert.equal(combineDateTimeSydney("2026-06-01", "9am"), null);
  assert.equal(combineDateTimeSydney(null, null), null);
});

test("combineDateTimeSydney does NOT call new Date()", () => {
  // Vercel's server is UTC. If the helper ever calls new Date(...)
  // and serialises, the wall-clock string would silently shift.
  // Stub global Date and confirm the helper doesn't touch it.
  const realDate = global.Date;
  let invoked = false;
  function StubDate(...args) {
    invoked = true;
    return new realDate(...args);
  }
  StubDate.now = () => { invoked = true; return realDate.now(); };
  StubDate.parse = (...args) => { invoked = true; return realDate.parse(...args); };
  StubDate.UTC = (...args) => { invoked = true; return realDate.UTC(...args); };
  // eslint-disable-next-line no-global-assign
  global.Date = StubDate;
  try {
    const out = combineDateTimeSydney("2026-06-01", "09:00");
    assert.equal(out, "2026-06-01T09:00:00");
    assert.equal(invoked, false, "combineDateTimeSydney must not invoke global Date");
  } finally {
    // eslint-disable-next-line no-global-assign
    global.Date = realDate;
  }
});

// ─── compareSydneyDateTimes ────────────────────────────────────────

test("compareSydneyDateTimes orders the canonical strings", () => {
  assert.equal(compareSydneyDateTimes("2026-06-01T09:00:00", "2026-06-01T17:00:00"), -1);
  assert.equal(compareSydneyDateTimes("2026-06-01T17:00:00", "2026-06-01T09:00:00"), 1);
  assert.equal(compareSydneyDateTimes("2026-06-01T09:00:00", "2026-06-01T09:00:00"), 0);
});

test("compareSydneyDateTimes handles multi-day spans", () => {
  // Overnight shoot — 5pm Mon → 10am Tue is a positive duration.
  const start = combineDateTimeSydney("2026-06-01", "17:00");
  const end   = combineDateTimeSydney("2026-06-02", "10:00");
  assert.equal(compareSydneyDateTimes(end, start), 1);
});

// ─── computeBackoff ────────────────────────────────────────────────

test("computeBackoff follows the 1m/5m/15m/1h/6h ladder", () => {
  assert.equal(computeBackoff(1), 60_000);
  assert.equal(computeBackoff(2), 300_000);
  assert.equal(computeBackoff(3), 900_000);
  assert.equal(computeBackoff(4), 3_600_000);
  assert.equal(computeBackoff(5), 21_600_000);
});

test("computeBackoff caps at 6h for attempts > 5", () => {
  assert.equal(computeBackoff(6), 21_600_000);
  assert.equal(computeBackoff(100), 21_600_000);
});

// ─── getCalendarSyncDecision ───────────────────────────────────────

const validSubtask = {
  id: "s1",
  stage: "shoot",
  startDate: "2026-06-01",
  endDate: "2026-06-01",
  startTime: "09:00",
  endTime: "17:00",
  assigneeIds: ["editor-1"],
  syncToCalendar: true,
};
const validProject = {
  id: "p1",
  clientContact: { email: "client@example.com" },
};

test("decision: valid shoot → sync", () => {
  const d = getCalendarSyncDecision({ subtask: validSubtask, project: validProject });
  assert.equal(d.action, "sync");
});

test("decision: missing subtask → delete (subtask-missing)", () => {
  const d = getCalendarSyncDecision({ subtask: null, project: validProject });
  assert.equal(d.action, "delete");
  assert.equal(d.reason, "subtask-missing");
});

test("decision: syncToCalendar=false → delete (toggle-off)", () => {
  const d = getCalendarSyncDecision({
    subtask: { ...validSubtask, syncToCalendar: false },
    project: validProject,
  });
  assert.equal(d.action, "delete");
  assert.equal(d.reason, "toggle-off");
});

test("decision: stage moved away from shoot → delete", () => {
  const d = getCalendarSyncDecision({
    subtask: { ...validSubtask, stage: "edit" },
    project: validProject,
  });
  assert.equal(d.action, "delete");
  assert.equal(d.reason, "stage-not-shoot");
  assert.equal(d.sendUpdates, "all");
});

test("decision: dates cleared → delete (unscheduled)", () => {
  const d = getCalendarSyncDecision({
    subtask: { ...validSubtask, startDate: null, endDate: null },
    project: validProject,
  });
  assert.equal(d.action, "delete");
  assert.equal(d.reason, "unscheduled");
});

test("decision: empty assigneeIds → delete (no-assignees)", () => {
  const d = getCalendarSyncDecision({
    subtask: { ...validSubtask, assigneeIds: [] },
    project: validProject,
  });
  assert.equal(d.action, "delete");
  assert.equal(d.reason, "no-assignees");
});

test("decision: missing times → hold-error (NOT delete)", () => {
  const d = getCalendarSyncDecision({
    subtask: { ...validSubtask, startTime: null, endTime: null },
    project: validProject,
  });
  assert.equal(d.action, "hold-error");
  assert.match(d.message, /times required/i);
});

test("decision: end before start same-day → hold-error", () => {
  const d = getCalendarSyncDecision({
    subtask: {
      ...validSubtask,
      startDate: "2026-06-01",
      startTime: "17:00",
      endDate: "2026-06-01",
      endTime: "10:00",
    },
    project: validProject,
  });
  assert.equal(d.action, "hold-error");
  assert.match(d.message, /end must be after start/i);
});

test("decision: multi-day shoot (next-day end) → sync", () => {
  // Overnight shoot — 5pm Monday wrapping to 10am Tuesday is a real
  // production case and must validate as a valid sync.
  const d = getCalendarSyncDecision({
    subtask: {
      ...validSubtask,
      startDate: "2026-06-01",
      startTime: "17:00",
      endDate: "2026-06-02",
      endTime: "10:00",
    },
    project: validProject,
  });
  assert.equal(d.action, "sync");
});

test("decision: missing client email → hold-error (NOT delete)", () => {
  const d = getCalendarSyncDecision({
    subtask: validSubtask,
    project: { id: "p1", clientContact: {} },
  });
  assert.equal(d.action, "hold-error");
  assert.match(d.message, /client email/i);
});
