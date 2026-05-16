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

// Modal open/push. trigger_id is valid for ~3s, so callers must invoke
// these promptly after receiving the interaction.
export function slackOpenView({ trigger_id, view, botToken }) {
  return slackCall("views.open", { trigger_id, view }, botToken);
}
export function slackPushView({ trigger_id, view, botToken }) {
  return slackCall("views.push", { trigger_id, view }, botToken);
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
      text: { type: "mrkdwn", text: `${header}\n${lines.join("\n")}` },
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
    case "planInfeasible": return _planInfeasibleText(f);
    default: return "Flag.";
  }
}

function _planInfeasibleText(f) {
  switch (f.subkind) {
    case "noEditCapacity":
      return `No editor capacity for Video ${f.videoIndex} (needs ~${f.estHours}h) before the deadline.`;
    case "extraShootNoFeasibleDay":
      return `No day in ${f.dateRangeStart}–${f.dateRangeEnd} where all shoot crew are free.`;
    case "extraShootNoCrew":
      return `Extra shoot requested with no crew selected.`;
    default:
      return `Plan infeasible (${f.subkind || "unknown"}).`;
  }
}

// ─── Phase 2 plan Block Kit ────────────────────────────────────────

// Modal opened by /plan or the "Plan it" follow-up button. v2.0 is a
// SINGLE view with optional shoot inputs (the locked design called for
// a two-step push when extra-shoot=yes; the existing interactivity
// handler acks 200 before processing, which makes a synchronous
// views.push awkward — single-view-with-optional-shoot is the v2.0
// pragmatic equivalent, flagged for the Codex pass).
export function buildPlanModalView({ project, editors, defaultDeadline }) {
  const editorOpts = (editors || [])
    .filter(e => e?.id && e.role === "editor")
    .map(e => ({ text: { type: "plain_text", text: e.name || e.id }, value: e.id }));
  const crewOpts = (editors || [])
    .filter(e => e?.id) // crew + founders + editors can be on shoots
    .map(e => ({ text: { type: "plain_text", text: e.name || e.id }, value: e.id }));

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${project.projectName}* — ${project.numberOfVideos} videos`
          + `\nPlan the editing pipeline. The brain proposes; you approve.`,
      },
    },
    {
      type: "input", block_id: "editors", optional: true,
      label: { type: "plain_text", text: "Editors to involve" },
      element: {
        type: "multi_static_select", action_id: "v",
        placeholder: { type: "plain_text", text: "Pick editors" },
        options: editorOpts.length ? editorOpts
          : [{ text: { type: "plain_text", text: "(no editors)" }, value: "_none" }],
      },
    },
    {
      type: "input", block_id: "anyone", optional: true,
      label: { type: "plain_text", text: "Or let the brain pick" },
      element: {
        type: "checkboxes", action_id: "v",
        options: [{ text: { type: "plain_text", text: "Anyone with capacity" }, value: "yes" }],
      },
    },
    {
      type: "input", block_id: "deadline",
      label: { type: "plain_text", text: "Deadline" },
      element: {
        type: "datepicker", action_id: "v",
        ...(defaultDeadline ? { initial_date: defaultDeadline } : {}),
      },
    },
    {
      type: "input", block_id: "extra_shoot", optional: true,
      label: { type: "plain_text", text: "Extra shoot needed?" },
      element: {
        type: "radio_buttons", action_id: "v",
        options: [
          { text: { type: "plain_text", text: "No" }, value: "no" },
          { text: { type: "plain_text", text: "Yes" }, value: "yes" },
        ],
      },
    },
    { type: "divider" },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "_Only fill the shoot fields below if you picked Yes._" }],
    },
    {
      type: "input", block_id: "shoot_duration", optional: true,
      label: { type: "plain_text", text: "Shoot duration (hours)" },
      element: { type: "plain_text_input", action_id: "v", placeholder: { type: "plain_text", text: "e.g. 5" } },
    },
    {
      type: "input", block_id: "shoot_earliest", optional: true,
      label: { type: "plain_text", text: "Shoot earliest date" },
      element: { type: "datepicker", action_id: "v" },
    },
    {
      type: "input", block_id: "shoot_latest", optional: true,
      label: { type: "plain_text", text: "Shoot latest date" },
      element: { type: "datepicker", action_id: "v" },
    },
    {
      type: "input", block_id: "shoot_crew", optional: true,
      label: { type: "plain_text", text: "Shoot crew" },
      element: {
        type: "multi_static_select", action_id: "v",
        placeholder: { type: "plain_text", text: "Pick crew" },
        options: crewOpts.length ? crewOpts
          : [{ text: { type: "plain_text", text: "(none)" }, value: "_none" }],
      },
    },
    {
      type: "input", block_id: "shoot_times", optional: true,
      label: { type: "plain_text", text: "Shoot start/end time (optional, HH:MM-HH:MM)" },
      element: { type: "plain_text_input", action_id: "v", placeholder: { type: "plain_text", text: "09:00-14:00" } },
    },
  ];

  return {
    type: "modal",
    callback_id: "plan_modal",
    private_metadata: JSON.stringify({ projectId: project.id }),
    title: { type: "plain_text", text: "Plan the pipeline" },
    submit: { type: "plain_text", text: "Generate plan" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// Pull a typed planner `input` object out of a view_submission.
export function parsePlanModalSubmission(view) {
  const v = view?.state?.values || {};
  const get = (block) => v[block]?.v;
  const meta = (() => { try { return JSON.parse(view?.private_metadata || "{}"); } catch { return {}; } })();

  const requestedEditorIds = (get("editors")?.selected_options || [])
    .map(o => o.value).filter(x => x && x !== "_none");
  const anyoneWithCapacity = (get("anyone")?.selected_options || []).some(o => o.value === "yes");
  const deadline = get("deadline")?.selected_date || null;
  const extraYes = get("extra_shoot")?.selected_option?.value === "yes";

  let extraShoot = null;
  if (extraYes) {
    const durationHours = parseFloat(get("shoot_duration")?.value || "");
    const dateRangeStart = get("shoot_earliest")?.selected_date || null;
    const dateRangeEnd = get("shoot_latest")?.selected_date || dateRangeStart;
    const crew = (get("shoot_crew")?.selected_options || [])
      .map(o => o.value).filter(x => x && x !== "_none");
    const timeStr = (get("shoot_times")?.value || "").trim();
    const tm = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(timeStr);
    extraShoot = {
      dateRangeStart,
      dateRangeEnd,
      durationHours: Number.isFinite(durationHours) ? durationHours : 4,
      assigneeIds: crew,
      timesKnown: !!tm,
      startTime: tm ? tm[1] : null,
      endTime: tm ? tm[2] : null,
    };
  }

  return {
    projectId: meta.projectId || null,
    input: { requestedEditorIds, anyoneWithCapacity, deadline, extraShoot },
  };
}

const STAGE_HEAD = { shoot: ":red_circle: *Shoots*", edit: ":large_blue_circle: *Edits*",
  revisions: ":large_orange_circle: *Revisions*" };

// The proposed-plan card posted in-thread.
export function buildPlanCardBlocks({ project, proposal, narration }) {
  const subtasks = proposal.proposedSubtasks || [];
  const hard = proposal.hardViolations || [];
  const warnings = proposal.warnings || [];
  const byStage = { shoot: [], edit: [], revisions: [] };
  for (const s of subtasks) (byStage[s.stage] || (byStage[s.stage] = [])).push(s);

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:date: *Proposed plan — ${project.projectName}* (${project.numberOfVideos} videos)\n`
          + `_${narration?.summary || "Deterministic plan; Opus-narrated."}_`,
      },
    },
  ];

  for (const stage of ["shoot", "edit", "revisions"]) {
    const rows = byStage[stage] || [];
    if (!rows.length) continue;
    const lines = rows.map(s => {
      const key = stage === "shoot" ? "shoot#extra" : `${stage}#${s.videoIndex}`;
      const when = s.startDate
        ? `${s.startDate}${s.startTime ? ` ${s.startTime}-${s.endTime}` : ""}`
        : "unscheduled";
      const who = (s.assigneeIds || []).join(", ") || "—";
      const note = narration?.perRowText?.[key] ? `  _${narration.perRowText[key]}_` : "";
      return `• ${s.name} · ${when} · ${who}${note}`;
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${STAGE_HEAD[stage]}\n${lines.join("\n")}` } });
  }

  if (warnings.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: *Warnings (${warnings.length})*\n`
        + warnings.map(w => `• ${_shortFlagText(w)}`).join("\n") },
    });
  }
  if (hard.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:no_entry: *Hard violations (${hard.length})*\n`
        + hard.map(h => `• ${_shortFlagText(h)}`).join("\n") },
    });
  }
  if (narration?.recommendation) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_${narration.recommendation}_` }] });
  }

  const writeCount = subtasks.length;
  const actions = hard.length
    ? [
        { type: "button", style: "danger",
          text: { type: "plain_text", text: "Review violations" },
          action_id: "plan_review_violations", value: proposal.shortId },
        { type: "button", text: { type: "plain_text", text: "Cancel" },
          action_id: "plan_cancel", value: proposal.shortId },
      ]
    : [
        { type: "button", style: "primary",
          text: { type: "plain_text", text: `Approve all ${writeCount} subtasks` },
          action_id: "plan_approve", value: proposal.shortId },
        { type: "button", text: { type: "plain_text", text: "Cancel" },
          action_id: "plan_cancel", value: proposal.shortId },
      ];
  blocks.push({ type: "actions", elements: actions });
  return blocks;
}

// Second-confirm view shown when the producer clicks "Review
// violations". Lists each hard violation in plain English with a final
// "Approve anyway" button.
export function buildViolationReviewBlocks({ proposal }) {
  const hard = proposal.hardViolations || [];
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:no_entry: *${hard.length} hard violation(s)* — `
        + `these block one-click approve. Read them, then approve anyway only if you accept the risk.` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: hard.map(h => `• ${_shortFlagText(h)}`).join("\n") },
    },
    {
      type: "actions",
      elements: [
        { type: "button", style: "danger",
          text: { type: "plain_text", text: "Approve anyway" },
          action_id: "plan_approve_anyway", value: proposal.shortId },
        { type: "button", text: { type: "plain_text", text: "Cancel" },
          action_id: "plan_cancel", value: proposal.shortId },
      ],
    },
  ];
}

// Compact "applied" card after approve.
export function buildPlanAppliedBlocks({ project, result, byUser }) {
  const c = result.counts || {};
  return [
    {
      type: "section",
      text: { type: "mrkdwn",
        text: `:white_check_mark: *Plan applied — ${project.projectName}*\n`
          + `${c.created || 0} created · ${c.updated || 0} updated · ${c.skipped || 0} left as-is`
          + (byUser ? `  _by ${byUser.name || byUser.id}_` : "") },
    },
  ];
}
