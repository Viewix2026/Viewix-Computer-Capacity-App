// Creates a Stripe PaymentIntent for a sale record's deposit.
// Called by SalePublicView when the customer opens /s/{shortId}/{slug}.
// The amount is read server-side from Firebase — never trusted from the
// client — so a tampered payload can't change the charge amount.
//
// Hardening (pre-live-mode, audit 2026-04):
//   1. Per-IP rate limit — 10 requests/minute sliding window, enforced
//      in-memory per serverless instance. Cold starts reset; attackers
//      would need to cycle through cold instances to bypass, which
//      doesn't scale for anyone but us (and even we don't).
//   2. Intent dedup — if a sale already has an active intent with the
//      same amount that isn't succeeded/canceled, return THAT client
//      secret instead of minting a new one. Stops casual spam from
//      cluttering the Stripe dashboard + burning Stripe API quota.

import Stripe from "stripe";
import { adminGet, adminPatch } from "./_fb-admin.js";

// ─── In-memory per-IP rate limiter ─────────────────────────────────
// Map key: client IP. Value: { count, windowStart }. Window rolls on
// the first hit past the 60s boundary. Survives warm-instance cold
// starts only — that's fine for a cost-control guardrail, not a
// security boundary.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const rateLimits = new Map();
function checkRate(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimits.set(ip, entry);
  // Opportunistic cleanup — drop stale entries so the Map can't grow
  // unbounded across a long-lived warm instance.
  if (rateLimits.size > 500) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  // Rate limit before touching Stripe or Firebase — keeps a flood from
  // even hitting our upstream APIs.
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
    const amount = Number(sale.depositAmount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit amount" });

    const stripe = new Stripe(secret);
    const amountCents = Math.round(amount * 100);

    // Reuse-existing-intent path — the common case when a customer
    // opens the link, gets distracted, refreshes 20 minutes later.
    // Stripe's /retrieve is cheap and returns the client_secret on
    // still-pending intents; we only mint a new one if the old one
    // is gone or the amount has changed since (founder edited the
    // deposit default mid-flow).
    if (sale.stripeActiveIntentId) {
      try {
        const existing = await stripe.paymentIntents.retrieve(sale.stripeActiveIntentId);
        const canReuse =
          existing &&
          existing.status !== "succeeded" &&
          existing.status !== "canceled" &&
          existing.amount === amountCents;
        if (canReuse) {
          return res.status(200).json({ clientSecret: existing.client_secret, reused: true });
        }
      } catch {
        // Intent doesn't exist any more, or Stripe had a transient error —
        // fall through and mint a new one.
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
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

    // Cache the intent id on the sale so subsequent requests can
    // dedup. Writing via adminPatch (not set) so we don't clobber
    // other sale fields.
    try {
      await adminPatch(`/sales/${saleId}`, { stripeActiveIntentId: intent.id });
    } catch (writeErr) {
      // Non-fatal — if the write fails we'll just mint a fresh intent
      // next time. Log and carry on.
      console.error("Failed to cache stripeActiveIntentId:", writeErr.message);
    }

    return res.status(200).json({ clientSecret: intent.client_secret });
  } catch (e) {
    console.error("create-payment-intent error:", e);
    return res.status(500).json({ error: e.message });
  }
}
