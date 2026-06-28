// node --test api/__tests__/xero-reconcile.test.mjs
// Covers the reconciler's pure identity + eligibility helpers — the parts
// that decide WHICH slices bridge and how they're located for the per-slice
// state machine. The Xero/Stripe/Firebase I/O is exercised against the demo
// org in the manual go-live proof, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sliceKey, isSliceEligible, findSliceIdx, allSlicesPaid } from "../cron/xero-reconcile.js";

const GO_LIVE = Date.parse("2026-06-01T00:00:00Z");

// ─── Identity: custom (sliceId) vs preset (idx) ─────────────────────

test("sliceKey uses sliceId for custom slices, idx for presets", () => {
  assert.equal(sliceKey({ sliceId: "s_abc" }, 0), "s_abc");
  assert.equal(sliceKey({}, 0), "idx0");          // preset deposit slice
  assert.equal(sliceKey({}, 1), "idx1");          // preset balance slice
});

test("findSliceIdx locates by sliceId first, falls back to idx for presets", () => {
  const custom = [{ sliceId: "s_a" }, { sliceId: "s_b" }, { sliceId: "s_c" }];
  assert.equal(findSliceIdx(custom, { sliceId: "s_b", idx: 99 }), 1); // sliceId wins over a stale idx
  const preset = [{ label: "Deposit" }, { label: "Balance" }];
  assert.equal(findSliceIdx(preset, { sliceId: undefined, idx: 1 }), 1); // no sliceId → idx
  assert.equal(findSliceIdx(preset, { sliceId: undefined, idx: 5 }), -1); // out of range
  assert.equal(findSliceIdx(custom, { sliceId: "missing", idx: undefined }), -1);
});

// ─── Eligibility (derived, no stamp) ────────────────────────────────

test("a paid slice on/after go-live with no bridge marker is eligible", () => {
  assert.equal(isSliceEligible({ status: "paid", paidAt: "2026-06-15T00:00:00Z" }, GO_LIVE), true);
});

test("historical paid slice (before go-live) is NOT eligible", () => {
  assert.equal(isSliceEligible({ status: "paid", paidAt: "2026-05-10T00:00:00Z" }, GO_LIVE), false);
});

test("already-bridged slice is NOT eligible (idempotent across runs)", () => {
  assert.equal(
    isSliceEligible({ status: "paid", paidAt: "2026-06-15T00:00:00Z", xeroBridgedAt: "2026-06-16T00:00:00Z" }, GO_LIVE),
    false
  );
});

test("non-paid slices (pending/declined/refunded/cancelled) are NOT eligible", () => {
  for (const status of ["pending", "declined", "refunded", "cancelled", "processing"]) {
    assert.equal(isSliceEligible({ status, paidAt: "2026-06-15T00:00:00Z" }, GO_LIVE), false, status);
  }
});

test("paid slice with no paidAt is NOT eligible (can't date the posting)", () => {
  assert.equal(isSliceEligible({ status: "paid", paidAt: null }, GO_LIVE), false);
  assert.equal(isSliceEligible({ status: "paid" }, GO_LIVE), false);
});

test("null/garbage slice is NOT eligible", () => {
  assert.equal(isSliceEligible(null, GO_LIVE), false);
  assert.equal(isSliceEligible(undefined, GO_LIVE), false);
});

// ─── allSlicesPaid: gates the under-collection guard (Codex code-review #1) ──

test("deposit-only sale (balance still pending) is NOT fully paid", () => {
  // The bug this guards: on a deposit-only sale, eligible=[deposit] and the old
  // `i === last` made it 'final', tripping the under-collection guard and
  // blocking EVERY staged deposit from bridging.
  const sale = { schedule: [{ status: "paid" }, { status: "pending" }] };
  assert.equal(allSlicesPaid(sale), false);
});

test("sale with every slice paid IS fully paid", () => {
  assert.equal(allSlicesPaid({ schedule: [{ status: "paid" }, { status: "paid" }] }), true);
  assert.equal(allSlicesPaid({ schedule: [{ status: "paid" }] }), true);
});

test("sale with a refunded/cancelled slice is NOT fully paid", () => {
  assert.equal(allSlicesPaid({ schedule: [{ status: "paid" }, { status: "refunded" }] }), false);
  assert.equal(allSlicesPaid({ schedule: [{ status: "paid" }, { status: "cancelled" }] }), false);
});

test("empty/missing schedule is NOT fully paid (can't be 'final')", () => {
  assert.equal(allSlicesPaid({ schedule: [] }), false);
  assert.equal(allSlicesPaid({}), false);
  assert.equal(allSlicesPaid(null), false);
});
