// api/trigger-internal-review.js
//
// Phase 4 (#C) — project-level "internal review ready" trigger.
//
// Fired fire-and-forget from EditorDashboardViewix.handleSubmit on every
// Finish. Detects "all video edits done" via projectEditsAllFinished
// (reformats excluded — they happen AFTER the review). When that flips
// to true for a project, this endpoint:
//   1. Creates an "Internal Review" subtask on the project (revisions
//      stage, unscheduled — the date is set later when attendees confirm).
//   2. Posts one interactive Slack message to #scheduling tagging the
//      Project Lead + Steve + Jeremy with Yes / Can't attend buttons.
//   3. Stamps /projects/{id}/notifications/internalReady = ISO so we
//      never double-fire.
// Idempotent server-side — multiple editors finishing the same project's
// last edit will all hit this endpoint; only the first request that
// observes the gate passing will actually do the work.
//
// Booking + calendar invite + outcome (approve / needs changes) live in
// api/slack-interactivity.js (review_attend_* / review_outcome_* action
// handlers) once attendees have responded. This file is the kickoff only.
//
// Request (POST JSON): { projectId }
//   200 { ok:true, created|skipped }   200 even on no-op (idempotent)

import { adminGet, adminSet, adminPatch } from "./_fb-admin.js";
import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { slackPostMessage } from "./_slack-helpers.js";
import { projectEditsAllFinished } from "../shared/scheduling/reviewPipeline.js";

const ALLOWED_ROLES = ["founders", "manager", "lead", "editor"];

// Founders we always tag on internal-review readiness, in addition to
// the project lead. Names are matched against the /editors roster (the
// same lookup notify-finish.js uses for Slack IDs).
const FOUNDER_NAMES = ["Steve", "Jeremy"];

function lc(s) { return (s == null ? "" : String(s)).trim().toLowerCase(); }

// Resolve a roster entry by name (case-insensitive). Returns the full
// editor object or null. Falls back to null on any read error so the
// trigger degrades to "fewer mentions" rather than failing the post.
function findEditorByName(editors, name) {
  if (!name) return null;
  const want = lc(name);
  return editors.find(e => e && lc(e.name) === want) || null;
}

// Build the Slack message blocks for the attendance ping. One row of
// buttons (Yes / Can't attend) — clicker is identified by payload.user.id
// in the interactivity handler, so we don't need per-user buttons.
function buildAttendanceBlocks({ projectId, subtaskId, clientName, projectName, invitees }) {
  const header = clientName
    ? `*${clientName}: ${projectName}* is ready for internal review.`
    : `*${projectName}* is ready for internal review.`;
  const mentionLine = invitees
    .filter(i => i.slackId)
    .map(i => `<@${i.slackId}>`)
    .join(" ");
  const inviteeText = invitees.length
    ? `Invitees: ${invitees.map(i => i.slackId ? `<@${i.slackId}>` : `*${i.name}*`).join(", ")}`
    : "";
  const body = [
    header,
    mentionLine ? `${mentionLine} — can you attend a 30-min internal review?` : "Can you attend a 30-min internal review?",
    inviteeText,
    "_Booking auto-confirms once every invitee has responded._",
  ].filter(Boolean).join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text: body } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Yes I'll attend" },
          action_id: `review_attend_yes:${projectId}:${subtaskId}`,
          value: `${projectId}:${subtaskId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Can't attend" },
          action_id: `review_attend_no:${projectId}:${subtaskId}`,
          value: `${projectId}:${subtaskId}`,
        },
      ],
    },
  ];
}

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  let body;
  try {
    body = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  const projectId = (body.projectId || "").toString().trim();
  if (!projectId) return res.status(400).json({ ok: false, error: "projectId required" });

  // Re-read the project — never trust the caller's snapshot for the
  // completion gate; another editor may have finished in parallel.
  let project;
  try { project = await adminGet(`/projects/${projectId}`); }
  catch (e) { return res.status(500).json({ ok: false, error: `project read failed: ${e.message}` }); }
  if (!project) return res.status(404).json({ ok: false, error: "project_not_found" });

  // Idempotency #1 — notifications.internalReady was stamped already.
  if (project.notifications && project.notifications.internalReady) {
    return res.status(200).json({ ok: true, skipped: "already_triggered", at: project.notifications.internalReady });
  }

  // Gate — only proceed once every video edit is done.
  if (!projectEditsAllFinished(project)) {
    return res.status(200).json({ ok: true, skipped: "not_all_edits_done" });
  }

  // Idempotency #2 — a prior call already created the subtask (e.g. the
  // notifications flag write failed; do not double-seed the subtask).
  const subs = project.subtasks ? Object.values(project.subtasks) : [];
  if (subs.some(s => s && s.isInternalReview)) {
    return res.status(200).json({ ok: true, skipped: "subtask_exists" });
  }

  // Resolve invitees from /editors (Project Lead + the two founders).
  // Each invitee carries a slackId where available so the message can
  // <@mention> them; missing slackId falls back to bold name.
  let editors = [];
  try {
    const raw = await adminGet("/editors");
    editors = Array.isArray(raw) ? raw : Object.values(raw || {});
  } catch (e) {
    console.warn("trigger-internal-review: editor lookup failed:", e.message);
  }
  const invitees = [];
  const leadEditor = findEditorByName(editors, project.projectLead);
  if (leadEditor) invitees.push({ name: leadEditor.name, id: leadEditor.id, slackId: leadEditor.slackUserId || null, role: "lead" });
  for (const fname of FOUNDER_NAMES) {
    const f = findEditorByName(editors, fname);
    if (f && !invitees.some(i => i.id === f.id)) {
      invitees.push({ name: f.name, id: f.id, slackId: f.slackUserId || null, role: "founder" });
    }
  }

  // Create the Internal Review subtask. Unscheduled — the booking step
  // in slack-interactivity sets startDate/endDate/start/endTime once
  // every invitee has responded. Status stays `stuck` until then so the
  // Team Board treats it as "needs scheduling" (matches the producer's
  // mental model — it's blocked on attendance).
  const now = new Date().toISOString();
  const stId = `st-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const orderBase = subs.reduce((m, s) => Math.max(m, s?.order ?? 0), 0) + 1;
  const reviewSubtask = {
    id: stId,
    name: "Internal Review",
    stage: "revisions",
    status: "stuck",
    startDate: null, endDate: null, startTime: null, endTime: null,
    assigneeIds: [], assigneeId: null,
    isInternalReview: true,
    internalReview: {
      state: "awaitingAttendance",
      invitees,
      attendance: {}, // { [slackId]: "yes" | "no" }
      slackChannel: null,
      slackTs: null,
      bookedSlot: null,
      calendarEventId: null,
    },
    source: "internal-review",
    order: orderBase,
    createdAt: now, updatedAt: now,
  };
  try {
    await adminSet(`/projects/${projectId}/subtasks/${stId}`, reviewSubtask);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `subtask write failed: ${e.message}` });
  }

  // Stamp the idempotency key NOW (before the Slack post) so a parallel
  // call observes "already_triggered" and bails — the Slack post is the
  // expensive bit and we'd rather miss a post than spam the channel.
  // The Slack ts is patched onto the subtask after a successful post.
  try {
    await adminPatch(`/projects/${projectId}/notifications`, { internalReady: now });
  } catch (e) {
    console.warn("trigger-internal-review: idempotency stamp failed:", e.message);
  }

  // Post the interactive Slack message. Best-effort — if Slack fails
  // the subtask is still on the dashboard for the producer to act on.
  const channel = process.env.SLACK_SCHEDULE_CHANNEL_ID;
  const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
  if (!channel || !botToken) {
    console.warn("trigger-internal-review: SLACK_SCHEDULE_CHANNEL_ID / SLACK_SCHEDULE_BOT_TOKEN missing — subtask created without Slack ping");
    return res.status(200).json({ ok: true, created: stId, slack: { ok: false, reason: "not_configured" } });
  }

  const blocks = buildAttendanceBlocks({
    projectId,
    subtaskId: stId,
    clientName: project.clientName || "",
    projectName: project.projectName || "Untitled project",
    invitees,
  });
  let slackPost;
  try {
    slackPost = await slackPostMessage({
      channel,
      blocks,
      text: `Internal review ready — ${project.projectName || projectId}`,
      botToken,
    });
  } catch (e) {
    console.error("trigger-internal-review: slack post failed:", e.message);
    return res.status(200).json({ ok: true, created: stId, slack: { ok: false, reason: e.message } });
  }

  // Persist Slack message coordinates so the attendance handler can
  // update the same message in place when invitees click.
  if (slackPost && slackPost.ok && slackPost.ts) {
    try {
      await adminPatch(`/projects/${projectId}/subtasks/${stId}/internalReview`, {
        slackChannel: channel,
        slackTs: slackPost.ts,
      });
    } catch (e) {
      console.warn("trigger-internal-review: ts patch failed:", e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    created: stId,
    slack: { ok: !!slackPost?.ok, ts: slackPost?.ts || null },
    invitees: invitees.map(i => ({ name: i.name, slackId: i.slackId, role: i.role })),
  });
}
