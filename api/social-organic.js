// api/social-organic.js
// Vercel Serverless Function: Social Media Organic Competitor Intelligence
// Action-dispatch endpoint (mirrors api/preproduction.js pattern).
//
// Actions:
//   estimate              — Returns { estPosts, estCost } for a given input shape. No Apify call.
//   extractFromTranscript — Claude Sonnet pulls competitor handles + keywords from a transcript.
//   scrape                — Calls Apify apidojo/instagram-scraper, normalises, caches, writes posts[].
//   classify              — Batches posts to Claude Sonnet vision; writes format + hookType per post.
//   synthesise            — Opus pass: reads classified posts; writes synthesis.markdown + concepts.
//   runPipeline           — Sequentially runs scrape → classify → synthesise.
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   APIFY_API_TOKEN
//   APIFY_DAILY_BUDGET_USD (optional, defaults to 5)
//   FIREBASE_SERVICE_ACCOUNT (for admin SDK; falls back to REST if unset)

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// Hard caps (per plan §Cost control)
const MAX_HANDLES_PER_SCRAPE = 5;
const MAX_POSTS_PER_HANDLE = 50;
const MAX_PROJECTS_PER_DAY = 10;
const DEFAULT_DAILY_BUDGET_USD = 5;

// apidojo/instagram-scraper pricing: ~$2.60 per 1k results ($0.0026/post)
const APIFY_COST_PER_POST = 0.0026;

// ─── Firebase helpers (copy from api/preproduction.js; self-contained pattern) ───
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

// ─── Claude helper (copy from api/preproduction.js) ───
async function callClaude({ model = "claude-sonnet-4-6", systemPrompt, userMessage, maxTokens = 8000, apiKey }) {
  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
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

function parseJSON(raw) {
  let cleaned = (raw || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleaned);
}

// ─── Shared validation / estimation ───
function estimateCost({ handles = [], postsPerHandle = 30 }) {
  const handleCount = Math.min(handles.length, MAX_HANDLES_PER_SCRAPE);
  const perHandle = Math.min(postsPerHandle, MAX_POSTS_PER_HANDLE);
  const estPosts = handleCount * perHandle;
  const estCost = +(estPosts * APIFY_COST_PER_POST).toFixed(3);
  // Classification cost estimate (batched Claude vision, ~$0.008/post)
  const classifyCost = +(estPosts * 0.008).toFixed(3);
  // Synthesis is a single Opus call, roughly fixed
  const synthesisCost = 0.15;
  return {
    estPosts,
    estApifyCost: estCost,
    estClassifyCost: classifyCost,
    estSynthesisCost: synthesisCost,
    estTotalCost: +(estCost + classifyCost + synthesisCost).toFixed(3),
    estRuntimeSec: Math.max(20, handleCount * 10 + Math.ceil(estPosts / 10) * 3 + 30),
  };
}

// Check daily budget — returns { withinBudget, spentToday, budget }
async function checkDailyBudget() {
  const budget = parseFloat(process.env.APIFY_DAILY_BUDGET_USD) || DEFAULT_DAILY_BUDGET_USD;
  const today = new Date().toISOString().slice(0, 10);
  const log = await fbGet(`/preproduction/socialOrganic/_costLog/${today}`);
  const spentToday = Object.values(log || {}).reduce((sum, entry) => sum + (entry?.cost || 0), 0);
  return { withinBudget: spentToday < budget, spentToday: +spentToday.toFixed(3), budget };
}

// ─── Action: estimate ───
async function handleEstimate(req, res) {
  const { handles = [], postsPerHandle = 30 } = req.body || {};
  const est = estimateCost({ handles, postsPerHandle });
  const budget = await checkDailyBudget();
  return res.status(200).json({ ...est, budget });
}

// ─── Dispatcher ───
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const action = req.body?.action;
  if (!action) return res.status(400).json({ error: "Missing action" });

  try {
    switch (action) {
      case "estimate":
        return await handleEstimate(req, res);
      // Other actions are stubbed until their respective slices land
      case "extractFromTranscript":
      case "scrape":
      case "classify":
      case "synthesise":
      case "runPipeline":
        return res.status(501).json({ error: `Action "${action}" not implemented yet` });
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`social-organic ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
