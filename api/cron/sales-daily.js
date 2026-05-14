// api/cron/sales-daily.js
//
// Daily 09:00 Sydney cron that auto-charges due "auto"-trigger
// instalments on Custom-videoType sales. Mirrors the auth + Sydney-9
// gate pattern from api/cron/daily-09.js (twin UTC 22:00 + 23:00
// entries so one always lands on Sydney 09 year-round through DST).
//
// What it does:
//   1. Loads /sales.
//   2. For every Custom sale with a paid deposit (schedule[0] paid),
//      finds any pending "auto"-trigger slice whose dueDateKeySydney
//      is on or before today (Sydney).
//   3. Atomically claims that slice via an RTDB transaction —
//      pending → processing — recording an autoAttemptKey. Only
//      one cron instance can win; everyone else skips.
//   4. Charges the saved card off-session with
//      idempotencyKey = `custom-auto:${autoAttemptKey}:${amountCents}`.
//   5. On success: stripe-webhook flips the slice to paid.
//      On caught Stripe error: rolls processing → declined, sets
//      lastDeclineAt/Message, Slack-pings.
//
// Why "atomic claim" — the cron may overlap with a founder manually
// clicking "Charge" or another cron run; without the RTDB transaction
// both could enter the Stripe charge path simultaneously. Stripe's
// idempotency key would catch the exact same key, but a stale schedule
// + a fresh autoAttemptKey could produce two different keys for the
// same physical due slice. The transaction is the real lock.
//
// Auth: identical to daily-09 — Vercel cron header OR `?secret`.

import Stripe from "stripe";
import { adminGet, adminPatch, runRtdbTransaction } from "../_fb-admin.js";

function sydneyHour() {
  return parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Sydney",
      hour: "2-digit", hour12: false,
    }).format(new Date()),
    10
  );
}

function sydneyTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
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
  // Auth — Vercel cron header OR ?secret=$CRON_TEST_SECRET (manual test).
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const querySecret = (typeof req.query?.secret === "string"
    ? req.query.secret
    : new URL(req.url, "http://x").searchParams.get("secret")) || "";
  const expectedSecret = process.env.CRON_TEST_SECRET || "";
  const secretValid = !!expectedSecret && querySecret === expectedSecret;
  if (!isVercelCron && !secretValid) {
    return res.status(401).json({ error: "Cron header or valid ?secret required" });
  }

  const url = new URL(req.url, "http://x");
  const force = secretValid && url.searchParams.get("force") === "1";
  const dryRun = secretValid && url.searchParams.get("dryRun") === "1";

  if (!force) {
    const hr = sydneyHour();
    if (hr !== 9) {
      return res.status(200).json({ ok: true, skipped: "wrong_hour", sydneyHour: hr });
    }
  }

  const today = sydneyTodayKey();
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });
  }
  const stripe = new Stripe(stripeSecret);

  let sales;
  try {
    sales = (await adminGet("/sales")) || {};
  } catch (e) {
    console.error("sales-daily: /sales load failed:", e.message);
    return res.status(500).json({ error: `sales load failed: ${e.message}` });
  }

  const summary = {
    today,
    scanned: 0,
    claimed: 0,
    charged: 0,
    declined: 0,
    skipped: 0,
    dryRun,
  };

  for (const [saleId, sale] of Object.entries(sales)) {
    if (!sale || typeof sale !== "object") continue;
    if (sale.videoType !== "custom") continue;
    const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
    if (!schedule.length) continue;
    if (schedule[0].status !== "paid") continue;       // need deposit first
    summary.scanned++;

    for (let i = 1; i < schedule.length; i++) {
      const slice = schedule[i];
      if (!slice) continue;
      if (slice.status !== "pending") continue;
      if (slice.trigger !== "auto") continue;
      const dueKey = slice.dueDateKeySydney || "";
      if (!dueKey || dueKey > today) continue;          // not yet due

      if (dryRun) {
        summary.skipped++;
        continue;
      }

      // ── Atomic claim via RTDB transaction ──────────────────────────
      // Only one writer can win the pending → processing flip; everyone
      // else falls through with `committed: false` and we skip them.
      const sliceId = slice.sliceId;
      const nowIso = new Date().toISOString();
      const autoAttemptKey = `${saleId}:${sliceId || `idx-${i}`}:${nowIso}`;

      let claimed = false;
      try {
        const result = await runRtdbTransaction(`/sales/${saleId}/schedule`, (current) => {
          if (!Array.isArray(current)) return undefined;
          const idx = sliceId
            ? current.findIndex(s => s && s.sliceId === sliceId)
            : i;
          if (idx === -1 || !current[idx]) return undefined;
          if (current[idx].status !== "pending") return undefined; // someone else won
          const next = current.slice();
          next[idx] = {
            ...next[idx],
            status: "processing",
            autoAttemptKey,
            processingStartedAt: nowIso,
          };
          return next;
        });
        claimed = !!result.committed;
      } catch (txErr) {
        console.error(`sales-daily: claim transaction failed for ${saleId} slice ${sliceId || i}:`, txErr.message);
        continue;
      }
      if (!claimed) {
        summary.skipped++;
        continue;
      }
      summary.claimed++;

      // ── Charge off-session ─────────────────────────────────────────
      const customerId = sale.stripeCustomerId;
      const paymentMethodId = sale.stripePaymentMethodId;
      if (!customerId || !paymentMethodId) {
        // Revert the claim — there's no card to charge.
        await revertClaim(saleId, sliceId, i, autoAttemptKey, "No saved card on customer", null);
        await slackNotify(`:warning: *Custom auto-charge skipped* — ${sale.clientName || saleId} · ${slice.label}: no saved card on Stripe customer. Send a new payment link.`);
        summary.declined++;
        continue;
      }

      const amountCents = Math.round(Number(slice.amount) * 100);
      if (!amountCents || amountCents <= 0) {
        await revertClaim(saleId, sliceId, i, autoAttemptKey, "Invalid slice amount", null);
        summary.declined++;
        continue;
      }

      const descriptorBase = `Viewix — ${sale.clientName} — custom/custom`;

      try {
        const pi = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "aud",
          customer: customerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          description: `${descriptorBase} — ${slice.label || `Slice ${i}`}`,
          metadata: {
            saleId,
            shortId: sale.shortId || "",
            clientName: sale.clientName || "",
            videoType: "custom",
            packageKey: "custom",
            sliceIdx: String(i),
            sliceId: sliceId || "",
            source: "cron",
          },
        }, {
          idempotencyKey: `custom-auto:${autoAttemptKey}:${amountCents}`,
        });

        if (pi.status === "succeeded") {
          // Webhook will mark paid. If the webhook is delayed or
          // misfires, reconcile-sale-payments can still resolve it.
          summary.charged++;
        } else if (pi.status === "requires_action") {
          // SCA — record as declined-with-auth-required so the
          // dashboard surfaces a retry that prompts an email.
          await revertClaim(saleId, sliceId, i, autoAttemptKey, "Authentication required (3DS)", pi.id);
          await slackNotify(`:lock: *Custom auto-charge needs SCA* — ${sale.clientName || saleId} · ${slice.label}: customer's bank wants 3DS re-auth. Email them and retry from the dashboard.`);
          summary.declined++;
        } else {
          await revertClaim(saleId, sliceId, i, autoAttemptKey, `Unexpected PI status: ${pi.status}`, pi.id);
          summary.declined++;
        }
      } catch (stripeErr) {
        // Most off-session failures throw synchronously here; the webhook
        // payment_intent.payment_failed is a secondary path.
        const piId = stripeErr?.raw?.payment_intent?.id || stripeErr?.payment_intent?.id || null;
        await revertClaim(saleId, sliceId, i, autoAttemptKey, stripeErr?.message || String(stripeErr), piId);
        const amountDisp = (amountCents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
        await slackNotify(`:no_entry: *Custom auto-charge declined* — ${sale.clientName || saleId} · ${slice.label} (${amountDisp}): ${stripeErr?.message || stripeErr}. Retry from the dashboard once resolved.`);
        summary.declined++;
      }
    }
  }

  return res.status(200).json({ ok: true, ...summary });

  // ─── Helper: roll processing → declined and clear autoAttemptKey ──
  async function revertClaim(saleId, sliceId, fallbackIdx, expectedAttemptKey, message, piId) {
    try {
      await runRtdbTransaction(`/sales/${saleId}/schedule`, (current) => {
        if (!Array.isArray(current)) return undefined;
        const idx = sliceId
          ? current.findIndex(s => s && s.sliceId === sliceId)
          : fallbackIdx;
        if (idx === -1 || !current[idx]) return undefined;
        // Guard: only revert OUR claim — if a webhook already flipped
        // it paid, leave it alone.
        if (current[idx].status === "paid" || current[idx].status === "refunded") return undefined;
        if (current[idx].autoAttemptKey && current[idx].autoAttemptKey !== expectedAttemptKey) return undefined;
        const next = current.slice();
        next[idx] = {
          ...next[idx],
          status: "declined",
          lastDeclineAt: new Date().toISOString(),
          lastDeclineMessage: message || "Decline",
          ...(piId ? { stripePaymentIntentId: piId } : {}),
          autoAttemptKey: null,
          processingStartedAt: null,
        };
        return next;
      });
    } catch (e) {
      console.error(`sales-daily: revertClaim failed for ${saleId}:`, e.message);
    }
  }
}
