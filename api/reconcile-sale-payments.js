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
import { adminGet, adminPatch } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

// Mark a single slice paid. Mirrors stripe-webhook.js#markSlicePaid
// but kept inline so reconcile is a self-contained admin path that
// can't be regressed by a webhook refactor.
//
// Resolves the target row by sliceId first (Custom-sale stable id) and
// falls back to sliceIdx for legacy preset sales whose Stripe metadata
// predates sliceId. After any custom row insert/remove/reorder, idx
// alone would attach money to the wrong slice — sliceId is identity.
async function markSlicePaid(saleId, { sliceId, sliceIdx }, patch = {}) {
  const sale = await adminGet(`/sales/${saleId}`);
  if (!sale) return { skipped: "sale gone" };
  const schedule = Array.isArray(sale.schedule) ? [...sale.schedule] : [];

  let idx = -1;
  if (sliceId) idx = schedule.findIndex(s => s && s.sliceId === sliceId);
  if (idx === -1 && sliceIdx !== undefined && sliceIdx !== null) {
    const n = Number(sliceIdx);
    if (Number.isInteger(n) && n >= 0 && schedule[n]) idx = n;
  }
  if (idx === -1) {
    return { skipped: `no matching slice (sliceId=${sliceId || "n/a"}, sliceIdx=${sliceIdx})` };
  }
  if (schedule[idx].status === "paid") return { skipped: "already paid" };

  schedule[idx] = {
    ...schedule[idx],
    status: "paid",
    paidAt: schedule[idx].paidAt || new Date().toISOString(),
    reconciledAt: new Date().toISOString(),  // Marker so we can audit which slices needed reconcile
    ...patch,
  };
  const allPaid = schedule.every(s => s.status === "paid");
  await adminPatch(`/sales/${saleId}`, {
    schedule,
    paid: allPaid,
    ...(allPaid ? { paidAt: new Date().toISOString() } : {}),
  });
  return { marked: idx, sliceId: schedule[idx].sliceId || null, allPaid };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  try {
    await requireRole(req, ["founders", "founder"]);
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
        const result = await markSlicePaid(saleId, { sliceIdx: i }, {
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
      // Paginate Search results — Stripe caps each page at 100 and
      // returns `next_page` when there are more matches. Previously
      // the first 100 PaymentIntents were the only ones reconciled
      // and the rest silently dropped, so a sale with >100 retries
      // could leave later slices stuck pending forever.
      const allPaymentIntents = [];
      let nextPage;
      do {
        const page = await stripe.paymentIntents.search({
          query: `metadata['saleId']:'${saleId}' AND status:'succeeded'`,
          limit: 100,
          ...(nextPage ? { page: nextPage } : {}),
        });
        allPaymentIntents.push(...page.data);
        nextPage = page.next_page || null;
      } while (nextPage);
      log.push({ paymentIntents: allPaymentIntents.length });
      for (const pi of allPaymentIntents) {
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
        const result = await markSlicePaid(saleId, { sliceId, sliceIdx }, {
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
