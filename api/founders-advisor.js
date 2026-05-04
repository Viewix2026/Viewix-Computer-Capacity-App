// api/founders-advisor.js
//
// The "Advisor" backend for the Founders tab. Two POST actions:
//
//   action: "runAnalysis"
//     Reads /foundersData (north-stars + goals), /foundersMetrics
//     (12-month history), /attioCache (Attio deal data) and feeds a
//     compact summary to Claude Opus 4.7. Saves the resulting
//     briefing to /foundersBriefings/{id} and returns it.
//
//   action: "postToSlack"
//     Posts an existing briefing's executive-summary section to a
//     Slack webhook (SLACK_FOUNDERS_BRIEFING_WEBHOOK_URL). Updates
//     the briefing record with sentToSlack: true + slackPostedAt.
//
// GET with Vercel's `x-vercel-cron: 1` header runs the weekly cadence:
// runs analysis + auto-posts to Slack. Manual runs use authenticated POST.

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import crypto from "crypto";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// Claude Opus 4.7 — producer asked for the latest Opus. If Anthropic
// changes the slug, swap here only.
const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 8000;

// ─── Firebase helpers (admin SDK with REST fallback) ──────────────
async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ─── Claude call ───────────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, apiKey) {
  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || "";
}

// ─── Context summariser ───────────────────────────────────────────
// Takes raw Firebase nodes and produces the compact prompt the
// advisor sees. Keeps the prompt focused on dashboard-level insights
// rather than the full Data tab table (per producer's request).
function fmtMoney(v) {
  const n = Math.round(Number(v) || 0);
  return `$${n.toLocaleString("en-AU")}`;
}
function deltaPct(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}
function pctStr(d) {
  if (d == null || !isFinite(d)) return "—";
  const sign = d >= 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}%`;
}

function summariseAttioMonthly(attioCache) {
  if (!attioCache?.data || !Array.isArray(attioCache.data)) return null;
  const extractVal = d => {
    const v = d.values;
    const candidates = [v?.deal_value, v?.amount, v?.value, v?.revenue, v?.contract_value];
    for (const c of candidates) {
      if (c?.[0] != null) {
        const n = c[0].currency_value ?? c[0].value;
        if (n != null) return typeof n === "number" ? n : parseFloat(n) || 0;
      }
    }
    return 0;
  };
  const extractDate = d => {
    const v = d.values;
    const candidates = [v?.close_date, v?.closed_at, v?.won_date, v?.created_at];
    for (const c of candidates) if (c?.[0]?.value) return c[0].value;
    return d.created_at || null;
  };
  const extractStage = d => {
    const v = d.values;
    const candidates = [v?.stage, v?.status, v?.deal_stage, v?.pipeline_stage];
    for (const c of candidates) {
      const t = c?.[0]?.status?.title || c?.[0]?.value;
      if (t) return (typeof t === "string" ? t : "").toLowerCase();
    }
    return "";
  };
  const wonKw = ["won", "closed won", "closed-won", "completed", "signed", "active"];
  const monthly = {};
  for (const d of attioCache.data) {
    const val = extractVal(d);
    const dateStr = extractDate(d);
    const stage = extractStage(d);
    if (val > 0 && dateStr && wonKw.some(k => stage.includes(k))) {
      const dt = new Date(dateStr);
      if (isNaN(dt)) continue;
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthly[key]) monthly[key] = { revenue: 0, count: 0 };
      monthly[key].revenue += val;
      monthly[key].count += 1;
    }
  }
  return monthly;
}

function buildContext({ foundersData = {}, foundersMetrics = {}, attioCache = null }) {
  const lines = [];
  const now = new Date();
  const ymKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // ── Headline numbers ──
  lines.push("## Headline numbers (now)");
  lines.push(`- Current Revenue (YTD): ${fmtMoney(foundersData.currentRevenue)}`);
  lines.push(`- Revenue Target (${now.getFullYear()}): ${fmtMoney(foundersData.revenueTarget)}`);
  if (foundersData.revenueTarget) {
    const pct = (foundersData.currentRevenue || 0) / foundersData.revenueTarget;
    const yearPct = (now.getMonth() + (now.getDate() / 31)) / 12;
    lines.push(`- Progress vs target: ${(pct * 100).toFixed(1)}% — Year through: ${(yearPct * 100).toFixed(1)}%`);
    lines.push(`- Pace: ${pct >= yearPct ? "ON OR AHEAD of pace" : "BEHIND pace"} (delta ${fmtMoney((pct - yearPct) * foundersData.revenueTarget)})`);
  }
  lines.push("");

  // ── North stars ──
  lines.push("## North-star metrics");
  const ns = [
    ["Monthly Revenue", foundersData.monthlyRevenue, "$"],
    ["Active Clients", foundersData.activeClients, ""],
    ["Avg Retainer Value", foundersData.avgRetainerValue, "$"],
    ["Client Churn Rate", foundersData.clientChurnRate, "%"],
    ["Lead Pipeline Value", foundersData.leadPipelineValue, "$"],
    ["Close Rate (3mo)", foundersData.closingRate, "%"],
  ];
  for (const [label, v, unit] of ns) {
    if (v == null) continue;
    const fmt = unit === "$" ? fmtMoney(v) : unit === "%" ? `${v}%` : v;
    lines.push(`- ${label}: ${fmt}`);
  }
  lines.push("");

  // ── Recent monthly metrics history (last 12 months, key fields) ──
  const sortedKeys = Object.keys(foundersMetrics).sort().reverse();
  const last12 = sortedKeys.slice(0, 12);
  if (last12.length > 0) {
    lines.push("## Recent monthly metrics (last 12 months, latest first)");
    const trackedFields = [
      "monthlyRevenue", "newClientsAcquired", "totalLeads", "cpl",
      "callsBooked", "showRate", "closeRateCallToDeal", "leadToDealRate",
      "ltv", "cac", "ltvCacRatio",
      "activeRetainers", "retainerChurnRate", "newClientRevenue", "repeatClientRevenue",
      "top5Concentration", "largestSingleClientPct",
    ];
    for (const k of last12) {
      const m = foundersMetrics[k] || {};
      const row = trackedFields
        .filter(f => m[f] != null && m[f] !== "")
        .map(f => `${f}=${m[f]}`)
        .join(" · ");
      if (row) lines.push(`- ${k}: ${row}`);
    }
    lines.push("");

    // Highlight notable mom changes for the latest month
    const latest = foundersMetrics[last12[0]];
    const prev = foundersMetrics[last12[1]];
    if (latest && prev) {
      lines.push("## Latest month-on-month deltas");
      for (const f of trackedFields) {
        const c = parseFloat(latest[f]);
        const p = parseFloat(prev[f]);
        if (isNaN(c) || isNaN(p)) continue;
        const d = deltaPct(c, p);
        if (d == null || !isFinite(d) || Math.abs(d) < 5) continue;
        lines.push(`- ${f}: ${pctStr(d)} (${p} → ${c})`);
      }
      lines.push("");
    }
  }

  // ── Attio monthly revenue trend ──
  const attioMonthly = summariseAttioMonthly(attioCache);
  if (attioMonthly) {
    const sortedAttio = Object.entries(attioMonthly).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
    if (sortedAttio.length > 0) {
      lines.push("## Attio monthly revenue (last 12 months)");
      for (const [k, m] of sortedAttio) {
        lines.push(`- ${k}: ${fmtMoney(m.revenue)} (${m.count} deal${m.count === 1 ? "" : "s"})`);
      }
      lines.push("");
    }
  }

  // ── Goals ──
  const goals = Object.values(foundersData.goals || {}).filter(Boolean);
  if (goals.length > 0) {
    lines.push("## Active goals");
    for (const g of goals) {
      const pct = g.target ? ((Number(g.current) || 0) / Number(g.target)) * 100 : null;
      const pctStr2 = pct == null ? "" : ` — ${pct.toFixed(0)}%`;
      const dl = g.deadline ? ` · due ${g.deadline}` : "";
      lines.push(`- ${g.title || "(untitled)"} · target ${g.target} ${g.unit || ""}, current ${g.current || 0}${pctStr2}${dl}`);
      if (g.notes) lines.push(`  notes: ${g.notes.replace(/\n+/g, " ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── System prompt ─────────────────────────────────────────────────
const ADVISOR_SYSTEM_PROMPT = `You are a senior strategy consultant briefing the founders of Viewix — a Sydney-based content production agency that builds video for brands. Your job is to read the company's dashboard data and goals, then produce a tight strategic briefing.

OUTPUT FORMAT (markdown, no preamble, no fences):

# Weekly Briefing — <month + year>

## 1. Executive summary
2-4 punchy lines summarising the state of the business this week. The kind of thing that can be pasted into Slack and instantly orient the founders.

## 2. What's working
2-4 bullet points on metrics or trends that are positive. Be specific — quote the number, not vibes.

## 3. What's a concern
2-4 bullet points on metrics moving the wrong way, concentration risks, missed goals, leading indicators of trouble. Each point should be backed by a specific number from the data.

## 4. Top 3 recommendations
Numbered list. Each recommendation:
- States the action concretely (verb + object + numeric target where applicable)
- Says WHY it matters (which metric or risk it addresses)
- Suggests how to validate it worked in the next briefing

## 5. Goals progress
For each active goal, one line: how far along, on track / at risk / off track, with reasoning. If no goals are set, say so and suggest 2-3 to add.

WRITING RULES:
- Plain confident prose. No hedging, no "consider doing X". Recommend and back it up.
- Quote numbers. "Churn rose from 4.2% to 6.8%" beats "churn is up".
- Write like a McKinsey associate who has 10 minutes to brief the CEO. Compress, don't pad.
- Never use em dashes. Use commas or full stops.
- Don't restate the prompt. Don't say "based on the data". Just analyse.
- If a metric is missing or unclear, say so and recommend what to start tracking.`;

// ─── Run the analysis ─────────────────────────────────────────────
async function runAnalysis() {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

  const [foundersData, foundersMetrics, attioCache] = await Promise.all([
    fbGet("/foundersData"),
    fbGet("/foundersMetrics"),
    fbGet("/attioCache"),
  ]);

  const userContext = buildContext({
    foundersData: foundersData || {},
    foundersMetrics: foundersMetrics || {},
    attioCache: attioCache || null,
  });

  const userMessage = `Here is this week's snapshot of the Viewix business. Produce the briefing.\n\n${userContext}`;

  const startedAt = Date.now();
  const content = await callClaude(ADVISOR_SYSTEM_PROMPT, userMessage, ANTHROPIC_KEY);
  const durationMs = Date.now() - startedAt;

  const id = `brief-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  const briefing = {
    id,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    content,
    durationMs,
    sentToSlack: false,
  };
  await fbSet(`/foundersBriefings/${id}`, briefing);
  return briefing;
}

// ─── Slack post helper ─────────────────────────────────────────────
async function postBriefingToSlack(briefingId) {
  const url = process.env.SLACK_FOUNDERS_BRIEFING_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_FOUNDERS_BRIEFING_WEBHOOK_URL not configured");

  const briefing = await fbGet(`/foundersBriefings/${briefingId}`);
  if (!briefing) throw new Error("Briefing not found");

  // Pull the executive-summary section as the Slack body. Falls back
  // to the whole content if we can't find the section header — avoids
  // posting an empty message.
  const content = briefing.content || "";
  const execMatch = content.match(/##\s*1\.\s*Executive summary[\s\S]*?(?=^##\s|\Z)/m);
  const exec = execMatch ? execMatch[0].replace(/^##\s*1\.\s*Executive summary\s*/m, "").trim() : content.slice(0, 1200);

  const titleMatch = content.match(/^#\s+([^\n]+)/m);
  const title = titleMatch ? titleMatch[1].trim() : "Viewix briefing";

  const text = `*${title}*\n\n${exec}\n\n_Full briefing in the dashboard → Founders → Advisor._`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook error ${resp.status}: ${await resp.text()}`);
  }
  await fbPatch(`/foundersBriefings/${briefingId}`, {
    sentToSlack: true,
    slackPostedAt: new Date().toISOString(),
  });
  return { ok: true };
}

// ─── Cron: weekly run + Slack post ────────────────────────────────
// Triggered by Vercel's scheduler (vercel.json#crons). Runs the
// analysis, then auto-posts the executive summary to Slack. Failures
// in the Slack step don't roll back the briefing — it stays visible
// in the Advisor history with sentToSlack: false.
async function weeklyCron() {
  const briefing = await runAnalysis();
  let slackResult = null;
  try {
    if (process.env.SLACK_FOUNDERS_BRIEFING_WEBHOOK_URL) {
      slackResult = await postBriefingToSlack(briefing.id);
    } else {
      slackResult = { skipped: true, reason: "no webhook configured" };
    }
  } catch (e) {
    slackResult = { error: e.message };
  }
  return { briefing: { id: briefing.id, generatedAt: briefing.generatedAt }, slack: slackResult };
}

// ─── Dispatcher ────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, GET, OPTIONS")) return;
  setCors(req, res, "POST, GET, OPTIONS");

  // GET = cron path. Vercel sets `x-vercel-cron: 1` on its scheduled
  // invocations. Manual triggering must go through the authenticated
  // POST path below.
  if (req.method === "GET") {
    const isCron = req.headers["x-vercel-cron"] === "1";
    if (!isCron) return res.status(401).json({ error: "Cron header required" });
    try {
      const result = await weeklyCron();
      return res.status(200).json({ success: true, ...result });
    } catch (e) {
      console.error("founders-advisor cron error:", e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await requireRole(req, ["founders"]);
  } catch (e) {
    return sendAuthError(res, e);
  }
  const action = req.body?.action;
  if (!action) return res.status(400).json({ error: "Missing action" });

  try {
    if (action === "runAnalysis") {
      const briefing = await runAnalysis();
      return res.status(200).json({ success: true, briefing });
    }
    if (action === "postToSlack") {
      const briefingId = req.body?.briefingId;
      if (!briefingId) return res.status(400).json({ error: "Missing briefingId" });
      const r = await postBriefingToSlack(briefingId);
      return res.status(200).json({ success: true, ...r });
    }
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    console.error(`founders-advisor ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
