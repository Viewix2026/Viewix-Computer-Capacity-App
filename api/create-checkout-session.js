// Create a Stripe Embedded Checkout Session for a Sale record.
//
// Replaces the old create-payment-intent flow with one that:
//   1. Creates / reuses a Stripe Customer per sale so the card saves
//      for later off-session charges (Meta Ads manual balance; Social
//      Media auto-payments 2 and 3).
//   2. Picks the right `mode` from the sale's billing schedule:
//        deposit_plus_manual  → mode: "payment" with
//                                setup_future_usage: "off_session"
//                                (first slice charges now, card saved,
//                                Charge Balance endpoint handles slice 2)
//        subscription_monthly → mode: "subscription" with a monthly
//                                recurring price — Stripe fires 3
//                                consecutive invoices. The webhook caps
//                                the subscription at 3 cycles via
//                                cancel_at_period_end on the 3rd invoice.
//        paid_in_full         → mode: "payment" (no save-card needed)
//   3. Returns { clientSecret } that the SalePublicView mounts into
//      Stripe's <EmbeddedCheckout> iframe.
//
// Amount is read server-side from Firebase — the client never sends it.
// Rate limit + intent dedup mirror the hardening that was on the old
// create-payment-intent endpoint.

import Stripe from "stripe";
import { adminGet, adminPatch } from "./_fb-admin.js";
import { scheduleForVideoType, GST_RATE } from "./_tiers.js";

// ─── Rate limiter (same shape as create-payment-intent) ────────────
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const rateLimits = new Map();
let cleanupCounter = 0;
function checkRate(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimits.set(ip, entry);
  if (++cleanupCounter >= 100) {
    cleanupCounter = 0;
    for (const [k, v] of rateLimits) {
      if (now - v.windowStart > RATE_WINDOW_MS * 2) rateLimits.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

// Get or create a Stripe Customer for this sale. The Customer is
// reused across subsequent off-session charges (Meta Ads balance,
// Social Media scheduled payments). Email is captured from Checkout
// during the customer's entry — we don't have it pre-checkout so the
// initial Customer is "anonymous" with saleId metadata.
async function getOrCreateCustomer(stripe, sale) {
  if (sale.stripeCustomerId) {
    try {
      const c = await stripe.customers.retrieve(sale.stripeCustomerId);
      if (c && !c.deleted) return c;
    } catch {
      // stale id — fall through and make a fresh one
    }
  }
  const c = await stripe.customers.create({
    name: sale.clientName || "Viewix customer",
    metadata: {
      saleId: sale.id,
      shortId: sale.shortId || "",
      videoType: sale.videoType || "",
      packageKey: sale.packageKey || "",
    },
  });
  await adminPatch(`/sales/${sale.id}`, { stripeCustomerId: c.id });
  return c;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const ip = clientIp(req);
  if (!checkRate(ip)) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  }

  try {
    const { saleId } = req.body || {};
    if (!saleId) return res.status(400).json({ error: "saleId required" });

    const sale = await adminGet(`/sales/${saleId}`);
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.paid) return res.status(400).json({ error: "Sale already paid" });

    // Sanity: we need schedule + first slice amount. Legacy sales with
    // only depositAmount (no schedule) can't use the new Checkout flow
    // until their owner regenerates them from the Sale form.
    const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
    if (schedule.length === 0) {
      return res.status(400).json({ error: "This sale was created before the Total-ex-GST flow. Ask a founder to regenerate the payment link." });
    }
    const firstSlice = schedule[0];
    if (!firstSlice || !firstSlice.amount || firstSlice.amount <= 0) {
      return res.status(400).json({ error: "Invalid first-slice amount on sale record" });
    }

    // Session dedup — if we minted a session for this sale that's
    // still `open`, return its clientSecret instead of creating a new
    // one. Customers refresh, close, come back; a fresh session each
    // time clutters the dashboard and burns quota.
    const stripe = new Stripe(secret);
    if (sale.stripeCheckoutSessionId) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(sale.stripeCheckoutSessionId);
        if (existing && existing.status === "open" && existing.client_secret) {
          return res.status(200).json({ clientSecret: existing.client_secret, reused: true });
        }
      } catch {
        // stale/expired; fall through
      }
    }

    const customer = await getOrCreateCustomer(stripe, sale);
    const cfg = scheduleForVideoType(sale.videoType);

    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["host"]}`;
    const returnUrl = `${origin}/s/${sale.shortId}?session_id={CHECKOUT_SESSION_ID}`;

    const descriptorBase = `Viewix — ${sale.clientName} — ${sale.videoType}/${sale.packageKey}`;

    let session;

    // ── Social Premium / Social Organic: 3-payment subscription ──
    //
    // Strategy: mode: 'subscription' creates a Customer + Subscription
    // in one go. We set the line item to an inline recurring price
    // (monthly AUD) at the slice amount. Stripe fires 3 consecutive
    // invoices on days 0 / 30 / 60. The webhook watches invoice.paid
    // events for this subscription and, on the 3rd one, flips
    // cancel_at_period_end=true so no 4th charge ever fires.
    //
    // GST is tracked via the amount being inclusive; for accounting
    // purposes we emit gst_rate percentage as metadata so our
    // reporting can split it back out. Proper Stripe Tax Rates would
    // be stripe.taxRates.create'd once and referenced here — deferred
    // until we wire up proper AU tax compliance.
    if (cfg.kind === "subscription_monthly") {
      const amountCents = Math.round(firstSlice.amount * 100);
      session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        mode: "subscription",
        customer: customer.id,
        return_url: returnUrl,
        // Stay in the iframe on success — fire onComplete instead of
        // redirecting. Without this, Stripe redirects to return_url
        // which re-renders /s/{shortId} as the deposit form again
        // before our webhook has flipped sale.paid. return_url is
        // still required by Stripe (used for bank redirects / 3DS
        // fallback), but the happy path stays embedded.
        redirect_on_completion: "never",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "aud",
            unit_amount: amountCents,
            recurring: { interval: "month", interval_count: 1 },
            product_data: {
              name: `${descriptorBase} — Payment (${schedule.length}-payment plan)`,
            },
          },
        }],
        subscription_data: {
          description: descriptorBase,
          metadata: {
            saleId: sale.id,
            shortId: sale.shortId || "",
            clientName: sale.clientName || "",
            videoType: sale.videoType || "",
            packageKey: sale.packageKey || "",
            scheduleLen: String(schedule.length),
            gstRate: String(GST_RATE),
          },
        },
        metadata: {
          saleId: sale.id,
          shortId: sale.shortId || "",
          flow: "subscription_monthly",
        },
      });
    }

    // ── Meta Ads / one-offs: deposit + manual balance ──
    //
    // One-time PaymentIntent for the deposit slice. setup_future_usage
    // saves the card against the Customer so the Charge Balance
    // endpoint can run the second slice off-session whenever the
    // founder says "project wrapped".
    else if (cfg.kind === "deposit_plus_manual") {
      const amountCents = Math.round(firstSlice.amount * 100);
      session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        mode: "payment",
        customer: customer.id,
        return_url: returnUrl,
        // Same reason as above — stay embedded, fire onComplete, let
        // our StudioThankYou render on the same page.
        redirect_on_completion: "never",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "aud",
            unit_amount: amountCents,
            product_data: {
              name: `${descriptorBase} — Deposit (50%)`,
            },
          },
        }],
        payment_intent_data: {
          setup_future_usage: "off_session",
          description: `${descriptorBase} — Deposit`,
          metadata: {
            saleId: sale.id,
            shortId: sale.shortId || "",
            clientName: sale.clientName || "",
            videoType: sale.videoType || "",
            packageKey: sale.packageKey || "",
            sliceIdx: "0",
            gstRate: String(GST_RATE),
          },
        },
        metadata: {
          saleId: sale.id,
          shortId: sale.shortId || "",
          flow: "deposit_plus_manual",
        },
      });
    }

    // ── Paid-in-full (not currently used but kept for completeness) ──
    else if (cfg.kind === "paid_in_full") {
      const amountCents = Math.round(firstSlice.amount * 100);
      session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        mode: "payment",
        customer: customer.id,
        return_url: returnUrl,
        // Same reason as above — stay embedded, fire onComplete, let
        // our StudioThankYou render on the same page.
        redirect_on_completion: "never",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "aud",
            unit_amount: amountCents,
            product_data: { name: descriptorBase },
          },
        }],
        payment_intent_data: {
          description: descriptorBase,
          metadata: {
            saleId: sale.id, shortId: sale.shortId || "",
            clientName: sale.clientName || "",
            videoType: sale.videoType || "", packageKey: sale.packageKey || "",
            sliceIdx: "0", gstRate: String(GST_RATE),
          },
        },
        metadata: { saleId: sale.id, shortId: sale.shortId || "", flow: "paid_in_full" },
      });
    }

    else {
      return res.status(400).json({ error: `Unknown schedule kind: ${cfg.kind}` });
    }

    // Cache the session id for the refresh-dedup path above.
    try {
      await adminPatch(`/sales/${sale.id}`, { stripeCheckoutSessionId: session.id });
    } catch (writeErr) {
      console.error("Failed to cache stripeCheckoutSessionId:", writeErr.message);
    }

    return res.status(200).json({ clientSecret: session.client_secret });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    return res.status(500).json({ error: e.message });
  }
}
