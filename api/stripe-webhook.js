// Stripe webhook receiver. Fires when a PaymentIntent succeeds — marks the
// corresponding /sales/{saleId} record as paid in Firebase and posts a
// notification to the #sales Slack channel.
//
// IMPORTANT: Stripe signs the raw request body. Vercel's default body parser
// would rewrite the bytes and break signature verification, so we export
// `config.api.bodyParser = false` and read the raw stream ourselves.

import Stripe from "stripe";
import { adminPatch } from "./_fb-admin.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
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
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      const saleId = intent.metadata?.saleId;
      if (!saleId) {
        console.warn("payment_intent.succeeded with no saleId metadata:", intent.id);
        return res.status(200).json({ received: true, ignored: true });
      }

      await adminPatch(`/sales/${saleId}`, {
        paid: true,
        paidAt: new Date().toISOString(),
        stripePaymentIntentId: intent.id,
        amountReceived: intent.amount_received / 100,
        // Clear the dedup cache field set by create-payment-intent —
        // the paid check happens first on subsequent calls, but
        // leaving this stale is confusing during debugging.
        stripeActiveIntentId: null,
      });

      const slackUrl = process.env.SLACK_SALES_WEBHOOK_URL;
      if (slackUrl) {
        const amount = (intent.amount_received / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
        const clientName = intent.metadata?.clientName || "Unknown";
        const pkg = `${intent.metadata?.videoType || "?"} · ${intent.metadata?.packageKey || "?"}`;
        const text = `:moneybag: *Deposit received* — *${clientName}* paid ${amount}\n> ${pkg}`;
        fetch(slackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
          .catch(e => console.error("Slack notify failed:", e.message));
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    return res.status(500).json({ error: e.message });
  }
}
