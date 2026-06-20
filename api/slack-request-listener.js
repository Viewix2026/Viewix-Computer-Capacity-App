// api/slack-request-listener.js
//
// Slack Events API entry for the Dashboard Requests intake bot. Listens to the
// #dashboard-feature-requests channel: when a teammate posts a bug/feature
// request, the bot threads on it, asks Claude-generated clarifying questions
// (where in the dashboard, expected vs actual, repro, screenshot), and once it
// has enough — or after a hard cap of clarifying rounds — files a ticket into
// /dashboardRequests at `triage`, where it shows up on the founders' Kanban.
//
// Mirrors api/slack-schedule-listener.js: signature-verified, immediate 200 ack
// + waitUntil, event_id dedup. Differences forced by the design:
//   · it is STATEFUL across a thread (accumulates Q&A) — so every intake write
//     is transactional (mutateRecord), or the round cap + double-create guard
//     would be racy (Codex R1-F6).
//   · it must NOT drop file_share events — those carry the screenshots
//     (Codex R1-F7). Screenshots are stored as Slack permalinks (a browser
//     can't fetch a private files.slack.com URL with the bot token).
//   · it is INERT (clean 200 no-op) when unconfigured, never 500 — repeated
//     500s make Slack disable the subscription (Codex R1-F5). Safe on deploy
//     because no Events URL points here until the env vars are wired last.

import { waitUntil } from "@vercel/functions";
import { adminGet, adminSet, getAdmin, mutateRecord } from "./_fb-admin.js";
import {
  readRawBody,
  verifySlackSignature,
  slackPostMessage,
  slackAddReaction,
  slackSwapReaction,
  slackGetPermalink,
  slackGetUserName,
  parseAllowlist,
} from "./_slack-helpers.js";
import { newRequestId, buildTicket } from "./_dashboard-requests.js";

export const config = { api: { bodyParser: false } };

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.SLACK_REQUEST_MODEL || "claude-haiku-4-6";
const MAX_TOKENS = 1024;
const MAX_QUESTION_ROUNDS = 3;
const EVENT_DEDUP_TTL_MS = 60 * 60 * 1000;

// Distinct from the scheduler's REACTION map: :eyes: while gathering, :memo:
// once a ticket is logged. The final :white_check_mark: is added by the GitHub
// webhook when the work actually ships (Phase 4).
const RX = { THINKING: "eyes", LOGGED: "memo", ERROR: "warning" };

const INTAKE_ROOT = "/dashboardRequestsIntake";
// Slack ts ("1718…​.123456") contains a ".", illegal in an RTDB key.
const threadPath = (rootTs) => `${INTAKE_ROOT}/threads/${String(rootTs).replace(/\./g, "_")}`;

// ─── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const secret = process.env.SLACK_REQUEST_SIGNING_SECRET;
  // Inert no-op until configured (Codex R1-F5) — a clean 200, not a 500.
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

  // Allowlist gate (before any LLM call) — keep token burn off non-team posts.
  const allowlist = parseAllowlist(process.env.SLACK_REQUEST_ALLOWED_USER_IDS);
  if (allowlist && !allowlist.has(event.user)) return;

  const userName = await slackGetUserName({ user: event.user, botToken });
  const path = threadPath(rootTs);

  // Create intake state iff absent. Returning the new object on the SDK's
  // cold-cache null first run forces a server fetch + re-run, so a genuine
  // pre-existing node is preserved (not clobbered).
  const created = await ensureIntakeState(path, {
    rootTs, channel, user: event.user, userName: userName || null,
    originalText: text, screenshots: files, rounds: [], questionCount: 0,
    status: "gathering", ticketCreated: false, ticketId: null, createdAt: Date.now(),
  });
  if (!created) return; // already existed (shouldn't happen — event_id deduped)

  await slackAddReaction({ channel, timestamp: rootTs, name: RX.THINKING, botToken });
  await triage({ rootTs, channel, botToken });
}

// Transactional create-if-absent. Uses a raw transaction (not mutateRecord) so
// the cold-null first run returns the new value to force a server re-run, while
// a real existing value is returned unchanged. Returns true iff WE created it.
async function ensureIntakeState(path, initial) {
  const { db } = getAdmin();
  if (!db) return false;
  const tx = await db.ref(path).transaction(cur => (cur ? cur : initial));
  // committed is true whether we wrote `initial` or found an existing node.
  // We created it iff the committed value is ours — identified by our unique
  // createdAt timestamp (captured before the transaction).
  const snap = tx.committed && tx.snapshot ? tx.snapshot.val() : null;
  return !!snap && snap.createdAt === initial.createdAt;
}

// ─── Thread reply (answer to a clarifying question) ────────────────
async function handleReply({ event, channel, botToken, text, files }) {
  const rootTs = event.thread_ts;
  const path = threadPath(rootTs);
  const existing = await adminGet(path);
  if (!existing) return; // not a tracked intake thread

  if (existing.ticketCreated) {
    // A reply after the ticket is filed is usually a NEW request posted inside
    // an old thread, which we'd otherwise silently swallow (Codex R2-F6). Nudge
    // once — a raw transaction so only the winning concurrent reply posts it.
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

  await mutateRecord(path, (cur) => {
    if (cur.ticketCreated) return cur;
    const rounds = Array.isArray(cur.rounds) ? cur.rounds.map(r => ({ ...r })) : [];
    let filled = false;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i] && rounds[i].a == null) { rounds[i].a = text || "(screenshot)"; filled = true; break; }
    }
    // No pending question but the user added text → keep it as an unprompted
    // note rather than dropping it. Under two fast concurrent replies the
    // second finds no pending slot; without this it would be lost (Codex R2-F1).
    if (!filled && text) rounds.push({ q: null, a: text });
    const screenshots = (Array.isArray(cur.screenshots) ? cur.screenshots : []).concat(files).slice(0, 20);
    if (!filled && !text && files.length === 0) return cur;
    return { ...cur, rounds, screenshots };
  });

  await triage({ rootTs, channel, botToken });
}

// ─── Triage step ───────────────────────────────────────────────────
async function triage({ rootTs, channel, botToken }) {
  const path = threadPath(rootTs);
  const state = await adminGet(path);
  if (!state || state.ticketCreated) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("slack-request-listener: ANTHROPIC_API_KEY missing"); return; }

  const atCap = (state.questionCount || 0) >= MAX_QUESTION_ROUNDS;
  // If a question is still outstanding, wait for the reply (unless we're at the
  // cap, in which case we file now with what we have).
  const pending = (state.rounds || []).some(r => r && r.a == null);
  if (pending && !atCap) return;

  const decision = await callClaudeForTriage({ state, apiKey, forceSubmit: atCap });
  if (decision.kind === "error") {
    if (atCap) {
      // At the cap with an LLM error there's no further user reply to retrigger
      // triage — file a minimal ticket rather than stranding the thread on
      // :eyes: forever (Codex R2-F4).
      const fallback = { kind: "submit", title: (state.originalText || "").slice(0, 100) || "Untitled request", type: "bug" };
      await createTicketFromState({ rootTs, channel, botToken, decision: fallback, state, needsDetail: true });
    } else {
      console.error("slack-request-listener triage error:", decision.message);
    }
    return; // transient error mid-conversation: leave :eyes:, the next reply retriggers
  }

  if (decision.kind === "ask" && !atCap) {
    const q = String(decision.question || "").trim();
    if (!q) return;
    const tx = await mutateRecord(path, (cur) => {
      if (cur.ticketCreated) return cur;
      const rounds = Array.isArray(cur.rounds) ? cur.rounds.slice() : [];
      if (rounds.some(r => r && r.a == null)) return cur; // already a pending question
      rounds.push({ q, a: null });
      return { ...cur, rounds, questionCount: (cur.questionCount || 0) + 1 };
    });
    const last = tx.snapshot?.rounds?.slice(-1)[0];
    if (tx.committed && last && last.a == null && last.q === q && !tx.snapshot?.ticketCreated) {
      await slackPostMessage({ channel, thread_ts: rootTs, text: q, botToken });
    }
    return;
  }

  // submit — Claude chose it, or we hit the cap (forceSubmit guarantees a
  // submit_ticket tool call).
  await createTicketFromState({ rootTs, channel, botToken, decision, state, needsDetail: atCap });
}

async function createTicketFromState({ rootTs, channel, botToken, decision, state, needsDetail }) {
  const path = threadPath(rootTs);
  const id = newRequestId();

  // Transactional create-once guard: claim ticketCreated with our id. If
  // another invocation already claimed it, snapshot carries a different id and
  // we bail — no double ticket (Codex R1-F6).
  const tx = await mutateRecord(path, (cur) => {
    if (cur.ticketCreated) return cur;
    return { ...cur, ticketCreated: true, ticketId: id, status: "created" };
  });
  if (!tx.committed || tx.snapshot?.ticketId !== id) return;

  const permalink = await slackGetPermalink({ channel, message_ts: rootTs, botToken });
  const clarifications = (state.rounds || [])
    .filter(r => r && r.a != null)
    .map(r => ({ q: r.q || "Additional detail", a: r.a }));
  let body = state.originalText || "";
  if (needsDetail) body += (body ? "\n\n" : "") + "_(auto-logged at the question limit — may need more detail)_";

  const ticket = buildTicket({
    id,
    title: decision.title || (state.originalText || "").slice(0, 100) || "Untitled request",
    body,
    type: decision.type,
    priority: null,
    source: "slack",
    requestedBy: { slackUserId: state.user || null, name: state.userName || "Teammate" },
    slack: { channelId: channel, messageTs: rootTs, threadTs: rootTs, permalink: permalink || null },
    screenshots: state.screenshots || [],
    clarifications,
  });
  await adminSet(`/dashboardRequests/${id}`, ticket);

  await slackPostMessage({
    channel, thread_ts: rootTs, botToken,
    text: "📋 Logged this on the Dashboard Requests board — thanks! We'll take it from here.",
  });
  await slackSwapReaction({ channel, timestamp: rootTs, removeName: RX.THINKING, addName: RX.LOGGED, botToken });
}

// ─── Claude triage call ────────────────────────────────────────────
const TRIAGE_TOOLS = [
  {
    name: "ask_clarification",
    description:
      "Ask the teammate ONE consolidated message (you may include 2–3 short bullet sub-questions) when you still need to understand the request before a developer could act on it. Good things to nail down: WHERE in the dashboard (which tab/page), what they EXPECTED vs what they SAW, steps to reproduce, and whether they can attach a screenshot.",
    input_schema: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
  },
  {
    name: "submit_ticket",
    description: "Use once you have enough that a developer could start work.",
    input_schema: {
      type: "object",
      required: ["title", "type"],
      properties: {
        title: { type: "string", description: "short imperative summary, <= 100 chars" },
        type: { type: "string", enum: ["bug", "feature"] },
      },
    },
  },
];

function buildTriageSystemPrompt() {
  return `You are the Viewix dashboard request triager in a Slack channel where the team reports bugs and feature requests for an internal dashboard.

Your job: gather just enough to file an actionable ticket, then file it. Most reports are bug fixes, not features.

RULES
- Call exactly ONE tool per turn.
- If the report is already clear and actionable (you know roughly WHERE in the dashboard and WHAT is wrong/wanted), call submit_ticket immediately — do not ask busywork questions.
- Otherwise call ask_clarification with ONE friendly message. Prefer to learn: which tab/page, expected vs actual behaviour, repro steps, and a screenshot if relevant. Keep it short; bundle a couple of bullets rather than many separate questions.
- Classify type: "bug" if something is broken/wrong; "feature" if it's a new capability or enhancement.
- Write the title as a concise imperative summary (e.g. "Fix revenue chart showing wrong YoY %", "Add CSV export to Time Log Analytics").
- Never invent details the teammate didn't say.`;
}

async function callClaudeForTriage({ state, apiKey, forceSubmit }) {
  const lines = [`Original request from ${state.userName || "a teammate"}: ${state.originalText || "(no text — see screenshot)"}`];
  if ((state.screenshots || []).length) lines.push(`They attached ${state.screenshots.length} screenshot(s).`);
  for (const r of (state.rounds || [])) {
    if (!r) continue;
    if (r.q) {
      lines.push(`You asked: ${r.q}`);
      if (r.a != null) lines.push(`They answered: ${r.a}`);
    } else if (r.a != null) {
      lines.push(`They added: ${r.a}`);
    }
  }
  if (forceSubmit) lines.push(`\n[You have reached the clarifying-question limit. Submit the ticket now with what you have.]`);

  let resp;
  try {
    resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: buildTriageSystemPrompt(), cache_control: { type: "ephemeral" } }],
        tools: TRIAGE_TOOLS,
        tool_choice: forceSubmit ? { type: "tool", name: "submit_ticket" } : { type: "any" },
        messages: [{ role: "user", content: lines.join("\n") }],
      }),
    });
  } catch (e) {
    return { kind: "error", message: `fetch failed: ${e?.message || e}` };
  }
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    return { kind: "error", message: `Anthropic API ${resp.status}: ${err.slice(0, 200)}` };
  }
  const data = await resp.json();
  const tool = (data.content || []).find(b => b.type === "tool_use");
  if (!tool) return { kind: "error", message: "Claude returned no tool call" };
  if (tool.name === "ask_clarification") return { kind: "ask", question: tool.input?.question };
  if (tool.name === "submit_ticket") {
    return { kind: "submit", title: tool.input?.title, type: tool.input?.type === "feature" ? "feature" : "bug" };
  }
  return { kind: "error", message: `unknown tool: ${tool.name}` };
}
