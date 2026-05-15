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
import { buildCustomSchedule } from "./_sale-schedules.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// Mark a specific slice paid on the sale record. Resolves the target
// slice by `sliceId` first (Custom sales use it as stable identity),
// falling back to `sliceIdx` for legacy preset sales whose Stripe
// metadata predates sliceId. Keeps the schedule array immutable-ish
// and sets top-level `paid: true` iff every slice is paid.
//
// For Custom slice 0 (deposit), also re-anchor the rest of the
// schedule to the actual paid timestamp so future dueAt values reflect
// when the deposit truly cleared (clients sometimes pay days late).
async function markSlicePaid(saleId, { sliceId, sliceIdx } = {}, patch = {}) {
  const sale = await adminGet(`/sales/${saleId}`);
  if (!sale) {
    console.warn("markSlicePaid: sale not found:", saleId);
    return;
  }
  const schedule = Array.isArray(sale.schedule) ? [...sale.schedule] : [];

  // Resolve target row: sliceId is stable identity; sliceIdx is fallback.
  let targetIdx = -1;
  if (sliceId) {
    targetIdx = schedule.findIndex(s => s && s.sliceId === sliceId);
  }
  if (targetIdx === -1 && sliceIdx !== undefined && sliceIdx !== null) {
    const n = Number(sliceIdx);
    if (Number.isInteger(n) && n >= 0 && schedule[n]) targetIdx = n;
  }
  if (targetIdx === -1) {
    console.warn(`markSlicePaid: no matching slice on sale ${saleId} (sliceId=${sliceId}, sliceIdx=${sliceIdx})`);
    return;
  }

  // Idempotency — Stripe retries webhook deliveries; never double-count.
  if (schedule[targetIdx].status === "paid") {
    return { allPaid: schedule.every(s => s.status === "paid"), slice: schedule[targetIdx] };
  }

  schedule[targetIdx] = {
    ...schedule[targetIdx],
    status: "paid",
    paidAt: new Date().toISOString(),
    ...patch,
  };

  // Custom: when the deposit (idx 0) clears, re-anchor the rest of the
  // schedule to depositPaidAt. mergeScheduleState() inside buildCustomSchedule
  // preserves the just-paid deposit row verbatim, so we never lose
  // receiptUrl or stripePaymentIntentId.
  const isCustom = sale.videoType === "custom";
  const isDeposit = targetIdx === 0;
  let nextSchedule = schedule;
  let extraPatch = {};
  if (isCustom && isDeposit) {
    const depositPaidAt = schedule[0].paidAt;
    extraPatch.depositPaidAt = depositPaidAt;
    try {
      nextSchedule = buildCustomSchedule(sale.customSlices || [], {
        depositAnchorDate: depositPaidAt,
        existingSchedule: schedule,
      });
    } catch (e) {
      console.error("Custom re-anchor failed:", e.message);
      // Keep the original schedule with the just-paid deposit; don't fail the webhook.
      nextSchedule = schedule;
    }
  }

  const allPaid = nextSchedule.every(s => s.status === "paid");
  await adminPatch(`/sales/${saleId}`, {
    schedule: nextSchedule,
    paid: allPaid,
    ...(allPaid ? { paidAt: new Date().toISOString() } : {}),
    ...extraPatch,
  });
  // Return the slice from the schedule we actually wrote back.
  const writtenSlice = nextSchedule.find(s => s.sliceId === schedule[targetIdx].sliceId) || schedule[targetIdx];
  return { allPaid, slice: writtenSlice };
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
  // Multi-secret support — try every webhook signing secret in env
  // until one verifies. Lets us run BOTH a test-mode AND live-mode
  // Stripe webhook destination off the same Vercel deployment without
  // having to rotate env vars when toggling modes. Order doesn't
  // matter; we accept the first one that verifies.
  //
  //   STRIPE_WEBHOOK_SECRET       — primary / single-mode setup
  //   STRIPE_WEBHOOK_SECRET_TEST  — test/sandbox destination
  //   STRIPE_WEBHOOK_SECRET_LIVE  — live destination
  const webhookSecrets = [
    { mode: "any", value: process.env.STRIPE_WEBHOOK_SECRET },
    { mode: "test", value: process.env.STRIPE_WEBHOOK_SECRET_TEST },
    { mode: "live", value: process.env.STRIPE_WEBHOOK_SECRET_LIVE },
  ].filter(s => s.value);
  if (!secret || webhookSecrets.length === 0) {
    return res.status(500).json({ error: "Stripe env vars not configured" });
  }

  const stripe = new Stripe(secret);
  const sig = req.headers["stripe-signature"];
  let event;
  let lastErr;
  let matchedMode = null;
  try {
    const raw = await readRawBody(req);
    for (const ws of webhookSecrets) {
      try {
        event = stripe.webhooks.constructEvent(raw, sig, ws.value);
        matchedMode = ws.mode;
        break; // verified — stop trying
      } catch (e) {
        lastErr = e;
      }
    }
    if (!event) throw lastErr || new Error("No matching webhook secret");
  } catch (e) {
    console.error("Webhook signature verification failed:", e.message);
    return res.status(400).json({ error: `Webhook Error: ${e.message}` });
  }

  if ((matchedMode === "live" && !event.livemode) || (matchedMode === "test" && event.livemode)) {
    console.warn("Stripe webhook livemode mismatch rejected:", { id: event.id, type: event.type, matchedMode, livemode: event.livemode });
    return res.status(400).json({ error: "Webhook mode mismatch" });
  }

  // Freshness window — secondary defence against replay. Stripe's
  // signature layer (`stripe.webhooks.constructEvent` above) already
  // rejects requests whose Stripe-Signature timestamp is older than
  // 5 minutes; this window guards against re-processing a stale
  // *business event* (e.g. someone re-feeding a captured event into
  // a test/live mix-up days later). 24h is wide enough to accommodate
  // Stripe's own legitimate retry policy, which can deliver events
  // hours after the original `event.created` for failed deliveries.
  // Tightening this further would reject real retries.
  const FRESHNESS_WINDOW_SECS = 24 * 60 * 60;
  if (event.created && (Date.now() / 1000 - event.created) > FRESHNESS_WINDOW_SECS) {
    console.warn("Stale webhook event rejected:", { id: event.id, type: event.type, ageSecs: Math.round(Date.now() / 1000 - event.created) });
    return res.status(400).json({ error: "Stale event (older than 24 hours)" });
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

      // Existence check — adminPatch (Firebase update()) creates the
      // path if it doesn't exist, which would resurrect a sale the
      // founder deleted from the dashboard. Stripe retries failed
      // events for days, so a delayed retry of an old event for a
      // since-deleted sale would silently re-create it. Skip if gone.
      const existing = await adminGet(`/sales/${saleId}`);
      if (!existing) {
        console.warn("checkout.session.completed for deleted sale, skipping:", saleId);
        return res.status(200).json({ received: true, ignored: "sale deleted" });
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
      const sliceId  = intent.metadata?.sliceId;
      if (!saleId || (sliceIdx === undefined && !sliceId)) {
        // Subscription invoice PIs land here too — ignore.
        return res.status(200).json({ received: true, ignored: "no sliceIdx/sliceId metadata" });
      }

      // Receipt URL lives on the Charge, not the PaymentIntent. Stripe
      // puts the latest charge id on intent.latest_charge — one extra
      // round-trip to fetch the Charge gets us the receipt_url we
      // surface on the thank-you page's Download Receipt button.
      let receiptUrl = null;
      if (intent.latest_charge) {
        try {
          const charge = await stripe.charges.retrieve(intent.latest_charge);
          receiptUrl = charge.receipt_url || null;
        } catch (e) {
          console.error("Failed to load charge for receipt_url:", e.message);
        }
      }

      const result = await markSlicePaid(saleId, { sliceId, sliceIdx }, {
        stripePaymentIntentId: intent.id,
        amountPaid: intent.amount_received / 100,
        receiptUrl,
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

      // invoice_pdf is the direct download URL; hosted_invoice_url is
      // the branded Stripe-hosted page with a PDF download button.
      // Prefer invoice_pdf so Download Receipt opens straight to the
      // PDF; fall back to hosted_invoice_url for older invoices where
      // the PDF isn't ready yet.
      const result = await markSlicePaid(saleId, { sliceIdx }, {
        stripeInvoiceId: invoice.id,
        amountPaid: invoice.amount_paid / 100,
        receiptUrl: invoice.invoice_pdf || invoice.hosted_invoice_url || null,
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
    // Fires when the subscription fully ends. Two cases:
    //   (a) Happy path — fired AFTER our cancel_at_period_end was set
    //       on the final invoice. All slices already paid. Just flip
    //       stripeSubscriptionActive=false for cleanliness.
    //   (b) Mid-plan cancellation — sub died before all invoices ran
    //       (manual cancel in Stripe Dashboard, dunning failure
    //       exhausting retries, customer's bank declining). Some
    //       slices remain "pending" forever; sale.paid never flips
    //       true; dashboard shows "2/3 PAID" indefinitely.
    //
    // For (b) we mark unpaid slices as "cancelled" so the allPaid
    // calculation can resolve and the UI shows the truth.
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const saleId = sub.metadata?.saleId;
      if (saleId) {
        const existing = await adminGet(`/sales/${saleId}`);
        if (existing) {
          const schedule = Array.isArray(existing.schedule) ? [...existing.schedule] : [];
          let cancelledCount = 0;
          const updatedSchedule = schedule.map(s => {
            if (s.status === "pending") {
              cancelledCount++;
              return { ...s, status: "cancelled", cancelledAt: new Date().toISOString() };
            }
            return s;
          });
          // allDone now means every slice is either paid OR cancelled
          // (i.e. the schedule has reached a terminal state).
          const allDone = updatedSchedule.every(s => s.status === "paid" || s.status === "cancelled");
          await adminPatch(`/sales/${saleId}`, {
            schedule: updatedSchedule,
            stripeSubscriptionActive: false,
            // Only set top-level paid=true if every slice paid (no
            // cancellations). A partial-paid + cancelled sale stays
            // paid: false so it shows up in "AWAITING" filters.
            ...(updatedSchedule.every(s => s.status === "paid") ? { paid: true, paidAt: new Date().toISOString() } : {}),
          });
          if (cancelledCount > 0) {
            await slackNotify(`:warning: *Subscription ended early* — ${sub.metadata?.clientName || saleId} · ${cancelledCount} unpaid instalment(s) marked cancelled. Subscription died mid-plan (manual cancel, dunning failure, or expired card). Reconcile in Stripe Dashboard.`);
          }
        }
      }
    }

    // ─── charge.refunded ───────────────────────────────────────────
    // A refund was issued (full or partial) on a previously-paid
    // charge. Flip the matching slice from "paid" to "refunded" so
    // the dashboard reflects the truth and the customer doesn't see
    // a stale PAID badge. Also drops the top-level paid flag if any
    // slice goes back to non-paid.
    if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const saleId = charge.metadata?.saleId;
      const sliceIdx = charge.metadata?.sliceIdx;
      const sliceId  = charge.metadata?.sliceId;
      // Refund metadata may live on the charge OR on the underlying
      // PaymentIntent. Subscription invoice charges put metadata on
      // the invoice, not the charge — try the PI as a fallback.
      let resolvedSaleId = saleId;
      let resolvedSliceIdx = sliceIdx;
      let resolvedSliceId  = sliceId;
      if ((!resolvedSaleId || (resolvedSliceIdx === undefined && !resolvedSliceId)) && charge.payment_intent) {
        try {
          const pi = await stripe.paymentIntents.retrieve(charge.payment_intent);
          resolvedSaleId = resolvedSaleId || pi.metadata?.saleId;
          resolvedSliceIdx = resolvedSliceIdx !== undefined ? resolvedSliceIdx : pi.metadata?.sliceIdx;
          resolvedSliceId = resolvedSliceId || pi.metadata?.sliceId;
        } catch (e) {
          console.error("charge.refunded: failed to load PI:", e.message);
        }
      }
      if (!resolvedSaleId || (resolvedSliceIdx === undefined && !resolvedSliceId)) {
        return res.status(200).json({ received: true, ignored: "no saleId/sliceIdx on refund" });
      }
      const existing = await adminGet(`/sales/${resolvedSaleId}`);
      if (!existing) {
        return res.status(200).json({ received: true, ignored: "sale deleted" });
      }
      const schedule = Array.isArray(existing.schedule) ? [...existing.schedule] : [];
      let idx = -1;
      if (resolvedSliceId) idx = schedule.findIndex(s => s && s.sliceId === resolvedSliceId);
      if (idx === -1 && resolvedSliceIdx !== undefined) {
        const n = Number(resolvedSliceIdx);
        if (Number.isInteger(n) && n >= 0 && schedule[n]) idx = n;
      }
      if (idx === -1) {
        return res.status(200).json({ received: true, ignored: "no slice match" });
      }
      // Idempotent — if already marked refunded, skip.
      if (schedule[idx].status === "refunded") {
        return res.status(200).json({ received: true, ignored: "already refunded" });
      }
      schedule[idx] = {
        ...schedule[idx],
        status: "refunded",
        refundedAt: new Date().toISOString(),
        refundedAmount: (charge.amount_refunded || 0) / 100,
      };
      await adminPatch(`/sales/${resolvedSaleId}`, {
        schedule,
        // Top-level paid is no longer true if any slice is non-paid.
        paid: false,
        paidAt: null,
      });
      const amount = ((charge.amount_refunded || 0) / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
      const clientName = existing.clientName || "a customer";
      await slackNotify(`:rewind: *Refund issued* — ${clientName} · ${amount} for ${schedule[idx].label || `slice ${idx}`}. Sale row updated.`);
    }

    // ─── payment_intent.payment_failed ─────────────────────────────
    // Off-session PaymentIntents (cron auto-charge, founder retry)
    // raise this event when Stripe processes the charge async and it
    // fails. Note: many off-session failures throw SYNCHRONOUSLY from
    // paymentIntents.create() — cron and charge-sale-balance write
    // decline state directly on those, so this webhook is a secondary
    // path that catches async failures only.
    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object;
      const saleId = intent.metadata?.saleId;
      const sliceId = intent.metadata?.sliceId;
      const sliceIdx = intent.metadata?.sliceIdx;
      if (saleId && (sliceId || sliceIdx !== undefined)) {
        const existing = await adminGet(`/sales/${saleId}`);
        if (existing) {
          const schedule = Array.isArray(existing.schedule) ? [...existing.schedule] : [];
          let idx = -1;
          if (sliceId) idx = schedule.findIndex(s => s && s.sliceId === sliceId);
          if (idx === -1 && sliceIdx !== undefined) {
            const n = Number(sliceIdx);
            if (Number.isInteger(n) && n >= 0 && schedule[n]) idx = n;
          }
          if (idx !== -1 && schedule[idx].status !== "paid" && schedule[idx].status !== "refunded") {
            schedule[idx] = {
              ...schedule[idx],
              status: "declined",
              lastDeclineAt: new Date().toISOString(),
              lastDeclineMessage: intent.last_payment_error?.message || "Payment failed",
              stripePaymentIntentId: intent.id,
              // Clear the in-flight attempt key so retries are clean.
              autoAttemptKey: null,
            };
            await adminPatch(`/sales/${saleId}`, { schedule });
            const amount = ((intent.amount || 0) / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
            const clientName = existing.clientName || "a customer";
            const label = schedule[idx].label || `slice ${idx}`;
            await slackNotify(`:no_entry: *Off-session charge failed* — ${clientName} · ${label} ${amount}. Card declined or auth required. Use 'Charge' / 'Retry' in the Sales tab once it's resolved.`);
          }
        }
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
