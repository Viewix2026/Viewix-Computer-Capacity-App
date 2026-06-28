// api/cron/xero-reconcile.js
//
// Daily reconciler for the Stripe → Xero bridge. For each dashboard sale
// slice that was paid through Stripe and whose Xero invoice carries
// Reference == saleId, it posts THREE entries into the "Stripe Clearing"
// bank account (Payment for the project amount + Receive-money for the
// surcharge/rounding + Spend-money for the ACTUAL Stripe fee) so Clearing
// nets to zero against the real Stripe payout. The accounting math lives in
// api/_xero-postings.js; the Xero HTTP client in api/_xero.js.
//
// Hard-OFF behind XERO_BRIDGE_ENABLED. Off the Stripe webhook hot path.
// Idempotent: a per-slice state machine stores each Xero id as it lands
// (xeroPaymentId → xeroReceiveId → xeroFeeId → xeroBridgedAt), and every
// posting also carries a deterministic Reference that is pre-checked before
// any create — the only idempotency that survives Xero's ~24h key window.
//
// Eligibility is DERIVED, never stamped: a slice bridges only when
// paidAt >= XERO_BRIDGE_GO_LIVE_AT AND a validated Reference-matched invoice
// exists. Pre-go-live invoices have no matching Reference, so history can't
// bleed even if the cutoff were misconfigured.

import Stripe from "stripe";
import { isAuthorizedCron } from "../_cronAuth.js";
import { adminGet, mutateRecord } from "../_fb-admin.js";
import { sydneyDateKey } from "../_sale-schedules.js";
import { xeroRequest, whereReference, getXeroContext, XeroError } from "../_xero.js";
import {
  computeXeroPostings,
  postingRef,
  XERO_CLEARING_ACCOUNT_CODE,
  XERO_FEES_ACCOUNT_CODE,
  XERO_SURCHARGE_ACCOUNT_CODE,
  XERO_SURCHARGE_TAX_TYPE,
  XERO_FEE_TAX_TYPE,
} from "../_xero-postings.js";

const STALE_CLAIM_MS = 6 * 60 * 60 * 1000; // > any cron runtime; a slow live run keeps its claim
const norm = (s) => String(s || "").trim().toLowerCase();
const dollars = (cents) => (cents / 100).toFixed(2);

async function slackNotify(text) {
  const url = process.env.SLACK_SALES_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch (e) {
    console.error("Slack notify failed:", e.message);
  }
}

// Stable per-slice identity that works for BOTH custom sales (sliceId) and
// preset deposit/subscription sales (no sliceId — identified by array idx,
// which is stable for presets since their schedules are never reordered).
export function sliceKey(slice, idx) {
  return slice.sliceId || `idx${idx}`;
}

// Is the whole sale fully paid? Only then is the LAST payment expected to
// zero the invoice — so the under-collection guard (which routes a slice to
// review if the invoice would be left part-paid) must ONLY apply on the final
// payment of a fully-paid sale. On a deposit-only sale the invoice is SUPPOSED
// to stay part-paid, so no slice is "final" yet (Codex code-review #1).
export function allSlicesPaid(sale) {
  const sched = Array.isArray(sale?.schedule) ? sale.schedule : [];
  return sched.length > 0 && sched.every((s) => s && s.status === "paid");
}

// Derived eligibility (no stamp): a paid slice on/after the go-live cutoff
// that hasn't already been bridged. The second gate (a validated
// Reference-matched invoice) is enforced in processSale.
export function isSliceEligible(slice, goLiveAtMs) {
  return !!(
    slice &&
    slice.status === "paid" &&
    !slice.xeroBridgedAt &&
    slice.paidAt &&
    Date.parse(slice.paidAt) >= goLiveAtMs
  );
}

// Locate a slice for a read-modify-write: prefer the stable sliceId; fall
// back to the array index for preset slices that don't carry one.
export function findSliceIdx(schedule, locator) {
  if (locator.sliceId) {
    const i = schedule.findIndex((s) => s && s.sliceId === locator.sliceId);
    if (i !== -1) return i;
  }
  if (Number.isInteger(locator.idx) && schedule[locator.idx]) return locator.idx;
  return -1;
}

// ── Firebase slice/sale mutators (reuse the cold-cache-safe mutateRecord) ──
async function patchSlice(saleId, locator, patch) {
  return mutateRecord(`/sales/${saleId}`, (sale) => {
    const schedule = Array.isArray(sale.schedule) ? [...sale.schedule] : [];
    const idx = findSliceIdx(schedule, locator);
    if (idx === -1) return null;
    schedule[idx] = { ...schedule[idx], ...patch };
    return { ...sale, schedule };
  });
}

async function patchSale(saleId, patch) {
  return mutateRecord(`/sales/${saleId}`, (sale) => ({ ...sale, ...patch }));
}

// Transactionally claim a slice for this run. Returns "claimed" | "held"
// | "done" | "lost". Stale claims (> 6h) are reclaimed (crashed prior run).
async function claimSlice(saleId, locator, nowMs) {
  let outcome = "lost";
  await mutateRecord(`/sales/${saleId}`, (sale) => {
    outcome = "lost";
    const schedule = Array.isArray(sale.schedule) ? [...sale.schedule] : [];
    const idx = findSliceIdx(schedule, locator);
    if (idx === -1) return null;
    const s = schedule[idx];
    if (s.xeroBridgedAt) { outcome = "done"; return null; }
    const claimedAt = s.xeroClaimAt ? Date.parse(s.xeroClaimAt) : 0;
    if (claimedAt && nowMs - claimedAt < STALE_CLAIM_MS) { outcome = "held"; return null; }
    schedule[idx] = { ...s, xeroClaimAt: new Date(nowMs).toISOString() };
    outcome = "claimed";
    return { ...sale, schedule };
  });
  return outcome;
}

// ── Stripe ACTUAL fee resolution (branches on which id the slice stored) ──
// A field may be a string id or an expanded object — coerce to the id.
const idOf = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? v.id : null);

async function resolveStripeFeeCents(stripe, slice) {
  try {
    let chargeId = null;
    let piId = null;
    if (slice.stripePaymentIntentId) {
      // Deposit / one-off / Custom slices store the PaymentIntent directly.
      piId = slice.stripePaymentIntentId;
    } else if (slice.stripeInvoiceId) {
      // Subscription slices store only the invoice id. On the Basil API
      // (Stripe v22) invoice.payment_intent/charge are gone — the link lives
      // under invoice.payments[].payment (an InvoicePayment with .payment_intent
      // or .charge, per the SDK types). `payments` is an includable property,
      // so expand it as ["payments"] (NOT "payments.data.payment", which 400s).
      // Legacy top-level inv.payment_intent/charge kept as a fallback for older
      // account API versions. Fails SAFE (null → review) if nothing resolves.
      const inv = await stripe.invoices.retrieve(slice.stripeInvoiceId, { expand: ["payments"] });
      const pm = (inv.payments?.data || [])
        .map((ip) => ip && ip.payment)
        .find((p) => p && (p.payment_intent || p.charge));
      piId = idOf(inv.payment_intent) || idOf(pm?.payment_intent) || null;
      chargeId = idOf(inv.charge) || idOf(pm?.charge) || null;
    }
    if (!chargeId && piId) {
      const pi = await stripe.paymentIntents.retrieve(piId);
      chargeId = idOf(pi.latest_charge);
    }
    if (!chargeId) return null;
    const charge = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
    const bt = charge.balance_transaction;
    if (!bt || typeof bt.fee !== "number") return null;
    return bt.fee; // Stripe balance_transaction.fee is already in cents
  } catch (e) {
    console.error("resolveStripeFeeCents failed:", e.message);
    return null;
  }
}

// ── Xero helpers ──
async function findInvoiceByReference(saleId) {
  const res = await xeroRequest("/Invoices", { query: whereReference(saleId) });
  const invoices = (res.Invoices || []).filter((i) => i.Type === "ACCREC");
  return invoices;
}

// Pre-create idempotency: has a Payment/BankTransaction with this Reference
// already been written? Returns the existing id, or null ONLY when the query
// genuinely returned no match. A Xero HTTP error MUST propagate (xeroRequest
// throws on non-2xx) — swallowing it and returning null would read as "none
// exists" and double-post past Xero's 24h Idempotency-Key window (Codex
// code-review #3). The caller's try/catch leaves ids in place and retries.
async function findExistingId(endpoint, ref, idField) {
  const res = await xeroRequest(`/${endpoint}`, { query: whereReference(ref) });
  const list = res[endpoint] || [];
  return list.length ? list[0][idField] : null;
}

async function postPayment(invoiceId, amountCents, date, ref) {
  const res = await xeroRequest("/Payments", {
    method: "PUT",
    idempotencyKey: ref,
    body: {
      Payments: [{
        Invoice: { InvoiceID: invoiceId },
        Account: { Code: XERO_CLEARING_ACCOUNT_CODE },
        Date: date,
        Amount: Number(dollars(amountCents)),
        Reference: ref,
      }],
    },
  });
  return res.Payments?.[0]?.PaymentID || null;
}

async function postBankTransaction(type, contactId, accountCode, taxType, amountCents, date, ref, description) {
  const res = await xeroRequest("/BankTransactions", {
    method: "PUT",
    idempotencyKey: ref,
    body: {
      BankTransactions: [{
        Type: type, // "RECEIVE" | "SPEND"
        Contact: { ContactID: contactId },
        BankAccount: { Code: XERO_CLEARING_ACCOUNT_CODE },
        Date: date,
        Reference: ref,
        LineAmountTypes: "Inclusive", // amounts are GST-inclusive cash (Codex R2-#3)
        LineItems: [{
          Description: description,
          Quantity: 1,
          UnitAmount: Number(dollars(amountCents)),
          AccountCode: accountCode,
          TaxType: taxType,
        }],
      }],
    },
  });
  return res.BankTransactions?.[0]?.BankTransactionID || null;
}

// ── Process one sale: validate its invoice, bridge its eligible slices ──
async function processSale(stripe, sale, eligible, nowMs, stats) {
  const saleId = sale.id;
  let invoices;
  try {
    invoices = await findInvoiceByReference(saleId);
  } catch (e) {
    console.error(`invoice lookup failed for ${saleId}:`, e.message);
    stats.errors++;
    return;
  }

  if (invoices.length === 0) {
    // No invoice yet (Zap not fired / Reference not set / not created).
    await noteMissing(sale, "no_invoice", nowMs, stats);
    return;
  }
  if (invoices.length > 1) {
    await patchSale(saleId, { xeroReviewRequired: true, xeroMatchStatus: "multiple_invoices" });
    await slackNotify(`:warning: *Xero bridge* — *${sale.clientName || saleId}* has ${invoices.length} invoices with Reference ${saleId}. Skipped to avoid mis-posting; reconcile manually.`);
    stats.review++;
    return;
  }

  const inv = invoices[0];
  if (inv.Status === "VOIDED" || inv.Status === "DELETED") {
    await patchSale(saleId, { xeroReviewRequired: true, xeroMatchStatus: `invoice_${String(inv.Status).toLowerCase()}` });
    stats.review++;
    return;
  }
  if (inv.Status === "DRAFT" || inv.Status === "SUBMITTED") {
    // Not yet AUTHORISED — can't apply payments. Retry next run; escalate if aged.
    await noteMissing(sale, "invoice_draft", nowMs, stats);
    return;
  }
  // AUTHORISED or PAID proceed — PAID is handled per-slice (resume incomplete
  // postings); it never short-circuits the whole sale (Codex R2-#1 / R3-#2).

  // ── Secondary validation (Codex #6) — never post on a typo'd Reference ──
  const expectedTotalCents = (Array.isArray(sale.schedule) ? sale.schedule : [])
    .reduce((sum, s) => sum + Math.round(Number(s?.projectAmount || 0) * 100), 0);
  const invTotalCents = Math.round(Number(inv.Total || 0) * 100);
  const contactOk = norm(inv.Contact?.Name) === norm(sale.clientName);
  const totalOk = Math.abs(invTotalCents - expectedTotalCents) <= 2;
  const currencyOk = (inv.CurrencyCode || "AUD") === "AUD";
  if (!contactOk || !totalOk || !currencyOk) {
    await patchSale(saleId, {
      xeroReviewRequired: true,
      xeroMatchStatus: "validation_failed",
      xeroReviewNote: `Reference matched invoice ${inv.InvoiceNumber || inv.InvoiceID} but ` +
        `${!contactOk ? `contact "${inv.Contact?.Name}" != "${sale.clientName}" ` : ""}` +
        `${!totalOk ? `total $${dollars(invTotalCents)} != expected $${dollars(expectedTotalCents)} ` : ""}` +
        `${!currencyOk ? `currency ${inv.CurrencyCode} != AUD` : ""}`.trim(),
    });
    await slackNotify(`:warning: *Xero bridge* — *${sale.clientName || saleId}* invoice failed validation (contact/total/currency). Not posted; check the Attio Reference and the invoice.`);
    stats.review++;
    return;
  }

  // Clear any prior "missing" flags now that we have a validated match.
  if (sale.xeroMatchStatus && sale.xeroMatchStatus !== "matched") {
    await patchSale(saleId, { xeroMatchStatus: "matched", xeroFirstMissedAt: null });
  }

  // ── Bridge each eligible slice sequentially (local AmountDue decrement) ──
  let remainingDueCents = Math.round(Number(inv.AmountDue || 0) * 100);
  const contactId = inv.Contact?.ContactID;
  const saleFullyPaid = allSlicesPaid(sale);

  for (let i = 0; i < eligible.length; i++) {
    const slc = { ...eligible[i] };
    const locator = { sliceId: slc.sliceId, idx: slc._idx };
    const key = sliceKey(slc, slc._idx);
    // The under-collection guard only applies to the LAST payment of a sale
    // that is FULLY paid — never to a deposit-only sale (whose invoice is
    // meant to stay part-paid). (Codex code-review #1)
    const isFinalSlice = saleFullyPaid && i === eligible.length - 1;
    const claim = await claimSlice(saleId, locator, nowMs);
    if (claim === "done") { continue; }
    if (claim === "held" || claim === "lost") { stats.skipped++; continue; }

    const date = sydneyDateKey(slc.paidAt) || sydneyDateKey(new Date().toISOString());

    // Plan once and PERSIST it before any Xero write, then RESUME from the
    // stored plan. Recomputing on resume would re-run the AmountDue/cap logic
    // against an invoice our own prior payment already reduced — tripping the
    // review guard on a payment that actually posted (Codex code-review #2).
    let plan = slc.xeroPlan || null;
    if (!plan) {
      const feeCents = await resolveStripeFeeCents(stripe, slc);
      const computed = computeXeroPostings({ slice: slc, stripeFeeCents: feeCents, remainingDueCents, isFinalSlice });
      if (!computed.ok) {
        await patchSlice(saleId, locator, { xeroReviewReason: computed.reviewReason, xeroClaimAt: null });
        stats.review++;
        continue;
      }
      plan = {
        paymentCents: computed.paymentCents,
        receiveCents: computed.surchargeCents + computed.roundingIncomeCents,
        feeCents: computed.feeCents,
      };
      await patchSlice(saleId, locator, { xeroPlan: plan });
    }

    try {
      // 1) Payment → invoice, into Clearing.
      if (!slc.xeroPaymentId) {
        const ref = postingRef(saleId, key, "payment");
        let id = await findExistingId("Payments", ref, "PaymentID");
        const newlyPosted = !id; // adopting an existing payment must NOT decrement
        if (!id) {
          // Stale-plan guard (Codex code-review N1): the plan's payment was
          // sized against the AmountDue at plan time. If AmountDue has since
          // SHRUNK (an external partial payment / invoice edit landed between
          // runs), posting plan.paymentCents would over-apply — Xero rejects
          // it into a retry loop. Convert that into a clean review item.
          if (plan.paymentCents > remainingDueCents) {
            await patchSlice(saleId, locator, { xeroReviewReason: "amount_due_changed_since_plan", xeroClaimAt: null });
            stats.review++;
            continue;
          }
          id = await postPayment(inv.InvoiceID, plan.paymentCents, date, ref);
        }
        slc.xeroPaymentId = id;
        await patchSlice(saleId, locator, { xeroPaymentId: id });
        // Only a payment NEWLY posted this run reduces the AmountDue our local
        // figure tracks. A prior run's payment (adopted via findExistingId, or
        // a resumed slice) is already reflected in the AmountDue we fetched, so
        // decrementing again would understate room for later slices.
        if (newlyPosted) remainingDueCents = Math.max(0, remainingDueCents - plan.paymentCents);
      }

      // 2) Receive-money (surcharge + rounding) → Clearing, coded to income.
      if (!slc.xeroReceiveId && plan.receiveCents > 0) {
        const ref = postingRef(saleId, key, "surcharge");
        let id = await findExistingId("BankTransactions", ref, "BankTransactionID");
        if (!id) id = await postBankTransaction("RECEIVE", contactId, XERO_SURCHARGE_ACCOUNT_CODE, XERO_SURCHARGE_TAX_TYPE, plan.receiveCents, date, ref, `Stripe surcharge — ${slc.label || "payment"}`);
        slc.xeroReceiveId = id;
        await patchSlice(saleId, locator, { xeroReceiveId: id });
      }

      // 3) Spend-money (actual Stripe fee) → out of Clearing, to Stripe Fees.
      if (!slc.xeroFeeId && plan.feeCents > 0) {
        const ref = postingRef(saleId, key, "fee");
        let id = await findExistingId("BankTransactions", ref, "BankTransactionID");
        if (!id) id = await postBankTransaction("SPEND", contactId, XERO_FEES_ACCOUNT_CODE, XERO_FEE_TAX_TYPE, plan.feeCents, date, ref, `Stripe fee — ${slc.label || "payment"}`);
        slc.xeroFeeId = id;
        await patchSlice(saleId, locator, { xeroFeeId: id });
      }

      // Complete only when every required leg has an id.
      const receiveDone = plan.receiveCents > 0 ? !!slc.xeroReceiveId : true;
      const feeDone = plan.feeCents > 0 ? !!slc.xeroFeeId : true;
      if (slc.xeroPaymentId && receiveDone && feeDone) {
        await patchSlice(saleId, locator, { xeroBridgedAt: new Date(nowMs).toISOString(), xeroClaimAt: null });
        stats.posted++;
      }
    } catch (e) {
      // Leave whatever ids landed; next run resumes the missing legs.
      console.error(`bridge posting failed for ${saleId}/${key}:`, e.message);
      await patchSlice(saleId, locator, { xeroClaimAt: null, xeroLastError: String(e.message).slice(0, 300) });
      stats.errors++;
    }
  }
}

// Record a missing/draft-invoice match and escalate once after >1 business day.
async function noteMissing(sale, status, nowMs, stats) {
  const firstMissed = sale.xeroFirstMissedAt ? Date.parse(sale.xeroFirstMissedAt) : null;
  const patch = { xeroMatchStatus: status };
  if (!firstMissed) patch.xeroFirstMissedAt = new Date(nowMs).toISOString();
  await patchSale(sale.id, patch);
  stats.missing++;

  const since = firstMissed || nowMs;
  const ageHrs = (nowMs - since) / (60 * 60 * 1000);
  if (ageHrs > 24 && !sale.xeroEscalatedAt) {
    await patchSale(sale.id, { xeroEscalatedAt: new Date(nowMs).toISOString() });
    await slackNotify(`:money_with_wings: *Xero bridge* — *${sale.clientName || sale.id}* has paid Stripe slices but still no usable invoice (${status}) after >1 day. Check the Attio "Dashboard Sale ID" field and that the invoice is approved.`);
  }
}

export default async function handler(req, res) {
  const auth = isAuthorizedCron(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  if (process.env.XERO_BRIDGE_ENABLED !== "true") {
    return res.status(200).json({ ok: true, disabled: true });
  }

  // Config sanity — never run half-configured against live books.
  if (!XERO_CLEARING_ACCOUNT_CODE || !XERO_FEES_ACCOUNT_CODE || !XERO_SURCHARGE_ACCOUNT_CODE) {
    await slackNotify(":warning: *Xero bridge* — missing account-code env vars; reconciler aborted.");
    return res.status(200).json({ ok: false, error: "account codes not configured" });
  }
  const goLiveAt = Date.parse(process.env.XERO_BRIDGE_GO_LIVE_AT || "");
  if (!Number.isFinite(goLiveAt)) {
    await slackNotify(":warning: *Xero bridge* — XERO_BRIDGE_GO_LIVE_AT not a valid ISO date; reconciler aborted.");
    return res.status(200).json({ ok: false, error: "go-live cutoff not configured" });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(200).json({ ok: false, error: "STRIPE_SECRET_KEY not configured" });
  const stripe = new Stripe(stripeKey);

  // Assert the connected Xero org up front (demo↔live guard); validate codes.
  try {
    await getXeroContext();
    const accRes = await xeroRequest("/Accounts");
    const codes = new Set((accRes.Accounts || []).map((a) => a.Code));
    const missing = [XERO_CLEARING_ACCOUNT_CODE, XERO_FEES_ACCOUNT_CODE, XERO_SURCHARGE_ACCOUNT_CODE].filter((c) => !codes.has(c));
    if (missing.length) {
      await slackNotify(`:warning: *Xero bridge* — account code(s) ${missing.join(", ")} not found in the connected org. Aborted.`);
      return res.status(200).json({ ok: false, error: "account codes not in org", missing });
    }
  } catch (e) {
    const msg = e instanceof XeroError ? e.message : String(e.message);
    await slackNotify(`:warning: *Xero bridge* — startup check failed: ${msg}`);
    return res.status(200).json({ ok: false, error: msg });
  }

  const nowMs = Date.now();
  const sales = (await adminGet("/sales")) || {};
  const stats = { posted: 0, review: 0, missing: 0, skipped: 0, errors: 0, salesScanned: 0 };

  for (const sale of Object.values(sales)) {
    if (!sale || !sale.id) continue;
    const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
    const eligible = schedule
      .map((s, idx) => (s ? { ...s, _idx: idx } : null))
      .filter((s) => isSliceEligible(s, goLiveAt));
    if (eligible.length === 0) continue;
    stats.salesScanned++;
    try {
      await processSale(stripe, sale, eligible, nowMs, stats);
    } catch (e) {
      console.error(`processSale crashed for ${sale.id}:`, e.message);
      stats.errors++;
    }
  }

  if (stats.posted || stats.review || stats.errors) {
    await slackNotify(
      `:abacus: *Xero bridge run* — ${stats.posted} posted, ${stats.review} to review, ${stats.missing} awaiting invoice, ${stats.skipped} skipped, ${stats.errors} errors (${stats.salesScanned} sales scanned).`
    );
  }
  return res.status(200).json({ ok: true, ...stats });
}
