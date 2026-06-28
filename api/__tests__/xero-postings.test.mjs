// node --test api/__tests__/xero-postings.test.mjs
// Locks the accounting core of the Stripe → Xero bridge: the three-posting
// math that makes Stripe Clearing net to zero, the rounding guards (both
// directions), and the review-routing for inconsistent inputs. Pure logic —
// no network, no Firebase, no Xero.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeXeroPostings,
  postingRef,
  ROUNDING_TOLERANCE_CENTS,
} from "../_xero-postings.js";

// A normal slice: $1000 project (GST-inc) + $20 surcharge = $1020 paid.
const slice = (over = {}) => ({
  sliceId: "s_abc",
  projectAmount: 1000,
  surcharge: 20,
  amount: 1020,
  amountPaid: 1020,
  ...over,
});

// ─── The headline invariant: Clearing nets to zero ──────────────────

test("worked example $1000/$20/$30/$990 nets to zero", () => {
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: 3000, // $30 actual Stripe fee
    remainingDueCents: 100000, // $1000 invoice fully due
  });
  assert.equal(r.ok, true);
  assert.equal(r.paymentCents, 100000);
  assert.equal(r.surchargeCents, 2000);
  assert.equal(r.feeCents, 3000);
  assert.equal(r.roundingIncomeCents, 0);
  // Clearing interim = 100000 + 2000 - 3000 = 99000 = the $990 payout cash.
  assert.equal(r.netClearingCents, 99000);
  assert.equal(r.cashCents, 99000);
  assert.equal(r.netClearingCents, r.cashCents);
});

test("net invariant holds across fee sizes: payment + rounding + surcharge === amountPaid", () => {
  for (const feeCents of [0, 1, 2999, 3000, 5000]) {
    const r = computeXeroPostings({
      slice: slice(),
      stripeFeeCents: feeCents,
      remainingDueCents: 100000,
    });
    assert.equal(r.ok, true);
    assert.equal(
      r.paymentCents + r.roundingIncomeCents + r.surchargeCents,
      102000, // amountPaid in cents
      `fee ${feeCents}`
    );
    assert.equal(r.netClearingCents, r.cashCents, `fee ${feeCents} clearing===cash`);
  }
});

test("surcharge-free slice still nets (deposit with no surcharge)", () => {
  const r = computeXeroPostings({
    slice: slice({ surcharge: 0, amount: 1000, amountPaid: 1000 }),
    stripeFeeCents: 1730,
    remainingDueCents: 100000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.surchargeCents, 0);
  assert.equal(r.paymentCents + r.surchargeCents, 100000);
  assert.equal(r.netClearingCents, r.cashCents);
});

// ─── Rounding: over-collection (project > AmountDue) ─────────────────

test("1c over-collection caps payment to AmountDue and absorbs cent as rounding income", () => {
  // Invoice AmountDue is $999.99 but this final slice's project is $1000.00.
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: 3000,
    remainingDueCents: 99999,
    isFinalSlice: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.paymentCents, 99999); // capped to AmountDue
  assert.equal(r.roundingIncomeCents, 1); // the 1c excess into clearing
  // Net preserved: 99999 + 1 + 2000 - 3000 = 99000.
  assert.equal(r.paymentCents + r.roundingIncomeCents + r.surchargeCents, 102000);
  assert.equal(r.netClearingCents, r.cashCents);
});

test("over-collection beyond tolerance routes to review, never posts", () => {
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: 3000,
    remainingDueCents: 100000 - (ROUNDING_TOLERANCE_CENTS + 1),
    isFinalSlice: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "payment_exceeds_amount_due");
});

// ─── Rounding: under-collection (AmountDue > project) on final slice ─

test("1c under-collection on final slice is tolerated", () => {
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: 3000,
    remainingDueCents: 100001, // invoice 1c larger than collected
    isFinalSlice: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.paymentCents, 100000);
  assert.equal(r.roundingIncomeCents, 0);
});

test("under-collection beyond tolerance on final slice routes to review", () => {
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: 3000,
    remainingDueCents: 100000 + (ROUNDING_TOLERANCE_CENTS + 1),
    isFinalSlice: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "invoice_would_remain_unpaid");
});

test("under-collection on a NON-final slice is fine (balance slice still to come)", () => {
  // Mid-schedule: invoice still has plenty owing; this slice just pays its part.
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: 3000,
    remainingDueCents: 250000, // lots still due
    isFinalSlice: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.paymentCents, 100000);
});

// ─── Review routing for bad inputs ──────────────────────────────────

test("unresolved Stripe fee (NaN) routes to review, never posts a guessed fee", () => {
  const r = computeXeroPostings({
    slice: slice(),
    stripeFeeCents: NaN,
    remainingDueCents: 100000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "stripe_fee_unresolved");
});

test("negative fee routes to review", () => {
  const r = computeXeroPostings({ slice: slice(), stripeFeeCents: -5, remainingDueCents: 100000 });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "stripe_fee_unresolved");
});

test("project+surcharge not matching amountPaid routes to review", () => {
  // amountPaid says $1100 but project+surcharge only make $1020.
  const r = computeXeroPostings({
    slice: slice({ amountPaid: 1100 }),
    stripeFeeCents: 3000,
    remainingDueCents: 100000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "amount_paid_mismatch");
});

test("non-positive project amount routes to review", () => {
  const r = computeXeroPostings({
    slice: slice({ projectAmount: 0, surcharge: 0, amount: 0, amountPaid: 0 }),
    stripeFeeCents: 0,
    remainingDueCents: 100000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "non_positive_project_amount");
});

test("zero AmountDue (invoice already paid) routes to review", () => {
  const r = computeXeroPostings({ slice: slice(), stripeFeeCents: 3000, remainingDueCents: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reviewReason, "invoice_no_amount_due");
});

// ─── Idempotency references are deterministic + distinct per kind ───

test("postingRef is deterministic and unique per kind", () => {
  assert.equal(postingRef("sale-1", "s_x", "payment"), "viewix-sale-1-s_x-payment");
  const kinds = ["payment", "surcharge", "fee", "rounding"].map((k) => postingRef("sale-1", "s_x", k));
  assert.equal(new Set(kinds).size, 4);
});
