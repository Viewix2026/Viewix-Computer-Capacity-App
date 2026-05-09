// api/_slack-helpers.js
// Shared utilities for the Slack scheduling integration.
// - Raw-body reader (Vercel's default JSON parser would break Slack's HMAC signature check)
// - HMAC SHA256 signature verification with 5-min timestamp drift guard
// - Sydney-local date helper (en-CA gives YYYY-MM-DD without manual assembly)
// - chat.postMessage / chat.update / chat.postEphemeral wrappers using the bot token
// - Stage metadata mirrored from src/components/Projects.jsx so confirm cards
//   render with the same colour cues as the dashboard's TeamBoard

import crypto from "crypto";

// ─── Raw body ──────────────────────────────────────────────────────
// Endpoints that receive Slack callbacks must export
//   `export const config = { api: { bodyParser: false } }`
// so this helper sees the exact bytes Slack signed.
export async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ─── Signature verification ────────────────────────────────────────
// Slack signs requests with v0:{timestamp}:{rawBody} HMAC-SHA256.
// Reject anything older than 5 minutes (replay protection).
export function verifySlackSignature({ rawBody, timestamp, signature, secret }) {
  if (!rawBody || !timestamp || !signature || !secret) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 5) return false;
  const base = `v0:${ts}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  // Both must be the same length for timingSafeEqual.
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Sydney date ───────────────────────────────────────────────────
// Subtask startDate/endDate live as YYYY-MM-DD in the dashboard's
// local sense (Sydney). en-CA's default format IS YYYY-MM-DD, so this
// is the cleanest cross-DST way to compute "today" without slicing UTC.
export function todaySydney() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

// ─── Slack Web API ─────────────────────────────────────────────────
const SLACK_API = "https://slack.com/api";

async function slackCall(method, body, botToken) {
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    throw new Error(`Slack ${method} failed: ${data.error || resp.status}`);
  }
  return data;
}

export function slackPostMessage({ channel, blocks, text, thread_ts, botToken }) {
  return slackCall("chat.postMessage", { channel, blocks, text: text || "Viewix Scheduler", thread_ts }, botToken);
}

export function slackUpdateMessage({ channel, ts, blocks, text, botToken }) {
  return slackCall("chat.update", { channel, ts, blocks, text: text || "Viewix Scheduler" }, botToken);
}

// Ephemeral messages don't return a `ts` we can later update — they're fire-and-forget.
export function slackPostEphemeral({ channel, user, text, botToken }) {
  return slackCall("chat.postEphemeral", { channel, user, text }, botToken);
}

// ─── Misc ──────────────────────────────────────────────────────────
export function randomShortId() {
  // 8 chars from a 5-byte hex source — enough entropy for our short-lived
  // proposal records without leaking too much into Slack button payloads.
  return crypto.randomBytes(5).toString("hex").slice(0, 8);
}

// Mirrors SUBTASK_STAGE_OPTIONS in src/components/Projects.jsx.
// Keeping these here as the single Slack-side reference avoids importing
// from the React tree into a serverless function.
export const STAGES = ["preProduction", "shoot", "revisions", "edit", "hold"];

export const STAGE_LABELS = {
  preProduction: "Pre Production",
  shoot: "Shoot",
  revisions: "Revisions",
  edit: "Edit",
  hold: "Hold",
};

// Slack-rendered colour cues. Use the closest standard emoji to each
// SUBTASK_STAGE_OPTIONS colour so the confirm card matches the gantt bar.
export const STAGE_EMOJI = {
  preProduction: ":large_purple_circle:",
  shoot: ":red_circle:",
  revisions: ":large_orange_circle:",
  edit: ":large_blue_circle:",
  hold: ":large_yellow_circle:",
};

// Default subtask names per stage when we mode=create. Matches the
// auto-seeded names in DEFAULT_SUBTASKS so existing clients can't tell
// a Slack-created subtask apart from a hand-created one at a glance.
export const DEFAULT_NAME_FOR_STAGE = {
  preProduction: "Pre Production",
  shoot: "Shoot",
  revisions: "Revisions",
  edit: "Edit",
  hold: "Hold",
};

// Status-preservation rule. When updating an existing subtask:
// - leave inProgress / done / waitingClient alone (never regress)
// - lift "stuck" / "notStarted" / missing into "scheduled"
const PRESERVE_STATUSES = new Set(["inProgress", "done", "waitingClient", "scheduled"]);
export function nextStatusForUpdate(currentStatus) {
  if (currentStatus && PRESERVE_STATUSES.has(currentStatus)) return currentStatus;
  return "scheduled";
}

// Fingerprint of the fields a confirm card was rendered against. Used
// at confirm time to detect that someone edited the target subtask in
// the dashboard while the card was waiting.
//
// Scope kept tight on purpose: only the fields a producer would
// reasonably care about preserving when racing the bot. Earlier
// versions also included updatedAt / stage / name and got false
// positives from harmless field-shape differences between the parent
// fetch (used at proposal time) and the leaf fetch (used at confirm
// time). Those three add no real safety — if a stage or name changed
// out from under the user, a Slack-side date update is still the
// intent — and they're the most likely to drift spuriously.
export function fingerprintSubtask(st) {
  if (!st) return null;
  return {
    startDate: st.startDate || null,
    endDate: st.endDate || null,
    startTime: st.startTime || null,
    endTime: st.endTime || null,
    assigneeIds: Array.isArray(st.assigneeIds) ? [...st.assigneeIds].sort() : [],
    status: st.status || null,
  };
}

export function fingerprintsMatch(a, b) {
  if (!a || !b) return false;
  if (a.startDate !== b.startDate) return false;
  if (a.endDate !== b.endDate) return false;
  if (a.startTime !== b.startTime) return false;
  if (a.endTime !== b.endTime) return false;
  if (a.status !== b.status) return false;
  const aa = a.assigneeIds || [];
  const bb = b.assigneeIds || [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

// Allowlist parsing — comma-separated env var → Set, or null when empty.
export function parseAllowlist(value) {
  if (!value) return null;
  const ids = String(value).split(",").map(s => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}
