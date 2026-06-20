// api/github-request-webhook.js
//
// Closes the Dashboard Requests loop (Phase 4). GitHub posts here when an issue
// opened by the handoff is closed — or when a PR that references it is merged.
// Either way we move the matching ticket to `done` and swap the original Slack
// message's reaction to :white_check_mark:, so the person who reported it sees
// it shipped without anyone touching the board by hand.
//
// Inert (clean 200) until GITHUB_REQUESTS_WEBHOOK_SECRET is set — safe to ship
// before the webhook is configured. Signature: GitHub's X-Hub-Signature-256
// (HMAC-SHA256 of the raw body), constant-time compared.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { adminGet, adminPatch } from "./_fb-admin.js";
import { findTicketByIssueNumber } from "./_dashboard-requests.js";
import { readRawBody, slackSwapReaction, REACTION } from "./_slack-helpers.js";

export const config = { api: { bodyParser: false } };

const LOGGED_REACTION = "memo"; // what the intake bot left on the message

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const secret = process.env.GITHUB_REQUESTS_WEBHOOK_SECRET;
  if (!secret) return res.status(200).json({ ok: true, inert: "webhook secret not set" });

  const sig = req.headers["x-hub-signature-256"];
  if (!verifyGithubSignature({ rawBody, signature: sig, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: "invalid JSON" }); }

  res.status(200).end();
  waitUntil(processWebhook(payload).catch(err => {
    console.error("github-request-webhook error:", err);
  }));
}

function verifyGithubSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function processWebhook(payload) {
  // Issue closed as COMPLETED (e.g. auto-closed by a merged PR's "closes #N")
  // → done. Gate on state_reason so a manual "not planned" / "duplicate" close
  // does NOT falsely tell the Slack reporter it shipped (Codex R2-F7).
  if (payload.issue && payload.action === "closed") {
    if (payload.issue.state_reason === "completed") {
      await completeByIssue(payload.issue.number, null);
    }
    return;
  }

  // PR merged → done for every issue it references, and stamp the PR url.
  if (payload.pull_request && payload.action === "closed" && payload.pull_request.merged) {
    const pr = payload.pull_request;
    const refs = referencedIssues(`${pr.title || ""}\n${pr.body || ""}`);
    for (const n of refs) await completeByIssue(n, pr.html_url);
    return;
  }
}

// Collect #N references from PR text. Over-matching is harmless — only ids that
// map to a real ticket do anything. Exported for unit testing.
export function referencedIssues(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/#(\d+)/g)) out.add(parseInt(m[1], 10));
  return [...out].filter(Number.isFinite);
}

async function completeByIssue(issueNumber, prUrl) {
  const found = await findTicketByIssueNumber(issueNumber);
  if (!found) return;
  const [id, ticket] = found;

  const patch = { updatedAt: Date.now() };
  if (ticket.status !== "done") patch.status = "done";
  if (prUrl && !(ticket.github && ticket.github.prUrl)) {
    patch.github = { ...(ticket.github || {}), prUrl };
  }
  // Nothing to do if already done and the PR url is already stamped.
  if (!patch.status && !patch.github) return;
  await adminPatch(`/dashboardRequests/${id}`, patch);

  // ✅ on the original Slack message. Uses the intake bot's token; idempotent
  // (already_reacted / no_reaction are swallowed by the helper).
  const s = ticket.slack;
  const botToken = process.env.SLACK_REQUEST_BOT_TOKEN;
  if (s && s.channelId && s.messageTs && botToken) {
    await slackSwapReaction({
      channel: s.channelId,
      timestamp: s.messageTs,
      removeName: LOGGED_REACTION,
      addName: REACTION.DONE,
      botToken,
    });
  }
}
