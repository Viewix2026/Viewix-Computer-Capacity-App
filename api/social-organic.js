// api/social-organic.js
// Vercel Serverless Function: Social Media Organic Competitor Intelligence
// Action-dispatch endpoint (mirrors api/preproduction.js pattern).
//
// Actions:
//   estimate              — Returns { estPosts, estCost } for a given input shape. No Apify call.
//   extractFromTranscript — Claude Sonnet pulls competitor handles + keywords from a transcript.
//   scrape                — Calls Apify apidojo/instagram-scraper, normalises, caches, writes posts[].
//   classify              — Batches posts to Claude Sonnet vision; writes format + hookType per post.
//   runPipeline           — Sequentially runs scrape → classify. Synthesis was removed:
//                           the producer-driven review → shortlist → select → script workflow
//                           replaces it, because AI-synthesised briefs tended to hallucinate
//                           formats and producers rewrote the output anyway.
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   APIFY_API_TOKEN
//   APIFY_DAILY_BUDGET_USD (optional, defaults to 5)
//   FIREBASE_SERVICE_ACCOUNT (for admin SDK; falls back to REST if unset)

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import crypto from "crypto";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
// Official Apify Instagram scraper — the input schema matches what we send
// (directUrls + resultsLimit). The apidojo version is cheaper but uses a
// different schema (usernames + limit); if cost becomes an issue we can
// swap back with a matching input translator.
const APIFY_ACTOR = "apify~instagram-scraper";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days

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

// ─── Apify helpers ───
// Cache key per handle + date-range + postsPerHandle so repeat scrapes in the
// same niche reuse data for free.
function cacheKey({ handle, from, to, postsPerHandle }) {
  return crypto
    .createHash("sha1")
    .update(`${handle.toLowerCase()}|${from || ""}|${to || ""}|${postsPerHandle}`)
    .digest("hex")
    .slice(0, 24);
}

// Normalise raw Apify post objects into our stable schema (plan §2a).
function normaliseInstagramPost(raw, handleHint) {
  const caption = raw.caption || raw.text || "";
  const timestamp = raw.timestamp || raw.takenAtTimestamp || raw.takenAt || null;
  const views = raw.videoViewCount ?? raw.videoPlayCount ?? raw.viewsCount ?? raw.plays ?? null;
  const likes = raw.likesCount ?? raw.likes ?? 0;
  const comments = raw.commentsCount ?? raw.comments ?? 0;
  const isVideo = raw.isVideo ?? (raw.type === "Video") ?? false;
  const hashtags = Array.isArray(raw.hashtags) ? raw.hashtags : (caption.match(/#[\w]+/g) || []);
  const owner = raw.ownerUsername || raw.username || handleHint.replace(/^@/, "");
  // engagement rate: prefer views as denominator for videos, fall back to likes*10 for photos
  const denom = views && views > 0 ? views : Math.max(likes * 10, 1);
  const engagementRate = +((likes + comments) / denom).toFixed(4);

  return {
    id: raw.id || raw.shortCode || raw.shortcode || raw.url || `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    shortCode: raw.shortCode || raw.shortcode || null,
    handle: `@${owner.toLowerCase()}`,
    url: raw.url || (raw.shortCode ? `https://www.instagram.com/p/${raw.shortCode}/` : null),
    thumbnail: raw.displayUrl || raw.thumbnailUrl || raw.imageUrl || null,
    caption: caption.slice(0, 2000),
    hashtags,
    timestamp: timestamp ? new Date(typeof timestamp === "number" ? timestamp * 1000 : timestamp).toISOString() : null,
    isVideo,
    views: views ?? null,
    likes,
    comments,
    engagementRate,
    // Filled later in classify slice
    format: null, formatConfidence: null, formatEvidence: null, hookType: null,
    // overperformanceScore is filled once we compute handle baselines below
    overperformanceScore: null,
    durationSec: raw.videoDuration ?? null,
  };
}

// Handles like @mannix.squiers contain periods, which Firebase rejects as
// a key character (along with # $ / [ ]). Sanitise for storage only — the
// original handle is preserved inside the value so display sites don't
// need to reverse-decode.
export function fbSafeHandleKey(handle) {
  return String(handle || "").replace(/[.#$/\[\]]/g, "_");
}

// Compute { avgViews, avgLikes, medianViews, postCount } per handle from the scraped posts,
// then fill each post's overperformanceScore = views / handleMedianViews.
function computeHandleStatsAndScore(posts) {
  const byHandle = {};
  posts.forEach(p => {
    if (!byHandle[p.handle]) byHandle[p.handle] = [];
    byHandle[p.handle].push(p);
  });

  const stats = {};
  Object.entries(byHandle).forEach(([handle, group]) => {
    const views = group.map(g => g.views || 0).filter(v => v > 0).sort((a, b) => a - b);
    const likes = group.map(g => g.likes || 0);
    const avgViews = views.length ? views.reduce((s, v) => s + v, 0) / views.length : 0;
    const avgLikes = likes.reduce((s, v) => s + v, 0) / (likes.length || 1);
    const medianViews = views.length ? views[Math.floor(views.length / 2)] : 0;
    stats[fbSafeHandleKey(handle)] = {
      handle,  // original, unsanitised — use this for display
      avgViews: Math.round(avgViews),
      avgLikes: Math.round(avgLikes),
      medianViews: Math.round(medianViews),
      postCount: group.length,
    };
    const baseline = medianViews || avgViews || 1;
    group.forEach(p => {
      p.overperformanceScore = p.views ? +((p.views / baseline)).toFixed(2) : null;
    });
  });
  return stats;
}

// Call Apify synchronously (up to 5 min) and return the dataset items directly.
// Docs: POST /v2/acts/:actorId/run-sync-get-dataset-items?token=...
async function apifyScrape({ handles, postsPerHandle, from, to, token }) {
  const directUrls = handles.map(h => `https://www.instagram.com/${h.replace(/^@/, "")}/`);
  const input = {
    directUrls,
    resultsType: "posts",
    resultsLimit: postsPerHandle,
    searchType: "user",
    addParentData: false,
    // onlyPostsNewerThan accepted by several actors; safely ignored if not.
    onlyPostsNewerThan: from || null,
  };
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Apify ${resp.status}: ${body.slice(0, 500)}`);
  }
  const items = await resp.json();
  return Array.isArray(items) ? items : [];
}

// ─── Classification helpers (Slice 4) ───
const FORMAT_BUCKETS = [
  "talking_head", "skit", "tutorial", "vo_broll", "transformation",
  "ugc_testimonial", "listicle", "trend", "product_demo", "other",
];
const HOOK_TYPES = ["question", "claim", "contrarian", "curiosity", "null"];

function buildClassifierSystemPrompt() {
  return `You classify Instagram videos into format buckets for a video-production agency's competitor research tool. You receive 1-10 posts (caption + thumbnail + view count + engagement + handle) and return a JSON array, one object per post in the same order.

FORMAT BUCKETS (pick exactly one):
- talking_head      : Single person speaking direct-to-camera, no cuts to other scenes
- skit              : Multiple characters, scripted/comedic scenario
- tutorial          : Step-by-step how-to, numbered or sequential teaching
- vo_broll          : Voiceover over b-roll or product footage, no on-camera presenter
- transformation    : Before/after, reveal, process collapse
- ugc_testimonial   : Customer or creator speaking on behalf of brand
- listicle          : "X things / X reasons / X ways" format
- trend             : Uses a current audio/trend/meme format
- product_demo      : Showing product functionality, close-ups, usage
- other             : Doesn't fit above

HOOK TYPES (for talking_head / skit / tutorial only; null otherwise):
- question     : Opens with a question to the viewer
- claim        : Opens with a strong claim or statistic
- contrarian   : Opens by contradicting a common belief
- curiosity    : Opens with a teaser or pattern-break

For each post return:
{ "postId": "...", "format": "<one of the buckets>", "confidence": <0-1 number>, "evidence": "<short reason, 5-15 words>", "hookType": "<one of the hook types or null>" }

Respond with a single JSON array. No prose outside the JSON. No markdown code fences.`;
}

function buildClassifierUserMessage(posts) {
  const content = [
    {
      type: "text",
      text: "Classify these Instagram posts. Return the JSON array in the same order as the posts below.",
    },
  ];
  posts.forEach((p, i) => {
    content.push({
      type: "text",
      text: `\n--- Post ${i + 1} (postId: ${p.id}) ---\nHandle: ${p.handle}\nViews: ${p.views ?? "n/a"}\nLikes: ${p.likes} · Comments: ${p.comments}\nEngagement rate: ${p.engagementRate}\nCaption: ${(p.caption || "").slice(0, 600) || "(empty)"}`,
    });
    if (p.thumbnail) {
      content.push({
        type: "image",
        source: { type: "url", url: p.thumbnail },
      });
    }
  });
  return content;
}

// Claude call that supports multimodal content blocks (caption + image)
async function callClaudeMultimodal({ model, systemPrompt, userContent, maxTokens, apiKey }) {
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
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err.slice(0, 400)}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || "";
}

// ─── Action: classify ───
// Body: { projectId, fast?: boolean }
//   fast=true  → caption-only Haiku (cheap, ~$0.0005/post)
//   fast=false → Sonnet vision (default, ~$0.008/post)
async function handleClassify(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, fast = false } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const posts = Array.isArray(project.posts) ? project.posts : [];
  // Only classify posts that don't already have a format
  const unclassified = posts.filter(p => !p.format);
  if (!unclassified.length) {
    return res.status(200).json({ success: true, classified: 0, alreadyClassified: posts.length });
  }

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    status: "classifying",
    updatedAt: new Date().toISOString(),
  });

  const systemPrompt = buildClassifierSystemPrompt();
  // Vision mode uses Sonnet; Fast (caption-only) uses Haiku.
  // If vision fails mid-batch we gracefully retry that batch caption-only
  // with Haiku so nothing ends up unclassified.
  const visionModel = "claude-sonnet-4-6";
  const textModel = "claude-haiku-4-6";
  const batchSize = 10;
  const postById = Object.fromEntries(posts.map(p => [p.id, p]));
  const classified = [];
  const errors = [];

  const classifyBatchCaptionOnly = async (batch) => {
    const userText = batch.map((p, j) =>
      `Post ${j + 1} (postId: ${p.id}) — handle ${p.handle}, views ${p.views ?? "n/a"}, engagement ${p.engagementRate}\nCaption: ${(p.caption || "(empty)").slice(0, 400)}`
    ).join("\n\n");
    return callClaude({
      model: textModel, systemPrompt,
      userMessage: `Classify these Instagram posts. Return the JSON array in the same order.\n\n${userText}`,
      maxTokens: 4000, apiKey: ANTHROPIC_KEY,
    });
  };

  for (let i = 0; i < unclassified.length; i += batchSize) {
    const batch = unclassified.slice(i, i + batchSize);
    const batchIdx = i / batchSize;
    let raw = null;
    let usedFallback = false;
    try {
      if (fast) {
        raw = await classifyBatchCaptionOnly(batch);
      } else {
        // Vision — multimodal content blocks with thumbnail URLs
        const userContent = buildClassifierUserMessage(batch);
        try {
          raw = await callClaudeMultimodal({
            model: visionModel, systemPrompt, userContent, maxTokens: 4000, apiKey: ANTHROPIC_KEY,
          });
        } catch (visionErr) {
          // Vision failed (usually Instagram CDN blocking Anthropic's image fetcher
          // or Claude refusing a URL). Fall back to caption-only Haiku so the batch
          // isn't a total loss.
          console.warn(`[classify] Batch ${batchIdx} vision failed, retrying caption-only:`, visionErr.message);
          errors.push({ batch: batchIdx, stage: "vision", error: visionErr.message, recovered: true });
          raw = await classifyBatchCaptionOnly(batch);
          usedFallback = true;
        }
      }
      const parsed = parseJSON(raw);
      if (!Array.isArray(parsed)) throw new Error(`Classifier returned non-array: ${String(raw).slice(0, 200)}`);
      parsed.forEach(c => {
        if (!c.postId || !postById[c.postId]) return;
        if (!FORMAT_BUCKETS.includes(c.format)) c.format = "other";
        postById[c.postId].format = c.format;
        postById[c.postId].formatConfidence = +(c.confidence || 0);
        postById[c.postId].formatEvidence = (c.evidence || "").slice(0, 200) + (usedFallback ? " (caption-only)" : "");
        postById[c.postId].hookType = HOOK_TYPES.includes(c.hookType) && c.hookType !== "null" ? c.hookType : null;
        classified.push(c.postId);
      });
    } catch (err) {
      console.error(`[classify] Batch ${batchIdx} failed entirely:`, err.message, raw ? `Raw: ${String(raw).slice(0, 300)}` : "");
      errors.push({ batch: batchIdx, stage: usedFallback ? "text-fallback" : "parse", error: err.message, rawPreview: raw ? String(raw).slice(0, 200) : null });
    }
  }

  // Rebuild posts array preserving original order
  const updatedPosts = posts.map(p => postById[p.id] || p);

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    posts: updatedPosts,
    status: "review",
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({
    success: true,
    classified: classified.length,
    batchErrors: errors,
    // Surface which model(s) ran, useful for cost-attribution debugging.
    model: fast ? textModel : `${visionModel} (+ ${textModel} fallback)`,
  });
}

// ─── Transcript extraction (Slice 6) ───
// Pulls the transcript either from the request body (pasted text) or
// from a Google Doc URL. Google Doc is fetched server-side via the
// public export-to-txt endpoint — identical logic to api/preproduction.js.
async function resolveTranscript({ transcript, googleDocUrl }) {
  if (transcript && transcript.trim()) return transcript.trim();
  if (!googleDocUrl) throw new Error("Provide either transcript text or a Google Doc URL");
  const docIdMatch = googleDocUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!docIdMatch) throw new Error("Couldn't parse a Google Doc ID from the URL");
  const docId = docIdMatch[1];
  const docResp = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`);
  if (!docResp.ok) {
    throw new Error(`Google Doc fetch failed (${docResp.status}). Make sure the doc is set to "Anyone with the link can view".`);
  }
  const text = await docResp.text();
  return text.trim();
}

function buildExtractionSystemPrompt({ companyName }) {
  return `You extract competitor research signals from a pre-production meeting transcript for Viewix, a video production agency.

The client is: ${companyName}

Your job: read the transcript and return three lists:

1. COMPETITORS — any brands, creators, or businesses the client mentioned as competitors, inspirations, peers, or reference points. Include the Instagram handle if the client stated one (format "@handle"); otherwise pass displayName and leave handle null.

2. KEYWORDS — content topics, niches, or themes the client wants to explore or is known for. 1-5 word phrases, lowercase.

3. FORMATS OF INTEREST — any format types the client expressed interest in or gravitated toward. Use these exact strings (pick any that apply):
   talking_head, skit, tutorial, vo_broll, transformation, ugc_testimonial, listicle, trend, product_demo

Return STRICTLY valid JSON, no prose, no markdown fences:

{
  "competitors": [{ "handle": "@brand" | null, "displayName": "Brand", "reason": "one-line why this was flagged" }],
  "keywords": [{ "term": "men's suiting", "reason": "..." }],
  "formatsOfInterest": ["talking_head", "tutorial"]
}

If any list is empty, return an empty array for it. Don't invent competitors — only include what the client actually mentioned.`;
}

// ─── Action: extractFromTranscript ───
// Body: { projectId, transcript?, googleDocUrl? }
async function handleExtractFromTranscript(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, transcript: rawTranscript, googleDocUrl } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  let transcriptText;
  try {
    transcriptText = await resolveTranscript({ transcript: rawTranscript, googleDocUrl });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!transcriptText || transcriptText.length < 40) {
    return res.status(400).json({ error: "Transcript is empty or too short" });
  }

  const systemPrompt = buildExtractionSystemPrompt({ companyName: project.companyName });
  const raw = await callClaude({
    model: "claude-sonnet-4-6",
    systemPrompt,
    userMessage: transcriptText.slice(0, 20000),  // cap at 20k chars to control cost
    maxTokens: 2000,
    apiKey: ANTHROPIC_KEY,
  });

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) { return res.status(500).json({ error: "Failed to parse extraction response", raw: raw.slice(0, 500) }); }

  const transcriptSuggestions = {
    competitors: (parsed.competitors || []).map(c => ({
      handle: c.handle || null,
      displayName: c.displayName || c.handle || "(unnamed)",
      reason: c.reason || "",
      accepted: false,
    })),
    keywords: (parsed.keywords || []).map(k => ({
      term: k.term || "",
      reason: k.reason || "",
      accepted: false,
    })),
    formatsOfInterest: Array.isArray(parsed.formatsOfInterest) ? parsed.formatsOfInterest : [],
    generatedAt: new Date().toISOString(),
  };

  // Also persist the transcript on the project so it can be re-used / re-extracted
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    transcriptSuggestions,
    inputs: {
      ...(project.inputs || {}),
      transcript: {
        text: transcriptText,
        source: googleDocUrl ? "googledoc" : "manual",
        addedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({ success: true, transcriptSuggestions });
}

// ─── Synthesis helpers + handler removed in the producer-driven restructure.
// The old flow wrote /preproduction/socialOrganic/{id}/synthesis with an
// Opus-generated markdown brief. Legacy `synthesis` field on existing
// projects is preserved (harmless) but no longer read or written.
// Replacement: ReviewGrid → ShortlistStep → SelectStep → ScriptBuilderStep
// producer-driven, with a global /formatLibrary/ for cross-project reuse.

// ─── Action: manual reclassify ───
// Body: { projectId, postId, format, hookType? }
async function handleReclassify(req, res) {
  const { projectId, postId, format, hookType = null } = req.body || {};
  if (!projectId || !postId || !format) return res.status(400).json({ error: "Missing projectId, postId, or format" });
  if (!FORMAT_BUCKETS.includes(format)) return res.status(400).json({ error: `Invalid format: ${format}` });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const posts = Array.isArray(project.posts) ? project.posts : [];
  const idx = posts.findIndex(p => p.id === postId);
  if (idx < 0) return res.status(404).json({ error: "Post not found in project" });

  const updated = [...posts];
  updated[idx] = { ...updated[idx], format, hookType, formatEvidence: "(manual)", formatConfidence: 1 };
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    posts: updated,
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({ success: true });
}

// ─── Action: scrape ───
// Body: { projectId, inputs: { competitors, dateRange, postsPerHandle } }
async function handleScrape(req, res) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const { projectId, inputs } = req.body || {};
  if (!projectId || !inputs) return res.status(400).json({ error: "Missing projectId or inputs" });

  const handles = (inputs.competitors || []).map(c => c.handle).filter(Boolean);
  if (!handles.length) return res.status(400).json({ error: "No competitor handles to scrape" });
  if (handles.length > MAX_HANDLES_PER_SCRAPE) {
    return res.status(400).json({ error: `Max ${MAX_HANDLES_PER_SCRAPE} handles per scrape. Got ${handles.length}.` });
  }

  const postsPerHandle = Math.min(inputs.postsPerHandle || 30, MAX_POSTS_PER_HANDLE);
  const from = inputs.dateRange?.from || null;
  const to = inputs.dateRange?.to || null;

  // Daily budget gate
  const budget = await checkDailyBudget();
  const est = estimateCost({ handles, postsPerHandle });
  if ((budget.spentToday + est.estApifyCost) > budget.budget) {
    return res.status(429).json({
      error: "Daily research budget exceeded",
      detail: `Today's spend ($${budget.spentToday.toFixed(2)}) + this scrape ($${est.estApifyCost.toFixed(2)}) would exceed the cap ($${budget.budget.toFixed(2)}). Try again tomorrow or reduce the scrape size.`,
    });
  }

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    status: "scraping",
    updatedAt: new Date().toISOString(),
  });

  // Split handles into cache-hit + cache-miss groups
  const now = Date.now();
  const handleResults = {};  // handle -> { posts, cached, cacheKey }
  const missHandles = [];
  for (const handle of handles) {
    const key = cacheKey({ handle, from, to, postsPerHandle });
    const cached = await fbGet(`/caches/apifyScrapes/${key}`);
    if (cached?.fetchedAt && (now - new Date(cached.fetchedAt).getTime()) < CACHE_TTL_MS && Array.isArray(cached.posts)) {
      handleResults[handle] = { posts: cached.posts, cached: true, cacheKey: key };
    } else {
      missHandles.push({ handle, cacheKey: key });
    }
  }

  const errors = [];
  let actualCost = 0;

  // Scrape the cold handles (one Apify call per handle — simpler + easier to isolate failures)
  for (const { handle, cacheKey: key } of missHandles) {
    try {
      const startedAt = new Date().toISOString();
      const rawItems = await apifyScrape({ handles: [handle], postsPerHandle, from, to, token: APIFY_TOKEN });
      console.log(`[social-organic] Apify returned ${rawItems.length} raw items for ${handle}`);
      if (rawItems.length === 0) {
        // Capture a hint so the producer sees SOMETHING in the UI error
        errors.push({ handle, error: "Apify returned 0 items. Check the account is public and spelled correctly." });
      }
      const normalised = rawItems.map(r => normaliseInstagramPost(r, handle));
      const thisCost = +(normalised.length * APIFY_COST_PER_POST).toFixed(4);
      actualCost += thisCost;

      // Cache per-handle
      await fbSet(`/caches/apifyScrapes/${key}`, {
        handle,
        postsPerHandle,
        from,
        to,
        posts: normalised,
        fetchedAt: new Date().toISOString(),
        cost: thisCost,
      });
      handleResults[handle] = { posts: normalised, cached: false, cacheKey: key, startedAt };

      // Update handle directory (lightweight ledger for autocomplete)
      const normHandle = handle.toLowerCase().replace(/[^\w]/g, "_");
      const existing = (await fbGet(`/preproduction/socialOrganic/_handleDirectory/${normHandle}`)) || {};
      await fbSet(`/preproduction/socialOrganic/_handleDirectory/${normHandle}`, {
        handle,
        lastScrapedAt: new Date().toISOString(),
        totalRuns: (existing.totalRuns || 0) + 1,
        avgViews: normalised.length
          ? Math.round(normalised.reduce((s, p) => s + (p.views || 0), 0) / normalised.length)
          : (existing.avgViews || 0),
      });
    } catch (err) {
      errors.push({ handle, error: err.message });
      handleResults[handle] = { posts: [], cached: false, error: err.message };
    }
  }

  // Merge all handles' posts into the project's posts[] and compute handle stats
  const allPosts = [];
  Object.values(handleResults).forEach(r => { if (Array.isArray(r.posts)) allPosts.push(...r.posts); });
  const handleStats = computeHandleStatsAndScore(allPosts);

  // Log the actual spend for today
  const today = new Date().toISOString().slice(0, 10);
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fbSet(`/preproduction/socialOrganic/_costLog/${today}/${runId}`, {
    projectId,
    cost: actualCost,
    handles,
    hitCache: missHandles.length < handles.length,
    postsCollected: allPosts.length,
    timestamp: new Date().toISOString(),
  });

  // Write results back to the project
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    status: "review",
    posts: allPosts,
    handleStats,
    scrape: {
      runId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      costEstimate: est.estApifyCost,
      actualCost: +actualCost.toFixed(3),
      postCount: allPosts.length,
      hitCache: missHandles.length < handles.length,
      handlesHit: handles.filter(h => handleResults[h]?.cached).length,
      handlesMissed: missHandles.length,
      errors,
    },
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({
    success: true,
    postsCollected: allPosts.length,
    handleStats,
    actualCost: +actualCost.toFixed(3),
    hitCache: missHandles.length < handles.length,
    errors,
  });
}

// ─── Action: runPipeline ───
// Convenience wrapper: scrape → classify, updating status between phases.
// After classify, producer picks up in the Review UI (Phase 1 of the rebuild).
// Each phase is skipped if the relevant artefact already exists, so re-runs are safe.
// Body: { projectId, fast?: boolean, force?: boolean }
//   fast=true  → uses caption-only Haiku for classification
//   force=true → re-runs every phase even if results already exist
async function handleRunPipeline(req, res) {
  const { projectId, fast = false, force = false } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const result = { scrape: null, classify: null };

  // Phase 1: scrape (skipped if posts already exist and not forcing)
  const initial = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!initial) return res.status(404).json({ error: "Project not found" });

  const existingPosts = Array.isArray(initial.posts) ? initial.posts : [];
  if (force || existingPosts.length === 0) {
    const scrapeReq = { body: { projectId, inputs: initial.inputs } };
    // Capture the JSON payload by swapping in a tiny shim res
    let scrapePayload, scrapeStatus = 200;
    const shimRes = {
      status(code) { scrapeStatus = code; return this; },
      json(body) { scrapePayload = body; return this; },
      setHeader() { return this; },
    };
    await handleScrape(scrapeReq, shimRes);
    result.scrape = { status: scrapeStatus, ...scrapePayload };
    if (scrapeStatus >= 400) return res.status(scrapeStatus).json({ error: "Scrape phase failed", detail: scrapePayload });

    // Zero-post scrape → bail with a clear message. The classify phase has
    // nothing to work with and would fail more opaquely.
    if (!scrapePayload?.postsCollected || scrapePayload.postsCollected === 0) {
      const errDetail = scrapePayload?.errors?.length
        ? `Apify returned these errors: ${scrapePayload.errors.map(e => `${e.handle}: ${e.error}`).join("; ")}`
        : "Apify returned 0 posts. The actor may not be finding the handles, or they may be private/banned/restricted. Check the Vercel function logs for the raw Apify response.";
      return res.status(422).json({
        error: "Scrape returned 0 posts — nothing to classify",
        detail: errDetail,
        scrape: scrapePayload,
      });
    }
  } else {
    result.scrape = { skipped: true, postCount: existingPosts.length };
  }

  // Phase 2: classify
  const afterScrape = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  const unclassified = (afterScrape?.posts || []).filter(p => !p.format).length;
  if (force || unclassified > 0) {
    const classifyReq = { body: { projectId, fast } };
    let classifyPayload, classifyStatus = 200;
    const shimRes = {
      status(code) { classifyStatus = code; return this; },
      json(body) { classifyPayload = body; return this; },
      setHeader() { return this; },
    };
    await handleClassify(classifyReq, shimRes);
    result.classify = { status: classifyStatus, ...classifyPayload };
    if (classifyStatus >= 400) return res.status(classifyStatus).json({ error: "Classify phase failed", detail: classifyPayload });
  } else {
    result.classify = { skipped: true };
  }

  // Phase 3 (synthesise) removed — producers now drive review → shortlist → select → script.
  // Move the project to "review" stage so the Phase 1 UI kicks in automatically.
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    stage: "review",
    status: "review",
    updatedAt: new Date().toISOString(),
  });

  // Slack notification on success — best-effort, don't fail the pipeline if it errors
  const slackWebhook = process.env.SLACK_PREPRODUCTION_WEBHOOK_URL;
  if (slackWebhook) {
    try {
      const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
      const postCount = (project?.posts || []).length;
      const classifiedCount = (project?.posts || []).filter(p => p.format).length;
      await fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `:mag: Social organic research ready for review — *${project?.companyName}* — ${postCount} posts scraped, ${classifiedCount} classified.`,
        }),
      });
    } catch (e) {
      console.warn("Slack notification failed:", e.message);
    }
  }

  return res.status(200).json({ success: true, ...result });
}

// ═══════════════════════════════════════════════════════════════════
// SCRIPT BUILDER (Phase 5) — producer-driven preproduction doc
// generateScript:     full-doc generation from the picked formats + research
// rewriteScriptSection: small single-field Claude call, cell-level edits
// ═══════════════════════════════════════════════════════════════════

// Default preproduction brief prompt. Founders can override live at
// /preproductionTemplates/socialOrganicPrompt without a redeploy. Modelled
// on Picup Media's Social Retainer Video Sheet template:
//   Brand Truths → Brand Ambitions → Client Goals → Key Considerations →
//   Social Snapshot → Target Viewer Persona → Key Takeaways → Formats (from
//   selected) → Script Table (per video: content style, hook, text hook,
//   visual hook, script/notes, props).
const DEFAULT_SOCIAL_ORGANIC_PROMPT = `You are a senior creative strategist at Viewix, a Sydney-based video production agency. A producer has gathered research on a client's niche, shortlisted high-performing competitor videos, and picked the exact formats they want to shoot. Your job is to produce a single structured preproduction document the producer can take into the shoot.

RULES:
- Be specific, opinionated, and evidence-based. Do not reach for generic agency-speak.
- Every section should feel like a smart colleague who watched the reference videos, not a template.
- Never use em dashes. Use commas, full stops, or rewrite.
- Return a single JSON object with the exact structure below. No markdown, no preamble, no code fences.

STRUCTURE TO RETURN:
{
  "clientContext": {
    "brandTruths": "2-4 sentences on what the brand is known for, what it does best, and what makes it credible.",
    "brandAmbitions": "2-3 sentences on where this content should take the brand — not a mission statement, a pointed direction.",
    "clientGoals": "3-5 bullet-style lines, one per line, on what the client explicitly wants this content to achieve.",
    "keyConsiderations": "3-5 bullet-style lines on constraints or preferences: what they will not do, who they will not speak to, tone rules."
  },
  "socialSnapshot": {
    "averagePerformance": "One sentence summarising typical post performance on the client's handles (views, engagement cadence).",
    "highestPerforming": "One sentence describing the client's best-performing piece of content to date.",
    "takeaways": "3-5 bullet-style lines on what is working and what is not, grounded in the research data."
  },
  "targetViewer": {
    "demographic": "2-4 sentences on age, gender skew, consumption habits.",
    "painPoints": "3-5 bullet-style lines. Include direct viewer-voice quotes where the research supports it."
  },
  "scriptTable": [
    {
      "videoNumber": 1,
      "formatName": "Matches one of the selected formats exactly.",
      "contentStyle": "One-sentence description of what the final video looks like.",
      "hook": "The spoken opening line (verbatim or template with __client__ placeholders).",
      "textHook": "The on-screen text at the opening.",
      "visualHook": "What the viewer sees in frame for the first 2-3 seconds.",
      "scriptNotes": "Question prompts or talking-point bullets the producer should walk the client through on set.",
      "props": "Physical props, outfits, or location cues. Use 'N/A' if none."
    }
    // one entry per selected format
  ]
}

IMPORTANT:
- The scriptTable must have EXACTLY one entry per format in the "Selected Formats" list below, in the same order. Do not invent extra formats.
- Use formatName values verbatim from the Selected Formats input.
- Hook, textHook and visualHook should be concrete enough that a producer can read them aloud on set.`;

async function getPromptOverride() {
  // Live prompt override — falls back to the hardcoded default if empty.
  const p = await fbGet("/preproductionTemplates/socialOrganicPrompt");
  return (typeof p === "string" && p.trim()) ? p : DEFAULT_SOCIAL_ORGANIC_PROMPT;
}

async function getFantasticExample() {
  const ex = await fbGet("/preproductionTemplates/fantasticExample");
  return (typeof ex === "string" && ex.trim()) ? ex : null;
}

function buildScriptUserMessage({ project, selectedFormatObjects, fantasticExample }) {
  const posts = project.posts || [];
  const tickedPosts = Object.entries(project.videoReviews || {})
    .filter(([, r]) => r?.status === "ticked")
    .map(([id]) => posts.find(p => p.id === id))
    .filter(Boolean);
  const handleStats = project.handleStats || {};
  const transcript = project.inputs?.transcript?.text || null;

  const formatsBlock = selectedFormatObjects.map((fmt, i) => {
    const ex = Array.isArray(fmt.examples) ? fmt.examples : [];
    return [
      `FORMAT ${i + 1}: ${fmt.name}`,
      fmt.category ? `Category: ${fmt.category}` : null,
      fmt.videoAnalysis ? `Analysis: ${fmt.videoAnalysis}` : null,
      fmt.filmingInstructions ? `Filming: ${fmt.filmingInstructions}` : null,
      fmt.structureInstructions ? `Structure: ${fmt.structureInstructions}` : null,
      ex.length ? `Examples: ${ex.map(e => e.url).filter(Boolean).slice(0, 3).join(", ")}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const tickedBlock = tickedPosts.slice(0, 20).map(p =>
    `${p.handle} · ${p.overperformanceScore ? p.overperformanceScore.toFixed(1) + "× baseline" : ""}\n  Caption: ${(p.caption || "").slice(0, 220).replace(/\n+/g, " ")}`
  ).join("\n\n");

  const statsBlock = Object.entries(handleStats).map(([h, s]) =>
    `${s.handle || h}: avg ${s.avgViews} views, median ${s.medianViews}`
  ).join("\n");

  return `CLIENT: ${project.companyName}
${project.videoType ? `DEAL TYPE: ${project.videoType}` : ""}
${project.numberOfVideos ? `TOTAL VIDEOS TO SHOOT THIS ROUND: ${project.numberOfVideos}` : ""}

HANDLE STATS:
${statsBlock || "(none)"}

TICKED REFERENCE VIDEOS (producer hand-picked these during review — use them to ground the script table):
${tickedBlock || "(none)"}

${transcript ? `\nPRE-PRODUCTION MEETING TRANSCRIPT:\n${transcript.slice(0, 6000)}\n` : ""}

SELECTED FORMATS (render one scriptTable entry per format, in order):
${formatsBlock}

${fantasticExample ? `\nEXAMPLE OF A FANTASTIC PAST PREPRODUCTION DOC (same JSON shape; use it as a quality bar, do not copy verbatim):\n${fantasticExample.slice(0, 4000)}\n` : ""}

Produce the preproduction JSON now.`;
}

async function handleGenerateScript(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  if (selected.length === 0) {
    return res.status(400).json({ error: "No selected formats. Drag at least one into the selected queue first." });
  }

  // Resolve each selected format to the full library entry so we have the
  // analysis / filming / structure / examples available to Claude.
  const selectedFormatObjects = [];
  for (const s of selected) {
    const fmt = await fbGet(`/formatLibrary/${s.formatLibraryId}`);
    if (fmt) selectedFormatObjects.push(fmt);
  }

  const systemPrompt = await getPromptOverride();
  const fantasticExample = await getFantasticExample();
  const userMessage = buildScriptUserMessage({ project, selectedFormatObjects, fantasticExample });

  const runId = `script_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;
  const startedAt = Date.now();

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 16000,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 500) });
  }

  // Build the `formats` section from the selectedFormatObjects themselves
  // rather than letting Claude invent format descriptions. This is the
  // anti-hallucination guard the plan calls out.
  const formatsSection = selectedFormatObjects.map((fmt, i) => ({
    order: i,
    formatLibraryId: fmt.id,
    name: fmt.name,
    videoAnalysis: fmt.videoAnalysis || "",
    filmingInstructions: fmt.filmingInstructions || "",
    structureInstructions: fmt.structureInstructions || "",
    examples: (fmt.examples || []).slice(0, 3).map(e => ({
      url: e.url, thumbnail: e.thumbnail || null, sourceAccount: e.sourceAccount || null,
    })),
  }));

  const preproductionDoc = {
    clientContext: parsed.clientContext || {},
    socialSnapshot: parsed.socialSnapshot || {},
    targetViewer: parsed.targetViewer || {},
    formats: formatsSection,
    scriptTable: Array.isArray(parsed.scriptTable) ? parsed.scriptTable : [],
    generatedAt: new Date().toISOString(),
    modelUsed: "claude-opus-4-6",
    runId,
    rewriteHistory: project.preproductionDoc?.rewriteHistory || [],
  };

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    preproductionDoc,
    stage: "script",
    status: "review",
    updatedAt: new Date().toISOString(),
  });

  // Cost log — Opus is the expensive call, so worth tracking.
  try {
    const today = new Date().toISOString().slice(0, 10);
    await fbSet(`/preproduction/socialOrganic/_costLog/${today}/${runId}`, {
      type: "script",
      projectId,
      durationMs: Date.now() - startedAt,
      model: "claude-opus-4-6",
      createdAt: new Date().toISOString(),
    });
  } catch { /* noop */ }

  return res.status(200).json({ success: true, preproductionDoc });
}

// Translate a JS dot-path ("clientContext.brandTruths") into a Firebase
// slash-path. Kept simple on purpose — the incoming paths are all from a
// known set defined in the client-side renderer.
function pathToFbPath(jsPath) {
  return jsPath.replace(/\./g, "/");
}

async function handleRewriteScriptSection(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, path, instruction, currentValue } = req.body || {};
  if (!projectId || !path || !instruction) {
    return res.status(400).json({ error: "Missing projectId, path, or instruction" });
  }

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const systemPrompt = `You rewrite a single field of a social video preproduction doc for Viewix. Return ONLY the rewritten value as plain text. No markdown, no preamble, no code fences. Never use em dashes; use commas or full stops instead. Keep length comparable to the current value unless the instruction asks otherwise.`;

  const userMessage = `CLIENT: ${project.companyName}
FIELD PATH: ${path}

CURRENT VALUE:
"""
${currentValue || ""}
"""

REWRITE INSTRUCTION:
"""
${instruction}
"""

Return only the rewritten value.`;

  let newValue;
  try {
    const raw = await callClaude({
      model: "claude-sonnet-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 2000,
      apiKey: ANTHROPIC_KEY,
    });
    newValue = raw.trim();
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  const fbPath = `/preproduction/socialOrganic/${projectId}/preproductionDoc/${pathToFbPath(path)}`;
  await fbSet(fbPath, newValue);

  // Append to rewriteHistory — mirrors api/preproduction.js:351-361.
  const historyEntry = {
    timestamp: new Date().toISOString(),
    path,
    instruction,
    previousValue: currentValue || "",
    newValue,
  };
  const history = Array.isArray(project.preproductionDoc?.rewriteHistory) ? project.preproductionDoc.rewriteHistory : [];
  history.push(historyEntry);
  await fbSet(`/preproduction/socialOrganic/${projectId}/preproductionDoc/rewriteHistory`, history);
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, newValue });
}

// ═══════════════════════════════════════════════════════════════════
// TAB 1 — BRAND TRUTH (Phase B of 7-tab restructure)
// generateBrandTruth:     one-shot extraction from transcript + notes + Sherpa
// rewriteBrandTruthField: cell-level rewrite mirroring rewriteScriptSection
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_BRAND_TRUTH_PROMPT = `You are a senior creative strategist at Viewix, a Sydney-based video production agency. You have just sat in on a preproduction meeting with a client and need to produce the "Brand Truth" block that the producer will carry through the rest of the preproduction workflow.

RULES:
- Be specific, opinionated, evidence-based. No generic agency-speak.
- Quote the client's own language where useful — verbatim quotes are more valuable than paraphrased ones.
- Never use em dashes. Use commas, full stops, or rewrite.
- Return a single JSON object with the exact structure below. No markdown, no preamble, no code fences.

STRUCTURE:
{
  "brandTruths": "2-4 sentences on what the brand is known for, what it does best, and what makes it credible. Concrete claims, not fluff.",
  "brandAmbitions": "2-3 sentences on where this content should take the brand — a pointed direction, not a mission statement.",
  "clientGoals": "3-5 bullet-style lines, one per line, on what the client explicitly wants this content round to achieve.",
  "keyConsiderations": "3-5 bullet-style lines on constraints or preferences: what they won't do, who they won't speak to, tone rules, topics to avoid.",
  "targetViewerDemographic": "2-4 sentences on age, gender skew, consumption habits, platforms they live on.",
  "painPoints": "3-5 bullet-style lines, each capturing a specific viewer pain point. Use direct viewer-voice quotes where the transcript supports it.",
  "language": "2-4 sentences describing the tone + vocabulary + phrase patterns the target viewer uses and responds to. Include specific words/phrases where possible."
}`;

async function getBrandTruthPromptOverride() {
  const p = await fbGet("/preproductionTemplates/brandTruthPrompt");
  return (typeof p === "string" && p.trim()) ? p : DEFAULT_BRAND_TRUTH_PROMPT;
}

async function handleGenerateBrandTruth(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const transcript = project.brandTruth?.transcript || "";
  const producerNotes = project.brandTruth?.producerNotes || "";
  if (!transcript.trim() && !producerNotes.trim()) {
    return res.status(400).json({ error: "Paste a transcript or producer notes before generating." });
  }

  // Pull Sherpa / account-level context so Claude has the client background
  // it needs to ground the truths. We read the linked account record if the
  // webhook stored an attioCompanyId; otherwise we skip Sherpa.
  let sherpaBlock = "";
  if (project.attioCompanyId) {
    const accounts = await fbGet("/accounts");
    if (accounts) {
      const acct = Object.values(accounts).find(a => a?.attioId === project.attioCompanyId);
      if (acct) {
        const bits = [];
        if (acct.industry) bits.push(`Industry: ${acct.industry}`);
        if (acct.websiteUrl) bits.push(`Website: ${acct.websiteUrl}`);
        if (acct.notes) bits.push(`Notes: ${acct.notes}`);
        if (Array.isArray(acct.competitors) && acct.competitors.length) {
          bits.push(`Saved competitors: ${acct.competitors.map(c => c.handle || c.displayName).filter(Boolean).join(", ")}`);
        }
        if (bits.length) sherpaBlock = `\nSHERPA (saved client context):\n${bits.join("\n")}\n`;
      }
    }
  }

  const systemPrompt = await getBrandTruthPromptOverride();
  const userMessage = `CLIENT: ${project.companyName}
${project.videoType ? `DEAL TYPE: ${project.videoType}` : ""}
${project.numberOfVideos ? `TOTAL VIDEOS THIS ROUND: ${project.numberOfVideos}` : ""}
${sherpaBlock}
PREPRODUCTION MEETING TRANSCRIPT:
"""
${transcript.slice(0, 12000) || "(none)"}
"""

PRODUCER NOTES:
"""
${producerNotes.slice(0, 4000) || "(none)"}
"""

Produce the brand truth JSON now.`;

  const runId = `brandtruth_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;
  const startedAt = Date.now();

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 4000,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 500) });
  }

  const fields = {
    brandTruths:             parsed.brandTruths || "",
    brandAmbitions:          parsed.brandAmbitions || "",
    clientGoals:             parsed.clientGoals || "",
    keyConsiderations:       parsed.keyConsiderations || "",
    targetViewerDemographic: parsed.targetViewerDemographic || "",
    painPoints:              parsed.painPoints || "",
    language:                parsed.language || "",
  };

  await fbPatch(`/preproduction/socialOrganic/${projectId}/brandTruth`, {
    fields,
    generatedAt: new Date().toISOString(),
    modelUsed: "claude-opus-4-6",
    runId,
  });
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    updatedAt: new Date().toISOString(),
  });

  // Cost log — same pattern as handleGenerateScript.
  try {
    const today = new Date().toISOString().slice(0, 10);
    await fbSet(`/preproduction/socialOrganic/_costLog/${today}/${runId}`, {
      type: "brandTruth",
      projectId,
      durationMs: Date.now() - startedAt,
      model: "claude-opus-4-6",
      createdAt: new Date().toISOString(),
    });
  } catch { /* noop */ }

  return res.status(200).json({ success: true, fields });
}

// Single-field rewrite for Brand Truth cells. Mirrors rewriteScriptSection
// but writes under brandTruth/fields/{field} instead of preproductionDoc/*.
async function handleRewriteBrandTruthField(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, path, instruction, currentValue } = req.body || {};
  if (!projectId || !path || !instruction) {
    return res.status(400).json({ error: "Missing projectId, path, or instruction" });
  }

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const systemPrompt = `You rewrite a single field of a Brand Truth doc for Viewix. Return ONLY the rewritten value as plain text. No markdown, no preamble, no code fences. Never use em dashes; use commas or full stops instead. Keep length comparable to the current value unless the instruction asks otherwise.`;

  const userMessage = `CLIENT: ${project.companyName}
FIELD: ${path}

CURRENT VALUE:
"""
${currentValue || ""}
"""

REWRITE INSTRUCTION:
"""
${instruction}
"""

Return only the rewritten value.`;

  let newValue;
  try {
    const raw = await callClaude({
      model: "claude-sonnet-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 1500,
      apiKey: ANTHROPIC_KEY,
    });
    newValue = raw.trim();
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  // path comes in as a JS dot-path (e.g. "brandTruths"); it's a single-level
  // field directly under brandTruth/fields so we don't bother with a dotted
  // translator here.
  await fbSet(`/preproduction/socialOrganic/${projectId}/brandTruth/fields/${path}`, newValue);

  const historyEntry = {
    timestamp: new Date().toISOString(),
    path, instruction,
    previousValue: currentValue || "",
    newValue,
  };
  const history = Array.isArray(project.brandTruth?.rewriteHistory) ? project.brandTruth.rewriteHistory : [];
  history.push(historyEntry);
  await fbSet(`/preproduction/socialOrganic/${projectId}/brandTruth/rewriteHistory`, history);
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, newValue });
}

// ═══════════════════════════════════════════════════════════════════
// TAB 2 — FORMAT RESEARCH (Phase C)
// suggestCompetitors:     Claude proposes handles + keywords from context
// startClientScrape:      async Apify runs for client IG posts + profiles
// startCompetitorScrape:  async Apify run for ~120-video competitor scrape
// Completion signalled via /api/apify-webhook back into Firebase.
// ═══════════════════════════════════════════════════════════════════

const APIFY_IG_PROFILE_ACTOR = "apify~instagram-profile-scraper";
const APIFY_TT_PROFILE_ACTOR = "clockworks~tiktok-profile-scraper";
const APIFY_YT_CHANNEL_ACTOR = "streamers~youtube-channel-info";

// Resolve the webhook base URL. In Vercel production we want the canonical
// domain, not the ephemeral preview URL. The env var takes precedence; fall
// back to the preview URL for Vercel previews / local dev.
function apifyWebhookBase() {
  const fromEnv = process.env.APIFY_WEBHOOK_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return "https://planner.viewix.com.au";  // last-ditch canonical
}

// Fire an async Apify run + write a sidecar so the webhook can route the
// callback back to this project + purpose. Returns the runId.
async function startApifyRun({ actorId, input, token, projectId, purpose, extraSidecar = {} }) {
  const SECRET = process.env.APIFY_WEBHOOK_SECRET;
  if (!SECRET) throw new Error("APIFY_WEBHOOK_SECRET not configured");
  const webhookUrl = `${apifyWebhookBase()}/api/apify-webhook?secret=${encodeURIComponent(SECRET)}`;
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
    requestUrl: webhookUrl,
    payloadTemplate: `{"runId":"{{resource.id}}","status":"{{resource.status}}","datasetId":"{{resource.defaultDatasetId}}"}`,
  }];
  const webhooksB64 = Buffer.from(JSON.stringify(webhooks)).toString("base64");
  const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}&webhooks=${encodeURIComponent(webhooksB64)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Apify run start ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const runId = data.data?.id;
  if (!runId) throw new Error("Apify didn't return a run id");
  // Sidecar tells the webhook where to route the result.
  await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, {
    projectId, purpose, actorId,
    startedAt: new Date().toISOString(),
    ...extraSidecar,
  });
  return runId;
}

async function handleStartClientScrape(req, res) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const { projectId, handle } = req.body || {};
  if (!projectId || !handle) return res.status(400).json({ error: "Missing projectId or handle" });

  const cleanHandle = handle.replace(/^@+/, "").trim();
  if (!cleanHandle) return res.status(400).json({ error: "Invalid handle" });

  // Mark the bundle as running immediately so the UI can render spinners
  // without waiting for Apify's first webhook.
  await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape`, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null,
  });

  const runIds = {};
  const errors = {};

  // 1. Client's IG posts (reels-only filtered in the webhook handler).
  try {
    runIds.posts = await startApifyRun({
      actorId: APIFY_ACTOR,
      input: {
        directUrls: [`https://www.instagram.com/${cleanHandle}/`],
        resultsType: "posts",
        resultsLimit: 60,              // enough to find top-5 by views
        searchType: "user",
        addParentData: false,
      },
      token: APIFY_TOKEN,
      projectId,
      purpose: "clientPosts",
      extraSidecar: { handle: `@${cleanHandle.toLowerCase()}` },
    });
  } catch (e) {
    errors.posts = e.message;
  }

  // 2. IG profile scrape (for follower count).
  try {
    runIds.profileIG = await startApifyRun({
      actorId: APIFY_IG_PROFILE_ACTOR,
      input: { usernames: [cleanHandle] },
      token: APIFY_TOKEN,
      projectId,
      purpose: "clientProfileIG",
    });
  } catch (e) {
    errors.profileIG = e.message;
  }

  // TikTok + YouTube scrapes deferred to Phase D — they need the producer
  // to supply the platform handles, which happens in Tab 3.

  await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape`, {
    apifyRunIds: runIds,
  });

  return res.status(200).json({ success: true, runIds, errors });
}

async function handleStartCompetitorScrape(req, res) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const research = project.research || {};
  const competitors = Array.isArray(research.competitors) ? research.competitors : [];
  const handles = competitors.map(c => c.handle).filter(Boolean);
  if (handles.length === 0) {
    return res.status(400).json({ error: "No competitor handles to scrape" });
  }

  const directUrls = handles.map(h => `https://www.instagram.com/${h.replace(/^@/, "")}/`);
  // ~120 videos across N handles → 120 / N rounded. Cap at 50 per handle
  // (apify-side ceiling) and at least 10.
  const perHandle = Math.min(50, Math.max(10, Math.round(120 / handles.length)));

  await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null,
  });

  let runId;
  try {
    runId = await startApifyRun({
      actorId: APIFY_ACTOR,
      input: {
        directUrls,
        resultsType: "posts",
        resultsLimit: perHandle,
        searchType: "user",
        addParentData: false,
      },
      token: APIFY_TOKEN,
      projectId,
      purpose: "competitorPosts",
    });
  } catch (e) {
    await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, {
      status: "error",
      error: e.message,
      finishedAt: new Date().toISOString(),
    });
    return res.status(502).json({ error: "Failed to start Apify run", detail: e.message });
  }

  await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, {
    apifyRunId: runId,
  });

  return res.status(200).json({ success: true, runId, handles: handles.length, perHandle });
}

// Ask Claude for competitor handles + keywords grounded in brand truth,
// transcript, and the account's saved competitors. Returns suggestions only
// — the producer reviews and edits before approving Stage B.
async function handleSuggestCompetitors(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const bt = project.brandTruth?.fields || {};
  const transcript = project.brandTruth?.transcript || "";
  let sherpa = "";
  if (project.attioCompanyId) {
    const accounts = await fbGet("/accounts");
    if (accounts) {
      const acct = Object.values(accounts).find(a => a?.attioId === project.attioCompanyId);
      if (acct) {
        const saved = (acct.competitors || []).map(c => c.handle || c.displayName).filter(Boolean);
        if (saved.length) sherpa = `\nSAVED COMPETITORS (may or may not fit this round):\n${saved.join(", ")}`;
        if (acct.industry) sherpa = `Industry: ${acct.industry}` + sherpa;
      }
    }
  }

  const systemPrompt = `You suggest Instagram competitor handles + hashtag keywords for Viewix's Social Organic research. Return JSON only, no markdown, no code fences. Prioritise accounts and topics the client would actually benchmark against. Avoid generic industry-giant handles unless they genuinely overlap. Limit: 5 handles, 8 keywords.

STRUCTURE:
{
  "competitors": [{"handle": "@example", "reason": "one short sentence"}],
  "keywords": ["keyword one", "hashtag-friendly phrase"]
}`;

  const userMessage = `CLIENT: ${project.companyName}
${sherpa}
BRAND TRUTHS: ${bt.brandTruths || "(none)"}
TARGET VIEWER: ${bt.targetViewerDemographic || "(none)"}
PAIN POINTS: ${bt.painPoints || "(none)"}

PREPRODUCTION TRANSCRIPT (first 4000 chars):
"""
${transcript.slice(0, 4000)}
"""

Suggest competitor handles and keywords now.`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-sonnet-4-6",
      systemPrompt, userMessage,
      maxTokens: 1500,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 400) });
  }

  const normalisedCompetitors = (parsed.competitors || [])
    .map(c => {
      if (typeof c === "string") return { handle: c.startsWith("@") ? c : `@${c.replace(/^@+/, "")}`, reason: "" };
      const h = (c.handle || c.username || "").trim();
      if (!h) return null;
      return { handle: h.startsWith("@") ? h : `@${h.replace(/^@+/, "")}`, reason: c.reason || "" };
    })
    .filter(Boolean)
    .slice(0, 5);
  const keywords = (parsed.keywords || []).map(k => (k || "").toString().trim().replace(/^#/, "")).filter(Boolean).slice(0, 8);

  await fbPatch(`/preproduction/socialOrganic/${projectId}/research`, {
    aiSuggestedAt: new Date().toISOString(),
    aiSuggestions: { competitors: normalisedCompetitors, keywords },
  });

  return res.status(200).json({ success: true, competitors: normalisedCompetitors, keywords });
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
      case "scrape":
        return await handleScrape(req, res);
      case "classify":
        return await handleClassify(req, res);
      case "reclassify":
        return await handleReclassify(req, res);
      case "extractFromTranscript":
        return await handleExtractFromTranscript(req, res);
      case "runPipeline":
        return await handleRunPipeline(req, res);
      case "generateScript":
        return await handleGenerateScript(req, res);
      case "rewriteScriptSection":
        return await handleRewriteScriptSection(req, res);
      case "generateBrandTruth":
        return await handleGenerateBrandTruth(req, res);
      case "rewriteBrandTruthField":
        return await handleRewriteBrandTruthField(req, res);
      case "startClientScrape":
        return await handleStartClientScrape(req, res);
      case "startCompetitorScrape":
        return await handleStartCompetitorScrape(req, res);
      case "suggestCompetitors":
        return await handleSuggestCompetitors(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`social-organic ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
