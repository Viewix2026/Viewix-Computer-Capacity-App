// api/slack-interactivity.js
//
// Slack Interactivity entry — receives button clicks from confirm /
// clarification cards posted by api/slack-schedule-listener.js. Action ids:
//
//   confirm_schedule           — apply the proposed Firebase write
//   cancel_schedule            — mark proposal cancelled, no write
//   clarify_project_<i>        — user picked a project candidate
//   clarify_stage_<i>          — user picked a stage
//   clarify_assignee_<i>       — user picked an editor
//   clarify_subtask_<i>        — user picked which same-stage subtask
//   clarify_resched_or_new_<i> — user picked update vs create on conflict
//
// Slack delivers interactivity as application/x-www-form-urlencoded with
// a single `payload=<urlencoded JSON>` field, so we read the raw body for
// signature verification and only then URL-decode + JSON-parse.

import { waitUntil } from "@vercel/functions";
import { adminGet, adminPatch, getAdmin } from "./_fb-admin.js";
import { earliestCommonAvailableDay } from "../shared/scheduling/reviewPipeline.js";
import { getCalendarClient } from "./_google-calendar.js";
import { combineDateTimeSydney } from "./_calendar-utils.js";
import { runBrainPassForScheduling } from "./_scheduling-brain-pass.js";
import { runPlanProposal } from "./_scheduling-planner.js";
import { applyPlanCore } from "./scheduling-plan-apply.js";
import {
  readRawBody,
  verifySlackSignature,
  todaySydney,
  slackPostMessage,
  slackUpdateMessage,
  slackPostEphemeral,
  slackSwapReaction,
  slackOpenView,
  parseAllowlist,
  fingerprintSubtask,
  fingerprintsMatch,
  nextStatusForUpdate,
  buildBrainFlagsBlocks,
  buildPlanModalView,
  parsePlanModalSubmission,
  buildPlanCardBlocks,
  buildViolationReviewBlocks,
  buildPlanAppliedBlocks,
  STAGES,
  STAGE_LABELS,
  STAGE_EMOJI,
  DEFAULT_NAME_FOR_STAGE,
  REACTION,
} from "./_slack-helpers.js";
import { fingerprintFlag } from "../shared/scheduling/flags.js";
import { inferStage } from "../shared/scheduling/stages.js";

export const config = { api: { bodyParser: false } };

// ─── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const secret = process.env.SLACK_SCHEDULE_SIGNING_SECRET;
  if (!secret) {
    console.error("slack-interactivity: SLACK_SCHEDULE_SIGNING_SECRET not configured");
    return res.status(500).json({ error: "signing secret not configured" });
  }
  if (!verifySlackSignature({ rawBody, timestamp, signature, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // Form-decode then parse the JSON payload Slack stuffs in `payload=`.
  let payload;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get("payload") || "{}");
  } catch (e) {
    return res.status(400).json({ error: "invalid payload" });
  }

  // P2 #4 — `plan_open` must call views.open BEFORE the ack: Slack's
  // trigger_id is short-lived and opening the modal inside waitUntil
  // (post-ack) is timing-fragile under cold starts. The project +
  // editors reads are two fast Firebase gets, well within the 3s
  // window. All other interactions keep the ack-then-waitUntil path.
  const firstAction = payload?.actions?.[0];
  if (payload?.type === "block_actions" && firstAction?.action_id === "plan_open") {
    const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
    const allowlist = parseAllowlist(process.env.SLACK_SCHEDULE_ALLOWED_USER_IDS);
    if (allowlist && !allowlist.has(payload.user?.id)) {
      res.status(200).end();
      return;
    }
    try {
      await handlePlanOpen({ payload, botToken });
    } catch (err) {
      console.error("slack-interactivity plan_open error:", err);
    }
    res.status(200).end();
    return;
  }

  // Ack 200 immediately. Long work continues in waitUntil.
  res.status(200).end();
  waitUntil(processInteraction(payload).catch(err => {
    console.error("slack-interactivity error:", err);
  }));
}

// ─── Dispatcher ────────────────────────────────────────────────────
async function processInteraction(payload) {
  const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
  if (!botToken) {
    console.error("slack-interactivity: SLACK_SCHEDULE_BOT_TOKEN missing");
    return;
  }

  const allowlist = parseAllowlist(process.env.SLACK_SCHEDULE_ALLOWED_USER_IDS);

  // Phase 2: the /plan modal submit arrives as a view_submission (no
  // actions array). The handler already acked 200 (which closes the
  // modal); the heavy work runs here.
  if (payload.type === "view_submission") {
    if (allowlist && !allowlist.has(payload.user?.id)) return;
    if (payload.view?.callback_id === "plan_modal") {
      await handlePlanModalSubmit({ payload, botToken });
    }
    return;
  }

  const action = payload.actions?.[0];
  if (!action) return;

  // Allowlist gate — same env var as the listener. Even if a user can
  // see the card in #scheduling, they can't act on it unless allowed.
  if (allowlist && !allowlist.has(payload.user?.id)) {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: "You're not on the scheduler allowlist — only allowed users can confirm scheduling actions.",
      botToken,
    });
    return;
  }

  const id = action.action_id || "";
  if (id === "confirm_schedule") {
    await handleConfirm({ payload, botToken });
    return;
  }
  if (id === "cancel_schedule") {
    await handleCancel({ payload, botToken });
    return;
  }
  if (id.startsWith("clarify_")) {
    await handleClarify({ payload, botToken });
    return;
  }
  // ── Phase 2 plan actions ─────────────────────────────────────────
  if (id === "plan_open") {
    await handlePlanOpen({ payload, botToken });
    return;
  }
  if (id === "plan_dismiss") {
    await handlePlanDismiss({ payload, botToken });
    return;
  }
  if (id === "plan_approve" || id === "plan_approve_anyway") {
    await handlePlanApprove({ payload, botToken, despite: id === "plan_approve_anyway" });
    return;
  }
  if (id === "plan_review_violations") {
    await handlePlanReview({ payload, botToken });
    return;
  }
  if (id === "plan_cancel") {
    await handlePlanCancel({ payload, botToken });
    return;
  }
  if (id === "open_project_link" || id === "open_team_board_link") {
    return; // URL buttons — no server action needed
  }
  // ── Phase 4 internal-review actions ─────────────────────────────────
  // Attendance (Yes / Can't attend) on the trigger-internal-review post.
  // Outcome (Approve / Needs changes) on the booked-review follow-up.
  // Each action_id encodes the projectId + subtaskId so the handler can
  // resolve the right subtask without state hidden in payload.value.
  if (id.startsWith("review_attend_yes:") || id.startsWith("review_attend_no:")) {
    await handleReviewAttend({ payload, botToken });
    return;
  }
  if (id.startsWith("review_outcome_approve:") || id.startsWith("review_outcome_changes:")) {
    await handleReviewOutcome({ payload, botToken });
    return;
  }
  console.warn("slack-interactivity: unknown action_id", id);
}

// ─── Phase 2 handlers ──────────────────────────────────────────────

// "Plan it" button (from the auto follow-up) → open the planner modal.
async function handlePlanOpen({ payload, botToken }) {
  const projectId = payload.actions?.[0]?.value;
  const triggerId = payload.trigger_id;
  if (!projectId || !triggerId) return;
  const [project, editorsRaw] = await Promise.all([
    adminGet(`/projects/${projectId}`),
    adminGet("/editors"),
  ]);
  if (!project) return;
  const editors = (Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {}))
    .filter(e => e?.id);
  try {
    await slackOpenView({
      trigger_id: triggerId,
      view: buildPlanModalView({
        project: { ...project, id: projectId },
        editors,
        defaultDeadline: project.dueDate || null,
      }),
      botToken,
    });
  } catch (e) {
    console.error("handlePlanOpen views.open error:", e);
  }
}

async function handlePlanDismiss({ payload, botToken }) {
  const ch = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!ch || !ts) return;
  await slackUpdateMessage({
    channel: ch, ts,
    blocks: [{ type: "section", text: { type: "mrkdwn",
      text: ":ok_hand: No worries — you've got the rest of this project." } }],
    text: "Plan dismissed",
    botToken,
  });
}

// Modal submit → generate the plan, post the proposal card.
async function handlePlanModalSubmit({ payload, botToken }) {
  const channel = process.env.SLACK_SCHEDULE_CHANNEL_ID;
  if (!channel) { console.error("handlePlanModalSubmit: SLACK_SCHEDULE_CHANNEL_ID missing"); return; }

  const { projectId, input } = parsePlanModalSubmission(payload.view);
  if (!projectId) return;

  // Placeholder so the producer sees progress while Opus narrates.
  let placeholderTs = null;
  try {
    const ph = await slackPostMessage({
      channel,
      text: "Brain is planning…",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: Brain is planning the pipeline…" } }],
      botToken,
    });
    placeholderTs = ph?.ts || null;
  } catch (e) { console.error("handlePlanModalSubmit placeholder error:", e); }

  let out;
  try {
    out = await runPlanProposal({
      projectId,
      input,
      triggeredBy: "slack",
      triggeredVia: "manual",
      triggeredByUserId: payload.user?.id || null,
      triggeredByUserName: payload.user?.name || null,
    });
  } catch (e) {
    console.error("handlePlanModalSubmit runPlanProposal error:", e);
    if (placeholderTs) {
      await slackUpdateMessage({ channel, ts: placeholderTs,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `:warning: Couldn't build the plan: ${e.message || e}` } }],
        text: "Plan failed", botToken }).catch(() => {});
    }
    return;
  }

  const project = (await adminGet(`/projects/${projectId}`)) || {};
  const blocks = buildPlanCardBlocks({
    project: { ...project, id: projectId },
    proposal: out.record,
    narration: out.narration,
  });
  if (placeholderTs) {
    await slackUpdateMessage({ channel, ts: placeholderTs, blocks,
      text: out.narration?.summary || "Proposed plan", botToken });
    // Record the card ts so approve/cancel can update the right message.
    await getAdmin().db.ref(`/scheduling/proposedPlans/${out.shortId}/cardTs`).set(placeholderTs);
  } else {
    const post = await slackPostMessage({ channel, blocks,
      text: out.narration?.summary || "Proposed plan", botToken });
    if (post?.ts) await getAdmin().db.ref(`/scheduling/proposedPlans/${out.shortId}/cardTs`).set(post.ts);
  }
}

async function handlePlanReview({ payload, botToken }) {
  const shortId = payload.actions?.[0]?.value;
  const ch = payload.channel?.id;
  const ts = payload.message?.ts;
  const proposal = await adminGet(`/scheduling/proposedPlans/${shortId}`);
  if (!proposal || !ch || !ts) return;
  await slackUpdateMessage({
    channel: ch, ts,
    blocks: buildViolationReviewBlocks({ proposal }),
    text: "Review violations",
    botToken,
  });
}

async function handlePlanApprove({ payload, botToken, despite }) {
  const shortId = payload.actions?.[0]?.value;
  const ch = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!shortId) return;
  let result;
  try {
    result = await applyPlanCore({
      shortId,
      approveDespiteViolations: !!despite,
      actor: { id: payload.user?.id || null, name: payload.user?.name || null },
    });
  } catch (e) {
    console.error("handlePlanApprove error:", e);
    result = { status: "error", reason: e.message || String(e) };
  }

  const proposal = await adminGet(`/scheduling/proposedPlans/${shortId}`);
  const project = proposal ? (await adminGet(`/projects/${proposal.projectId}`)) || {} : {};
  let blocks;
  if (result.status === "applied") {
    blocks = buildPlanAppliedBlocks({
      project: { ...project, id: proposal?.projectId },
      result, byUser: payload.user,
    });
  } else if (result.status === "stale") {
    blocks = buildViolationReviewBlocks({ proposal: { ...proposal, hardViolations: result.hardViolations } });
  } else {
    blocks = [{ type: "section", text: { type: "mrkdwn",
      text: `:warning: Couldn't apply the plan (${result.reason || result.status}).` } }];
  }
  if (ch && ts) {
    await slackUpdateMessage({ channel: ch, ts, blocks,
      text: result.status === "applied" ? "Plan applied" : "Plan not applied", botToken });
  }
}

async function handlePlanCancel({ payload, botToken }) {
  const shortId = payload.actions?.[0]?.value;
  const ch = payload.channel?.id;
  const ts = payload.message?.ts;

  // Record the cancellation as the source of truth. If this write
  // fails we must NOT tell the user it succeeded — the proposal would
  // still be live and could be actioned later. Surface the failure so
  // they can retry instead.
  let cancelled = false;
  if (shortId) {
    try {
      const { db } = getAdmin();
      await db.ref(`/scheduling/proposedPlans/${shortId}`).update({
        status: "cancelled", cancelledAt: Date.now(), cancelledBy: payload.user?.id || null,
      });
      cancelled = true;
    } catch (e) {
      console.error("handlePlanCancel: failed to record cancellation:", e.message);
    }
  }

  if (ch && ts) {
    const text = cancelled
      ? ":x: Plan cancelled — no schedule changes were applied."
      : ":warning: Couldn't record the cancellation — the plan is still live. Try again.";
    await slackUpdateMessage({
      channel: ch, ts,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      text: cancelled ? "Plan cancelled" : "Cancel failed",
      botToken,
    });
  }
}

// ─── Confirm ───────────────────────────────────────────────────────
async function handleConfirm({ payload, botToken }) {
  const action = payload.actions[0];
  const shortId = action.value;
  const { db } = getAdmin();
  const ref = db.ref(`/scheduling/pending/${shortId}`);

  // Atomically flip status pending→used to make double-clicks idempotent.
  // The transaction returns the *previous* value via committed=false when
  // another click already won the race.
  let proposal = null;
  let claimed = false;
  const tx = await ref.transaction(curr => {
    if (!curr) return curr; // missing → no-op
    if (curr.status !== "pending") return curr; // someone else got here first or wrong state
    if (Date.now() > (curr.expiresAt || 0)) return curr; // expired — let post-tx handler render
    proposal = curr;
    claimed = true;
    return { ...curr, status: "claimed", claimedAt: Date.now(), claimedBy: payload.user?.id };
  });
  if (!tx.committed && tx.snapshot?.val) proposal = tx.snapshot.val();
  else if (!proposal && tx.snapshot) proposal = tx.snapshot.val();

  if (!proposal) {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: "That confirmation is no longer available — the proposal is gone.",
      botToken,
    });
    return;
  }

  if (!claimed) {
    if (proposal.status === "used") {
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: `Already scheduled by <@${proposal.usedBy || "someone"}>.`,
        botToken,
      });
    } else if (proposal.status === "cancelled") {
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: "That proposal was cancelled.",
        botToken,
      });
    } else if (proposal.status === "stale") {
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: "That proposal was marked stale (subtask was edited in the dashboard).",
        botToken,
      });
    } else if (Date.now() > (proposal.expiresAt || 0)) {
      await ref.update({ status: "expired" });
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: "That confirmation has expired (1h limit) — please re-issue your scheduling request.",
        botToken,
      });
      // Flip the producer's :eyes: reaction to :warning: so they
      // can see at a glance the proposal lapsed.
      if (proposal.slackChannel && proposal.slackTs) {
        await slackSwapReaction({
          channel: proposal.slackChannel,
          timestamp: proposal.slackTs,
          removeName: REACTION.THINKING,
          addName: REACTION.ERROR,
          botToken,
        });
      }
    } else {
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: `That confirmation is no longer valid (status: ${proposal.status}).`,
        botToken,
      });
    }
    return;
  }

  // We won the claim. From here on, any failure must release the claim
  // back to "pending" or mark stale/error so the user can retry.
  try {
    await applyProposal({ proposal, payload, botToken });
    await ref.update({
      status: "used",
      usedAt: Date.now(),
      usedBy: payload.user?.id || null,
    });
    // Flip :eyes: to :white_check_mark: on the producer's message.
    if (proposal.slackChannel && proposal.slackTs) {
      await slackSwapReaction({
        channel: proposal.slackChannel,
        timestamp: proposal.slackTs,
        removeName: REACTION.THINKING,
        addName: REACTION.DONE,
        botToken,
      });
    }
  } catch (e) {
    console.error("slack-interactivity confirm apply error:", e);
    if (e?.code === "STALE") {
      await ref.update({ status: "stale" });
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: "This subtask was modified in the dashboard since the card was created. Please re-issue your scheduling request.",
        botToken,
      });
      // STALE — flip :eyes: to :warning: so the producer doesn't
      // think the bot is still working.
      if (proposal.slackChannel && proposal.slackTs) {
        await slackSwapReaction({
          channel: proposal.slackChannel,
          timestamp: proposal.slackTs,
          removeName: REACTION.THINKING,
          addName: REACTION.ERROR,
          botToken,
        });
      }
    } else {
      // Release the claim so the user can retry. Reaction stays on
      // :eyes: because the proposal is still pending.
      await ref.update({ status: "pending", claimedAt: null, claimedBy: null });
      await slackPostEphemeral({
        channel: payload.channel?.id,
        user: payload.user?.id,
        text: `Couldn't apply the schedule: ${e.message || "unknown error"}. The card is still active — try again.`,
        botToken,
      });
    }
  }
}

// Apply the resolved patch to Firebase, write audit log, update the
// confirm card. Throws { code: "STALE" } if a race recheck fails — the
// caller resets the proposal accordingly.
async function applyProposal({ proposal, payload, botToken }) {
  const { db } = getAdmin();
  const patch = proposal.resolvedPatch;
  const projectId = patch.projectId;
  const nowIso = new Date().toISOString();

  let finalSubtaskId = patch.subtaskId;
  let finalWrite = null;
  let preStatus = null;
  let beforeFingerprint = null;

  if (patch.mode === "update") {
    const path = `/projects/${projectId}/subtasks/${patch.subtaskId}`;
    const existing = await adminGet(path);
    if (!existing) {
      throw new Error("target subtask was deleted");
    }
    beforeFingerprint = fingerprintSubtask(existing);
    if (proposal.targetFingerprint && !fingerprintsMatch(beforeFingerprint, proposal.targetFingerprint)) {
      // Log both fingerprints so we can diagnose any future false positives.
      console.error("slack-interactivity STALE mismatch", {
        shortId: proposal.shortId,
        path,
        expected: proposal.targetFingerprint,
        actual: beforeFingerprint,
      });
      const err = new Error("target subtask changed since proposal was created");
      err.code = "STALE";
      throw err;
    }
    preStatus = existing.status || null;
    const update = {
      ...patch.fields,
      status: nextStatusForUpdate(existing.status),
      updatedAt: nowIso,
    };
    // Strip nulls we explicitly want to keep (e.g. assigneeId may be null).
    // RTDB stores null as deletion, which is exactly what we want for a
    // cleared assignee, so no special handling needed.
    await db.ref(path).update(update);
    finalWrite = { path, update };
  } else {
    // Create. Use push() to get an ordered key, then build the full record.
    const newRef = db.ref(`/projects/${projectId}/subtasks`).push();
    finalSubtaskId = newRef.key;
    const all = (await adminGet(`/projects/${projectId}/subtasks`)) || {};
    const maxOrder = Object.values(all).reduce(
      (m, st) => Math.max(m, Number(st?.order) || 0),
      0,
    );
    const record = {
      id: finalSubtaskId,
      name: patch.fields.name || DEFAULT_NAME_FOR_STAGE[patch.fields.stage],
      status: "scheduled",
      stage: patch.fields.stage,
      startDate: patch.fields.startDate,
      endDate: patch.fields.endDate || patch.fields.startDate,
      startTime: patch.fields.startTime || null,
      endTime: patch.fields.endTime || null,
      assigneeIds: patch.fields.assigneeIds || [],
      assigneeId: patch.fields.assigneeId || null,
      source: "slack",
      order: maxOrder + 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await newRef.set(record);
    finalWrite = { path: `/projects/${projectId}/subtasks/${finalSubtaskId}`, record };
  }

  // Audit log — always push() so we never collide on RTDB-illegal keys.
  await db.ref("/scheduling/history").push({
    actor: payload.user?.id || null,
    actorName: payload.user?.name || null,
    ts: nowIso,
    shortId: proposal.shortId,
    originalText: proposal.originalText,
    claudeIntent: proposal.claudeIntent,
    resolvedPatch: patch,
    targetFingerprintBefore: beforeFingerprint,
    preUpdateStatus: preStatus,
    finalWrite,
    projectId,
    subtaskId: finalSubtaskId,
  });

  // Update the confirm card to a "scheduled" state with link buttons.
  const ts = proposal.confirmMessageTs;
  if (ts && payload.channel?.id) {
    await slackUpdateMessage({
      channel: payload.channel.id,
      ts,
      blocks: scheduledCardBlocks({ proposal, finalSubtaskId, byUser: payload.user }),
      text: `Scheduled by ${payload.user?.name || payload.user?.id || "someone"}`,
      botToken,
    });
  }

  // Phase 2 auto-trigger — if we just scheduled a SHOOT on a
  // multi-video project that hasn't been planned yet, offer to plan
  // the rest of the pipeline in-thread. Best-effort; never block the
  // confirm path on it.
  try {
    await maybeOfferPlan({
      projectId,
      appliedStage: patch.fields?.stage,
      threadTs: ts || proposal.confirmMessageTs,
      channel: payload.channel?.id,
      botToken,
    });
  } catch (e) {
    console.error("maybeOfferPlan error:", e);
  }
}

// Post the "Plan the rest?" follow-up when a first shoot lands on a
// multi-video project with no plan-group-tagged subtasks yet.
async function maybeOfferPlan({ projectId, appliedStage, threadTs, channel, botToken }) {
  if (appliedStage !== "shoot" || !channel) return;
  const project = await adminGet(`/projects/${projectId}`);
  if (!project) return;
  if (!(parseInt(project.numberOfVideos, 10) > 1)) return;

  const subtasks = project.subtasks || {};

  // P2 #5 — first-shoot-only. If the project already has another
  // active scheduled shoot besides the one just confirmed, this isn't
  // the first shoot and we shouldn't re-prompt "plan the rest".
  const activeShoots = Object.values(subtasks).filter(s =>
    s && inferStage(s) === "shoot" && s.startDate &&
    s.status !== "done" && s.status !== "archived").length;
  if (activeShoots > 1) return;

  // Already planned? Skip if any subtask carries a _planGroupId, or a
  // non-terminal proposedPlan exists for this project.
  const alreadyTagged = Object.values(subtasks).some(s => s && s._planGroupId);
  if (alreadyTagged) return;
  const plans = (await adminGet("/scheduling/proposedPlans")) || {};
  const live = Object.values(plans).some(p =>
    p?.projectId === projectId && ["pending", "claimed", "approved"].includes(p?.status));
  if (live) return;

  await slackPostMessage({
    channel,
    thread_ts: threadTs || undefined,
    text: `Plan the rest of ${project.projectName}?`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn",
          text: `:movie_camera: Just scheduled the *${project.projectName}* shoot. `
            + `It has ${project.numberOfVideos} videos — plan the rest of the pipeline?` },
      },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary",
            text: { type: "plain_text", text: "Plan it" },
            action_id: "plan_open", value: projectId },
          { type: "button",
            text: { type: "plain_text", text: "I'll handle it" },
            action_id: "plan_dismiss", value: projectId },
        ],
      },
    ],
    botToken,
  });
}

// ─── Cancel ────────────────────────────────────────────────────────
async function handleCancel({ payload, botToken }) {
  const action = payload.actions[0];
  const shortId = action.value;
  const { db } = getAdmin();
  const ref = db.ref(`/scheduling/pending/${shortId}`);

  let proposal = null;
  const tx = await ref.transaction(curr => {
    if (!curr) return curr;
    if (curr.status !== "pending" && curr.status !== "awaiting_clarification") return curr;
    proposal = curr;
    return { ...curr, status: "cancelled", cancelledAt: Date.now(), cancelledBy: payload.user?.id };
  });
  if (!tx.committed) {
    if (tx.snapshot) proposal = tx.snapshot.val();
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: proposal ? `Proposal already ${proposal.status}.` : "Proposal not found.",
      botToken,
    });
    return;
  }
  if (proposal?.confirmMessageTs && payload.channel?.id) {
    await slackUpdateMessage({
      channel: payload.channel.id,
      ts: proposal.confirmMessageTs,
      blocks: cancelledCardBlocks({ proposal, byUser: payload.user }),
      text: `Cancelled by ${payload.user?.name || payload.user?.id || "someone"}`,
      botToken,
    });
  }
  // Flip :eyes: to :x: on the producer's message.
  if (proposal?.slackChannel && proposal?.slackTs) {
    await slackSwapReaction({
      channel: proposal.slackChannel,
      timestamp: proposal.slackTs,
      removeName: REACTION.THINKING,
      addName: REACTION.CANCELLED,
      botToken,
    });
  }
}

// ─── Clarify ───────────────────────────────────────────────────────
async function handleClarify({ payload, botToken }) {
  const action = payload.actions[0];
  // Button value format: "{shortId}|{kind}:{value}".
  const v = action.value || "";
  const [shortId, kindAndValue] = v.split("|");
  if (!shortId || !kindAndValue) return;
  const sepIdx = kindAndValue.indexOf(":");
  if (sepIdx < 0) return;
  const kind = kindAndValue.slice(0, sepIdx);
  const value = kindAndValue.slice(sepIdx + 1);

  const { db } = getAdmin();
  const ref = db.ref(`/scheduling/pending/${shortId}`);
  const proposal = await adminGet(`/scheduling/pending/${shortId}`);
  if (!proposal) {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: "That clarification is no longer available.",
      botToken,
    });
    return;
  }
  if (proposal.status !== "awaiting_clarification") {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: `That clarification can't be resolved (status: ${proposal.status}).`,
      botToken,
    });
    return;
  }
  if (Date.now() > (proposal.expiresAt || 0)) {
    await ref.update({ status: "expired" });
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: "That clarification has expired — please re-issue your scheduling request.",
      botToken,
    });
    return;
  }

  // Patch the partialIntent with the chosen value, then re-run the
  // backend pipeline to produce either a confirm card or another
  // clarification — under the same shortId so we don't fragment history.
  const partial = { ...(proposal.partialIntent || {}) };
  if (kind === "project") partial.projectId = value;
  else if (kind === "stage") partial.stage = value;
  else if (kind === "assignee") {
    partial.assigneeIds = Array.from(new Set([...(partial.assigneeIds || []), value]));
  } else if (kind === "subtask") {
    partial._chosenSubtaskId = value;
  } else if (kind === "resched_or_new") {
    partial.explicitMode = value === "create" ? "create" : "update";
  }

  await ref.update({ partialIntent: partial });

  // Re-run the resolution pipeline with the patched intent. If it's
  // still incomplete, post a new clarification card; otherwise build
  // the confirm card and flip status to pending.
  const reResult = await resolveAfterClarification({ proposal: { ...proposal, partialIntent: partial }, botToken, payload });
  if (!reResult) return;
}

async function resolveAfterClarification({ proposal, botToken, payload }) {
  const { db } = getAdmin();
  const ref = db.ref(`/scheduling/pending/${proposal.shortId}`);
  const partial = proposal.partialIntent || {};

  // Need projectId, stage, startDate to proceed. If the user is still
  // missing required pieces, leave the proposal in awaiting_clarification.
  // (We don't currently re-prompt automatically — the original message
  // can be re-typed if needed. Keeping logic minimal here avoids a
  // recursive Claude call that would race the user's clicks.)
  if (!partial.projectId || !partial.stage || !partial.startDate) {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: "Got that — but more detail is needed. Re-post the original message with the missing piece (date, project name, or stage).",
      botToken,
    });
    return false;
  }

  // Resolve project + assignees against current Firebase state.
  const project = await adminGet(`/projects/${partial.projectId}`);
  if (!project) {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: payload.user?.id,
      text: "That project no longer exists in Firebase.",
      botToken,
    });
    return false;
  }
  const editorsRaw = (await adminGet("/editors")) || [];
  const editorList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw);
  const editorById = new Map(editorList.filter(e => e?.id).map(e => [e.id, e]));
  const assigneeIds = (partial.assigneeIds || []).filter(id => editorById.has(id));

  const subtasksObj = (await adminGet(`/projects/${partial.projectId}/subtasks`)) || {};

  // Honour an explicit subtask choice from the "which task" clarification.
  let target;
  if (partial._chosenSubtaskId) {
    const existing = subtasksObj[partial._chosenSubtaskId];
    target = existing
      ? { mode: "update", subtaskId: partial._chosenSubtaskId, existing: { id: partial._chosenSubtaskId, ...existing } }
      : { mode: "create", subtaskId: null, existing: null };
  } else {
    target = pickTargetSubtaskInline({
      subtasksObj,
      stage: partial.stage,
      explicitMode: partial.explicitMode,
    });
  }

  if (target.mode === "clarify") {
    // Still ambiguous (e.g. user picked the project but multiple Edits exist).
    await ref.update({
      clarificationKind: "subtask",
      clarificationQuestion: `Multiple ${STAGE_LABELS[partial.stage]} tasks under "${project.projectName}" — which one?`,
      clarificationOptions: target.candidates,
    });
    if (proposal.confirmMessageTs && payload.channel?.id) {
      await slackUpdateMessage({
        channel: payload.channel.id,
        ts: proposal.confirmMessageTs,
        blocks: clarificationBlocksInline({
          shortId: proposal.shortId,
          kind: "subtask",
          question: `Multiple ${STAGE_LABELS[partial.stage]} tasks under "${project.projectName}" — which one?`,
          options: target.candidates,
          originalText: proposal.originalText,
        }),
        text: "Which subtask?",
        botToken,
      });
    }
    return true;
  }

  // Conflict detection again (state may have changed since the original card).
  if (target.mode === "update") {
    const today = todaySydney();
    if (target.existing.startDate && target.existing.startDate < today) {
      // Past existing — force resched-vs-new clarification unless the
      // user already answered that one (explicitMode set).
      if (!partial.explicitMode) {
        await ref.update({
          clarificationKind: "resched_or_new",
          clarificationQuestion: `There's already a ${STAGE_LABELS[partial.stage]} on ${target.existing.startDate} for ${project.projectName}. Reschedule that one or add a new ${STAGE_LABELS[partial.stage]} day?`,
          clarificationOptions: [
            { label: "Reschedule existing", value: "update" },
            { label: `Add new ${STAGE_LABELS[partial.stage]} day`, value: "create" },
          ],
        });
        if (proposal.confirmMessageTs && payload.channel?.id) {
          await slackUpdateMessage({
            channel: payload.channel.id,
            ts: proposal.confirmMessageTs,
            blocks: clarificationBlocksInline({
              shortId: proposal.shortId,
              kind: "resched_or_new",
              question: `There's already a ${STAGE_LABELS[partial.stage]} on ${target.existing.startDate}. Reschedule it or add a new ${STAGE_LABELS[partial.stage]} day?`,
              options: [
                { label: "Reschedule existing", value: "update" },
                { label: `Add new ${STAGE_LABELS[partial.stage]} day`, value: "create" },
              ],
              originalText: proposal.originalText,
            }),
            text: "Reschedule or add new?",
            botToken,
          });
        }
        return true;
      }
      // explicitMode already set → fall through into the chosen mode.
      if (partial.explicitMode === "create") {
        target = { mode: "create", subtaskId: null, existing: null };
      }
    }
  }

  // Build the resolved proposal and flip status to pending.
  // Mirror the listener's assignee-preservation rule: if mode=update
  // and user didn't specify assignees, keep whatever the subtask
  // already had instead of zeroing them.
  const preserveExistingAssignees =
    target.mode === "update" && assigneeIds.length === 0 && target.existing;
  const finalAssigneeIds = preserveExistingAssignees
    ? (Array.isArray(target.existing.assigneeIds) ? target.existing.assigneeIds : (target.existing.assigneeId ? [target.existing.assigneeId] : []))
    : assigneeIds;
  const finalAssigneeId = preserveExistingAssignees
    ? (target.existing.assigneeId || finalAssigneeIds[0] || null)
    : (assigneeIds[0] || null);
  const fields = {
    startDate: partial.startDate,
    endDate: partial.endDate || partial.startDate,
    startTime: partial.startTime || null,
    endTime: partial.endTime || null,
    assigneeIds: finalAssigneeIds,
    assigneeId: finalAssigneeId,
    stage: partial.stage,
    name:
      target.mode === "create"
        ? defaultNameForStageInline(partial.stage, partial.startDate, subtasksObj)
        : (target.existing?.name || null),
    source: "slack",
  };

  // Run the brain pass against the resolved post-clarification proposal.
  // Codex P1 #3 fix — previously this path skipped the brain entirely
  // and the rebuilt confirm card always read "Confirm" (not "Confirm
  // anyway"), so clarified scheduling requests could create silent
  // conflicts. Same helper the listener's clean-path uses, so the two
  // surfaces stay in lockstep.
  const brainOutcome = await runBrainPassForScheduling({
    projectId: partial.projectId,
    targetSubtaskId: target.subtaskId,
    targetMode: target.mode,
    fields,
    today: todaySydney(),
  });

  const updated = {
    status: "pending",
    claudeIntent: partial,
    resolvedPatch: {
      projectId: partial.projectId,
      subtaskId: target.subtaskId,
      mode: target.mode,
      fields,
    },
    targetFingerprint: target.existing ? fingerprintSubtask(target.existing) : null,
    project: { id: partial.projectId, projectName: project.projectName, clientName: project.clientName },
    clarificationKind: null,
    clarificationOptions: null,
    clarificationQuestion: null,
    brainFlags: brainOutcome.flags || [],
    brainNarration: brainOutcome.narration || null,
  };
  await ref.update(updated);

  // Update the original card to the confirm view.
  if (proposal.confirmMessageTs && payload.channel?.id) {
    const finalProposal = { ...proposal, ...updated };
    await slackUpdateMessage({
      channel: payload.channel.id,
      ts: proposal.confirmMessageTs,
      blocks: confirmCardBlocksInline({
        proposal: finalProposal,
        project: { id: partial.projectId, projectName: project.projectName, clientName: project.clientName },
        editors: editorList,
      }),
      text: `Confirm: ${STAGE_LABELS[partial.stage]} for ${project.projectName} on ${partial.startDate}`,
      botToken,
    });
  }
  return true;
}

// Inline copies of the listener's pure helpers — kept inline rather than
// exporting from _slack-helpers.js because they belong to the listener's
// resolution pipeline, not generic Slack utilities. Easier to read both
// files in isolation.
function pickTargetSubtaskInline({ subtasksObj, stage, explicitMode }) {
  if (explicitMode === "create") {
    return { mode: "create", subtaskId: null, existing: null };
  }
  const all = Object.entries(subtasksObj || {})
    .map(([id, st]) => ({ id, ...(st || {}) }))
    .filter(st => st && st.id);
  const sameStage = all.filter(st => st.stage === stage);
  if (sameStage.length === 0) return { mode: "create", subtaskId: null, existing: null };
  if (stage === "edit") {
    const exact = sameStage.find(st => st.name === "Edit");
    if (exact) return { mode: "update", subtaskId: exact.id, existing: exact };
  }
  if (sameStage.length === 1) {
    return { mode: "update", subtaskId: sameStage[0].id, existing: sameStage[0] };
  }
  const unscheduled = sameStage.filter(st => !st.startDate);
  if (unscheduled.length === 1) {
    return { mode: "update", subtaskId: unscheduled[0].id, existing: unscheduled[0] };
  }
  return {
    mode: "clarify",
    subtaskId: null,
    existing: null,
    candidates: sameStage.map(st => ({
      label: `${st.name || "(unnamed)"}${st.startDate ? ` — ${st.startDate}` : ""}`,
      value: st.id,
    })),
  };
}

function defaultNameForStageInline(stage, startDate, subtasksObj) {
  const defaultName = DEFAULT_NAME_FOR_STAGE[stage];
  const all = Object.values(subtasksObj || {});
  const collision = all.some(st => st && st.name === defaultName && st.stage === stage);
  return collision ? `${defaultName} — ${startDate}` : defaultName;
}

// ─── Block Kit ─────────────────────────────────────────────────────
function scheduledCardBlocks({ proposal, finalSubtaskId, byUser }) {
  const f = proposal.resolvedPatch.fields;
  const project = proposal.project || { projectName: "?", clientName: "?", id: proposal.resolvedPatch.projectId };
  const dateLine = (f.endDate && f.endDate !== f.startDate)
    ? `${f.startDate} → ${f.endDate}`
    : f.startDate;
  const projectUrl = `https://planner.viewix.com.au/#projects/projects/${project.id}`;
  const teamBoardUrl = `https://planner.viewix.com.au/#projects/teamBoard`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:white_check_mark: *Scheduled by <@${byUser?.id || "?"}>* ${STAGE_EMOJI[f.stage]} *${STAGE_LABELS[f.stage]}*\n` +
          `*Project:* ${project.clientName} — ${project.projectName}\n` +
          `*Date:* ${dateLine}`,
      },
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open project" }, url: projectUrl, action_id: "open_project_link" },
        { type: "button", text: { type: "plain_text", text: "Open Team Board" }, url: teamBoardUrl, action_id: "open_team_board_link" },
      ],
    },
  ];
}

function cancelledCardBlocks({ proposal, byUser }) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:x: *Cancelled by <@${byUser?.id || "?"}>*\n_From your message:_ ${truncate(proposal.originalText, 140)}`,
      },
    },
  ];
}

function clarificationBlocksInline({ shortId, kind, question, options, originalText }) {
  const opts = (options || []).slice(0, 4);
  return [
    { type: "section", text: { type: "mrkdwn", text: `:thinking_face: ${question}` } },
    {
      type: "actions",
      elements: opts.map((o, i) => ({
        type: "button",
        text: { type: "plain_text", text: String(o.label).slice(0, 75) },
        action_id: `clarify_${kind}_${i}`,
        value: `${shortId}|${kind}:${o.value}`,
      })),
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_From your message:_ ${truncate(originalText, 140)}` }],
    },
  ];
}

function confirmCardBlocksInline({ proposal, project, editors }) {
  const f = proposal.resolvedPatch.fields;
  const editorList = Array.isArray(editors) ? editors : [];
  const editorById = new Map(editorList.filter(e => e?.id).map(e => [e.id, e]));
  const assigneeNames = (f.assigneeIds || [])
    .map(id => editorById.get(id)?.name)
    .filter(Boolean);
  const dateLine = (f.endDate && f.endDate !== f.startDate)
    ? `${f.startDate} → ${f.endDate}`
    : f.startDate;
  const timeLine = f.startTime ? `\n*Time:* ${f.startTime}${f.endTime ? `–${f.endTime}` : ""}` : "";
  const modeLine = proposal.resolvedPatch.mode === "create" ? "Create new subtask" : "Update existing subtask";

  // Brain flags: mirror the listener's clean-path confirm card so the
  // post-clarification card surfaces conflicts the same way. Codex
  // P1 #3 fix.
  const hasBrainFlags = Array.isArray(proposal.brainFlags) && proposal.brainFlags.length > 0;
  const headsUpBlocks = hasBrainFlags
    ? buildBrainFlagsBlocks({
        flags: proposal.brainFlags,
        narration: proposal.brainNarration,
        header: ":warning: *Heads up*",
        fingerprintFn: fingerprintFlag,
      })
    : [];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Schedule confirmation* ${STAGE_EMOJI[f.stage]} *${STAGE_LABELS[f.stage]}*\n` +
          `*Project:* ${project.clientName} — ${project.projectName}\n` +
          `*Subtask:* ${f.name || STAGE_LABELS[f.stage]} _(${modeLine})_\n` +
          `*Date:* ${dateLine}${timeLine}\n` +
          `*Editor:* ${assigneeNames.length ? assigneeNames.join(", ") : "_unassigned_"}`,
      },
    },
    ...headsUpBlocks,
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_From your message:_ ${truncate(proposal.originalText, 140)}` }],
    },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: hasBrainFlags ? "Confirm anyway" : "Confirm" }, action_id: "confirm_schedule", value: proposal.shortId },
        { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "cancel_schedule", value: proposal.shortId },
      ],
    },
  ];
}

function truncate(s, n) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─── Phase 4: internal-review handlers ─────────────────────────────
// Triggered by api/trigger-internal-review.js. The attendance handler
// records a Yes/No from an invitee, updates the Slack card with the
// running tally, and — once every invitee has responded — runs the
// booking step (pick a day all confirmed attendees are in the suite,
// stamp the subtask, create a Google Calendar invite, post outcome
// buttons). The outcome handler (Approve / Needs changes) closes the
// loop: Approve fires the client-ready alert; Needs changes spawns an
// "Internal Changes" subtask for the project lead.

function parseReviewActionId(id) {
  // "review_attend_yes:{projectId}:{subtaskId}" → { kind, projectId, subtaskId }
  const m = String(id || "").match(/^(review_(?:attend_yes|attend_no|outcome_approve|outcome_changes)):([^:]+):([^:]+)$/);
  if (!m) return null;
  return { kind: m[1], projectId: m[2], subtaskId: m[3] };
}

async function handleReviewAttend({ payload, botToken }) {
  const action = payload.actions?.[0];
  const parsed = parseReviewActionId(action?.action_id);
  if (!parsed) return;
  const { kind, projectId, subtaskId } = parsed;
  const slackUserId = payload.user?.id;
  if (!slackUserId) return;
  const choice = kind === "review_attend_yes" ? "yes" : "no";

  // Re-read project so we have the latest subtask state.
  const project = await adminGet(`/projects/${projectId}`);
  if (!project) return;
  const subtask = (project.subtasks || {})[subtaskId];
  if (!subtask || !subtask.isInternalReview) return;
  const ir = subtask.internalReview || {};
  const invitees = Array.isArray(ir.invitees) ? ir.invitees : [];

  // Only invitees may click. Anyone else gets a soft ephemeral nudge.
  const isInvitee = invitees.some(i => i.slackId === slackUserId);
  if (!isInvitee) {
    await slackPostEphemeral({
      channel: payload.channel?.id,
      user: slackUserId,
      text: "You're not on the invitee list for this internal review.",
      botToken,
    });
    return;
  }

  // Record the vote — idempotent per invitee.
  const attendance = { ...(ir.attendance || {}), [slackUserId]: choice };
  await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}/internalReview`, {
    attendance,
    updatedAt: new Date().toISOString(),
  });

  // Update the original message with the running tally so everyone sees
  // who's in / out without scrolling thread replies.
  const tallyLines = invitees.map(i => {
    const v = attendance[i.slackId];
    const mark = v === "yes" ? "✅ in" : v === "no" ? "🚫 out" : "⏳ pending";
    const who = i.slackId ? `<@${i.slackId}>` : `*${i.name}*`;
    return `• ${who} — ${mark}`;
  });
  // Only invitees with a Slack ID can ever click a response — counting
  // the ID-less ones deadlocked auto-booking behind a vote that could
  // never arrive.
  const respondable = invitees.filter(i => i.slackId);
  const allResponded = respondable.length > 0 && respondable.every(i => !!attendance[i.slackId]);
  const headline = allResponded
    ? "All invitees have responded — booking the review…"
    : "Attendance so far:";
  const tallyBlocks = [
    { type: "section", text: { type: "mrkdwn", text: `*${(project.clientName ? project.clientName + ": " : "") + (project.projectName || "Untitled project")}* — internal review` } },
    { type: "section", text: { type: "mrkdwn", text: [headline, ...tallyLines].join("\n") } },
  ];
  // Only keep the attendance buttons while someone is still pending —
  // once everyone has responded the row would be misleading.
  if (!allResponded) {
    tallyBlocks.push({
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Yes I'll attend" }, action_id: `review_attend_yes:${projectId}:${subtaskId}`, value: `${projectId}:${subtaskId}` },
        { type: "button", text: { type: "plain_text", text: "Can't attend" }, action_id: `review_attend_no:${projectId}:${subtaskId}`, value: `${projectId}:${subtaskId}` },
      ],
    });
  }
  if (ir.slackChannel && ir.slackTs) {
    try {
      await slackUpdateMessage({ channel: ir.slackChannel, ts: ir.slackTs, blocks: tallyBlocks, text: "Internal review attendance update", botToken });
    } catch (e) {
      console.warn("review attendance: slack update failed:", e.message);
    }
  }

  if (allResponded) {
    await bookInternalReview({ projectId, subtaskId, project, attendance, invitees, botToken });
  }
}

// Pick a day, stamp the subtask, create the Calendar invite, post the
// outcome buttons. Defensive: idempotency check on internalReview.state,
// so two simultaneous "last-vote" clicks don't double-book.
async function bookInternalReview({ projectId, subtaskId, project, attendance, invitees, botToken }) {
  // Re-read latest state — guard against the rare double-fire from two
  // last-vote clicks landing nearly simultaneously.
  const fresh = await adminGet(`/projects/${projectId}/subtasks/${subtaskId}`);
  if (!fresh || !fresh.isInternalReview) return;
  if (fresh.internalReview?.state && fresh.internalReview.state !== "awaitingAttendance") return;

  // Resolve invitees who said yes -> editor records (id + email).
  let editors = [];
  try {
    const raw = await adminGet("/editors");
    editors = Array.isArray(raw) ? raw : Object.values(raw || {});
  } catch (e) {
    console.warn("bookInternalReview: editor lookup failed:", e.message);
  }
  const confirmedSlackIds = invitees.filter(i => attendance[i.slackId] === "yes").map(i => i.slackId);
  const confirmedEditors = invitees
    .filter(i => attendance[i.slackId] === "yes")
    .map(i => editors.find(e => e?.id === i.id))
    .filter(Boolean);
  const confirmedEditorIds = confirmedEditors.map(e => e.id);

  // No-one available — leave the subtask stuck and surface to the
  // channel so a producer reschedules manually.
  if (confirmedEditorIds.length === 0) {
    await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}/internalReview`, {
      state: "noAttendees",
      updatedAt: new Date().toISOString(),
    });
    if (fresh.internalReview?.slackChannel && fresh.internalReview?.slackTs) {
      try {
        await slackPostMessage({
          channel: fresh.internalReview.slackChannel,
          thread_ts: fresh.internalReview.slackTs,
          text: ":warning: No invitees confirmed attendance — please reschedule manually.",
          botToken,
        });
      } catch (e) { console.warn("noAttendees post failed:", e.message); }
    }
    return;
  }

  // Pick the soonest day every confirmed attendee is in the suite
  // (shoot days excluded). Default 9:30am Sydney, 30-min slot.
  const weekData = (await adminGet("/weekData")) || {};
  const fromDate = todaySydney();
  const pickedDay = earliestCommonAvailableDay(confirmedEditorIds, editors, weekData, fromDate);

  // Stamp the subtask + invite. Status -> scheduled, status set on the
  // subtask itself (assigneeIds = confirmed editors) so it appears on
  // the Team Board / Project tabs immediately.
  const now = new Date().toISOString();
  const subtaskPatch = {
    status: pickedDay ? "scheduled" : "stuck",
    startDate: pickedDay,
    endDate: pickedDay,
    startTime: pickedDay ? "09:30" : null,
    endTime: pickedDay ? "10:00" : null,
    assigneeIds: confirmedEditorIds,
    assigneeId: confirmedEditorIds[0] || null,
    updatedAt: now,
  };
  await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}`, subtaskPatch);

  // Best-effort Google Calendar invite. Attendee emails come off the
  // /editors roster; missing emails are silently omitted.
  let calendarEventId = null;
  let calendarHtmlLink = null;
  if (pickedDay) {
    try {
      const start = combineDateTimeSydney(pickedDay, "09:30");
      const end = combineDateTimeSydney(pickedDay, "10:00");
      const attendees = confirmedEditors
        .map(e => (e.email && String(e.email).includes("@")) ? { email: e.email } : null)
        .filter(Boolean);
      if (start && end) {
        const cal = getCalendarClient();
        const summary = `Internal review — ${project.clientName ? project.clientName + ": " : ""}${project.projectName || "Project"}`;
        const description = [
          `30-min internal review for ${project.projectName || "this project"}.`,
          attendees.length ? `Attendees: ${attendees.map(a => a.email).join(", ")}` : "",
          `\n— Auto-booked from #scheduling by the Viewix dashboard.`,
        ].filter(Boolean).join("\n");
        const calendarId = process.env.VIEWIX_CALENDAR_ID;
        if (!calendarId) throw new Error("VIEWIX_CALENDAR_ID not set");
        const ev = await cal.events.insert({
          calendarId,
          sendUpdates: "all",
          requestBody: {
            summary,
            description,
            start: { dateTime: start, timeZone: "Australia/Sydney" },
            end: { dateTime: end, timeZone: "Australia/Sydney" },
            attendees,
            reminders: { useDefault: true },
            guestsCanInviteOthers: false,
            guestsCanSeeOtherGuests: true,
            extendedProperties: { private: { source: "viewix-dashboard", projectId: String(projectId), subtaskId: String(subtaskId), kind: "internal-review" } },
          },
        });
        calendarEventId = ev?.data?.id || null;
        calendarHtmlLink = ev?.data?.htmlLink || null;
      }
    } catch (e) {
      console.warn("bookInternalReview: calendar invite failed:", e.message);
    }
  }

  await adminPatch(`/projects/${projectId}/subtasks/${subtaskId}/internalReview`, {
    state: pickedDay ? "booked" : "noCommonDay",
    bookedSlot: pickedDay ? { date: pickedDay, startTime: "09:30", endTime: "10:00", confirmedSlackIds } : null,
    calendarEventId,
    calendarHtmlLink,
    updatedAt: now,
  });

  // Update the Slack card to show the booking + add outcome buttons.
  if (fresh.internalReview?.slackChannel && fresh.internalReview?.slackTs) {
    const headerLine = pickedDay
      ? `:white_check_mark: *Internal review booked* — ${project.clientName ? project.clientName + ": " : ""}${project.projectName || "Project"}`
      : `:warning: *Internal review couldn't pick a day* — manual reschedule needed`;
    const detailLine = pickedDay
      ? `*${pickedDay}* · 9:30–10:00am Sydney · Attendees: ${confirmedSlackIds.map(s => `<@${s}>`).join(" ")}${calendarHtmlLink ? ` · <${calendarHtmlLink}|Calendar invite>` : ""}`
      : "No common in-suite day found for the confirmed attendees in the next 21 days.";
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: headerLine } },
      { type: "section", text: { type: "mrkdwn", text: detailLine } },
    ];
    if (pickedDay) {
      blocks.push({
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: `review_outcome_approve:${projectId}:${subtaskId}`, value: `${projectId}:${subtaskId}` },
          { type: "button", text: { type: "plain_text", text: "Needs changes" }, action_id: `review_outcome_changes:${projectId}:${subtaskId}`, value: `${projectId}:${subtaskId}` },
        ],
      });
    }
    try {
      await slackUpdateMessage({ channel: fresh.internalReview.slackChannel, ts: fresh.internalReview.slackTs, blocks, text: "Internal review booked", botToken });
    } catch (e) { console.warn("booking update failed:", e.message); }
  }
}

async function handleReviewOutcome({ payload, botToken }) {
  const action = payload.actions?.[0];
  const parsed = parseReviewActionId(action?.action_id);
  if (!parsed) return;
  const { kind, projectId, subtaskId } = parsed;
  const slackUserId = payload.user?.id;

  const project = await adminGet(`/projects/${projectId}`);
  if (!project) return;
  const subtask = (project.subtasks || {})[subtaskId];
  if (!subtask || !subtask.isInternalReview) return;
  const ir = subtask.internalReview || {};
  // Outcome can only be set once the review was actually booked.
  if (ir.state !== "booked") {
    await slackPostEphemeral({
      channel: payload.channel?.id, user: slackUserId,
      text: "This review isn't booked yet — can't record an outcome.",
      botToken,
    });
    return;
  }

  // Delegate the actual writes to the shared outcome applier so the
  // UI surface and the Slack surface stay in lockstep — one source of
  // truth for "what does Approve / Needs changes do."
  const outcome = kind === "review_outcome_approve" ? "approve" : "needsChanges";
  let result;
  try {
    const mod = await import("./internal-review-outcome.js");
    result = await mod.applyReviewOutcome({ projectId, subtaskId, outcome, actor: slackUserId || null });
  } catch (e) {
    console.warn("review outcome apply failed:", e.message);
    await slackPostEphemeral({ channel: payload.channel?.id, user: slackUserId, text: `Couldn't record outcome: ${e.message}`, botToken });
    return;
  }

  // Surface in the original thread so the channel sees what happened.
  if (ir.slackChannel && ir.slackTs) {
    const text = outcome === "approve"
      ? `:white_check_mark: *Approved* by <@${slackUserId}> — videos flipped to Ready for Client. Account Manager has been pinged.`
      : `:memo: *Needs changes* by <@${slackUserId}> — spawned "Internal Changes" subtask for *${project.projectLead || "the project lead"}*${result?.spawnedSubtaskId ? "" : ""} (priority 1).`;
    try {
      await slackPostMessage({ channel: ir.slackChannel, thread_ts: ir.slackTs, text, botToken });
    } catch (e) { console.warn("outcome thread post failed:", e.message); }
  }
}
