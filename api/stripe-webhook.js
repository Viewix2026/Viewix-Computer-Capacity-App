// Stripe webhook receiver.
//
// Events we handle:
//
//   payment_intent.succeeded  — Fires for every successful charge. We use
//                               it as the source of truth for slice paid
//                               status across all schedule kinds:
//                                 · Meta Ads deposit (sliceIdx=0)
//                                 · Meta Ads balance  (sliceIdx=1,
//                                    off-session from Charge Balance)
//                                 · one-off paid-in-full (sliceIdx=0)
//                               The PI's metadata.sliceIdx tells us
//                               which slice, metadata.saleId which
//                               record. Subscription invoices also fire
//                               PI.succeeded as a side effect, but their
//                               metadata lives on the invoice not the
//                               PI, so we guard against double-marking
//                               by checking for metadata.sliceIdx.
//
//   invoice.paid              — Fires for each successful subscription
//                               invoice (Social Media 3-payment plan).
//                               We count paid invoices per subscription
//                               and mark the matching schedule slice
//                               paid. On the Nth (final) invoice we set
//                               cancel_at_period_end=true so Stripe
//                               stops after the plan.
//
//   customer.subscription.deleted — fires after the final billing cycle
//                               ends (post-cancel_at_period_end). We
//                               flip the sale's top-level `paid` flag
//                               to true if every slice succeeded.
//
// Stripe signs the raw bytes — we disable Vercel's body parser and
// read the stream ourselves.

import Stripe from "stripe";
import { adminGet, adminPatch } from "./_fb-admin.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// Mark a specific slice paid on the sale record. Keeps the schedule
// array immutable-ish (returns a new copy with the matched slice
// flipped), and sets top-level `paid: true` iff every slice is paid.
async function markSlicePaid(saleId, sliceIdx, patch = {}) {
  const sale = await adminGet(`/sales/${saleId}`);
  if (!sale) {
    console.warn("markSlicePaid: sale not found:", saleId);
    return;
  }
  const schedule = Array.isArray(sale.schedule) ? [...sale.schedule] : [];
  if (!schedule[sliceIdx]) {
    console.warn(`markSlicePaid: sliceIdx ${sliceIdx} out of range on sale ${saleId}`);
    return;
  }
  // Idempotency — if the slice is already paid, skip. Stripe retries
  // webhook deliveries; we must not double-count.
  if (schedule[sliceIdx].status === "paid") {
    return;
  }
  schedule[sliceIdx] = {
    ...schedule[sliceIdx],
    status: "paid",
    paidAt: new Date().toISOString(),
    ...patch,
  };
  const allPaid = schedule.every(s => s.status === "paid");
  await adminPatch(`/sales/${saleId}`, {
    schedule,
    paid: allPaid,
    ...(allPaid ? { paidAt: new Date().toISOString() } : {}),
  });
  return { allPaid, slice: schedule[sliceIdx] };
}

async function slackNotify(text) {
  const slackUrl = process.env.SLACK_SALES_WEBHOOK_URL;
  if (!slackUrl) return;
  try {
    await fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error("Slack notify failed:", e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !webhookSecret) {
    return res.status(500).json({ error: "Stripe env vars not configured" });
  }

  const stripe = new Stripe(secret);
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (e) {
    console.error("Webhook signature verification failed:", e.message);
    return res.status(400).json({ error: `Webhook Error: ${e.message}` });
  }

  try {
    // ─── checkout.session.completed ────────────────────────────────
    // Fires once per Checkout completion. Two jobs:
    //   (a) Capture the saved payment_method on the sale (needed for
    //       off-session Charge Balance and to confirm card-save worked)
    //   (b) For subscription flows: record the subscription id. Slice
    //       payment tracking happens on invoice.paid.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const saleId = session.metadata?.saleId;
      if (!saleId) {
        console.warn("checkout.session.completed missing saleId metadata");
        return res.status(200).json({ received: true, ignored: true });
      }

      const patch = { stripeCheckoutSessionId: null };

      // Capture the PaymentMethod id for future off-session use.
      if (session.payment_intent) {
        try {
          const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
          if (pi.payment_method) patch.stripePaymentMethodId = pi.payment_method;
        } catch (e) {
          console.error("Failed to load PI for PM capture:", e.message);
        }
      }
      if (session.subscription) {
        patch.stripeSubscriptionId = session.subscription;
        // The subscription's default_payment_method is what future
        // charges will use. Capture it now too.
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          if (sub.default_payment_method) {
            patch.stripePaymentMethodId = sub.default_payment_method;
          }
        } catch (e) {
          console.error("Failed to load subscription for PM capture:", e.message);
        }
      }

      await adminPatch(`/sales/${saleId}`, patch);
    }

    // ─── payment_intent.succeeded ──────────────────────────────────
    // Source of truth for non-subscription payments (Meta Ads deposit,
    // Meta Ads balance, one-off paid-in-full). Subscription invoices
    // also generate a PI, but those don't carry sliceIdx metadata, so
    // the guard below skips them — invoice.paid handles those.
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      const saleId  = intent.metadata?.saleId;
      const sliceIdx = intent.metadata?.sliceIdx;
      if (!saleId || sliceIdx === undefined) {
        // Subscription invoice PIs land here too — ignore.
        return res.status(200).json({ received: true, ignored: "no sliceIdx metadata" });
      }

      const result = await markSlicePaid(saleId, Number(sliceIdx), {
        stripePaymentIntentId: intent.id,
        amountPaid: intent.amount_received / 100,
      });

      // Slack notify — "deposit received" for sliceIdx=0,
      //                 "balance received" for later slices.
      const amount = (intent.amount_received / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
      const clientName = intent.metadata?.clientName || "Unknown";
      const pkg = `${intent.metadata?.videoType || "?"} · ${intent.metadata?.packageKey || "?"}`;
      const label = Number(sliceIdx) === 0 ? "Deposit" : "Balance";
      const emoji = Number(sliceIdx) === 0 ? ":moneybag:" : ":white_check_mark:";
      const allDone = result?.allPaid ? " · *project fully paid*" : "";
      await slackNotify(`${emoji} *${label} received* — *${clientName}* paid ${amount}${allDone}\n> ${pkg}`);
    }

    // ─── invoice.paid ──────────────────────────────────────────────
    // Subscription flows — one event per successful monthly invoice.
    // We count them to figure out which slice just paid. On the final
    // one, cancel_at_period_end=true to stop Stripe from billing a
    // 4th cycle.
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (!subId) {
        // Non-subscription invoice — skip.
        return res.status(200).json({ received: true, ignored: "no subscription id" });
      }

      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(subId);
      } catch (e) {
        console.error("invoice.paid: failed to load subscription:", e.message);
        return res.status(200).json({ received: true, error: "subscription fetch failed" });
      }

      const saleId = sub.metadata?.saleId;
      if (!saleId) {
        console.warn("invoice.paid: subscription missing saleId metadata");
        return res.status(200).json({ received: true, ignored: true });
      }

      // Count paid invoices for this subscription to derive sliceIdx.
      // Stripe's invoice listing returns newest-first; paid invoices
      // total = sliceIdx + 1 (1-based). Using `status: paid` filter
      // is safer than relying on billing_reason.
      const allInvoices = await stripe.invoices.list({
        subscription: subId, limit: 10, status: "paid",
      });
      const paidCount = allInvoices.data.length;
      const sliceIdx  = paidCount - 1;
      const scheduleLen = Number(sub.metadata?.scheduleLen || 3);

      const result = await markSlicePaid(saleId, sliceIdx, {
        stripeInvoiceId: invoice.id,
        amountPaid: invoice.amount_paid / 100,
      });

      // Cap the subscription once we've hit the final slice. Stripe
      // will stop after the current period ends (i.e., no 4th
      // invoice). Must be idempotent — if the subscription is already
      // set to cancel, skip.
      if (sliceIdx >= scheduleLen - 1 && !sub.cancel_at_period_end) {
        try {
          await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
        } catch (e) {
          console.error("Failed to set cancel_at_period_end:", e.message);
        }
      }

      // Slack notify.
      const amount = (invoice.amount_paid / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
      const clientName = sub.metadata?.clientName || "Unknown";
      const pkg = `${sub.metadata?.videoType || "?"} · ${sub.metadata?.packageKey || "?"}`;
      const label = `Payment ${sliceIdx + 1} of ${scheduleLen}`;
      const emoji = sliceIdx === 0 ? ":moneybag:" : sliceIdx === scheduleLen - 1 ? ":trophy:" : ":arrows_counterclockwise:";
      const allDone = result?.allPaid ? " · *project fully paid*" : "";
      await slackNotify(`${emoji} *${label} received* — *${clientName}* paid ${amount}${allDone}\n> ${pkg}`);
    }

    // ─── customer.subscription.deleted ─────────────────────────────
    // Fires when the subscription fully ends (after our
    // cancel_at_period_end flip). Clears stripeSubscriptionId so the
    // UI doesn't keep trying to reference it.
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const saleId = sub.metadata?.saleId;
      if (saleId) {
        await adminPatch(`/sales/${saleId}`, { stripeSubscriptionActive: false });
      }
    }

    // ─── invoice.payment_failed ────────────────────────────────────
    // Soft-fails — Stripe retries per our dunning settings. We only
    // ping Slack here so the team knows to chase the customer.
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      let clientName = "a customer";
      if (subId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          clientName = sub.metadata?.clientName || clientName;
        } catch {}
      }
      const amount = (invoice.amount_due / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
      await slackNotify(`:warning: *Payment failed* — ${clientName}'s scheduled charge of ${amount} didn't go through. Stripe will retry automatically; may need a nudge to update the card.`);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    return res.status(500).json({ error: e.message });
  }
}
