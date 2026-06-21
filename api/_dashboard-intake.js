// api/_dashboard-intake.js
// The Dashboard Requests intake state machine — shared by the events listener
// (api/slack-request-listener.js) and the button interactivity endpoint
// (api/slack-request-interactivity.js) so both drive the SAME transactional
// thread state. Logic relocated verbatim from the #314 listener, plus:
//   · one question per turn (MAX_QUESTION_ROUNDS raised)
//   · optional multiple-choice buttons (renderQuestion + stored round.options)
//   · recordReply() extracted so a button click and a typed reply share one path
//
// Invariants preserved from #314: every mutation is transactional; the create
// guard is write-first + unique confirm token; answers are never lost (an
// orphan answer becomes a note).

import { adminGet, adminSet, getAdmin, mutateRecord } from "./_fb-admin.js";
import {
  slackPostMessage, slackUpdateMessage, slackSwapReaction, slackGetPermalink, randomShortId,
} from "./_slack-helpers.js";
import { buildTicket, ticketIdForThread } from "./_dashboard-requests.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.SLACK_REQUEST_MODEL || "claude-haiku-4-5";
const MAX_TOKENS = 1024;
// One question per turn means more rounds than the old bundled-message flow, so
// the cap is higher — still a hard stop with the forceSubmit fallback.
export const MAX_QUESTION_ROUNDS = 5;

// :eyes: while gathering, :memo: once logged. Final :white_check_mark: is added
// by the GitHub webhook when the work ships (Phase 4).
export const RX = { THINKING: "eyes", LOGGED: "memo", ERROR: "warning" };

export const INTAKE_ROOT = "/dashboardRequestsIntake";
// Slack ts ("1718…​.123456") contains a ".", illegal in an RTDB key.
export const threadPath = (rootTs) => `${INTAKE_ROOT}/threads/${String(rootTs).replace(/\./g, "_")}`;

// Slack mrkdwn uses single-asterisk *bold*; the model tends to emit **bold**.
// Convert so questions don't render literal asterisks.
export function toSlackMrkdwn(s) {
  return String(s == null ? "" : s).replace(/\*\*(.+?)\*\*/g, "*$1*");
}

// ─── Intake state create-if-absent ─────────────────────────────────
// Raw transaction (not mutateRecord) so the cold-null first run returns the new
// value to force a server re-run, while a real existing value is returned
// unchanged. Returns true iff WE created it.
export async function ensureIntakeState(path, initial) {
  const { db } = getAdmin();
  if (!db) return false;
  const tx = await db.ref(path).transaction(cur => (cur ? cur : initial));
  const snap = tx.committed && tx.snapshot ? tx.snapshot.val() : null;
  return !!snap && snap.createdAt === initial.createdAt;
}

// ─── Record an answer (typed reply OR button click) ────────────────
// Fills the last pending question's answer; an answer with no pending slot
// (concurrent replies, or unprompted info) is kept as a note rather than lost.
export async function recordReply({ path, text, files = [] }) {
  return mutateRecord(path, (cur) => {
    if (cur.ticketCreated) return cur;
    const rounds = Array.isArray(cur.rounds) ? cur.rounds.map(r => ({ ...r })) : [];
    let filled = false;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i] && rounds[i].a == null) { rounds[i].a = text || "(screenshot)"; filled = true; break; }
    }
    if (!filled && text) rounds.push({ q: null, a: text });
    const screenshots = (Array.isArray(cur.screenshots) ? cur.screenshots : []).concat(files).slice(0, 20);
    if (!filled && !text && files.length === 0) return cur;
    return { ...cur, rounds, screenshots };
  });
}

// ─── Render a question (plain text, or buttons for a choice set) ────
// `roundIndex` is baked into each button value so a click maps to the EXACT
// question it was shown under — a stale button from an earlier (already-typed)
// answer can't fill a later question.
export async function renderQuestion({ channel, rootTs, roundIndex, question, options, botToken }) {
  const q = toSlackMrkdwn(question);
  const opts = Array.isArray(options) ? options.filter(o => typeof o === "string" && o.trim()).slice(0, 5) : [];
  if (opts.length >= 2) {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: q } },
      {
        type: "actions",
        block_id: "dr_q",
        elements: opts.map((opt, i) => ({
          type: "button",
          text: { type: "plain_text", text: opt.slice(0, 75) },
          action_id: `dr_ans_${i}`,
          value: `${rootTs}::${roundIndex}::${i}`,
        })),
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "_…or just reply in the thread._" }] },
    ];
    await slackPostMessage({ channel, thread_ts: rootTs, text: q, blocks, botToken });
  } else {
    await slackPostMessage({ channel, thread_ts: rootTs, text: q, botToken });
  }
}

// ─── Triage step ───────────────────────────────────────────────────
export async function triage({ rootTs, channel, botToken }) {
  const path = threadPath(rootTs);
  const state = await adminGet(path);
  if (!state || state.ticketCreated) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("dashboard-intake: ANTHROPIC_API_KEY missing"); return; }

  const atCap = (state.questionCount || 0) >= MAX_QUESTION_ROUNDS;
  const pending = (state.rounds || []).some(r => r && r.a == null);
  if (pending && !atCap) return; // waiting on the user's answer

  const decision = await callClaudeForTriage({ state, apiKey, forceSubmit: atCap });
  if (decision.kind === "error") {
    if (atCap) {
      const fallback = { kind: "submit", title: (state.originalText || "").slice(0, 100) || "Untitled request", type: "bug" };
      await createTicketFromState({ rootTs, channel, botToken, decision: fallback, state, needsDetail: true });
    } else {
      console.error("dashboard-intake triage error:", decision.message);
    }
    return;
  }

  if (decision.kind === "ask" && !atCap) {
    const q = String(decision.question || "").trim();
    if (!q) return;
    const options = Array.isArray(decision.options)
      ? decision.options.filter(o => typeof o === "string" && o.trim()).slice(0, 5)
      : [];
    const tx = await mutateRecord(path, (cur) => {
      if (cur.ticketCreated) return cur;
      const rounds = Array.isArray(cur.rounds) ? cur.rounds.slice() : [];
      if (rounds.some(r => r && r.a == null)) return cur; // a question is already outstanding
      rounds.push(options.length >= 2 ? { q, a: null, options } : { q, a: null });
      return { ...cur, rounds, questionCount: (cur.questionCount || 0) + 1 };
    });
    const rounds = tx.snapshot?.rounds || [];
    const roundIndex = rounds.length - 1;
    const last = rounds[roundIndex];
    if (tx.committed && last && last.a == null && last.q === q && !tx.snapshot?.ticketCreated) {
      await renderQuestion({ channel, rootTs, roundIndex, question: q, options, botToken });
    }
    return;
  }

  await createTicketFromState({ rootTs, channel, botToken, decision, state, needsDetail: atCap });
}

export async function createTicketFromState({ rootTs, channel, botToken, decision, state, needsDetail }) {
  const path = threadPath(rootTs);
  const id = ticketIdForThread(rootTs);

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

  // Write the ticket FIRST (create-if-absent), then claim — crash-safe and
  // never clobbers a founder's edits / stamped issue (Codex #314 F3 / R2-N1).
  const { db } = getAdmin();
  if (db) await db.ref(`/dashboardRequests/${id}`).transaction(cur => (cur ? cur : ticket));
  else await adminSet(`/dashboardRequests/${id}`, ticket);

  // Unique-token create-once guard so concurrent racers announce exactly once.
  const confirmToken = randomShortId();
  const tx = await mutateRecord(path, (cur) => {
    if (cur.ticketCreated) return cur;
    return { ...cur, ticketCreated: true, ticketId: id, confirmToken, status: "created" };
  });
  if (!tx.committed || tx.snapshot?.confirmToken !== confirmToken) return;

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
      "Ask the teammate exactly ONE short question when you still need to understand the request before a developer could act on it. Ask only one thing per turn — you'll get more turns. Good things to learn over the conversation: WHERE in the dashboard (which tab/page), what they EXPECTED vs what they SAW, how often it happens, and whether they can attach a screenshot. When the answer is a clear set of choices, provide `options` (2–6 short labels) so the teammate can tap a button instead of typing; omit `options` for open-ended questions.",
    input_schema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", description: "ONE clear question" },
        options: {
          type: "array",
          maxItems: 6,
          items: { type: "string", description: "a short tappable answer, <= 60 chars" },
          description: "optional multiple-choice answers; omit for open-ended questions",
        },
      },
    },
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
- Ask exactly ONE question per turn via ask_clarification — never bundle multiple questions into one message. You get multiple turns; keep each question short and focused.
- If the report is already clear and actionable (you know roughly WHERE in the dashboard and WHAT is wrong/wanted), call submit_ticket immediately — do not ask busywork questions.
- When a question has a natural set of answers (which tab/page, how often, severity, expected vs actual), pass 'options' with 2-6 short labels so the teammate can tap a button. Use plain open-ended questions (no options) when the answer is free-form.
- Classify type: "bug" if something is broken/wrong; "feature" if it's a new capability or enhancement.
- Write the title as a concise imperative summary (e.g. "Fix revenue chart showing wrong YoY %", "Add CSV export to Time Log Analytics").
- Never invent details the teammate didn't say.`;
}

export async function callClaudeForTriage({ state, apiKey, forceSubmit }) {
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
  if (tool.name === "ask_clarification") {
    return { kind: "ask", question: tool.input?.question, options: tool.input?.options };
  }
  if (tool.name === "submit_ticket") {
    return { kind: "submit", title: tool.input?.title, type: tool.input?.type === "feature" ? "feature" : "bug" };
  }
  return { kind: "error", message: `unknown tool: ${tool.name}` };
}
