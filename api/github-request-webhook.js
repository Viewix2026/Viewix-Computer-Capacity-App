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
import { findTicketByIssueNumber, githubRequestsConfig } from "./_dashboard-requests.js";
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
  // Ignore webhooks from any repo other than the configured one. The webhook is
  // repo-wide and the dashboard repo also sees unrelated PRs/issues, so without
  // this a stray payload could complete a ticket by a coincidental number
  // (Codex F2). Only enforce when the repo is configured — if it isn't,
  // createIssueForTicket is inert so no ticket carries an issueNumber to match.
  const cfg = githubRequestsConfig();
  if (cfg) {
    // When configured, require an exact repo match — a payload with no
    // repository.full_name is treated as a mismatch, not a bypass (Codex R2-N4).
    const repo = payload.repository?.full_name;
    if (!repo || repo.toLowerCase() !== cfg.repo.toLowerCase()) return;
  }

  // Issue closed as COMPLETED (e.g. auto-closed by a merged PR's "closes #N")
  // → done. This is the PRIMARY done trigger: the issue is unambiguously one we
  // opened (matched by issueNumber). Gate on state_reason so a manual
  // "not planned" / "duplicate" close does NOT falsely tell the Slack reporter
  // it shipped (Codex R2-F7).
  if (payload.issue && payload.action === "closed") {
    if (payload.issue.state_reason === "completed") {
      await completeByIssue(payload.issue.number, null);
    }
    return;
  }

  // PR merged → done + stamp the PR url, but ONLY for issues the PR explicitly
  // CLOSES (closes/fixes/resolves #N) — never a bare "#N" mention, or an
  // incidental cross-reference in an unrelated PR would falsely complete a
  // ticket sharing that number (Codex F2). The issues.closed path above is the
  // main trigger; this covers a merge to a non-default branch, where GitHub
  // does not auto-close the linked issue.
  if (payload.pull_request && payload.action === "closed" && payload.pull_request.merged) {
    const pr = payload.pull_request;
    const refs = closingReferences(`${pr.title || ""}\n${pr.body || ""}`);
    for (const n of refs) await completeByIssue(n, pr.html_url);
    return;
  }
}

// Collect #N references from PR text. Exported for unit testing; retained as a
// general utility. NOT used for completion — see closingReferences.
export function referencedIssues(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/#(\d+)/g)) out.add(parseInt(m[1], 10));
  return [...out].filter(Number.isFinite);
}

// Collect issues a PR explicitly CLOSES via GitHub's auto-close keywords
// (close/closes/closed · fix/fixes/fixed · resolve/resolves/resolved #N).
// Unlike a bare "#N" mention this won't sweep in incidental cross-references,
// so an unrelated merged PR can't complete a coincidentally-numbered ticket.
export function closingReferences(text) {
  const out = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+#(\d+)/gi;
  for (const m of String(text).matchAll(re)) out.add(parseInt(m[1], 10));
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
