// Pure unit tests for api/_sale-schedules.js — focused on the single-slice
// "Pay in full" custom-schedule path (CUSTOM_MIN_SLICES lowered 2 → 1) and
// the empty-schedule footgun the webhook guard protects against.
// Run via:  node api/_sale-schedules.test.mjs
// Same convention as the other suites — no test runner, assertions throw.

import assert from "node:assert/strict";
import {
  validateCustomSlices,
  buildCustomSchedule,
  sumCustomSlicesExGst,
  newSliceId,
} from "./_sale-schedules.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const singleSlice = (amountExGst) => [{
  sliceId: newSliceId(),
  label: "Full payment",
  amountExGst,
  offsetDays: 0,
  trigger: "now",
}];

// ── validation: single slice is now valid (pay in full) ──────────────
test("validate: single full-payment slice is accepted", () => {
  const r = validateCustomSlices(singleSlice(900), 900);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("validate: empty schedule is rejected", () => {
  const r = validateCustomSlices([], 900);
  assert.equal(r.ok, false);
});

test("validate: single slice must be trigger 'now' at offset 0", () => {
  const bad = [{ sliceId: newSliceId(), label: "x", amountExGst: 900, offsetDays: 0, trigger: "auto" }];
  assert.equal(validateCustomSlices(bad, 900).ok, false);
});

test("validate: single slice sum must equal total ex-GST", () => {
  assert.equal(validateCustomSlices(singleSlice(800), 900).ok, false);
});

// ── build: single slice produces a one-row schedule charged today ────
test("build: single slice → length 1, trigger now, charged today", () => {
  const sched = buildCustomSchedule(singleSlice(900), { depositAnchorDate: new Date("2026-06-07T00:00:00Z") });
  assert.equal(sched.length, 1);
  assert.equal(sched[0].trigger, "now");
  assert.equal(sched[0].dueLabel, "Today");
  assert.equal(sched[0].status, "pending");
  // amount = projectAmount (inc GST) + Stripe surcharge, both > 0
  assert.ok(sched[0].amount > sched[0].projectAmount);
});

// ── footgun the webhook guard defends: empty in → empty out ──────────
test("build: empty customSlices yields an empty schedule (guarded downstream)", () => {
  assert.deepEqual(buildCustomSchedule([], { depositAnchorDate: new Date() }), []);
  // [].every() is vacuously true — the webhook must NOT treat this as
  // fully paid. See markSlicePaid()'s `nextSchedule.length > 0` guard.
  assert.equal([].every(s => s.status === "paid"), true);
});

// ── sum helper round-trips a single slice ────────────────────────────
test("sum: single slice sums to its own ex-GST amount", () => {
  assert.equal(sumCustomSlicesExGst(singleSlice(1234.5)), 1234.5);
});

console.log(`\n${passed} passed`);
