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
  applySlicePaid,
} from "./_sale-schedules.js";
import { subscriptionSliceAmount } from "./_tiers.js";

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

// ─── subscriptionSliceAmount (flat instalments) ────────────────────
test("subscriptionSliceAmount: equal thirds, standard cents", () => {
  assert.equal(subscriptionSliceAmount(10010, 3), 3336.67);
  assert.equal(subscriptionSliceAmount(9900, 3), 3300);
  assert.equal(subscriptionSliceAmount(0, 3), 0);
  assert.equal(subscriptionSliceAmount(100, 0), 0);
});

// ─── applySlicePaid (shared webhook/reconcile decision core) ───────
const mkSale = (over = {}) => ({
  id: "sale-1",
  videoType: "socialPremium",
  clientName: "Acme",
  schedule: [
    { idx: 0, sliceId: "sl-a", label: "Payment 1", status: "paid",    amount: 100, paidAt: "2026-06-01T00:00:00.000Z" },
    { idx: 1, sliceId: "sl-b", label: "Payment 2", status: "pending", amount: 100 },
    { idx: 2, sliceId: "sl-c", label: "Payment 3", status: "pending", amount: 100 },
  ],
  paid: false,
  ...over,
});
const NOW = "2026-06-10T01:00:00.000Z";

test("applySlicePaid: happy path marks the slice, sale not yet allPaid", () => {
  const r = applySlicePaid(mkSale(), { sliceId: "sl-b", now: NOW, patch: { stripeInvoiceId: "in_1" } });
  assert.equal(r.action, "paid");
  assert.equal(r.nextSale.schedule[1].status, "paid");
  assert.equal(r.nextSale.schedule[1].paidAt, NOW);
  assert.equal(r.nextSale.schedule[1].stripeInvoiceId, "in_1");
  assert.equal(r.nextSale.paid, false);
  assert.equal(r.info.allPaid, false);
  assert.equal(r.nextSale.schedule[2].status, "pending"); // sibling untouched
});

test("applySlicePaid: last slice flips paid:true + paidAt", () => {
  const sale = mkSale();
  sale.schedule[1].status = "paid";
  const r = applySlicePaid(sale, { sliceId: "sl-c", now: NOW });
  assert.equal(r.action, "paid");
  assert.equal(r.nextSale.paid, true);
  assert.equal(r.nextSale.paidAt, NOW);
  assert.equal(r.info.allPaid, true);
});

test("applySlicePaid: already-paid slice is an idempotent no-op", () => {
  const r = applySlicePaid(mkSale(), { sliceId: "sl-a", now: NOW });
  assert.equal(r.action, "already_paid");
  assert.equal(r.info.allPaid, false);
});

test("applySlicePaid: sliceIdx fallback resolves when sliceId absent", () => {
  const r = applySlicePaid(mkSale(), { sliceIdx: 1, now: NOW });
  assert.equal(r.action, "paid");
  assert.equal(r.nextSale.schedule[1].status, "paid");
});

test("applySlicePaid: no match", () => {
  assert.equal(applySlicePaid(mkSale(), { sliceId: "nope", now: NOW }).action, "no_match");
});

test("applySlicePaid: amount mismatch without heal bails for review", () => {
  const r = applySlicePaid(mkSale(), { sliceId: "sl-b", paidAmountCents: 9950, now: NOW });
  assert.equal(r.action, "mismatch");
  assert.equal(r.info.expectedCents, 10000);
  assert.equal(r.info.paidAmountCents, 9950);
});

test("applySlicePaid: healAmountToPaid heals the row to the actual charge", () => {
  const r = applySlicePaid(mkSale(), { sliceId: "sl-b", paidAmountCents: 10250, now: NOW, healAmountToPaid: true });
  assert.equal(r.action, "paid");
  assert.equal(r.nextSale.schedule[1].amount, 102.5);
  assert.equal(r.nextSale.schedule[1].amountDriftFrom, 100);
  assert.ok(r.nextSale.scheduleDriftNote.includes("102.50"));
  assert.ok(r.nextSale.scheduleDriftNote.includes("100.00"));
});

test("applySlicePaid: heal flag with matching amount adds no drift fields", () => {
  const r = applySlicePaid(mkSale(), { sliceId: "sl-b", paidAmountCents: 10000, now: NOW, healAmountToPaid: true });
  assert.equal(r.action, "paid");
  assert.equal(r.nextSale.schedule[1].amountDriftFrom, undefined);
  assert.equal(r.nextSale.scheduleDriftNote, undefined);
});

test("applySlicePaid: custom deposit re-anchors and stamps depositPaidAt", () => {
  const custom = mkSale({ videoType: "custom", customSlices: [] });
  custom.schedule = [
    { idx: 0, sliceId: "sl-d", label: "Deposit", status: "pending", amount: 500 },
    { idx: 1, sliceId: "sl-e", label: "Balance", status: "pending", amount: 500 },
  ];
  const r = applySlicePaid(custom, { sliceId: "sl-d", now: NOW });
  assert.equal(r.action, "paid");
  assert.equal(r.nextSale.depositPaidAt, NOW);
  // customSlices is empty → rebuild yields [] → MUST fall back to the
  // schedule containing the just-paid row (never drop rows / never let
  // [].every() vacuously flip paid:true).
  assert.equal(r.nextSale.schedule.length, 2);
  assert.equal(r.nextSale.schedule[0].status, "paid");
  assert.equal(r.nextSale.paid, false);
});

console.log(`\n${passed} passed`);
