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
import { slackPostMessage } from "../_slack-helpers.js";

const FROM = "Viewix <hello@viewix.com.au>";
const REPLY_TO = "hello@viewix.com.au";
const PENDING_TTL_MS = 60 * 1000; // stale-lock cutoff

// ─── Production-management Slack alerts ─────────────────────────────
// Per Jeremy 2026-05-17: the email system must NOT post routine
// success/summary noise to Slack. It posts ONLY when something didn't
// go to plan, and those alerts go to the production-management
// channel (NOT project-leads). Channel id is overridable via env;
// defaults to the channel Jeremy specified so it works with zero
// new config. Bot token reuses the existing Viewix Dashboard Slack
// app token (same workspace) already used by the scheduling brain.
//
// One-time setup note: the Viewix Dashboard Slack app must be a
// member of the production-management channel for chat.postMessage
// to succeed (`/invite` the app once). postProdAlert fails soft —
// a missing invite logs a warning, never breaks the cron.
const PROD_MGMT_CHANNEL_ID = process.env.SLACK_PROD_MGMT_CHANNEL_ID || "C0AEX112NP9";

// channelId defaults to prod-management. Callers that want a different
// channel (e.g. daily-09 routing its scheduling summaries to #scheduling)
// pass an explicit id. Fails soft on a missing token/channel or a
// non-member bot — an alert is never allowed to break a cron.
async function postProdAlert(text, channelId = PROD_MGMT_CHANNEL_ID) {
  const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
  if (!botToken || !channelId) {
    console.warn("send.js postProdAlert: bot token / channel id missing — alert dropped:", text);
    return;
  }
  try {
    await slackPostMessage({ channel: channelId, text, botToken });
  } catch (e) {
    console.warn("send.js postProdAlert failed:", e.message);
  }
}

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
    // The old single `skipped_missing` lumped three distinct, separately-
    // actionable failures together, so the Slack nag couldn't say WHY a
    // client didn't get emailed. Split by cause so every alert is self-
    // describing (see postCronSummary). All three are "didn't go to plan".
    skipped_no_email: 0,      // no/invalid client email — fix the project record
    skipped_no_subject: 0,    // email had no subject — internal/template issue
    skipped_bad_status: 0,    // shoot subtask not in a schedulable status
    skipped_no_subtask_id: 0, // shoot subtask has no id — data repair needed
    failed: 0,
    // Per-reason list of human-readable project labels for every problem
    // counter, so the Slack nag can name the exact offending record
    // ("which project?") instead of just a count. Keyed by counter name;
    // populated via noteOffender() at each increment site.
    offenders: {},
  };
}

// Record which project tripped a problem counter, so postCronSummary can
// list it under the matching reason line. No-op when counters or label is
// missing. label should identify the record a producer must fix, e.g.
// "gemIQ / Walkthrough (-Nabc123)".
function noteOffender(counters, reason, label) {
  if (!counters || !label) return;
  const o = counters.offenders || (counters.offenders = {});
  (o[reason] || (o[reason] = [])).push(label);
}

let _resend = null;
function getResend() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

// Slack-log a single line for an event-driven send issue (Confirmation
// / ReadyForReview render fail, missing API key, send failure, timeout,
// late reconciliation). These are all "didn't go to plan" signals —
// never routine success — so they go to the production-management
// channel, NOT project-leads (per Jeremy 2026-05-17). Best-effort —
// never throws.
async function slackLog(line) {
  await postProdAlert(line);
}

// Slack-post the rendered HTML preview during dry-run so producers
// can eyeball the actual email body without it leaving the
// boundary. Truncated to 2900 chars (Slack's mrkdwn block limit) so
// long emails don't 400 the post.
async function slackDryRunPreview({ template, key, to, cc, subject, html, projectId }) {
  const url = process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const preview = String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1800);
  const ccLine = Array.isArray(cc) && cc.length > 0 ? `> cc: ${cc.join(", ")}\n` : "";
  const text =
    `:test_tube: *DRY-RUN email* — ${template}\n` +
    `> key: \`${key}\`\n` +
    `> projectId: \`${projectId || "—"}\`\n` +
    `> to: ${to}\n` +
    ccLine +
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
export async function send({ template, idempotencyKey, to, cc, subject, props, projectId, counters, sendTimeoutMs }) {
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
  // Primary `to` is required. cc is additive — having only cc with no
  // primary means we don't have a clearly addressed recipient, so we
  // skip rather than send a touchpoint to additional clients only.
  if (!to) {
    if (c) {
      c.skipped_no_email++;
      noteOffender(c, "skipped_no_email", `${props?.project?.projectName || "(untitled project)"}${projectId ? ` (${projectId})` : ""}`);
    }
    return { state: "skipped", reason: "missing_to" };
  }
  if (!subject) {
    if (c) c.skipped_no_subject++;
    return { state: "skipped", reason: "missing_subject" };
  }

  // Normalise cc: accept a string or an array, drop falsy / empty
  // entries, dedupe, and remove any address equal to the primary `to`
  // (Resend rejects sending the same address as both to and cc).
  let ccList = null;
  if (cc) {
    const raw = Array.isArray(cc) ? cc : [cc];
    const dedup = new Set();
    for (const c of raw) {
      const v = typeof c === "string" ? c.trim() : "";
      if (!v) continue;
      if (v.toLowerCase() === String(to).toLowerCase()) continue;
      dedup.add(v);
    }
    if (dedup.size > 0) ccList = Array.from(dedup);
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
    await slackDryRunPreview({ template, key: idempotencyKey, to, cc: ccList, subject, html, projectId });
    await writeLog(idempotencyKey, {
      state: "dryRun",
      template,
      projectId: projectId || null,
      to,
      cc: ccList,
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
        // Resend SDK accepts cc as string | string[]. Omit when null
        // so older email-log entries stay compact.
        ...(ccList ? { cc: ccList } : {}),
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
        cc: ccList,
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
        cc: ccList,
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
      cc: ccList,
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

// Per-pass cron outcome reporter.
//
// Changed 2026-05-17 (Jeremy): a clean cron run posts NOTHING to
// Slack. The old behaviour spammed project-leads with a `sent=N ·
// skipped_…=N` line every single run — pure noise on a healthy
// system. Now this only speaks up when a run didn't go to plan, and
// it speaks to the production-management channel (via postProdAlert),
// never project-leads.
//
// "Didn't go to plan" = a send failed OR any client was skipped for a
// fixable reason. Each reason is its OWN counter so the alert names the
// exact cause instead of an opaque `skipped_missing=N` (a producer
// reading the nag must know whether to add a client email, fix a shoot
// status, or repair a malformed subtask). Every other counter (sent,
// skipped_alreadySent, skipped_inFlight, skipped_dryRun,
// skipped_killSwitch) is normal/expected → silent.
//
// channelId routes the post; defaults to prod-management. daily-09
// passes the #scheduling id so its scheduling summaries land where the
// team acts on them.
const CRON_PROBLEM_REASONS = [
  ["failed", "Sends failed — check the email log / Resend."],
  ["skipped_no_email", "A client could not be emailed (no/invalid client email) — fix the project record."],
  ["skipped_bad_status", "A shoot was skipped because its subtask status isn't schedulable — check the project."],
  ["skipped_no_subtask_id", "A shoot was skipped because its subtask has no id — data repair needed on the project."],
  ["skipped_no_subject", "An email was skipped with no subject — internal/template issue."],
];
export async function postCronSummary(label, counters, channelId) {
  const present = CRON_PROBLEM_REASONS.filter(([k]) => (counters?.[k] || 0) > 0);
  if (present.length === 0) return; // healthy run — say nothing

  // Lead with the problem counters; append the full breakdown for
  // context, then one plain-English line per cause so the nag is
  // self-describing.
  const problems = present.map(([k]) => `${k}=${counters[k]}`);
  const fullBreakdown = Object.entries(counters)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  const detail = present.map(([k, msg]) => {
    const items = counters?.offenders?.[k] || [];
    const list = items.length
      ? "\n" + items.map(p => `>     • ${p}`).join("\n")
      : "";
    return `> ${msg}${list}`;
  }).join("\n");
  const text =
    `:warning: *${label}* did not go to plan — ${problems.join(" · ")}\n` +
    `> full: ${fullBreakdown}\n` +
    detail;
  await postProdAlert(text, channelId);
}

// Cron pass crashed entirely (the try/catch in daily-09 around each
// pass). Previously this was swallowed into the HTTP response only —
// a pass throwing produced ZERO Slack signal, which directly violates
// "tell me if it doesn't go to plan". Now it alerts prod-mgmt.
export async function postCronPassError(label, errorMessage) {
  await postProdAlert(
    `:rotating_light: *${label}* CRASHED — ${errorMessage}\n` +
    `> The pass threw before completing. Other passes in the run still execute independently. Investigate the cron logs.`
  );
}

export { newCounters, noteOffender, FROM, REPLY_TO };
