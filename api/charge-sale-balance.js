// Charge the next pending slice on a sale off-session. Used by the
// Sale tab's "Charge Balance" button for Meta Ads sales (and any other
// "deposit_plus_manual" schedule) once the project wraps.
//
// The card was saved during the deposit Checkout via
// setup_future_usage='off_session' on the PaymentIntent. This endpoint
// creates a fresh PaymentIntent using that saved PaymentMethod, with
// off_session=true + confirm=true so Stripe attempts immediate charge.
//
// Auth: endpoint is callable only by a signed-in founder. We rely on a
// shared auth header (set in SALE_BALANCE_AUTH env) rather than full
// Firebase auth token validation — shipping-first, hardening later.
// Matches the pattern used by api/preproduction.js.

import Stripe from "stripe";
import { adminGet, adminPatch } from "./_fb-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const authSecret = process.env.SALE_BALANCE_AUTH;
  if (authSecret) {
    const provided = req.headers["x-viewix-auth"];
    if (provided !== authSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const { saleId, sliceIdx } = req.body || {};
    if (!saleId) return res.status(400).json({ error: "saleId required" });
    const idx = Number(sliceIdx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: "sliceIdx required" });

    const sale = await adminGet(`/sales/${saleId}`);
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
    const slice = schedule[idx];
    if (!slice) return res.status(400).json({ error: `sliceIdx ${idx} out of range` });
    if (slice.status === "paid") return res.status(400).json({ error: "Slice already paid" });
    if (slice.trigger !== "manual") {
      return res.status(400).json({ error: `Slice ${idx} is not a manual-trigger slice (trigger=${slice.trigger})` });
    }

    const stripe = new Stripe(secret);
    const amountCents = Math.round(Number(slice.amount) * 100);
    if (!amountCents || amountCents <= 0) return res.status(400).json({ error: "Invalid slice amount" });

    // ── Resolve the PaymentMethod to charge ─────────────────────────
    // Ideally the checkout.session.completed webhook captured both
    // stripeCustomerId and stripePaymentMethodId at deposit time.
    // If the webhook didn't fire (endpoint missing that event in
    // Stripe Dashboard, or transient network fail), we can still
    // recover — Stripe has attached the PM to the Customer itself
    // via setup_future_usage='off_session' on the deposit PI. So
    // fall back to: list the customer's payment methods, use the
    // newest card. This makes the endpoint self-healing and also
    // lets us patch the sale record so next time we don't need the
    // fallback.
    let customerId = sale.stripeCustomerId;
    let paymentMethodId = sale.stripePaymentMethodId;

    // Fallback 1: if customerId isn't on the sale, try to recover
    // from the Checkout Session id we cached during create-session.
    if (!customerId && sale.stripeCheckoutSessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sale.stripeCheckoutSessionId);
        if (session?.customer) customerId = session.customer;
      } catch (e) {
        console.error("charge-balance fallback: failed to load checkout session:", e.message);
      }
    }

    if (!customerId) {
      return res.status(400).json({
        error: "No Stripe customer linked to this sale. The deposit must clear before the balance can be charged.",
      });
    }

    // Fallback 2: if PaymentMethod id isn't on the sale, list the
    // customer's saved cards and use the most recent.
    if (!paymentMethodId) {
      try {
        const list = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 5 });
        if (list.data?.length) {
          // Newest first — Stripe returns in reverse creation order.
          paymentMethodId = list.data[0].id;
          // Backfill the sale record so future charges skip the fallback.
          try {
            await adminPatch(`/sales/${saleId}`, {
              stripePaymentMethodId: paymentMethodId,
              ...(sale.stripeCustomerId === customerId ? {} : { stripeCustomerId: customerId }),
            });
          } catch (e) {
            console.error("charge-balance: failed to backfill PM id on sale:", e.message);
          }
        }
      } catch (e) {
        console.error("charge-balance fallback: failed to list customer PMs:", e.message);
      }
    }

    if (!paymentMethodId) {
      return res.status(400).json({
        error: "No card saved on the Stripe customer. This can happen if the deposit was paid without 'save for future use' — ask the customer to pay the balance via a new payment link instead.",
      });
    }

    const descriptorBase = `Viewix — ${sale.clientName} — ${sale.videoType}/${sale.packageKey}`;

    // off_session + confirm = Stripe tries the charge immediately.
    // If the bank requires SCA, Stripe returns requires_action and
    // the Charge Balance button should surface that so the customer
    // can be emailed to authenticate (handled in a follow-up pass).
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "aud",
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: `${descriptorBase} — ${slice.label || `Slice ${idx}`}`,
      metadata: {
        saleId: sale.id,
        shortId: sale.shortId || "",
        clientName: sale.clientName || "",
        videoType: sale.videoType || "",
        packageKey: sale.packageKey || "",
        sliceIdx: String(idx),
      },
    });

    // Depending on PI status, respond accordingly. The webhook
    // (payment_intent.succeeded) will flip the slice to paid; we
    // don't mutate the schedule here.
    if (pi.status === "succeeded") {
      return res.status(200).json({ ok: true, status: "succeeded", paymentIntentId: pi.id });
    }
    if (pi.status === "requires_action") {
      return res.status(200).json({ ok: false, status: "requires_action", paymentIntentId: pi.id, nextAction: pi.next_action });
    }
    return res.status(200).json({ ok: false, status: pi.status, paymentIntentId: pi.id });
  } catch (e) {
    // Stripe's common off-session-decline shape.
    if (e && e.code === "authentication_required") {
      return res.status(200).json({
        ok: false,
        status: "authentication_required",
        paymentIntentId: e.raw?.payment_intent?.id || null,
        message: "Customer's bank requires 3D Secure re-authentication. Email them to complete the charge.",
      });
    }
    console.error("charge-sale-balance error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
