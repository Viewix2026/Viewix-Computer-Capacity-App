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

import { getAdmin, adminGet, adminPatch } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { buildTicket, ticketIdForThread } from "./_dashboard-requests.js";
import { slackPostMessage, slackAddReaction, slackGetPermalink, slackGetUserName } from "./_slack-helpers.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.SLACK_REQUEST_MODEL || "claude-haiku-4-5";
const BATCH = 8; // per apply call — the UI loops until a batch makes no progress
const MAX_FETCH = 2000; // hard cap on messages pulled, so a huge channel can't DoS the function
const APPLY_BUDGET_MS = 240_000; // wall-clock budget per apply call (maxDuration is 300s)
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
    if (cursor && msgs.length < MAX_FETCH) await sleep(300);
  } while (cursor && msgs.length < MAX_FETCH);
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

async function postQuestions(botToken, channel, ts, questions) {
  if (questions.length) {
    const lines = ["👋 Logging this on the Dashboard Requests board (retro cleanup). A few things that'd help us action it:",
      ...questions.map(q => `• ${q}`)];
    await slackPostMessage({ channel, thread_ts: ts, text: lines.join("\n"), botToken });
  }
  await slackAddReaction({ channel, timestamp: ts, name: "memo", botToken });
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
  // A message is still "pending" if it has no ticket yet, OR it has a backfilled
  // ticket whose questions never made it to Slack (commit-then-post-fail) — so
  // we re-drive the post instead of silently skipping it forever (Codex R-F3).
  const isPending = (m) => {
    const t = all[ticketIdForThread(m.ts)];
    return !t || (t.backfilled && t.clarificationsPosted !== true);
  };
  const pending = eligibleMsgs.filter(isPending);

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
    const startedAt = Date.now();
    let progressed = 0; // tickets created OR questions re-driven this batch
    let created = 0, failed = 0;

    for (const m of batch) {
      if (Date.now() - startedAt > APPLY_BUDGET_MS) break; // wall-clock guard (Codex R-F4)
      const id = ticketIdForThread(m.ts);
      // Wrap the WHOLE per-message unit so one Slack 429 / error can't abort the
      // batch and 500 the call (Codex R-F2).
      try {
        const existing = all[id] || (await adminGet(`/dashboardRequests/${id}`));

        // Re-drive: ticket exists but its questions never posted → just post + flag.
        if (existing && existing.backfilled && existing.clarificationsPosted !== true) {
          const qs = (existing.clarifications || []).map(c => c && c.q).filter(Boolean);
          await postQuestions(botToken, channel, m.ts, qs);
          await adminPatch(`/dashboardRequests/${id}`, { clarificationsPosted: true });
          progressed++;
          await sleep(500);
          continue;
        }
        if (existing) continue; // already fully handled

        // New ticket.
        const decision = await triageMessage(apiKey, (m.text || "").trim(), filesOf(m).length);
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
        ticket.clarificationsPosted = false; // flipped true only after the post succeeds

        // Create-if-absent; only post if WE created it (no double-post on a
        // concurrent run / re-click).
        let won = false;
        if (db) {
          const tx = await db.ref(`/dashboardRequests/${id}`).transaction(cur => (cur ? cur : ticket));
          won = !!(tx.committed && tx.snapshot?.val()?.createdAt === ticket.createdAt);
        }
        if (!won) continue;

        // Post AFTER commit; flag only on success, so a post failure here is
        // retried on the next run instead of being lost (Codex R-F3).
        await postQuestions(botToken, channel, m.ts, decision.questions);
        await adminPatch(`/dashboardRequests/${id}`, { clarificationsPosted: true });
        created++;
        progressed++;
        await sleep(500);
      } catch (e) {
        console.error("backfill: message failed, skipping:", e?.message || e);
        failed++;
      }
    }
    return res.status(200).json({
      ok: true, processed: batch.length, created, failed, progressed,
      remaining: Math.max(0, pending.length - progressed),
    });
  }

  return res.status(400).json({ error: `unknown mode: ${mode}` });
}
