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
import crypto from "crypto";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const APIFY_ACTOR = "apidojo~instagram-scraper";  // pay-per-result, cheaper than apify/instagram-scraper
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
    stats[handle] = {
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
  const model = fast ? "claude-haiku-4-6" : "claude-sonnet-4-6";
  const batchSize = 10;
  const postById = Object.fromEntries(posts.map(p => [p.id, p]));
  const classified = [];
  const errors = [];

  for (let i = 0; i < unclassified.length; i += batchSize) {
    const batch = unclassified.slice(i, i + batchSize);
    try {
      let raw;
      if (fast) {
        // Caption-only — send a single text block with all batch posts inlined
        const userText = batch.map((p, j) =>
          `Post ${j + 1} (postId: ${p.id}) — handle ${p.handle}, views ${p.views ?? "n/a"}, engagement ${p.engagementRate}\nCaption: ${(p.caption || "(empty)").slice(0, 400)}`
        ).join("\n\n");
        raw = await callClaude({
          model, systemPrompt,
          userMessage: `Classify these Instagram posts. Return the JSON array in the same order.\n\n${userText}`,
          maxTokens: 4000, apiKey: ANTHROPIC_KEY,
        });
      } else {
        // Vision — multimodal content blocks with thumbnail URLs
        const userContent = buildClassifierUserMessage(batch);
        raw = await callClaudeMultimodal({
          model, systemPrompt, userContent, maxTokens: 4000, apiKey: ANTHROPIC_KEY,
        });
      }
      const parsed = parseJSON(raw);
      if (!Array.isArray(parsed)) throw new Error("Classifier returned non-array");
      parsed.forEach(c => {
        if (!c.postId || !postById[c.postId]) return;
        if (!FORMAT_BUCKETS.includes(c.format)) c.format = "other";
        postById[c.postId].format = c.format;
        postById[c.postId].formatConfidence = +(c.confidence || 0);
        postById[c.postId].formatEvidence = (c.evidence || "").slice(0, 200);
        postById[c.postId].hookType = HOOK_TYPES.includes(c.hookType) && c.hookType !== "null" ? c.hookType : null;
        classified.push(c.postId);
      });
    } catch (err) {
      errors.push({ batch: i / batchSize, error: err.message });
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
    model,
  });
}

// ─── Synthesis helpers (Slice 5) ───
function buildSynthesisSystemPrompt({ companyName, promptLearnings = [] }) {
  return `You are a senior creative strategist at Viewix, a video production agency. You have just been handed the output of a competitor research scrape for a client and you need to write the synthesis that our producer will read before (or during) the pre-production meeting.

The client is: ${companyName}

The synthesis MUST be markdown with these exact section headings, in this order:

# Synthesis for ${companyName}

## 1. Overperformance signals
3-6 bullets. For each, identify a concrete trait shared by posts that outperformed the handle's median (overperformanceScore >= 1.5). Reference post IDs inline as \`ig_XXXX\`. Be specific: "First 3 seconds hold on a close-up face" not "strong hooks".

## 2. Hook patterns
3-5 bullets. Each is a specific hook archetype that works in this niche. Examples:
- "Contrarian claim that inverts a category assumption"
- "Question that implies the viewer is doing something wrong"
Include 2-3 example post IDs per pattern.

## 3. Format recommendations
Rank 3-5 format buckets the client should produce, strongest ROI first. For each:
- Format name (e.g. talking_head, skit, tutorial)
- One-sentence rationale tied to what's working in this specific niche
- 3-5 reference post IDs

## 4. Visual motifs
Recurring visual/editing/pacing patterns across overperformers (lighting, shot types, cut cadence, text overlays, colour grading).

## 5. Caption & CTA patterns
What's working in the copy alongside the video — hook lines in captions, CTA phrasings, hashtag strategy.

## 6. What NOT to do
Patterns that underperform, feel saturated, or clash with ${companyName}'s likely positioning.

## 7. Five concrete video concepts for ${companyName}
Give the producer 5 ready-to-shoot concepts. For each:
- **Title** — short, punchy
- **Premise** — one sentence: what happens in the video
- **Format** — from the bucket list above
- **Reference post IDs** — 2-3 examples

After section 7, add a single HTML comment line with the same 5 concepts as parseable JSON for programmatic handoff:
<!-- CONCEPTS_JSON: [{"title":"...","premise":"...","format":"talking_head","refPostIds":["ig_x","ig_y"]}, ...] -->

RULES:
- No preamble before the heading. Start with "# Synthesis for..."
- Reference post IDs inline using the exact id string from the data (e.g. \`ig_CxyZ\`). The renderer turns these into clickable links.
- Be specific, evidence-based, and opinionated. Avoid generic agency-speak ("engagement", "authentic storytelling").
- Do not wrap the response in a code fence.
${promptLearnings.length ? `\nPROMPT LEARNINGS (apply these rules):\n${promptLearnings.map(l => "- " + l).join("\n")}\n` : ""}`;
}

function buildSynthesisUserMessage({ project }) {
  const posts = project.posts || [];
  const handleStats = project.handleStats || {};
  const transcript = project.inputs?.transcript?.text || null;

  // Sort posts by overperformance so Claude sees the winners first
  const sorted = [...posts]
    .filter(p => p.format)  // drop unclassified for cleaner synthesis
    .sort((a, b) => (b.overperformanceScore || 0) - (a.overperformanceScore || 0));

  const statsBlock = Object.entries(handleStats).map(([h, s]) =>
    `${h}: ${s.postCount} posts, avg views ${s.avgViews}, median views ${s.medianViews}`
  ).join("\n");

  const postsBlock = sorted.map(p => {
    return [
      `${p.id} · ${p.handle} · ${p.format}${p.hookType ? `/${p.hookType}` : ""} · views ${p.views ?? "n/a"} · over ${p.overperformanceScore ?? "n/a"}x · eng ${p.engagementRate}`,
      `  Caption: ${(p.caption || "").slice(0, 500).replace(/\n+/g, " ")}`,
      p.formatEvidence ? `  Evidence: ${p.formatEvidence}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return `Classified competitor posts for ${project.companyName}:

HANDLE STATS:
${statsBlock || "(none)"}

POSTS (sorted by overperformance):
${postsBlock || "(none)"}

${transcript ? `\nPRE-PRODUCTION MEETING TRANSCRIPT (use to tailor recommendations to what the client actually wants):\n${transcript.slice(0, 8000)}\n` : ""}
Write the synthesis.`;
}

// ─── Action: synthesise ───
// Body: { projectId, regenerateNotes? }
async function handleSynthesise(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, regenerateNotes } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const posts = Array.isArray(project.posts) ? project.posts : [];
  if (!posts.length) return res.status(400).json({ error: "No posts to synthesise. Run scrape first." });

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    status: "synthesising",
    updatedAt: new Date().toISOString(),
  });

  // Pull any accumulated prompt learnings for this feature
  const learningsData = await fbGet("/preproduction/socialOrganicLearnings");
  const promptLearnings = learningsData
    ? Object.values(learningsData).filter(l => l && l.active && l.rule).map(l => l.rule)
    : [];

  const systemPrompt = buildSynthesisSystemPrompt({ companyName: project.companyName, promptLearnings });
  let userMessage = buildSynthesisUserMessage({ project });
  if (regenerateNotes) {
    userMessage = `The producer is regenerating this synthesis with extra instructions:\n\n"""${regenerateNotes.slice(0, 2000)}"""\n\nUse those instructions alongside the data below.\n\n${userMessage}`;
  }

  const markdown = await callClaude({
    model: "claude-opus-4-6",
    systemPrompt,
    userMessage,
    maxTokens: 8000,
    apiKey: ANTHROPIC_KEY,
  });

  // Parse the CONCEPTS_JSON sidecar — best effort, not a hard failure
  let concepts = [];
  const conceptsMatch = markdown.match(/<!--\s*CONCEPTS_JSON:\s*(\[[\s\S]*?\])\s*-->/);
  if (conceptsMatch) {
    try {
      const parsed = JSON.parse(conceptsMatch[1]);
      if (Array.isArray(parsed)) concepts = parsed;
    } catch (e) {
      console.warn("Failed to parse CONCEPTS_JSON sidecar:", e.message);
    }
  }

  // Extract topOverperformers from the post list directly (cheaper than asking Claude)
  const topOverperformers = [...posts]
    .filter(p => p.overperformanceScore != null)
    .sort((a, b) => b.overperformanceScore - a.overperformanceScore)
    .slice(0, 10)
    .map(p => p.id);

  const synthesis = {
    markdown,
    concepts,
    topOverperformers,
    generatedAt: new Date().toISOString(),
    modelUsed: "claude-opus-4-6",
    regenerateNotes: regenerateNotes || null,
  };

  await fbPatch(`/preproduction/socialOrganic/${projectId}`, {
    synthesis,
    status: "review",
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({ success: true, synthesis });
}

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
      case "synthesise":
        return await handleSynthesise(req, res);
      // Other actions are stubbed until their respective slices land
      case "extractFromTranscript":
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
