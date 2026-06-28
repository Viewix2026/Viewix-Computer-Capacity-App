// api/_xero-postings.js
//
// PURE accounting core for the Stripe → Xero reconciliation bridge.
// No I/O — every function here is deterministic and unit-tested
// (api/__tests__/xero-postings.test.mjs). The bridge's correctness with
// real money lives almost entirely in this file, so it is deliberately
// isolated from the Xero HTTP client and the cron orchestration.
//
// ─── The three postings (why clearing nets to zero) ─────────────────
// A dashboard slice is one Stripe charge. The customer paid
//   amountPaid = projectAmount + surcharge          (both GST-inclusive)
// Stripe deducts its OWN fee and deposits (amountPaid − fee) in a batch
// payout. To make the "Stripe Clearing" bank account net to zero against
// that payout, the bridge posts THREE entries per slice:
//
//   1. Payment  +projectAmount  → applied to the Xero invoice, into Clearing
//   2. Receive  +surcharge      → into Clearing, coded to surcharge income
//   3. Spend    −actualFee      → out of Clearing, coded to Stripe fees
//
// Clearing interim balance = projectAmount + surcharge − fee
//                          = amountPaid − fee
//                          = the exact cash the payout deposits.
// Reconciling the payout as a transfer OUT then zeroes Clearing.
//
// CRITICAL: the fee MUST be Stripe's *actual* balance_transaction fee, not
// the customer surcharge — they differ, and a wrong fee leaves a permanent
// residue equal to (actualFee − postedFee). The reconciler resolves the
// real fee from Stripe before calling in here.

// ─── Config (env-overridable; accountant nominates the tax types) ────
// Account CODES (not names) as they appear in the Xero chart of accounts.
export const XERO_CLEARING_ACCOUNT_CODE  = process.env.XERO_CLEARING_ACCOUNT_CODE  || "";
export const XERO_FEES_ACCOUNT_CODE      = process.env.XERO_FEES_ACCOUNT_CODE      || "";
export const XERO_SURCHARGE_ACCOUNT_CODE = process.env.XERO_SURCHARGE_ACCOUNT_CODE || "";

// Xero tax types for the two BankTransaction legs. Defaults are the
// AU-standard starting point; the accountant confirms before the flag is
// flipped (Scope Packet open decision #1). Changing the treatment is a
// change to THESE TWO CONSTANTS ONLY — the math below is treatment-agnostic
// because every BankTransaction line posts LineAmountTypes:"Inclusive", so
// the cash into/out of Clearing equals the line amount regardless of the
// tax rate Xero derives from it.
//   Surcharge: extra taxable consideration from the customer → GST on income.
//   Stripe fee: defaulted to BAS-excluded (no GST claimed) pending advice —
//     Stripe AU GST treatment varies by account; the accountant decides.
export const XERO_SURCHARGE_TAX_TYPE = process.env.XERO_SURCHARGE_TAX_TYPE || "OUTPUT";
export const XERO_FEE_TAX_TYPE       = process.env.XERO_FEE_TAX_TYPE       || "BASEXCLUDED";

// Max cents of schedule-rounding drift we will auto-absorb on the final
// slice. Anything larger is a real mismatch → review, never auto-posted.
export const ROUNDING_TOLERANCE_CENTS = 2;

// ─── helpers ────────────────────────────────────────────────────────
const toCents = (n) => Math.round(Number(n || 0) * 100);

// Deterministic, durable idempotency references. Written into the Xero
// Payment/BankTransaction `Reference` field AND used as the pre-create
// `where=Reference=="..."` query key — the only idempotency path that
// survives past Xero's ~24h Idempotency-Key header window.
export function postingRef(saleId, sliceId, kind) {
  // kind: "payment" | "surcharge" | "fee" | "rounding"
  return `viewix-${saleId}-${sliceId}-${kind}`;
}

// ─── computeXeroPostings ────────────────────────────────────────────
//
// Pure. Decides the cents for each posting and whether the slice is
// postable at all. Does NOT build Xero payloads or touch config account
// codes — the reconciler assembles bodies from these cents + the config.
//
// Inputs:
//   slice            — the schedule slice (projectAmount, surcharge,
//                      amount/amountPaid — all GST-inclusive dollars).
//   stripeFeeCents   — Stripe's ACTUAL fee for this charge (integer cents).
//   remainingDueCents— the Xero invoice's current AmountDue in cents,
//                      decremented locally across a sale's slices in one run.
//   isFinalSlice     — true if this is the last eligible paid slice for the
//                      sale in this run (enables the under-collection guard).
//
// Returns one of:
//   { ok:false, reviewReason }                       — route to review queue
//   { ok:true, paymentCents, roundingIncomeCents,
//     surchargeCents, feeCents,
//     netClearingCents, cashCents }                  — postable
//
// Invariant asserted by tests: paymentCents + roundingIncomeCents +
// surchargeCents === amountPaidCents, hence netClearingCents === cashCents
// and Clearing nets to zero once the payout transfer posts.
export function computeXeroPostings({ slice, stripeFeeCents, remainingDueCents, isFinalSlice = false }) {
  const projectCents   = toCents(slice?.projectAmount);
  const surchargeCents  = toCents(slice?.surcharge);
  // amountPaid is the real charge; fall back to scheduled amount.
  const amountPaidCents = toCents(slice?.amountPaid != null ? slice.amountPaid : slice?.amount);
  const feeCents        = Math.round(Number(stripeFeeCents));
  const dueCents        = Math.round(Number(remainingDueCents));

  if (!Number.isFinite(feeCents) || feeCents < 0) {
    return { ok: false, reviewReason: "stripe_fee_unresolved" };
  }
  if (projectCents <= 0) {
    return { ok: false, reviewReason: "non_positive_project_amount" };
  }
  if (!Number.isFinite(dueCents) || dueCents <= 0) {
    return { ok: false, reviewReason: "invoice_no_amount_due" };
  }
  // Sanity: the project + surcharge must reconcile to what the customer
  // actually paid (within 1c rounding). If not, the slice data is
  // inconsistent — don't guess against live books.
  if (Math.abs((projectCents + surchargeCents) - amountPaidCents) > 1) {
    return { ok: false, reviewReason: "amount_paid_mismatch" };
  }

  let paymentCents = projectCents;
  let roundingIncomeCents = 0;

  if (projectCents > dueCents) {
    // Over-collection: invoice has less owing than this slice's project
    // portion (schedule rounded a hair high, or an earlier slice already
    // covered more). Cap the Payment at AmountDue; absorb the small excess
    // as rounding income INTO Clearing so net-zero is preserved.
    const over = projectCents - dueCents;
    if (over > ROUNDING_TOLERANCE_CENTS) {
      return { ok: false, reviewReason: "payment_exceeds_amount_due" };
    }
    paymentCents = dueCents;
    roundingIncomeCents = over;
  } else if (isFinalSlice) {
    // Under-collection on the final slice: invoice would be left part-paid
    // (AmountDue > what we collected). Never auto-resolve — a receive-money
    // top-up would overstate Clearing and the invoice would still not zero.
    const under = dueCents - projectCents;
    if (under > ROUNDING_TOLERANCE_CENTS) {
      return { ok: false, reviewReason: "invoice_would_remain_unpaid" };
    }
  }

  const netClearingCents = paymentCents + roundingIncomeCents + surchargeCents - feeCents;
  const cashCents        = amountPaidCents - feeCents;

  return {
    ok: true,
    paymentCents,
    roundingIncomeCents,
    surchargeCents,
    feeCents,
    netClearingCents,
    cashCents,
  };
}
