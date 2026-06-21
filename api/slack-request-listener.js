// api/slack-request-listener.js
//
// Slack Events API entry for the Dashboard Requests intake bot. Listens to the
// #dashboard-feature-requests channel: when a teammate posts a bug/feature
// request, the bot threads on it, asks Claude-generated clarifying questions
// ONE at a time (with tappable buttons when the answer is a choice set), and
// once it has enough — or after a hard cap — files a ticket into
// /dashboardRequests at `triage`, where it shows on the founders' Kanban.
//
// The intake state machine (triage, ticket creation, the Claude call) lives in
// _dashboard-intake.js so the button interactivity endpoint
// (slack-request-interactivity.js) drives the SAME transactional state. This
// file owns only the Slack Events plumbing: signature, ack-fast, dedup,
// allowlist, and routing a message to new-request vs reply.
//
//   · STATEFUL across a thread → every intake write is transactional.
//   · must NOT drop file_share events — those carry screenshots.
//   · INERT (clean 200) when unconfigured, never 500.

import { waitUntil } from "@vercel/functions";
import { adminGet, getAdmin } from "./_fb-admin.js";
import {
  readRawBody,
  verifySlackSignature,
  slackPostMessage,
  slackAddReaction,
  slackGetUserName,
  parseAllowlist,
} from "./_slack-helpers.js";
import { INTAKE_ROOT, threadPath, RX, ensureIntakeState, recordReply, triage } from "./_dashboard-intake.js";

export const config = { api: { bodyParser: false } };

const EVENT_DEDUP_TTL_MS = 60 * 60 * 1000;

// ─── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const secret = process.env.SLACK_REQUEST_SIGNING_SECRET;
  // Inert no-op until configured — a clean 200, not a 500.
  if (!secret) return res.status(200).json({ ok: true, inert: "signing secret not set" });

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!verifySlackSignature({ rawBody, timestamp, signature, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: "invalid JSON" }); }

  if (payload.type === "url_verification") return res.status(200).send(payload.challenge);

  // Ack immediately so Slack doesn't retry; real work continues in waitUntil.
  res.status(200).end();
  if (payload.type === "event_callback") {
    waitUntil(processEvent(payload).catch(err => {
      console.error("slack-request-listener processEvent error:", err);
    }));
  }
}

// ─── Event processor ───────────────────────────────────────────────
async function processEvent(payload) {
  const event = payload.event || {};
  const eventId = payload.event_id;
  const channel = process.env.SLACK_REQUEST_CHANNEL_ID;
  const botToken = process.env.SLACK_REQUEST_BOT_TOKEN;
  if (!channel || !botToken) {
    console.error("slack-request-listener: SLACK_REQUEST_CHANNEL_ID or SLACK_REQUEST_BOT_TOKEN missing");
    return;
  }

  if (event.type !== "message") return;
  if (event.channel !== channel) return;
  if (event.bot_id) return;
  // Allow plain messages and file shares (screenshots); skip edits/joins/etc.
  if (event.subtype && event.subtype !== "file_share") return;

  const text = (event.text || "").trim();
  const files = extractFiles(event);
  if (!text && files.length === 0) return;

  // Dedup — Slack retries on slow ack. Distinct user replies are distinct
  // events with distinct ids, so this only collapses true retries.
  if (eventId) {
    const { db } = getAdmin();
    if (db) {
      const ref = db.ref(`${INTAKE_ROOT}/events/${eventId}`);
      const tx = await ref.transaction(c => (c ? undefined : { receivedAt: Date.now(), expiresAt: Date.now() + EVENT_DEDUP_TTL_MS }));
      if (!tx.committed) return; // duplicate
    }
  }

  // Allowlist gate (before any LLM call or state write) — applies to BOTH new
  // posts and thread replies, so a non-allowlisted member can't feed answers
  // into a tracked intake thread. A null allowlist means open to all.
  const allowlist = parseAllowlist(process.env.SLACK_REQUEST_ALLOWED_USER_IDS);
  if (allowlist && !allowlist.has(event.user)) return;

  const isReply = event.thread_ts && event.thread_ts !== event.ts;
  if (isReply) await handleReply({ event, channel, botToken, text, files });
  else await handleNewRequest({ event, channel, botToken, text, files });
}

function extractFiles(event) {
  const arr = Array.isArray(event.files) ? event.files : [];
  return arr
    .filter(f => f && f.permalink)
    .slice(0, 10)
    .map(f => ({ permalink: f.permalink, name: f.name || f.title || "file" }));
}

// ─── New top-level request ─────────────────────────────────────────
async function handleNewRequest({ event, channel, botToken, text, files }) {
  const rootTs = event.ts;
  const userName = await slackGetUserName({ user: event.user, botToken });
  const path = threadPath(rootTs);

  const created = await ensureIntakeState(path, {
    rootTs, channel, user: event.user, userName: userName || null,
    originalText: text, screenshots: files, rounds: [], questionCount: 0,
    status: "gathering", ticketCreated: false, ticketId: null, createdAt: Date.now(),
  });
  if (!created) return; // already existed (shouldn't happen — event_id deduped)

  await slackAddReaction({ channel, timestamp: rootTs, name: RX.THINKING, botToken });
  await triage({ rootTs, channel, botToken });
}

// ─── Thread reply (typed answer to a clarifying question) ──────────
async function handleReply({ event, channel, botToken, text, files }) {
  const rootTs = event.thread_ts;
  const path = threadPath(rootTs);
  const existing = await adminGet(path);
  if (!existing) return; // not a tracked intake thread

  if (existing.ticketCreated) {
    // A reply after the ticket is filed is usually a NEW request posted inside
    // an old thread, which we'd otherwise silently swallow. Nudge once — a raw
    // transaction so only the winning concurrent reply posts it.
    if (!existing.hintPosted) {
      const { db } = getAdmin();
      if (db) {
        const tx = await db.ref(path).transaction(cur => {
          if (!cur) return cur;          // cold-null → force refetch
          if (cur.hintPosted) return;    // abort — already nudged
          return { ...cur, hintPosted: true };
        });
        if (tx.committed) {
          await slackPostMessage({
            channel, thread_ts: rootTs, botToken,
            text: "This one's already logged ✅ — for a *new* request, post a fresh top-level message in the channel (not a reply here) so I can pick it up.",
          });
        }
      }
    }
    return;
  }

  await recordReply({ path, text, files });
  await triage({ rootTs, channel, botToken });
}
