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
import { adminGet, getAdmin } from "./_fb-admin.js";
import {
  readRawBody,
  verifySlackSignature,
  todaySydney,
  slackUpdateMessage,
  slackPostEphemeral,
  slackSwapReaction,
  parseAllowlist,
  fingerprintSubtask,
  fingerprintsMatch,
  nextStatusForUpdate,
  STAGES,
  STAGE_LABELS,
  STAGE_EMOJI,
  DEFAULT_NAME_FOR_STAGE,
  REACTION,
} from "./_slack-helpers.js";

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

  const action = payload.actions?.[0];
  if (!action) return;

  // Allowlist gate — same env var as the listener. Even if a user can
  // see the card in #scheduling, they can't act on it unless allowed.
  const allowlist = parseAllowlist(process.env.SLACK_SCHEDULE_ALLOWED_USER_IDS);
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
  console.warn("slack-interactivity: unknown action_id", id);
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
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_From your message:_ ${truncate(proposal.originalText, 140)}` }],
    },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Confirm" }, action_id: "confirm_schedule", value: proposal.shortId },
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
