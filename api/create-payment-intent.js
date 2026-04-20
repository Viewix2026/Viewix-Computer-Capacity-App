// Creates a Stripe PaymentIntent for a sale record's deposit.
// Called by SalePublicView when the customer opens /s/{shortId}/{slug}.
// The amount is read server-side from Firebase — never trusted from the
// client — so a tampered payload can't change the charge amount.

import Stripe from "stripe";
import { adminGet } from "./_fb-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  try {
    const { saleId } = req.body || {};
    if (!saleId) return res.status(400).json({ error: "saleId required" });

    const sale = await adminGet(`/sales/${saleId}`);
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.paid) return res.status(400).json({ error: "Sale already paid" });
    const amount = Number(sale.depositAmount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit amount" });

    const stripe = new Stripe(secret);
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "aud",
      automatic_payment_methods: { enabled: true },
      description: `Viewix deposit — ${sale.clientName} — ${sale.videoType}/${sale.packageKey}`,
      metadata: {
        saleId: sale.id,
        shortId: sale.shortId || "",
        clientName: sale.clientName || "",
        videoType: sale.videoType || "",
        packageKey: sale.packageKey || "",
      },
    });

    return res.status(200).json({ clientSecret: intent.client_secret });
  } catch (e) {
    console.error("create-payment-intent error:", e);
    return res.status(500).json({ error: e.message });
  }
}
