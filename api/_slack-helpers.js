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

// ─── Reactions ─────────────────────────────────────────────────────
// Used to mark progress on the producer's original `#scheduling`
// message: :eyes: while the bot is working / waiting for confirm,
// :white_check_mark: when scheduled, :x: when cancelled, :warning:
// on stale / expired / Claude error. Slack returns "already_reacted"
// or "no_reaction" when state is already what we want — both are
// expected during retries; swallow them.
async function slackReactionAdd({ channel, name, timestamp, botToken }) {
  try {
    return await slackCall("reactions.add", { channel, name, timestamp }, botToken);
  } catch (e) {
    if (String(e.message || "").includes("already_reacted")) return null;
    throw e;
  }
}
async function slackReactionRemove({ channel, name, timestamp, botToken }) {
  try {
    return await slackCall("reactions.remove", { channel, name, timestamp }, botToken);
  } catch (e) {
    if (String(e.message || "").includes("no_reaction")) return null;
    throw e;
  }
}
// Convenience wrapper for state transitions. Always tries the remove
// even if the from-name isn't actually present — saves callers from
// tracking which transition they're in.
export async function slackSwapReaction({ channel, timestamp, removeName, addName, botToken }) {
  if (!channel || !timestamp || !botToken) return;
  if (removeName) {
    await slackReactionRemove({ channel, name: removeName, timestamp, botToken }).catch(() => {});
  }
  if (addName) {
    await slackReactionAdd({ channel, name: addName, timestamp, botToken }).catch(() => {});
  }
}
// Just-add helper for the listener's first :eyes: stamp. No swap
// needed since there's nothing to remove yet.
export async function slackAddReaction({ channel, timestamp, name, botToken }) {
  if (!channel || !timestamp || !botToken) return;
  await slackReactionAdd({ channel, name, timestamp, botToken }).catch(() => {});
}

// Reaction names — keep in one place so the listener and interactivity
// surfaces stay in lockstep. Must match Slack emoji names exactly
// (no surrounding colons in the API call).
export const REACTION = {
  THINKING: "eyes",
  DONE: "white_check_mark",
  CANCELLED: "x",
  ERROR: "warning",
};

// ─── Misc ──────────────────────────────────────────────────────────
export function randomShortId() {
  // 8 chars from a 5-byte hex source — enough entropy for our short-lived
  // proposal records without leaking too much into Slack button payloads.
  return crypto.randomBytes(5).toString("hex").slice(0, 8);
}

// Hash a fingerprint string (from shared/scheduling/flags.js) to a
// short hex digest safe for use as a Firebase RTDB key. RTDB rejects
// keys containing `. # $ / [ ]`, and raw fingerprints contain `.` and
// `/` — so we hash before persistence. 16 hex chars is plenty of
// collision space for the small set of pending-flag records we
// expect (low hundreds at most).
export function hashFingerprint(fp) {
  return crypto.createHash("sha256").update(String(fp || "")).digest("hex").slice(0, 16);
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

// Normalise undefined → null so a fingerprint stored in Firebase
// (which strips nulls on write, so they round-trip as undefined)
// compares equal to a freshly computed fingerprint (where absent
// fields are |
// '|' null-coalesced to null). Without this, every confirm on a
// subtask with no startTime/endTime false-positives as STALE.
function _nullish(v) {
  return v === undefined ? null : v;
}

export function fingerprintsMatch(a, b) {
  if (!a || !b) return false;
  if (_nullish(a.startDate) !== _nullish(b.startDate)) return false;
  if (_nullish(a.endDate) !== _nullish(b.endDate)) return false;
  if (_nullish(a.startTime) !== _nullish(b.startTime)) return false;
  if (_nullish(a.endTime) !== _nullish(b.endTime)) return false;
  if (_nullish(a.status) !== _nullish(b.status)) return false;
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

// Slack Block Kit `text` fields are capped at 3000 chars per block —
// posts longer than that are rejected outright. Long Opus narrations
// can run close to the limit, so we clip with an explicit suffix.
const SLACK_TEXT_MAX = 2900;
function truncateForSlack(text, max = SLACK_TEXT_MAX) {
  if (typeof text !== "string" || text.length <= max) return text;
  return text.slice(0, max - 14) + " …(truncated)";
}

// Format a brain flag-set into a Block Kit "Heads up" section for use
// inside a confirm card (Slack scheduling) or as the flags block in
// the daily digest.
//
// `flags` is the typed Flag[] from detectFlags. `narration` is the
// output from narrateBrain — { perFlagText, recommendation }. When
// per-flag text is missing for a fingerprint we fall back to a plain
// stringification so the block always renders something.
export function buildBrainFlagsBlocks({ flags, narration, header = ":warning: Heads up", fingerprintFn }) {
  if (!flags || flags.length === 0) return [];
  const lines = [];
  for (const f of flags) {
    const fp = fingerprintFn ? fingerprintFn(f) : null;
    const text = (fp && narration?.perFlagText?.[fp]) || _shortFlagText(f);
    lines.push(`• ${text}`);
  }
  if (narration?.recommendation) {
    lines.push(`_${narration.recommendation}_`);
  }
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncateForSlack(`${header}\n${lines.join("\n")}`) },
    },
  ];
}

function _shortFlagText(f) {
  switch (f?.kind) {
    case "fixedTimeConflict": return `Time conflict on ${f.date}.`;
    case "multipleUntimedShoots": return `Multiple untimed shoots on ${f.date}.`;
    case "offDayAssigned": return `Editor not working on ${f.date}.`;
    case "dailyOverCapacity": return `Over-capacity (${f.plannedHours}h) on ${f.date}.`;
    case "dailyHardOverCapacity": return `Hard over-capacity (${f.plannedHours}h) on ${f.date}.`;
    case "weekDataMismatch": return `Schedule grid mismatch on ${f.date}.`;
    case "unassignedScheduled": return `Subtask scheduled with no assignee.`;
    default: return "Flag.";
  }
}
