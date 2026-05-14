// api/_email/send.js
// Single outbound function for every client touchpoint email.
//
// Responsibilities:
//   1. Global kill switch — `CLIENT_EMAILS_ENABLED=false` short-circuits
//      everything to a no-op (does not write `pending`, does not call
//      Resend). Counters are returned so cron paths can post one
//      summary line per run instead of spamming Slack per-call.
//   2. Atomic idempotency — uses a Firebase RTDB transaction on
//      `/emailLog/{key}` to acquire a `pending` lock. Two concurrent
//      callers can never both send the same email. Stale `pending`
//      locks expire after 60s so a crashed sender doesn't permanently
//      jam the key.
//   3. Render — calls `renderEmailHtml(template, props)` from
//      `./render.js`. Failure here is treated like any other send
//      failure: state goes `failed`, retry is allowed.
//   4. Send — Resend API call. Standard `from: "Viewix
//      <hello@viewix.com.au>"`, reply-to same.
//   5. Dry-run — `EMAIL_DRY_RUN=true` skips Resend, posts the
//      rendered HTML preview to Slack instead. Distinct from the kill
//      switch: dry-run still exercises the full rendering path.
//
// Idempotency key shapes (set by callers, not by this file):
//   /emailLog/{projectId}/Confirmation
//   /emailLog/{projectId}/ShootTomorrow/{subtaskId}/{startDate}
//   /emailLog/{projectId}/InEditSuite
//   /emailLog/{projectId}/ReadyForReview/{videoId || subtaskId}
//
// Failure semantics: a `failed` state record allows the next trigger
// to retry (we don't return early on `failed`, only on `sent`). This
// matters because Resend hiccups, Firebase transients, and bad
// addresses should all self-heal on the next cron / event firing.

import { Resend } from "resend";
import { getAdmin } from "../_fb-admin.js";
import { renderEmailHtml, TEMPLATES } from "./render.js";

const FROM = "Viewix <hello@viewix.com.au>";
const REPLY_TO = "hello@viewix.com.au";
const PENDING_TTL_MS = 60 * 1000; // stale-lock cutoff

// In-process counters so cron callers can log a single summary line
// per run instead of one Slack post per scanned project. The counters
// reset on each cold start which is fine — they're scoped to a
// single invocation, not durable.
function newCounters() {
  return {
    sent: 0,
    skipped_alreadySent: 0,
    skipped_inFlight: 0,
    skipped_killSwitch: 0,
    skipped_dryRun: 0,
    skipped_missing: 0,
    failed: 0,
  };
}

let _resend = null;
function getResend() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

// Slack-log a single line for an event-driven send (Confirmation,
// ReadyForReview). Cron paths post their own summary line and don't
// route through here. Best-effort — never throws.
async function slackLog(line) {
  const url = process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line }),
    });
  } catch (e) {
    console.warn("send.js slackLog failed:", e.message);
  }
}

// Slack-post the rendered HTML preview during dry-run so producers
// can eyeball the actual email body without it leaving the
// boundary. Truncated to 2900 chars (Slack's mrkdwn block limit) so
// long emails don't 400 the post.
async function slackDryRunPreview({ template, key, to, subject, html, projectId }) {
  const url = process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const preview = String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1800);
  const text =
    `:test_tube: *DRY-RUN email* — ${template}\n` +
    `> key: \`${key}\`\n` +
    `> projectId: \`${projectId || "—"}\`\n` +
    `> to: ${to}\n` +
    `> subject: ${subject}\n\n` +
    `\`\`\`${preview}\`\`\``;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("send.js slackDryRunPreview failed:", e.message);
  }
}

// Acquire the `pending` lock atomically. Returns:
//   { acquired: true,  prior: null }                — we got the lock
//   { acquired: false, prior: { state: 'sent' } }   — already sent
//   { acquired: false, prior: { state: 'pending' } }— in flight
//
// The transaction:
//   - bails (returns undefined) if state === 'sent' (no-op forever)
//   - bails if state === 'pending' AND startedAt is fresh
//     (another caller is currently sending)
//   - otherwise writes { state: 'pending', startedAt: now } and
//     wins the lock
//
// Stale `pending` past PENDING_TTL_MS is treated as recoverable —
// presumed crashed/hung — and the new caller takes the lock.
async function acquirePendingLock(key) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  const ref = db.ref(`/emailLog/${key}`);
  const now = Date.now();
  let priorSnapshot = null;
  const tx = await ref.transaction(current => {
    priorSnapshot = current;
    if (current && current.state === "sent") return; // abort
    if (current && current.state === "pending" && (now - (current.startedAt || 0)) < PENDING_TTL_MS) return; // abort
    // Timeout-failure entries indicate the foreground bailed but the
    // background Resend call is still in-flight reconciling. If a
    // webhook retry arrives inside the PENDING_TTL_MS window, we'd
    // otherwise acquire a fresh lock and trigger a duplicate send.
    // Hold the new caller off until the background settles.
    if (current && current.state === "failed" && current.timeout === true && (now - (current.failedAt || 0)) < PENDING_TTL_MS) return; // abort
    return { state: "pending", startedAt: now };
  });
  return {
    acquired: tx.committed,
    prior: priorSnapshot,
  };
}

async function writeLog(key, payload) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  await db.ref(`/emailLog/${key}`).set(payload);
}

/**
 * Send a templated client touchpoint email.
 *
 * @param {object} args
 * @param {string} args.template     - "Confirmation" | "ShootTomorrow" | "InEditSuite" | "ReadyForReview"
 * @param {string} args.idempotencyKey - Path under /emailLog (without leading slash). e.g. "proj-1234/Confirmation".
 * @param {string} args.to           - Recipient email. Required.
 * @param {string} args.subject      - Subject line. Required.
 * @param {object} args.props        - Props passed to the React Email template.
 * @param {string} args.projectId    - For logging context.
 * @param {object} [args.counters]   - Pass a counters object from newCounters() to accumulate across many calls.
 * @param {number} [args.sendTimeoutMs] - If set, the Resend.emails.send() call is raced against this timeout.
 *                                         On timeout, send() returns immediately with state:'failed', reason:'timeout',
 *                                         and writes a `failed` log entry. The original Resend call keeps running
 *                                         in the background — when it eventually completes, the result is reconciled
 *                                         into the log entry (success → overwrites `failed` with `sent`; failure →
 *                                         leaves `failed`). This lets the deal-won webhook bound its own latency to
 *                                         5s while still recording the eventual real outcome of a slow send.
 *                                         Caveat: there is a narrow window (between the foreground timeout and
 *                                         background Resend completion) where a webhook retry could acquire a fresh
 *                                         lock and trigger a duplicate send. Acceptable at our volume; the
 *                                         alternative (AbortSignal-based cancellation) isn't supported by the
 *                                         Resend SDK in 6.x.
 * @returns {Promise<{state:'sent'|'dryRun'|'skipped'|'failed'|'noop', reason?:string, messageId?:string}>}
 */
export async function send({ template, idempotencyKey, to, subject, props, projectId, counters, sendTimeoutMs }) {
  const c = counters; // optional — when null, counters are not bumped

  // Kill switch first. Distinct from dry-run — kill switch halts
  // everything; dry-run still renders + slack-previews.
  if (process.env.CLIENT_EMAILS_ENABLED === "false") {
    if (c) c.skipped_killSwitch++;
    return { state: "noop", reason: "kill_switch" };
  }

  if (!template) return { state: "failed", reason: "missing_template" };
  if (!TEMPLATES[template]) return { state: "failed", reason: `unknown_template: ${template}` };
  if (!idempotencyKey) return { state: "failed", reason: "missing_key" };
  if (!to) {
    if (c) c.skipped_missing++;
    return { state: "skipped", reason: "missing_to" };
  }
  if (!subject) {
    if (c) c.skipped_missing++;
    return { state: "skipped", reason: "missing_subject" };
  }

  // Acquire the lock. If someone already sent, no-op silently.
  let lock;
  try {
    lock = await acquirePendingLock(idempotencyKey);
  } catch (e) {
    console.error("send.js lock error:", e.message);
    if (c) c.failed++;
    return { state: "failed", reason: `lock_error: ${e.message}` };
  }

  if (!lock.acquired) {
    const priorState = lock.prior?.state;
    if (priorState === "sent") {
      if (c) c.skipped_alreadySent++;
      return { state: "skipped", reason: "already_sent" };
    }
    if (c) c.skipped_inFlight++;
    return { state: "skipped", reason: "in_flight" };
  }

  // Render the email. Rendering errors are recoverable — write
  // `failed` so the next trigger retries.
  let html;
  try {
    html = await renderEmailHtml(template, props || {});
  } catch (e) {
    console.error(`send.js render error (${template}):`, e);
    await writeLog(idempotencyKey, {
      state: "failed",
      error: `render: ${e.message}`,
      failedAt: Date.now(),
      template,
      projectId: projectId || null,
    });
    if (c) c.failed++;
    await slackLog(`:rotating_light: Email render failed: ${template} for project ${projectId || "?"} — ${e.message}`);
    return { state: "failed", reason: `render: ${e.message}` };
  }

  // Dry-run: post to Slack, mark state "dryRun" — distinct from real
  // "sent" so the next time we run with EMAIL_DRY_RUN=false the lock
  // does NOT short-circuit and the canary email actually sends. Only
  // a real `state: "sent"` is treated as terminal in lock acquisition
  // (see acquirePendingLock above). Replaying dry-run on the same key
  // re-sends the Slack preview every time — that's the desired
  // testability behaviour.
  if (process.env.EMAIL_DRY_RUN === "true") {
    await slackDryRunPreview({ template, key: idempotencyKey, to, subject, html, projectId });
    await writeLog(idempotencyKey, {
      state: "dryRun",
      template,
      projectId: projectId || null,
      to,
      subject,
      previewedAt: Date.now(),
    });
    if (c) c.skipped_dryRun++;
    return { state: "dryRun", reason: "dry_run" };
  }

  // Real send via Resend.
  const resend = getResend();
  if (!resend) {
    await writeLog(idempotencyKey, {
      state: "failed",
      error: "RESEND_API_KEY not configured",
      failedAt: Date.now(),
      template,
      projectId: projectId || null,
    });
    if (c) c.failed++;
    await slackLog(`:rotating_light: RESEND_API_KEY missing — ${template} not sent for project ${projectId || "?"}`);
    return { state: "failed", reason: "no_api_key" };
  }

  // Foreground/background reconciliation for sendTimeoutMs paths.
  // `timedOut` is the foreground signal: once we've returned to the
  // caller with a `failed` state due to timeout, the background
  // Resend call must reconcile its eventual result into /emailLog
  // without bumping the in-process counters (the caller has already
  // moved on). Without sendTimeoutMs, the Resend call runs inline
  // and the foreground/background distinction is meaningless.
  let timedOut = false;

  // The Resend interaction. Returns the same shape send() returns to
  // its caller, OR — if `timedOut` is set by the time it completes —
  // does the appropriate background log reconciliation and resolves
  // with a synthetic "background" marker so the foreground race can
  // still settle cleanly.
  const attemptSend = async () => {
    try {
      const result = await resend.emails.send({
        from: FROM,
        to,
        replyTo: REPLY_TO,
        subject,
        html,
      });
      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      const ok = {
        state: "sent",
        messageId: result.data?.id || null,
        template,
        projectId: projectId || null,
        to,
        subject,
        sentAt: Date.now(),
      };
      if (timedOut) {
        // Foreground already wrote `failed` and returned. Overwrite
        // with `sent` so future triggers see this as terminal-success.
        await writeLog(idempotencyKey, ok);
        await slackLog(`:envelope: Email *${template}* eventually delivered for project ${projectId || "?"} (${result.data?.id || "no id"}) — webhook had already returned via timeout.`);
        return { state: "background", reason: "late_success" };
      }
      await writeLog(idempotencyKey, ok);
      if (c) c.sent++;
      return { state: "sent", messageId: result.data?.id };
    } catch (e) {
      console.error(`send.js Resend error (${template}):`, e);
      const failed = {
        state: "failed",
        error: e.message,
        failedAt: Date.now(),
        template,
        projectId: projectId || null,
        to,
        subject,
      };
      if (timedOut) {
        // Foreground already wrote `failed` due to timeout; the real
        // failure replaces the timeout sentinel with the genuine
        // error so the next trigger has the actual reason on hand.
        await writeLog(idempotencyKey, failed);
        await slackLog(`:rotating_light: Email *${template}* failed in background for project ${projectId || "?"} — ${e.message}`);
        return { state: "background", reason: "late_failure" };
      }
      await writeLog(idempotencyKey, failed);
      if (c) c.failed++;
      await slackLog(`:rotating_light: Email send failed: ${template} → ${to} for project ${projectId || "?"} — ${e.message}`);
      return { state: "failed", reason: e.message };
    }
  };

  // No timeout: run inline. This is the cron/notify-finish path —
  // they don't have a strict latency budget the way the webhook
  // does, and a synchronous send keeps the lock+log lifecycle clean.
  if (!sendTimeoutMs) {
    return attemptSend();
  }

  // Timeout path: race the send against a timer. On timer win,
  // write `failed` (with reason 'timeout') and return; the send
  // keeps running and reconciles its eventual outcome into the
  // log entry via the timedOut branch above.
  const sendPromise = attemptSend();
  const result = await Promise.race([
    sendPromise,
    new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), sendTimeoutMs)),
  ]);
  if (result && result.__timeout) {
    timedOut = true;
    await writeLog(idempotencyKey, {
      state: "failed",
      error: `timeout after ${sendTimeoutMs}ms`,
      failedAt: Date.now(),
      template,
      projectId: projectId || null,
      to,
      subject,
      timeout: true,
    });
    if (c) c.failed++;
    await slackLog(`:hourglass: Email *${template}* timeout for project ${projectId || "?"} (${sendTimeoutMs}ms). Background send may still complete and reconcile the log.`);
    // Note: do NOT await sendPromise here — that's the whole point of
    // the timeout. It runs to completion in the background and writes
    // its own log update via the timedOut branch in attemptSend.
    return { state: "failed", reason: "timeout" };
  }
  return result;
}

// (Removed export `withTimeout` — replaced by the `sendTimeoutMs`
// option on `send()` itself. The old wrapper used Promise.race
// at the call site, which left the underlying Resend call running
// past the timeout with no log reconciliation. The inline version
// in send() writes a `failed` record on timeout and reconciles
// the eventual outcome. Per GPT review feedback (P2).)

// Summary line for cron paths. Posts one line per run with the
// counter totals. Avoids per-call Slack spam when the kill switch
// is engaged (or anywhere else counters accumulate).
export async function postCronSummary(label, counters) {
  const url = process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const total = Object.values(counters).reduce((a, b) => a + b, 0);
  if (total === 0) return; // nothing happened — nothing to log
  const parts = Object.entries(counters)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  const text = `:gear: *${label}* ${parts}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("send.js postCronSummary failed:", e.message);
  }
}

export { newCounters, FROM, REPLY_TO };
