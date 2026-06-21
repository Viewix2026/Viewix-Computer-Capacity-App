// api/dashboard-requests-backfill.js
// Founder-triggered, server-side backfill of the #dashboard-feature-requests
// backlog (the messages posted before the intake bot went live). Runs in prod
// where ALL env vars — including the "sensitive" ANTHROPIC_API_KEY — are
// present, so it sidesteps the local-script env hassles entirely.
//
// POST { mode: "preview" } → counts only, changes nothing.
// POST { mode: "apply" }   → processes up to BATCH not-yet-ticketed messages:
//   creates a Triage ticket (idempotent) + threads Claude-generated clarifying
//   questions onto the original message. Returns `remaining` so the caller can
//   loop until 0. Idempotent (keyed by ticketIdForThread) — safe to re-run.

import { getAdmin, adminGet } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { buildTicket, ticketIdForThread } from "./_dashboard-requests.js";
import { slackPostMessage, slackAddReaction, slackGetPermalink, slackGetUserName } from "./_slack-helpers.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.SLACK_REQUEST_MODEL || "claude-haiku-4-5";
const BATCH = 15; // per apply call — the UI loops until remaining hits 0
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchHistory(botToken, channel, cutoffTs) {
  const msgs = [];
  let cursor;
  do {
    const params = new URLSearchParams({ channel, limit: "200", latest: String(cutoffTs), inclusive: "false" });
    if (cursor) params.set("cursor", cursor);
    const r = await fetch(`https://slack.com/api/conversations.history?${params}`, { headers: { Authorization: `Bearer ${botToken}` } });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(`conversations.history: ${d.error || r.status}`);
    msgs.push(...(d.messages || []));
    cursor = d.response_metadata?.next_cursor || "";
    if (cursor) await sleep(300);
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

async function triageMessage(apiKey, text, fileCount) {
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
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 600, tools, tool_choice: { type: "tool", name: "triage" },
      messages: [{ role: "user", content: `Dashboard request${fileCount ? ` (with ${fileCount} screenshot(s))` : ""}: ${text || "(no text — see screenshot)"}` }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const data = await r.json();
  const t = (data.content || []).find(b => b.type === "tool_use");
  const inp = t?.input || {};
  return {
    title: (inp.title || text || "Untitled request").slice(0, 100),
    type: inp.type === "feature" ? "feature" : "bug",
    questions: Array.isArray(inp.questions) ? inp.questions.filter(q => typeof q === "string" && q.trim()).slice(0, 3) : [],
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try { await requireRole(req, ["founders"]); }
  catch (e) { return sendAuthError(res, e); }

  const botToken = process.env.SLACK_REQUEST_BOT_TOKEN;
  const channel = process.env.SLACK_REQUEST_CHANNEL_ID;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!botToken || !channel) return res.status(400).json({ error: "SLACK_REQUEST_BOT_TOKEN / SLACK_REQUEST_CHANNEL_ID not configured" });

  const mode = req.body?.mode || "preview";
  const before = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.before || "") ? req.body.before : "2026-06-18";
  const cutoff = Math.floor(new Date(`${before}T00:00:00Z`).getTime() / 1000);

  let history;
  try { history = await fetchHistory(botToken, channel, cutoff); }
  catch (e) { return res.status(502).json({ error: e.message }); }

  const eligibleMsgs = history.filter(eligible);
  const all = (await adminGet("/dashboardRequests")) || {};
  const pending = eligibleMsgs.filter(m => !all[ticketIdForThread(m.ts)]);

  if (mode === "preview") {
    return res.status(200).json({
      ok: true,
      totalMessages: history.length,
      eligible: eligibleMsgs.length,
      alreadyTicketed: eligibleMsgs.length - pending.length,
      toProcess: pending.length,
      sample: pending.slice(0, 5).map(m => (m.text || "(screenshot)").slice(0, 80)),
    });
  }

  if (mode === "apply") {
    if (!apiKey) return res.status(400).json({ error: "ANTHROPIC_API_KEY not configured" });
    const { db } = getAdmin();
    const batch = pending.slice(0, BATCH);
    let created = 0;
    for (const m of batch) {
      const id = ticketIdForThread(m.ts);
      let decision;
      try { decision = await triageMessage(apiKey, (m.text || "").trim(), filesOf(m).length); }
      catch (e) { console.error("backfill triage failed:", e?.message || e); continue; }

      const [name, link] = await Promise.all([
        slackGetUserName({ user: m.user, botToken }),
        slackGetPermalink({ channel, message_ts: m.ts, botToken }),
      ]);
      const ticket = buildTicket({
        id, title: decision.title, body: m.text || "", type: decision.type, priority: null, source: "slack",
        requestedBy: { slackUserId: m.user, name: name || "Teammate" },
        slack: { channelId: channel, messageTs: m.ts, threadTs: m.ts, permalink: link || null },
        screenshots: filesOf(m), clarifications: decision.questions.map(q => ({ q, a: null })),
      });
      ticket.backfilled = true;

      // Create-if-absent; only post to Slack if WE created it (no double-posting
      // on a concurrent run / re-click).
      let won = false;
      if (db) {
        const tx = await db.ref(`/dashboardRequests/${id}`).transaction(cur => (cur ? cur : ticket));
        won = !!(tx.committed && tx.snapshot?.val()?.createdAt === ticket.createdAt);
      }
      if (!won) continue;

      if (decision.questions.length) {
        const lines = ["👋 Logging this on the Dashboard Requests board (retro cleanup). A few things that'd help us action it:",
          ...decision.questions.map(q => `• ${q}`)];
        await slackPostMessage({ channel, thread_ts: m.ts, text: lines.join("\n"), botToken });
      }
      await slackAddReaction({ channel, timestamp: m.ts, name: "memo", botToken });
      created++;
      await sleep(700);
    }
    return res.status(200).json({ ok: true, processed: batch.length, created, remaining: Math.max(0, pending.length - batch.length) });
  }

  return res.status(400).json({ error: `unknown mode: ${mode}` });
}
