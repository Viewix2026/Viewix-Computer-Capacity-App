// One-time backfill of the #dashboard-feature-requests backlog.
//
// The intake bot only sees NEW messages (Slack's Events API doesn't replay
// history), so every request posted before it went live is unprocessed. This
// reads the channel's past messages up to a cutoff date, and for each one:
//   • creates a Triage ticket on the Dashboard Requests board (idempotent), and
//   • threads Claude-generated clarifying questions onto the original message,
//     and attaches those questions to the ticket as open clarifications.
//
// SAFE BY DEFAULT: dry-run unless you pass --apply. Idempotent: keyed by each
// message's ts (ticketIdForThread), so re-running never double-posts or
// double-creates. Rate-limited to stay under Slack limits.
//
// Run (from repo root, on a machine with .env.local):
//   node --env-file=.env.local scripts/backfill-dashboard-requests.mjs            # dry run (preview)
//   node --env-file=.env.local scripts/backfill-dashboard-requests.mjs --apply    # actually post + create
//   ... --before=2026-06-18   # only messages strictly before this UTC date (default: 2026-06-18, i.e. through Jun 17)
//
// Needs in .env.local: FIREBASE_SERVICE_ACCOUNT, SLACK_REQUEST_BOT_TOKEN,
// SLACK_REQUEST_CHANNEL_ID, ANTHROPIC_API_KEY (+ optional SLACK_REQUEST_MODEL).

import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { buildTicket, ticketIdForThread } from "../api/_dashboard-requests.js";

const DB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const SLACK_API = "https://slack.com/api";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const APPLY = process.argv.includes("--apply");
const beforeArg = (process.argv.find(a => a.startsWith("--before=")) || "").split("=")[1] || "2026-06-18";
const CUTOFF_TS = Math.floor(new Date(`${beforeArg}T00:00:00Z`).getTime() / 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Read .env.local ourselves rather than trusting `node --env-file`: the huge
// quoted FIREBASE_SERVICE_ACCOUNT value breaks Node's simple --env-file parser
// for the lines after it, so SLACK_REQUEST_*/ANTHROPIC_API_KEY silently never
// reach process.env. Reading the file directly is robust regardless.
const ENV_TEXT = (() => {
  try { return readFileSync(new URL("../.env.local", import.meta.url), "utf8"); }
  catch { return ""; }
})();
function envVar(key) {
  const m = ENV_TEXT.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return process.env[key] || "";
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

const MODEL = envVar("SLACK_REQUEST_MODEL") || "claude-haiku-4-5";
const ANTHROPIC_KEY = envVar("ANTHROPIC_API_KEY");

// ─── Firebase admin (self-init; .env.local stores FIREBASE_SERVICE_ACCOUNT with
// unescaped inner quotes that node --env-file truncates, so parse it directly) ──
function loadServiceAccount() {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = env.split("\n").find(l => l.startsWith("FIREBASE_SERVICE_ACCOUNT="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT not in .env.local");
  const raw = line.slice("FIREBASE_SERVICE_ACCOUNT=".length);
  const field = (k) => (raw.match(new RegExp(`"${k}":\\s*"([^"]*)"`)) || [])[1];
  const project_id = field("project_id");
  const client_email = field("client_email");
  const private_key = (field("private_key") || "").replace(/\\n/g, "\n");
  if (!project_id || !client_email || !private_key) throw new Error("Could not extract service account fields");
  return { project_id, client_email, private_key };
}
admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()), databaseURL: DB_URL });
const db = admin.database();

// ─── Slack ─────────────────────────────────────────────────────────
const BOT = envVar("SLACK_REQUEST_BOT_TOKEN");
const CHANNEL = envVar("SLACK_REQUEST_CHANNEL_ID");
async function slack(method, body, { get = false } = {}) {
  const opts = { method: get ? "GET" : "POST", headers: { Authorization: `Bearer ${BOT}` } };
  let url = `${SLACK_API}/${method}`;
  if (get) { url += "?" + new URLSearchParams(body).toString(); }
  else { opts.headers["Content-Type"] = "application/json; charset=utf-8"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || r.status}`);
  return data;
}

async function fetchHistory() {
  const msgs = [];
  let cursor;
  do {
    const page = await slack("conversations.history", {
      channel: CHANNEL, limit: "200", latest: String(CUTOFF_TS), inclusive: "false",
      ...(cursor ? { cursor } : {}),
    }, { get: true });
    msgs.push(...(page.messages || []));
    cursor = page.response_metadata?.next_cursor || "";
    if (cursor) await sleep(400);
  } while (cursor);
  return msgs;
}

function eligible(m) {
  if (!m || m.type !== "message") return false;
  if (m.bot_id) return false;
  if (m.subtype && m.subtype !== "file_share") return false;
  if (m.thread_ts && m.thread_ts !== m.ts) return false; // reply, not a root request
  if (!m.user) return false;
  const hasText = (m.text || "").trim().length > 0;
  const hasFiles = Array.isArray(m.files) && m.files.some(f => f && f.permalink);
  return hasText || hasFiles;
}

function filesOf(m) {
  return (Array.isArray(m.files) ? m.files : [])
    .filter(f => f && f.permalink).slice(0, 10)
    .map(f => ({ permalink: f.permalink, name: f.name || f.title || "file" }));
}

// ─── Claude: title + type + clarifying questions for one message ────
async function triageMessage(text, fileCount) {
  const tools = [{
    name: "triage",
    description: "Triage a dashboard bug/feature request into a ticket.",
    input_schema: {
      type: "object", required: ["title", "type", "questions"],
      properties: {
        title: { type: "string", description: "concise imperative summary, <=100 chars" },
        type: { type: "string", enum: ["bug", "feature"] },
        questions: { type: "array", maxItems: 3, items: { type: "string" }, description: "1-3 clarifying questions a developer would want answered" },
      },
    },
  }];
  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 600,
      tools, tool_choice: { type: "tool", name: "triage" },
      messages: [{ role: "user", content: `Dashboard request${fileCount ? ` (with ${fileCount} screenshot(s))` : ""}: ${text || "(no text — see screenshot)"}` }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const t = (data.content || []).find(b => b.type === "tool_use");
  const inp = t?.input || {};
  return {
    title: (inp.title || text || "Untitled request").slice(0, 100),
    type: inp.type === "feature" ? "feature" : "bug",
    questions: Array.isArray(inp.questions) ? inp.questions.filter(q => typeof q === "string" && q.trim()).slice(0, 3) : [],
  };
}

async function userName(uid) {
  try { const d = await slack("users.info", { user: uid }, { get: true }); const p = d.user?.profile || {}; return p.display_name || p.real_name || d.user?.name || null; }
  catch { return null; }
}
async function permalink(ts) {
  try { const d = await slack("chat.getPermalink", { channel: CHANNEL, message_ts: ts }, { get: true }); return d.permalink || null; }
  catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  if (!BOT || !CHANNEL || !ANTHROPIC_KEY) {
    throw new Error("Missing SLACK_REQUEST_BOT_TOKEN / SLACK_REQUEST_CHANNEL_ID / ANTHROPIC_API_KEY");
  }
  console.log(`\nBackfill — ${APPLY ? "APPLY (will post + create)" : "DRY RUN (no changes)"} · cutoff: before ${beforeArg} UTC\n`);
  const all = await fetchHistory();
  const reqs = all.filter(eligible);
  console.log(`Fetched ${all.length} messages; ${reqs.length} look like requests.\n`);

  let created = 0, skipped = 0;
  for (const m of reqs) {
    const id = ticketIdForThread(m.ts);
    const existing = await db.ref(`/dashboardRequests/${id}`).once("value");
    if (existing.exists()) { skipped++; console.log(`• skip (already a ticket): "${(m.text || "").slice(0, 60)}"`); continue; }

    const files = filesOf(m);
    let decision;
    try { decision = await triageMessage((m.text || "").trim(), files.length); }
    catch (e) { console.log(`! triage failed, skipping: ${e.message}`); continue; }

    const preview = `  → [${decision.type}] ${decision.title}\n     Qs: ${decision.questions.join(" | ") || "(none)"}`;
    if (!APPLY) { console.log(`• would create from "${(m.text || "").slice(0, 60)}"\n${preview}`); created++; continue; }

    const [name, link] = await Promise.all([userName(m.user), permalink(m.ts)]);
    const ticket = buildTicket({
      id, title: decision.title, body: m.text || "", type: decision.type, priority: null, source: "slack",
      requestedBy: { slackUserId: m.user, name: name || "Teammate" },
      slack: { channelId: CHANNEL, messageTs: m.ts, threadTs: m.ts, permalink: link || null },
      screenshots: files,
      clarifications: decision.questions.map(q => ({ q, a: null })),
    });
    ticket.backfilled = true;
    await db.ref(`/dashboardRequests/${id}`).transaction(cur => (cur ? cur : ticket));

    if (decision.questions.length) {
      const lines = ["👋 Logging this on the Dashboard Requests board (retro cleanup). A few things that'd help us action it:",
        ...decision.questions.map(q => `• ${q}`)];
      await slack("chat.postMessage", { channel: CHANNEL, thread_ts: m.ts, text: lines.join("\n") });
    }
    await slack("reactions.add", { channel: CHANNEL, timestamp: m.ts, name: "memo" }).catch(() => {});
    created++;
    console.log(`✓ created "${decision.title}"`);
    await sleep(1200); // gentle on Slack rate limits
  }

  console.log(`\nDone. ${APPLY ? "Created" : "Would create"}: ${created} · Skipped (existing): ${skipped}\n`);
  if (!APPLY) console.log("Re-run with --apply to actually post questions + create tickets.\n");
  process.exit(0);
}

main().catch(e => { console.error("backfill failed:", e); process.exit(1); });
