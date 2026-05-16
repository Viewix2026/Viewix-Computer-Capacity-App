// api/slack-plan-listener.js
//
// Phase 2 v2.0 — the `/plan <project>` slash command. Manual trigger
// for the auto-distribute planner (the auto trigger lives in
// slack-interactivity.js after a first-shoot confirm).
//
// Slash command bodies are application/x-www-form-urlencoded, NOT
// JSON. We verify the Slack HMAC on the raw bytes, then URLSearchParams
// the body. trigger_id is valid ~3s, so resolve the project and open
// the modal promptly, then ack 200.
//
// Auth: Slack HMAC + SLACK_SCHEDULE_ALLOWED_USER_IDS (write audience).

import { adminGet } from "./_fb-admin.js";
import {
  readRawBody,
  verifySlackSignature,
  parseAllowlist,
  slackOpenView,
  buildPlanModalView,
} from "./_slack-helpers.js";

export const config = { api: { bodyParser: false }, maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const secret = process.env.SLACK_SCHEDULE_SIGNING_SECRET;
  if (!secret) {
    console.error("slack-plan-listener: SLACK_SCHEDULE_SIGNING_SECRET not configured");
    return res.status(500).json({ error: "signing secret not configured" });
  }
  if (!verifySlackSignature({ rawBody, timestamp, signature, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const form = new URLSearchParams(rawBody);
  const userId = form.get("user_id");
  const triggerId = form.get("trigger_id");
  const text = (form.get("text") || "").trim();

  const allowlist = parseAllowlist(process.env.SLACK_SCHEDULE_ALLOWED_USER_IDS);
  if (allowlist && !allowlist.has(userId)) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "You're not on the scheduler allowlist — only allowed users can run `/plan`.",
    });
  }

  if (!text) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Usage: `/plan <project name>` — e.g. `/plan Acme`.",
    });
  }

  // Resolve the project by case-insensitive substring on projectName.
  let projects;
  try {
    projects = (await adminGet("/projects")) || {};
  } catch (e) {
    console.error("slack-plan-listener adminGet error:", e);
    return res.status(200).json({ response_type: "ephemeral",
      text: "Couldn't read projects right now — try again in a moment." });
  }

  const q = text.toLowerCase();
  const matches = Object.entries(projects)
    .map(([id, p]) => ({ id, ...p }))
    .filter(p => (p.projectName || "").toLowerCase().includes(q));

  if (matches.length === 0) {
    return res.status(200).json({ response_type: "ephemeral",
      text: `No project matching "${text}".` });
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 8).map(p => `• ${p.projectName}`).join("\n");
    return res.status(200).json({
      response_type: "ephemeral",
      text: `Multiple projects match "${text}":\n${names}\nBe more specific.`,
    });
  }

  const project = matches[0];
  if (!(parseInt(project.numberOfVideos, 10) > 1)) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: `${project.projectName} has ${project.numberOfVideos || 1} video — `
        + `nothing to auto-distribute. Schedule it directly.`,
    });
  }

  const editorsRaw = (await adminGet("/editors")) || [];
  const editors = (Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw))
    .filter(e => e?.id);

  try {
    await slackOpenView({
      trigger_id: triggerId,
      view: buildPlanModalView({
        project,
        editors,
        defaultDeadline: project.dueDate || null,
      }),
      botToken: process.env.SLACK_SCHEDULE_BOT_TOKEN,
    });
  } catch (e) {
    console.error("slack-plan-listener views.open error:", e);
    return res.status(200).json({ response_type: "ephemeral",
      text: "Couldn't open the planner modal — try again." });
  }

  // Empty 200 — the modal is already open; no channel message needed.
  return res.status(200).end();
}
