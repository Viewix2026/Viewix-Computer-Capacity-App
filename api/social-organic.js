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
import { processApifyRun } from "./_apifyProcess.js";
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
  // Defensive: REST fallback returns JSON on success or HTML/text on 401/403.
  // Without this guard, .json() would throw opaquely downstream when rules reject.
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Firebase REST ${r.status} on GET ${path}: ${body.slice(0, 200)}`);
  }
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
const DEFAULT_SOCIAL_ORGANIC_PROMPT = `You are a senior creative strategist at Viewix, a Sydney-based video production agency. A producer has gathered research on a client's niche, shortlisted high-performing competitor videos, and picked the exact formats they want to shoot. Your job is to produce a script table the producer can take into the shoot.

The Brand Truth, Client Research, and Format Selection have already been approved — use them as context but do NOT regenerate them. You are producing ONLY the per-video script table.

RULES:
- Be specific, opinionated, evidence-based. No generic agency-speak.
- Every line should feel like a smart colleague who watched the reference videos.
- Never use em dashes. Use commas, full stops, or rewrite.
- Return a single JSON object with the exact structure below. No markdown, no preamble, no code fences.

═══════════════════════════════════════════════════
SCRIPT DEPTH — read this carefully, producers are complaining about lazy outputs
═══════════════════════════════════════════════════

The \`scriptNotes\` field is where most of the value lives. Default mode is FULL SCRIPT — the actual words the presenter will say, written out in the order they say them, plus any b-roll/visual direction in square brackets inline.

DO (default mode):
- Write the spoken script verbatim, paragraph by paragraph, 120-220 words typical for a 30-60s video.
- Use [brackets] for visual cues and b-roll notes inline. Example: "Most people think sleep quality is about duration. [cut to stock footage of someone tossing in bed] It isn't. [cut to host, direct to camera] It's about the first 90 minutes."
- Include specific numbers, names, places, and quotes wherever the Brand Truth / research provides them. A script without specifics is a failed script.
- If you genuinely don't have enough research to write a full script on a topic, say so explicitly in the script with a [RESEARCH NEEDED: specific question] marker, rather than falling back to generic filler.

DO NOT (unless the format type justifies it):
- Do NOT return "talking point bullets" or "questions for the client to riff on" as the script. That's the producer's cop-out, not yours.
- Do NOT write "use pain point language here" or "mention their product" as placeholders — fill them in from the Brand Truth.
- Do NOT write "scripts will be developed in pre-production" — the producer IS in pre-production, and you ARE the development.

EXCEPTIONS — when bullets/questions ARE appropriate:
- Client interview / Q&A formats → provide the interview question list (6-10 open-ended questions the producer will ask on camera, not a verbatim script the client reads).
- Behind-the-scenes / day-in-the-life → provide a shot list + beat outline, not a verbatim script.
- Customer testimonial prompts → provide the prompt questions the client responds to, not a script.

For these exceptions, still be concrete and specific — the questions should be tailored to THIS client's business, not generic.

═══════════════════════════════════════════════════
ARTICLE REVIEWS / NEWS REACTIONS / STUDY BREAKDOWNS
═══════════════════════════════════════════════════

For any format that references external source material (news article review, study breakdown, book/podcast reaction, research commentary), you MUST source a specific, real article/study/paper relevant to the Brand Truth topic — using your training knowledge of real publications in the niche.

Required format for the scriptNotes field on these:

  SOURCE: [article / study title]
  URL: [best-known URL from training data — if uncertain, write BEST-GUESS-URL: <url> so the producer knows to verify]
  PUBLICATION: [e.g. Harvard Business Review, The Lancet, TechCrunch]
  KEY CLAIM: [one-sentence summary of what the source says]

  [Then the full script reacting to / breaking down / explaining the source]

Never return "find an article on this topic" or "source to be determined" — that's a failure mode. If you genuinely cannot confidently name a real source, pick an adjacent specific source you DO know and flag it clearly.

═══════════════════════════════════════════════════
STRUCTURE TO RETURN
═══════════════════════════════════════════════════
{
  "scriptTable": [
    {
      "videoNumber": 1,
      "formatName": "Matches one of the selected formats exactly.",
      "contentStyle": "One-sentence description of what the final video looks like.",
      "hook": "The spoken opening line (verbatim or template with __client__ placeholders).",
      "textHook": "The on-screen text at the opening.",
      "visualHook": "What the viewer sees in frame for the first 2-3 seconds.",
      "scriptNotes": "Full spoken script with inline [visual cues] — see SCRIPT DEPTH section above. Default mode is verbatim dialogue, not bullets.",
      "props": "Physical props, outfits, or location cues. Use 'N/A' if none."
    }
    // one entry per selected format — may span multiple rows if numberOfVideos > selectedFormats.length
  ]
}

IMPORTANT:
- Total rows must equal numberOfVideos.
- The Selected Formats input tells you EXACTLY how many videos of each format to produce. Respect those counts precisely — do not redistribute them. If a format says "Count: 5" produce 5 script rows for that format, in order, before moving to the next format.
- If a format says "Count: (not set)" (fallback case), distribute remaining rows roughly evenly across un-set formats.
- Use formatName values verbatim from the Selected Formats input.
- Hook, textHook and visualHook must be concrete enough to read aloud on set.`;

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
  // New schema sources — Brand Truth and client research are already approved.
  const bt = project.brandTruth?.fields || {};
  const competitorPosts = Array.isArray(project.competitorScrape?.posts) ? project.competitorScrape.posts : [];
  const tickedIds = new Set((project.videoReview?.ticked) || []);
  const tickedPosts = competitorPosts.filter(p => tickedIds.has(p.id));
  const extraLinks = Array.isArray(project.videoReview?.extraLinks) ? project.videoReview.extraLinks : [];
  const keyTakeaways = project.clientResearch?.keyTakeaways || "";
  const transcript = project.brandTruth?.transcript || "";

  const formatsBlock = selectedFormatObjects.map((fmt, i) => {
    const ex = Array.isArray(fmt.examples) ? fmt.examples : [];
    // Two paths:
    //   NEW (Idea Selection flow): fmt._tickedIdeas is an array of
    //     { title, text } the producer approved. We pass them as
    //     "Ideas to expand" — Claude produces one scriptTable row
    //     per ticked idea, using the idea as the creative seed.
    //   LEGACY (pre-Idea Selection): fmt._videoCount is a count and
    //     Claude falls back to even distribution.
    let seedBlock;
    if (Array.isArray(fmt._tickedIdeas) && fmt._tickedIdeas.length > 0) {
      const ideaLines = fmt._tickedIdeas
        .map((idea, j) => `  ${j + 1}. ${idea.title ? `[${idea.title}] ` : ""}${idea.text || ""}`)
        .join("\n");
      seedBlock = `Ticked ideas (produce ONE scriptTable row per idea, in order, using the idea as the creative seed — expand into the 7-column blueprint; don't invent extra rows and don't merge ideas):\n${ideaLines}`;
    } else {
      seedBlock = fmt._videoCount != null
        ? `Count: ${fmt._videoCount}`
        : `Count: (not set — fall back to equal distribution)`;
    }
    return [
      `FORMAT ${i + 1}: ${fmt.name}`,
      seedBlock,
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

  const extraBlock = extraLinks.length ? extraLinks.map(u => `  Extra link: ${u}`).join("\n") : "";

  return `CLIENT: ${project.companyName}
${project.videoType ? `DEAL TYPE: ${project.videoType}` : ""}
${project.numberOfVideos ? `TOTAL VIDEOS TO SHOOT THIS ROUND: ${project.numberOfVideos}` : ""}

APPROVED BRAND TRUTH (from Tab 1):
- Brand Truths: ${bt.brandTruths || "(none)"}
- Brand Ambitions: ${bt.brandAmbitions || "(none)"}
- Client Goals: ${bt.clientGoals || "(none)"}
- Key Considerations: ${bt.keyConsiderations || "(none)"}
- Target Viewer: ${bt.targetViewerDemographic || "(none)"}
- Pain Points: ${bt.painPoints || "(none)"}
- Language: ${bt.language || "(none)"}

PRODUCER'S READ ON CLIENT'S EXISTING CONTENT (from Tab 3):
${keyTakeaways || "(none)"}

TICKED REFERENCE VIDEOS (producer hand-picked these during review):
${tickedBlock || "(none)"}
${extraBlock}

${transcript ? `\nPRE-PRODUCTION MEETING TRANSCRIPT:\n${transcript.slice(0, 6000)}\n` : ""}

SELECTED FORMATS (in the order the producer chose them):
${formatsBlock}

${fantasticExample ? `\nEXAMPLE OF A FANTASTIC PAST PREPRODUCTION DOC (same JSON shape; use it as a quality bar, do not copy verbatim):\n${fantasticExample.slice(0, 4000)}\n` : ""}

Produce the scriptTable JSON now.`;
}

// ═══════════════════════════════════════════════════════════════════
// TAB 7 — IDEA SELECTION
// generateFormatIdeas: produces 10 idea concepts per selected format.
// Each idea = { id, title, text, selected: false }. Written to
//   /preproduction/socialOrganic/{id}/formatIdeas/{formatLibraryId}/{ideas,generatedAt}
// Producer ticks the ones they want progressed; Scripting consumes
// the ticked subset.
// ═══════════════════════════════════════════════════════════════════
async function handleGenerateFormatIdeas(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  if (selected.length === 0) {
    return res.status(400).json({ error: "No selected formats. Pick formats on the Format Selection tab first." });
  }

  // Flag the project as processing so the Idea Selection tab can show
  // a spinner when the producer navigates there (either by clicking
  // Generate directly or by having it auto-kicked from the Format
  // Selection Approve button). Cleared after writes below succeed OR
  // fail. 5-min staleness TTL handled on the client.
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    formatIdeasProcessingAt: new Date().toISOString(),
  });

  const bt = project.brandTruth?.fields || {};
  const btBlock = Object.entries(bt).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}:\n${v}`).join("\n\n");
  const existingIdeas = project.formatIdeas || {};

  // One Claude call per selected format so each batch of 10 is
  // independently tailored to that format's structure. Runs in
  // parallel, then we write the results. Individual failures don't
  // block the other formats — we surface them in the response.
  const systemPrompt = `You are a Viewix senior creative strategist. You are generating 10 video idea concepts for ONE specific video format.

RULES:
- Produce exactly 10 distinct idea concepts. Each is a complete, shootable premise that fits the format's structure.
- Each idea gets a short TITLE (3-6 words, the concept label) plus a one-sentence TEXT that explains the premise + hook angle.
- Be specific, evidence-based. Quote the brand truth's own phrases where it strengthens the idea. No generic agency-speak.
- Never use em dashes. Use commas, full stops, or rewrite.
- Titles must be distinct, not restatements of each other.
- Return ONLY a JSON object: { "ideas": [{ "title": "...", "text": "..." }, ...] }. No markdown, no preamble, no code fences.`;

  const runs = await Promise.all(selected.map(async (s) => {
    const fmt = await fbGet(`/formatLibrary/${s.formatLibraryId}`);
    if (!fmt) return { formatLibraryId: s.formatLibraryId, error: "Format not found in library" };

    const userMessage = `CLIENT: ${project.companyName}
${project.numberOfVideos ? `ROUND TOTAL: ${project.numberOfVideos} videos` : ""}

BRAND TRUTH:
${btBlock || "(not filled)"}

TARGET FORMAT: ${fmt.name}
${fmt.category ? `Category: ${fmt.category}` : ""}
${fmt.videoAnalysis ? `Analysis: ${fmt.videoAnalysis}` : ""}
${fmt.structureInstructions ? `Structure: ${fmt.structureInstructions}` : ""}
${fmt.filmingInstructions ? `Filming: ${fmt.filmingInstructions}` : ""}

Produce 10 distinct idea concepts tailored to this format's structure + the brand truth. JSON only.`;

    let raw;
    try {
      raw = await callClaude({
        model: "claude-opus-4-6",
        systemPrompt,
        userMessage,
        maxTokens: 3000,
        apiKey: ANTHROPIC_KEY,
      });
    } catch (e) {
      return { formatLibraryId: s.formatLibraryId, error: `Claude failed: ${e.message}` };
    }

    let parsed;
    try { parsed = parseJSON(raw); }
    catch (e) {
      return { formatLibraryId: s.formatLibraryId, error: `Invalid JSON: ${e.message}`, rawPreview: raw.slice(0, 300) };
    }

    const rawIdeas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
    // Preserve `selected` flags from the existing ideas if this is a
    // regeneration and a previously-ticked idea's title matches. Prevents
    // the producer losing their selections on a re-roll. Simple title
    // match — good enough for regen within the same brief.
    const existingForFormat = existingIdeas[s.formatLibraryId]?.ideas || [];
    const priorSelectedTitles = new Set(
      existingForFormat.filter(i => i?.selected).map(i => (i?.title || "").trim().toLowerCase())
    );

    const ideas = rawIdeas.slice(0, 10).map((it, i) => {
      const title = String(it?.title || "").trim() || `Idea ${i + 1}`;
      const text  = String(it?.text || "").trim();
      const wasSelected = priorSelectedTitles.has(title.toLowerCase());
      return { id: `idea_${Date.now()}_${i}`, title, text, selected: wasSelected };
    });

    return { formatLibraryId: s.formatLibraryId, ideas };
  }));

  // Write successful batches and collect errors.
  const errors = [];
  for (const run of runs) {
    if (run.error) {
      errors.push({ formatLibraryId: run.formatLibraryId, error: run.error });
      continue;
    }
    await fbPatch(`/preproduction/socialOrganic/${projectId}/formatIdeas/${run.formatLibraryId}`, {
      ideas: run.ideas,
      generatedAt: new Date().toISOString(),
    });
  }
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    updatedAt: new Date().toISOString(),
    formatIdeasProcessingAt: null,
  });

  if (errors.length === runs.length) {
    return res.status(502).json({ error: "All format idea runs failed", detail: errors });
  }
  return res.status(200).json({ ok: true, errors, succeeded: runs.length - errors.length });
}

async function handleGenerateScript(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, selectedFormats: inlineSelected, numberOfVideos: inlineTotal } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const projectFromFb = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!projectFromFb) return res.status(404).json({ error: "Project not found" });

  // Client sends its current state inline (see generate() on the
  // Scripts tab) because its fbUpdate() writes are fire-and-forget
  // and can be mid-flight when Generate is clicked. Prefer the
  // inline override; fall back to Firebase for anything missing.
  const project = {
    ...projectFromFb,
    selectedFormats: Array.isArray(inlineSelected) && inlineSelected.length > 0
      ? inlineSelected
      : projectFromFb.selectedFormats,
    numberOfVideos: typeof inlineTotal === "number" && inlineTotal > 0
      ? inlineTotal
      : projectFromFb.numberOfVideos,
  };

  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  if (selected.length === 0) {
    return res.status(400).json({ error: "No selected formats. Drag at least one into the selected queue first." });
  }

  // New flow: the Idea Selection tab has produced a batch of 10 ideas
  // per format and the producer has ticked the ones to progress. We
  // resolve each selected format to its library entry and carry only
  // the TICKED ideas forward — Claude then writes one scriptTable row
  // per ticked idea, using the idea title + text as the seed. Total
  // rows = total ticked (no more videoCount allocation guessing).
  //
  // Legacy fallback: if a project has no formatIdeas yet (was created
  // under the old flow), fall back to the legacy per-format videoCount
  // split so existing drafts still script cleanly.
  const formatIdeas = project.formatIdeas || {};
  const hasIdeas = Object.values(formatIdeas).some(f => Array.isArray(f?.ideas) && f.ideas.some(i => i?.selected));
  const selectedFormatObjects = [];
  for (const s of selected) {
    const fmt = await fbGet(`/formatLibrary/${s.formatLibraryId}`);
    if (!fmt) continue;
    const tickedIdeas = (formatIdeas[s.formatLibraryId]?.ideas || [])
      .filter(i => i && i.selected)
      .map(i => ({ title: i.title || "", text: i.text || "" }));
    selectedFormatObjects.push({
      ...fmt,
      _videoCount: hasIdeas ? tickedIdeas.length : (s.videoCount ?? null),
      _tickedIdeas: hasIdeas ? tickedIdeas : null,
    });
  }
  if (hasIdeas && selectedFormatObjects.every(f => !f._tickedIdeas?.length)) {
    return res.status(400).json({ error: "No ideas ticked. Go to Idea Selection and tick the ideas you want to progress." });
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

  // New 7-tab schema: clientContext / socialSnapshot / targetViewer are all
  // owned by Tab 1 (project.brandTruth.fields). Tab 7's preproductionDoc is
  // just formats + scriptTable, keeping the doc focused on what clients see.
  const preproductionDoc = {
    formats: formatsSection,
    scriptTable: Array.isArray(parsed.scriptTable) ? parsed.scriptTable : [],
    generatedAt: new Date().toISOString(),
    modelUsed: "claude-opus-4-6",
    runId,
    rewriteHistory: project.preproductionDoc?.rewriteHistory || [],
    clientFeedback: project.preproductionDoc?.clientFeedback || {},
  };

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    preproductionDoc,
    tab: "script",
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

// Whole-row rewrite for the scripting table. Called from the
// RowFeedbackModal ("Rewrite Whole Video" button). Takes a rowIndex
// + producer instruction and asks Claude to regenerate every field
// of that script row while preserving videoNumber + formatName +
// producerNote (the note is kept as a receipt of what the producer
// asked for). Other rows are untouched.
async function handleRewriteScriptRow(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, rowIndex, instruction } = req.body || {};
  if (!projectId || typeof rowIndex !== "number" || !instruction) {
    return res.status(400).json({ error: "Missing projectId, rowIndex, or instruction" });
  }

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const table = Array.isArray(project.preproductionDoc?.scriptTable) ? project.preproductionDoc.scriptTable : [];
  const row = table[rowIndex];
  if (!row) return res.status(400).json({ error: `No row at index ${rowIndex}` });

  const bt = project.brandTruth?.fields || {};
  const btBlock = Object.entries(bt).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}:\n${v}`).join("\n\n");

  const systemPrompt = `You rewrite a single row of a social video script table for Viewix. The producer has asked for specific changes to this whole video idea. Rewrite every editable field (contentStyle, hook, textHook, visualHook, scriptNotes, props) as one coherent idea. Keep the formatName unchanged — format is locked. Follow the producer's instruction literally.

RULES:
- Return a single JSON object with the exact structure below. No markdown, no preamble, no code fences.
- Never use em dashes. Use commas, full stops, or rewrite.
- Keep "hook" to one spoken line under 18 words.
- "textHook" is the on-screen caption overlay, under 8 words.
- "visualHook" describes what the viewer SEES in the first 2 seconds.
- "scriptNotes" is the structural beat-by-beat plan — 3-8 short lines.
- "props" is a comma-separated short list.
- "contentStyle" is a one-sentence tone/approach description.

{
  "contentStyle": "...",
  "hook": "...",
  "textHook": "...",
  "visualHook": "...",
  "scriptNotes": "...",
  "props": "..."
}`;

  const userMessage = `CLIENT: ${project.companyName}

BRAND TRUTH CONTEXT:
${btBlock || "(not filled)"}

FORMAT (locked): ${row.formatName || "(unknown)"}

CURRENT ROW VALUES:
Content Style: ${row.contentStyle || ""}
Hook (spoken): ${row.hook || ""}
Text Hook: ${row.textHook || ""}
Visual Hook: ${row.visualHook || ""}
Script / Notes: ${row.scriptNotes || ""}
Props: ${row.props || ""}

PRODUCER INSTRUCTION:
"""
${instruction}
"""

Rewrite every field of this video idea per the instruction. Return the JSON now.`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 2500,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 400) });
  }

  // Merge the rewritten fields into the row. Keep videoNumber and
  // formatName. Keep producerNote as the receipt of what was asked
  // for. Every other editable field gets overwritten.
  const newRow = {
    ...row,
    contentStyle: parsed.contentStyle ?? row.contentStyle,
    hook:         parsed.hook         ?? row.hook,
    textHook:     parsed.textHook     ?? row.textHook,
    visualHook:   parsed.visualHook   ?? row.visualHook,
    scriptNotes:  parsed.scriptNotes  ?? row.scriptNotes,
    props:        parsed.props        ?? row.props,
    producerNote: instruction.trim(),
    rewrittenAt:  new Date().toISOString(),
  };

  await fbSet(`/preproduction/socialOrganic/${projectId}/preproductionDoc/scriptTable/${rowIndex}`, newRow);

  // Audit entry in rewriteHistory, mirroring rewriteScriptSection.
  const history = Array.isArray(project.preproductionDoc?.rewriteHistory) ? project.preproductionDoc.rewriteHistory : [];
  history.push({
    timestamp: new Date().toISOString(),
    path: `scriptTable.${rowIndex}._row`,
    instruction,
    previousValue: { ...row },
    newValue: newRow,
  });
  await fbSet(`/preproduction/socialOrganic/${projectId}/preproductionDoc/rewriteHistory`, history);
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, row: newRow });
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

STRUCTURE — every field is a list of 3-5 short bullet-style lines, one idea per line, separated by a newline character ("\n"). Do NOT output prose paragraphs. Do NOT include leading bullet markers (no •, no dashes, no numbers) — the frontend renders the bullets automatically. Each line is one specific, concrete claim or observation. Keep lines under 25 words where possible.
{
  "brandTruths":             "3-5 lines on what the brand is known for, does best, what makes it credible. Concrete claims, one per line.",
  "brandAmbitions":          "3-5 lines on where this content should take the brand. Pointed directions, not mission statements, one per line.",
  "clientGoals":             "3-5 lines on what the client explicitly wants this content round to achieve.",
  "keyConsiderations":       "3-5 lines on constraints or preferences: what they won't do, who they won't speak to, tone rules, topics to avoid.",
  "targetViewerDemographic": "3-5 lines on age, gender skew, consumption habits, platforms they live on.",
  "painPoints":              "3-5 lines, each a specific viewer pain point. Use direct viewer-voice quotes where the transcript supports it.",
  "language":                "3-5 lines on the tone + vocabulary + phrase patterns the target viewer uses. Quote specific words/phrases where possible."
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
// "streamers/youtube-channel-info" doesn't exist on the Apify store — the
// actual Fast YouTube Channel Scraper (which exposes numberOfSubscribers
// + basic channel metadata) is published as youtube-channel-scraper.
const APIFY_YT_CHANNEL_ACTOR = "streamers~youtube-channel-scraper";

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

  // Only ONE Apify run for Stage A: the client's reels. Each post returned
  // carries ownerFollowersCount / owner.followersCount already, so we don't
  // need a separate profile scrape just to get the IG follower number — the
  // webhook handler pulls it off the first post directly. Removing the
  // second run eliminates a point of failure (actor availability / schema
  // differences) and halves the surface area.
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
    console.error(`[startClientScrape] posts run failed:`, e);
  }

  const anyRunStarted = Object.keys(runIds).length > 0;

  if (!anyRunStarted) {
    // Everything failed. Roll back the approval so the producer's UI goes
    // straight back to the approve button with the error visible — no
    // manual reset needed. Surface the Apify error so we can fix the
    // input schema / actor name if that's the cause.
    const msg = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" · ");
    await fbSet(`/preproduction/socialOrganic/${projectId}/clientScrape`, null);
    await fbSet(`/preproduction/socialOrganic/${projectId}/approvals/research_a`, null);
    return res.status(502).json({
      error: "Apify wouldn't accept the run",
      detail: msg || "All Apify runs failed to start",
      errors,
    });
  }

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
    console.error(`[startCompetitorScrape] failed:`, e);
    // Roll back so the producer's UI goes back to the approve button
    // with the Apify error surfaced.
    await fbSet(`/preproduction/socialOrganic/${projectId}/competitorScrape`, null);
    await fbSet(`/preproduction/socialOrganic/${projectId}/approvals/research_b`, null);
    return res.status(502).json({ error: "Apify wouldn't accept the run", detail: e.message });
  }

  await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, {
    apifyRunId: runId,
  });

  return res.status(200).json({ success: true, runId, handles: handles.length, perHandle });
}

// Ask Claude to guess the client's Instagram handle from the transcript +
// brand truth + Sherpa. Fires on Brand Truth approval (Tab 1 → Tab 2) so
// Stage A opens pre-filled. Producer can still edit before approving.
async function handleSuggestClientHandle(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  // Sherpa lookup — website URL is a strong signal (handle often matches
  // domain), saved competitors sometimes include the client itself.
  let website = "", sherpaNotes = "";
  if (project.attioCompanyId) {
    const accounts = await fbGet("/accounts");
    if (accounts) {
      const acct = Object.values(accounts).find(a => a?.attioId === project.attioCompanyId);
      if (acct) {
        website = acct.websiteUrl || acct.website || "";
        sherpaNotes = acct.notes || "";
      }
    }
  }

  const bt = project.brandTruth?.fields || {};
  const transcript = project.brandTruth?.transcript || "";

  const systemPrompt = `You extract a client's social media handles (Instagram, TikTok, YouTube) from preproduction context. Return JSON only — no markdown, no code fences.

RULES:
- Check the transcript first. If a handle is stated explicitly (e.g. "our instagram is @foo", "tiktok.com/@bar", "find us on youtube at @baz"), use it verbatim.
- Website domain is a strong signal for all three — most brands use the same handle across platforms.
- TikTok handles: format "@name" (no dots).
- YouTube handles: format "@name" (since 2022). Do NOT return /channel/UC... URLs or legacy /c/name formats — only the @-style handle.
- Confidence levels per platform:
  - "high"   = transcript explicitly mentions it OR website domain matches cleanly.
  - "medium" = strong inference from company name / brand truth.
  - "low"    = pure guess from the name, could easily be wrong.
- If you really can't guess for a platform, return handle: null for that one.

STRUCTURE:
{
  "instagram": { "handle": "@example", "confidence": "high"|"medium"|"low", "reason": "one short sentence" },
  "tiktok":    { "handle": "@example", "confidence": "...", "reason": "..." },
  "youtube":   { "handle": "@example", "confidence": "...", "reason": "..." }
}`;

  const userMessage = `CLIENT NAME: ${project.companyName}
WEBSITE: ${website || "(unknown)"}
SHERPA NOTES: ${sherpaNotes || "(none)"}
BRAND TRUTHS: ${bt.brandTruths || "(none)"}

PREPRODUCTION TRANSCRIPT (first 6000 chars):
"""
${transcript.slice(0, 6000) || "(none)"}
"""

What are the client's social handles?`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-sonnet-4-6",
      systemPrompt, userMessage,
      maxTokens: 800,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch {
    // Back-compat: old prompt returned a flat {handle, confidence, reason}.
    // Keep tolerant regex fallback so a Claude blip doesn't break the flow.
    const m = raw.match(/@[a-zA-Z0-9_.]+/);
    parsed = {
      instagram: { handle: m ? m[0] : null, confidence: "low", reason: "parsed from non-JSON response" },
      tiktok:    { handle: null, confidence: "low", reason: "" },
      youtube:   { handle: null, confidence: "low", reason: "" },
    };
  }

  // Normalise each platform's handle — strip leading @'s and re-add exactly one.
  const norm = (h) => {
    const s = (h || "").toString().trim();
    if (!s) return null;
    return s.startsWith("@") ? s : "@" + s.replace(/^@+/, "");
  };

  const ig = parsed.instagram || {};
  const tt = parsed.tiktok    || {};
  const yt = parsed.youtube   || {};
  const igHandle = norm(ig.handle);
  const ttHandle = norm(tt.handle);
  const ytHandle = norm(yt.handle);

  // Instagram goes to research.clientHandle (the one that gates Stage A).
  // Never overwrite a handle the producer has manually set.
  await fbPatch(`/preproduction/socialOrganic/${projectId}/research`, {
    ...(project.research?.clientHandle ? {} : { clientHandle: igHandle }),
    handleSuggestion: {
      instagram: { handle: igHandle, confidence: ig.confidence || "low", reason: ig.reason || "" },
      tiktok:    { handle: ttHandle, confidence: tt.confidence || "low", reason: tt.reason || "" },
      youtube:   { handle: ytHandle, confidence: yt.confidence || "low", reason: yt.reason || "" },
      suggestedAt: new Date().toISOString(),
    },
  });

  // TT + YT land under clientScrape.handles — same path handleStartProfileScrape
  // uses — so the ClientResearchStep inputs auto-populate. Strip the leading
  // @ first because the scrape API expects a bare handle.
  const handlesPatch = {};
  if (ttHandle) handlesPatch.tiktok  = ttHandle.replace(/^@/, "");
  if (ytHandle) handlesPatch.youtube = ytHandle.replace(/^@/, "");
  if (Object.keys(handlesPatch).length) {
    // Only write to platforms the producer hasn't already filled in.
    const existingHandles = project.clientScrape?.handles || {};
    const safePatch = {};
    if (handlesPatch.tiktok && !existingHandles.tiktok)   safePatch.tiktok  = handlesPatch.tiktok;
    if (handlesPatch.youtube && !existingHandles.youtube) safePatch.youtube = handlesPatch.youtube;
    if (Object.keys(safePatch).length) {
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/handles`, safePatch);
    }
  }

  return res.status(200).json({
    success: true,
    instagram: { handle: igHandle, confidence: ig.confidence, reason: ig.reason },
    tiktok:    { handle: ttHandle, confidence: tt.confidence, reason: tt.reason },
    youtube:   { handle: ytHandle, confidence: yt.confidence, reason: yt.reason },
  });
}

// Fire TikTok / YouTube profile scrapes for Tab 3. Producers supply handles
// here because Fathom/Attio don't reliably know them. Each triggers its own
// Apify actor; results land under clientScrape.profile.followers.{tiktok,youtube}
// via the same apify-webhook routing as the IG scrapes.
async function handleStartProfileScrape(req, res) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const { projectId, platform, handle } = req.body || {};
  if (!projectId || !platform || !handle) {
    return res.status(400).json({ error: "Missing projectId, platform, or handle" });
  }
  const cleanHandle = handle.replace(/^@+/, "").trim();

  let actorId, input, purpose;
  if (platform === "tiktok") {
    actorId = APIFY_TT_PROFILE_ACTOR;
    input = { profiles: [cleanHandle], resultsPerPage: 1, shouldDownloadVideos: false };
    purpose = "clientProfileTT";
  } else if (platform === "youtube") {
    actorId = APIFY_YT_CHANNEL_ACTOR;
    // streamers/youtube-channel-scraper takes startUrls with method.
    const url = /^https?:\/\//.test(handle)
      ? handle
      : `https://www.youtube.com/@${cleanHandle}`;
    input = { startUrls: [{ url, method: "GET" }], maxResults: 1 };
    purpose = "clientProfileYT";
  } else {
    return res.status(400).json({ error: "platform must be 'tiktok' or 'youtube'" });
  }

  try {
    const runId = await startApifyRun({
      actorId, input, token: APIFY_TOKEN,
      projectId, purpose,
      extraSidecar: { handle: cleanHandle },
    });
    // Also store the supplied handle on the project so the UI remembers it.
    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/handles`, {
      [platform]: cleanHandle,
    });
    return res.status(200).json({ success: true, runId });
  } catch (e) {
    return res.status(502).json({ error: "Failed to start Apify run", detail: e.message });
  }
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

// ═══════════════════════════════════════════════════════════════════
// TAB 6 — FORMAT SELECTION (Phase F)
// suggestFormats: Claude ranks the library against the project context,
// returns a recommended count + ranked format IDs. The UI pre-populates
// the right-panel selected list with the top N, producer refines.
// ═══════════════════════════════════════════════════════════════════
async function handleSuggestFormats(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const library = await fbGet("/formatLibrary");
  // Scope the suggestion to the organic half of the library — legacy
  // entries without a formatType default to organic. Meta Ads formats
  // never show up as suggestions for Social Organic projects.
  const libraryEntries = Object.values(library || {})
    .filter(f => f && f.id && !f.archived)
    .filter(f => (f.formatType || "organic") === "organic");
  if (libraryEntries.length === 0) {
    return res.status(200).json({ success: true, count: 0, formatIds: [], reason: "library_empty" });
  }

  // Sprinkle in shortlisted formats from this project (Phase 2 shortlist)
  // — Claude should strongly prefer those because they were hand-picked.
  const shortlistedIds = Object.values(project.shortlistedFormats || {})
    .map(s => s?.formatLibraryId).filter(Boolean);
  const shortlistedSet = new Set(shortlistedIds);

  const bt = project.brandTruth?.fields || {};
  const takeaways = project.clientResearch?.keyTakeaways || "";
  const numberOfVideos = project.numberOfVideos || null;

  // Suggested count: videos ÷ 5, rounded, floor 1 ceil 8. Producer can
  // override in the UI but this is a sensible anchor.
  const suggestedCount = numberOfVideos
    ? Math.min(8, Math.max(1, Math.round(numberOfVideos / 5)))
    : 4;

  const libraryBlock = libraryEntries.map(f => {
    const tags = (f.tags || []).join(", ");
    const inShortlist = shortlistedSet.has(f.id) ? " [SHORTLISTED THIS PROJECT]" : "";
    return `${f.id}: ${f.name}${inShortlist}
  Analysis: ${(f.videoAnalysis || "").slice(0, 200)}
  Tags: ${tags}`;
  }).join("\n\n");

  const systemPrompt = `You rank a video-format library against a specific client's preproduction context. Return JSON only — no markdown, no code fences.

STRUCTURE:
{
  "count": integer,            // 3-8 formats, anchored at videos÷5 unless context says otherwise
  "formatIds": ["fmt_...", ...],   // ranked best-first, length = count
  "reason": "one sentence on why this mix"
}

RULES:
- Only use format IDs from the library below. Do NOT invent new ones.
- Prefer formats flagged [SHORTLISTED THIS PROJECT] — those are producer-chosen.
- Match the client's tone + target viewer + platforms + pain points.
- Spread across different content styles (don't pick 5 talking-heads if the library has variety).`;

  const userMessage = `CLIENT: ${project.companyName}
VIDEOS THIS ROUND: ${numberOfVideos ?? "unknown"}
SUGGESTED COUNT ANCHOR: ~${suggestedCount}

BRAND TRUTHS: ${bt.brandTruths || "(none)"}
BRAND AMBITIONS: ${bt.brandAmbitions || "(none)"}
CLIENT GOALS: ${bt.clientGoals || "(none)"}
KEY CONSIDERATIONS: ${bt.keyConsiderations || "(none)"}
TARGET VIEWER: ${bt.targetViewerDemographic || "(none)"}
PAIN POINTS: ${bt.painPoints || "(none)"}
LANGUAGE: ${bt.language || "(none)"}

PRODUCER'S READ ON CLIENT'S EXISTING CONTENT: ${takeaways || "(none)"}

AVAILABLE FORMATS (library):
${libraryBlock}

Rank them. Return JSON.`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt, userMessage,
      maxTokens: 2000,
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

  // Filter to real IDs only (Claude sometimes invents), dedupe, trim to count.
  const validIds = new Set(libraryEntries.map(f => f.id));
  const cleanIds = (parsed.formatIds || []).filter(id => validIds.has(id));
  const dedupedIds = Array.from(new Set(cleanIds));
  const count = Math.max(1, Math.min(8, parseInt(parsed.count, 10) || suggestedCount));
  const formatIds = dedupedIds.slice(0, count);

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    suggestedFormatCount: count,
    suggestedFormatIds: formatIds,
    suggestedFormatReason: parsed.reason || "",
    suggestedFormatsAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({ success: true, count, formatIds, reason: parsed.reason || "" });
}

// ═══════════════════════════════════════════════════════════════════
// Recovery: poll Apify directly for in-flight runs and replay the
// webhook locally when any have finished. Covers webhook drops, Vercel
// cold-start misses, secret mismatches during env-var rotations, etc.
// Safe to call repeatedly — it's idempotent (sidecar deleted on success).
// ═══════════════════════════════════════════════════════════════════
// Wipe a stuck scrape bundle so the producer can re-approve. Used when the
// refresh fallback found no in-flight runs but status is still "running" —
// means the run never started at Apify in the first place (e.g. actor-input
// schema mismatch). Clears the relevant approval gate + scrape state so
// Stage A or Stage B goes back to "not approved".
async function handleResetScrape(req, res) {
  const { projectId, which } = req.body || {};
  if (!projectId || !which) return res.status(400).json({ error: "Missing projectId or which" });
  if (which !== "client" && which !== "competitor") return res.status(400).json({ error: "which must be 'client' or 'competitor'" });

  const sidecars = (await fbGet(`/preproduction/socialOrganic/_apifyRuns`)) || {};
  // Best-effort sidecar cleanup — orphans are only diagnostic but they
  // shouldn't persist once the producer has explicitly reset.
  const wantPurpose = which === "client"
    ? new Set(["clientPosts", "clientProfileIG", "clientProfileTT", "clientProfileYT"])
    : new Set(["competitorPosts"]);
  for (const [runId, meta] of Object.entries(sidecars)) {
    if (meta?.projectId === projectId && wantPurpose.has(meta?.purpose)) {
      await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
    }
  }

  const scrapeField = which === "client" ? "clientScrape" : "competitorScrape";
  const approvalKey = which === "client" ? "research_a" : "research_b";
  await fbSet(`/preproduction/socialOrganic/${projectId}/${scrapeField}`, null);
  await fbSet(`/preproduction/socialOrganic/${projectId}/approvals/${approvalKey}`, null);

  return res.status(200).json({ success: true });
}

async function handleRefreshScrapes(req, res) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  const SECRET = process.env.APIFY_WEBHOOK_SECRET;
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });
  if (!SECRET) return res.status(500).json({ error: "APIFY_WEBHOOK_SECRET not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const sidecars = (await fbGet(`/preproduction/socialOrganic/_apifyRuns`)) || {};
  const mine = Object.entries(sidecars).filter(([, meta]) => meta?.projectId === projectId);

  if (mine.length === 0) {
    // No runs exist but the status bundle might still say "running" —
    // that's the "run never actually started" failure mode. Roll both
    // bundles + approvals back so the producer can just re-approve.
    const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
    const recovered = [];
    if (project?.clientScrape?.status === "running") {
      await fbSet(`/preproduction/socialOrganic/${projectId}/clientScrape`, null);
      await fbSet(`/preproduction/socialOrganic/${projectId}/approvals/research_a`, null);
      recovered.push("clientScrape");
    }
    if (project?.competitorScrape?.status === "running") {
      await fbSet(`/preproduction/socialOrganic/${projectId}/competitorScrape`, null);
      await fbSet(`/preproduction/socialOrganic/${projectId}/approvals/research_b`, null);
      recovered.push("competitorScrape");
    }
    return res.status(200).json({
      success: true, checked: 0, recovered,
      note: recovered.length
        ? `Rolled back ${recovered.join(" + ")} — the Apify run never started. Retry to see the underlying error.`
        : "No in-flight runs for this project.",
    });
  }

  const results = [];

  for (const [runId, meta] of mine) {
    try {
      const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(APIFY_TOKEN)}`);
      if (!r.ok) {
        const errBody = await r.text();
        results.push({ runId, purpose: meta.purpose, outcome: "apify_error", httpStatus: r.status, detail: errBody.slice(0, 200), consoleUrl: `https://console.apify.com/actors/runs/${runId}` });
        continue;
      }
      const data = await r.json();
      const apifyStatus = data?.data?.status;
      const datasetId = data?.data?.defaultDatasetId;
      const startedAt = data?.data?.startedAt;
      const finishedAt = data?.data?.finishedAt;
      const exitCode = data?.data?.exitCode;
      const durationMs = startedAt && finishedAt ? (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) : null;

      if (apifyStatus === "SUCCEEDED" || apifyStatus === "FAILED" || apifyStatus === "ABORTED" || apifyStatus === "TIMED-OUT" || apifyStatus === "TIMED_OUT") {
        // Process the run in-process (no HTTP loopback). Previously we fetched
        // our own /api/apify-webhook which got blocked by Vercel Deployment
        // Protection — returning an "Authentication Required" HTML page.
        // Calling the helper directly bypasses all of that.
        let processResult;
        let processError = null;
        try {
          processResult = await processApifyRun({
            runId, status: apifyStatus, datasetId, apifyToken: APIFY_TOKEN,
          });
        } catch (e) {
          processError = e.message || String(e);
        }
        results.push({
          runId, purpose: meta.purpose,
          outcome: processError ? "replay_failed" : "replayed",
          apifyStatus, exitCode, durationMs,
          replayDetail: processError,
          processOutcome: processResult?.outcome,
          consoleUrl: `https://console.apify.com/actors/runs/${runId}`,
        });
      } else {
        results.push({
          runId, purpose: meta.purpose,
          outcome: "still_running",
          apifyStatus,
          startedAt,
          runningForSec: startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : null,
          consoleUrl: `https://console.apify.com/actors/runs/${runId}`,
        });
      }
    } catch (e) {
      results.push({ runId, purpose: meta.purpose, outcome: "error", error: e.message });
    }
  }

  return res.status(200).json({ success: true, checked: mine.length, results });
}

// ═══════════════════════════════════════════════════════════════════
// TAB 7 — PUSH TO DELIVERIES (Phase G)
// Mirrors the Meta Ads handoff in src/components/Preproduction.jsx:612-637
// but runs server-side so we can: (a) guard against duplicate pushes,
// (b) bundle all writes atomically, (c) include fields the client side
// doesn't have handy (e.g. client logo from the account record).
// ═══════════════════════════════════════════════════════════════════
// Push to Runsheets. Social Organic preproduction flows into a shooting
// runsheet (not the Deliveries tab — deliveries are for post-production
// handover, which happens after the shoot). Shape mirrors what the
// Runsheets UI's handleCreate writes: projectType "organic", one video
// slot per scriptTable row, an empty shoot-day the producer schedules
// against via drag-drop.
async function handlePushToRunsheet(req, res) {
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const scriptTable = project.preproductionDoc?.scriptTable || [];
  if (scriptTable.length === 0) {
    return res.status(400).json({ error: "No script rows — generate the scripts first" });
  }

  // Guard against duplicate pushes — the UI disables the button once
  // runsheetHandoff is set, but the server enforces it.
  if (project.runsheetHandoff?.runsheetId) {
    return res.status(409).json({ error: "Already pushed to Runsheets", runsheetId: project.runsheetHandoff.runsheetId });
  }

  const runsheetId = `rs-${Date.now()}`;
  const now = new Date().toISOString();

  // Map the Social Organic script rows onto the Runsheets video shape.
  // Organic runsheets don't use the Meta Ads columns (hook/explainThePain/
  // results/etc.) — we carry across formatName, the spoken hook, text/visual
  // hooks, script notes, and props. The other fields stay as empty strings
  // so the Runsheet UI doesn't crash on them.
  // Runsheet videos carry both a sequential video name ("Video 1") AND the
  // format type as separate fields, so the Runsheet UI can render both
  // in the unassigned pool + assigned-slot chips. Previously videoName
  // collapsed into formatName which lost the "which of the N videos is
  // this" identity producers need on set.
  const videos = scriptTable.map((row, i) => ({
    id: `v-${Date.now()}-${i}`,
    videoName: `Video ${i + 1}`,
    formatName: row.formatName || "",
    contentStyle: row.contentStyle || "",
    hook: row.hook || "",
    textHook: row.textHook || "",
    visualHook: row.visualHook || "",
    scriptNotes: row.scriptNotes || "",
    props: row.props || "",
    people: "",
    // Meta Ads columns kept empty so the Runsheets UI has consistent shape.
    explainThePain: "", results: "", theOffer: "", whyTheOffer: "",
    cta: "", metaAdHeadline: "", metaAdCopy: "",
    motivatorType: "", audienceType: "",
  }));

  // Default template: 5 time slots with sensible AU-production timings,
  // middle slot is a lunch break. Producers tweak / extend on the day;
  // this just gets them past the "what do I put here" blank state.
  const tsBase = Date.now();
  const shootDays = [{
    id: `sd-${tsBase}-0`,
    label: "Shoot 1",
    date: "",
    location: "",
    startTime: "09:00",
    endTime: "16:00",
    timeSlots: [
      { id: `ts-${tsBase}-0`, startTime: "09:00", endTime: "10:30", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      { id: `ts-${tsBase}-1`, startTime: "10:30", endTime: "12:00", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      { id: `ts-${tsBase}-2`, startTime: "12:00", endTime: "13:00", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "Lunch", isBreak: true },
      { id: `ts-${tsBase}-3`, startTime: "13:00", endTime: "14:30", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      { id: `ts-${tsBase}-4`, startTime: "14:30", endTime: "16:00", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
    ],
  }];

  const runsheet = {
    id: runsheetId,
    projectId,
    projectType: "organic",
    companyName: project.companyName || "",
    status: "draft",
    producerId: "",
    directorId: "",
    clientContacts: [],
    shootDays,
    videos,
    createdAt: now,
    updatedAt: now,
    sourceType: "socialOrganic",
    sourceProjectId: projectId,
  };

  await fbSet(`/runsheets/${runsheetId}`, runsheet);
  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    runsheetHandoff: { runsheetId, pushedAt: now },
    status: "exported",
    tab: "done",
    updatedAt: now,
  });
  await fbSet(`/preproduction/socialOrganic/${projectId}/approvals/script`, now);

  return res.status(200).json({ success: true, runsheetId, videoCount: videos.length });
}

// ═══════════════════════════════════════════════════════════════════
// FORMAT LIBRARY — Opus-powered seed import
// Takes raw text from the Seed Importer modal, asks Claude Opus to
// extract structured format entries, returns them for preview. The
// frontend commits to /formatLibrary on user approval (same path the
// heuristic parser uses, so nothing downstream changes).
// ═══════════════════════════════════════════════════════════════════
async function handleSmartParseFormats(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { rawText } = req.body || {};
  if (!rawText || rawText.trim().length < 20) {
    return res.status(400).json({ error: "Paste the raw format text first (min 20 chars)" });
  }

  const systemPrompt = `You structure social video format documentation for Viewix's format library. The producer has pasted raw text from a Google Doc / Notion / Word doc describing many formats. Extract each one into a JSON object.

RULES:
- Return a JSON array, one object per distinct format. No markdown, no preamble, no code fences.
- Each format has these fields (every field required, empty string if unknown):
  - "name": the format's title, exactly as written.
  - "videoAnalysis": the "why it works" / "what is it" breakdown. Use the doc's existing prose verbatim where possible.
  - "filmingInstructions": how the crew shoots it (camera setup, clothing cues, lighting, location). Pull from "Filming:" sections if present.
  - "structureInstructions": hook → beats → close. Pull from "Structure:" sections if present.
  - "examples": array of URLs referenced for this format (instagram.com, tiktok.com, youtube.com). Strip query strings where reasonable but keep the post path.
  - "tags": 2-5 short lowercase tags you infer from the format (no #, no spaces ideally, use hyphens).
- If a format's description has sections labelled "Filming:" and "Structure:", split them. If it's a single prose block, put it in videoAnalysis and leave filmingInstructions / structureInstructions empty.
- Preserve the doc's voice — don't paraphrase away specifics.
- Never use em dashes. Use commas or full stops.`;

  const userMessage = `RAW DOC:
"""
${rawText.slice(0, 40000)}
"""

Return the JSON array now.`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt, userMessage,
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

  if (!Array.isArray(parsed)) {
    return res.status(422).json({ error: "Expected an array", rawPreview: JSON.stringify(parsed).slice(0, 500) });
  }

  // Normalise — guarantee every field exists and is the right shape so the
  // UI preview doesn't have to defensively handle missing fields.
  const normalised = parsed.map(f => ({
    name: (f.name || "").toString().trim(),
    videoAnalysis: (f.videoAnalysis || "").toString().trim(),
    filmingInstructions: (f.filmingInstructions || "").toString().trim(),
    structureInstructions: (f.structureInstructions || "").toString().trim(),
    examples: Array.isArray(f.examples)
      ? f.examples.map(e => (typeof e === "string" ? { url: e.trim() } : { url: (e?.url || "").toString().trim() })).filter(e => e.url)
      : [],
    tags: Array.isArray(f.tags) ? f.tags.map(t => (t || "").toString().trim()).filter(Boolean) : [],
  })).filter(f => f.name);

  return res.status(200).json({ success: true, formats: normalised });
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
      case "rewriteScriptRow":
        return await handleRewriteScriptRow(req, res);
      case "generateFormatIdeas":
        return await handleGenerateFormatIdeas(req, res);
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
      case "startProfileScrape":
        return await handleStartProfileScrape(req, res);
      case "suggestClientHandle":
        return await handleSuggestClientHandle(req, res);
      case "suggestFormats":
        return await handleSuggestFormats(req, res);
      case "pushToRunsheet":
      case "pushToDeliveries":  // legacy action name — kept so in-flight callers don't 400
        return await handlePushToRunsheet(req, res);
      case "smartParseFormats":
        return await handleSmartParseFormats(req, res);
      case "refreshScrapes":
        return await handleRefreshScrapes(req, res);
      case "resetScrape":
        return await handleResetScrape(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`social-organic ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
