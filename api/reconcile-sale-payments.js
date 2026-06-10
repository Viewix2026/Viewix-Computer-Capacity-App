// api/reconcile-sale-payments.js
// Founder-only escape hatch for when Stripe webhooks didn't land.
//
// Pulls truth from Stripe directly — paid invoices on the sale's
// subscription, plus any successful payment intents tagged with the
// sale's saleId — and marks the matching slices on the /sales record
// paid. Idempotent: re-running on an already-correct sale is a no-op.
//
// Symptoms this fixes:
//   · Sale reads "AWAITING DEPOSIT" but Stripe shows the invoice
//     paid (most common: webhook delivery failed, or
//     STRIPE_WEBHOOK_SECRET env var was wrong/missing for the mode
//     the event came in on, or a livemode mismatch rejected the
//     event at signature-verify time).
//   · Subscription mid-flight where one invoice's webhook went
//     through but a later one didn't.
//   · Charge Balance succeeded at Stripe but the PI.succeeded
//     webhook was rejected.

import Stripe from "stripe";
import { adminGet, mutateRecord } from "./_fb-admin.js";
import { applySlicePaid } from "./_sale-schedules.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

// Mark a single slice paid. Shares the applySlicePaid decision core
// with stripe-webhook.js (so the bookkeeping rules can't drift) and
// runs it inside a whole-sale transaction — the old read-then-patch
// here could clobber a webhook flipping a sibling slice mid-reconcile.
//
// healAmountToPaid: reconcile pulls TRUTH from Stripe, so when the
// actual charge disagrees with the stored row (legacy uneven
// subscription plans), the row heals to reality instead of bailing.
async function markSlicePaid(saleId, { sliceId, sliceIdx, paidAmountCents }, patch = {}) {
  const now = new Date().toISOString();
  let result = null; // re-assigned every updater run; read only after the null-gate
  const tx = await mutateRecord(`/sales/${saleId}`, (sale) => {
    result = applySlicePaid(sale, {
      sliceId, sliceIdx, paidAmountCents, now,
      healAmountToPaid: true,
      patch: {
        ...patch,
        reconciledAt: now, // audit marker: this slice needed reconcile
      },
    });
    return result.action === "paid" ? result.nextSale : null;
  });
  if (tx.snapshot == null) return { skipped: "sale gone" };
  if (result?.action === "already_paid") return { skipped: "already paid" };
  if (result?.action === "no_match") {
    return { skipped: `no matching slice (sliceId=${sliceId || "n/a"}, sliceIdx=${sliceIdx})` };
  }
  if (tx.committed && result?.action === "paid") {
    return { marked: true, sliceId: result.info.slice?.sliceId || null, allPaid: result.info.allPaid };
  }
  return { skipped: "transaction not committed" };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  try {
    await requireRole(req, ["founders", "manager"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { saleId } = req.body || {};
  if (!saleId) return res.status(400).json({ error: "saleId required" });

  const sale = await adminGet(`/sales/${saleId}`);
  if (!sale) return res.status(404).json({ error: "Sale not found" });

  const stripe = new Stripe(secret);
  const log = [];

  try {
    // ── Subscription path ──────────────────────────────────────────
    // For Social Media monthly plans: each paid invoice corresponds to
    // a slice. Stripe lists invoices most-recent-first by default; we
    // sort by created ascending so sliceIdx 0 is the oldest invoice.
    if (sale.stripeSubscriptionId) {
      let allInvoices = [];
      let starting_after;
      do {
        const page = await stripe.invoices.list({
          subscription: sale.stripeSubscriptionId,
          limit: 100,
          ...(starting_after ? { starting_after } : {}),
        });
        allInvoices = allInvoices.concat(page.data);
        starting_after = page.has_more ? page.data[page.data.length - 1].id : null;
      } while (starting_after);
      const paidInvoices = allInvoices
        .filter(inv => inv.status === "paid")
        .sort((a, b) => (a.created || 0) - (b.created || 0));
      log.push({ subscription: sale.stripeSubscriptionId, paidInvoices: paidInvoices.length });
      for (let i = 0; i < paidInvoices.length; i++) {
        const inv = paidInvoices[i];
        // Subscription invoices are 1:1 with sliceIdx (preset-only path),
        // no sliceId yet — pass sliceIdx as the legacy resolver.
        const result = await markSlicePaid(saleId, { sliceIdx: i, paidAmountCents: inv.amount_paid || 0 }, {
          stripeInvoiceId: inv.id,
          amountPaid: (inv.amount_paid || 0) / 100,
          // Receipt URL on the invoice's hosted page
          receiptUrl: inv.hosted_invoice_url || null,
        });
        log.push({ sliceIdx: i, invoiceId: inv.id, ...result });
      }
    }

    // ── PaymentIntent path (deposit-plus-manual / paid-in-full) ───
    // Search Stripe for any PI tagged with this saleId. metadata.sliceIdx
    // tells us which slice. Idempotent — already-paid slices skip.
    // Search API needs `metadata['saleId']` syntax.
    try {
      const search = await stripe.paymentIntents.search({
        query: `metadata['saleId']:'${saleId}' AND status:'succeeded'`,
        limit: 100,
      });
      log.push({ paymentIntents: search.data.length });
      for (const pi of search.data) {
        const sliceIdx = pi.metadata?.sliceIdx;
        const sliceId  = pi.metadata?.sliceId;
        if ((sliceIdx === undefined || sliceIdx === null) && !sliceId) {
          log.push({ piId: pi.id, skipped: "no sliceId/sliceIdx metadata" });
          continue;
        }
        let receiptUrl = null;
        if (pi.latest_charge) {
          try {
            const charge = await stripe.charges.retrieve(pi.latest_charge);
            receiptUrl = charge.receipt_url || null;
          } catch (e) {
            // Non-fatal — receipt url is nice-to-have.
          }
        }
        // sliceId is identity for Custom sales; sliceIdx is the legacy
        // resolver for preset PaymentIntents. Post-edit row insert/
        // remove can leave sliceIdx stale, so try sliceId first.
        const result = await markSlicePaid(saleId, { sliceId, sliceIdx, paidAmountCents: pi.amount_received || 0 }, {
          stripePaymentIntentId: pi.id,
          amountPaid: (pi.amount_received || 0) / 100,
          receiptUrl,
        });
        log.push({ sliceId: sliceId || null, sliceIdx: sliceIdx !== undefined ? Number(sliceIdx) : null, piId: pi.id, ...result });
      }
    } catch (e) {
      // Stripe Search API requires the account to have it enabled (it's
      // included on standard accounts but not all custom Connect setups).
      // Don't fail the whole reconcile if search isn't available.
      log.push({ paymentIntentsSearchError: e.message });
    }

    const updated = await adminGet(`/sales/${saleId}`);
    return res.status(200).json({
      ok: true,
      sale: { id: saleId, paid: updated?.paid || false, schedule: updated?.schedule || [] },
      log,
    });
  } catch (e) {
    console.error("reconcile-sale-payments error:", e);
    return res.status(500).json({ error: e.message, log });
  }
}
