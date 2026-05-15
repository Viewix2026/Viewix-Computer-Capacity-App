// api/_analyticsAi.js — Claude wrappers for the Analytics tab.
//
// Phase 7 ships:
//   classifyFormatWithClaude(post) — replaces the v0 heuristic with
//                                    caption + metadata classification
//   nicheTakeForCompetitorPost(post) — 2-sentence "why this worked +
//                                      how to apply"
//   nichePulse(competitorPosts) — max 2 dot-points naming the
//                                 patterns competitors are riding
//
// Cost discipline (per the plan's locked decision #17):
//   - Every classifier defaults to caption + post metadata only.
//   - Thumbnail vision is reserved for (a) low-confidence caption
//     results, (b) the top 10% of overperformers. Phase 7 ships
//     the caption-only path; thumbnail fallback is a flag we can
//     light up after the pilot if accuracy needs it.
//   - Aggressive cache by post-content hash. Re-runs ONLY when the
//     post text changes. Cache lives at /analytics/_aiCache/{kind}/{hash}.
//
// Feature flag: ANALYTICS_CLAUDE_ENABLED env var. When unset or
// "false", recomputeClientAnalytics falls back to the Phase 6
// heuristic classifier and skips the niche takes / pulse entirely.
// This lets the pilot start (with the heuristic) before Claude
// calibration is done — same data shape either way.
//
// All functions are pure async — they own the Claude HTTP call and
// the cache read/write but no other side effects.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";
import { createHash } from "node:crypto";
import { fetchWithTimeout, TIMEOUTS } from "./_http.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// Same model the rest of the codebase already uses. Sonnet for
// quality; classification volume is low enough that the per-call
// cost is dominated by writes + thinking time, not the model tier.
const MODEL_CLASSIFY = "claude-sonnet-4-6";
const MODEL_TAKES    = "claude-sonnet-4-6";

// Allow disabling Claude wholesale without removing the wiring.
// Useful for pre-pilot, calibration, or budget freezes.
//
// Default is EXPLICIT-OPT-IN: a missing ANTHROPIC_API_KEY OR a
// missing/false ANALYTICS_CLAUDE_ENABLED both fall back to the
// Phase 6 heuristic. Set ANALYTICS_CLAUDE_ENABLED="true"
// (case-insensitive) once you've hand-reviewed ~50 classifications
// and are happy with accuracy.
//
// Safer than defaulting to "on" — prevents a forgotten env var from
// quietly enabling Claude classifications + niche takes before
// they've been calibrated.
export function isClaudeEnabled() {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  const flag = (process.env.ANALYTICS_CLAUDE_ENABLED || "false").toLowerCase();
  return flag === "true" || flag === "1";
}

// ─── fb helpers (admin-or-REST, same shape as elsewhere) ──────────

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

// ─── Claude HTTP wrapper ───────────────────────────────────────────

async function callClaude({ model, systemPrompt, userMessage, maxTokens = 600 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const resp = await fetchWithTimeout(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // ephemeral cache on the system prompt — Anthropic prompt
      // caching kicks in for repeat calls with the same system text.
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    }),
  }, TIMEOUTS.anthropic);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || "";
}

function parseJSON(raw) {
  let cleaned = (raw || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  }
  try { return JSON.parse(cleaned); } catch { return null; }
}

function hashOf(s) {
  return createHash("sha1").update(String(s || "")).digest("hex").slice(0, 16);
}

// ─── Format classifier (Phase 7) ──────────────────────────────────

const FORMAT_KEYS = [
  "founder_talking_head", "client_proof", "behind_the_scenes",
  "transformation", "educational_explainer", "objection_handling",
  "trend_based", "product_service_demo", "hiring_team_culture",
  "event_activation", "other",
];

const FORMAT_SYSTEM_PROMPT = `You are a content classifier for a video production agency.
You are given a single Instagram post's caption and metadata.
Output a JSON object with two fields:
{
  "format": one of [${FORMAT_KEYS.map(k => `"${k}"`).join(", ")}],
  "confidence": "high" | "med" | "low"
}

Definitions:
- founder_talking_head: the founder/owner addressing camera (first-person).
- client_proof: testimonial, review, client win story.
- behind_the_scenes: process, day-in-the-life, how content is made.
- transformation: before/after, results-style outcome content.
- educational_explainer: tutorial, how-to, tips, guide content.
- objection_handling: addressing a common doubt or myth.
- trend_based: riding a trending sound or format.
- product_service_demo: showing a specific product or service.
- hiring_team_culture: hiring, team culture, recruitment.
- event_activation: event recap, conference, launch.
- other: doesn't fit cleanly.

Return ONLY the JSON object. No prose, no markdown.`;

/**
 * classifyFormatWithClaude(post) → { format, formatConfidence, source: "claude" }
 *
 * Caches by hash(caption) — the only input. If the same caption
 * shows up across re-runs (which it usually does for the same post),
 * we hit cache and don't pay for the call again.
 */
export async function classifyFormatWithClaude(post) {
  if (!isClaudeEnabled()) {
    throw new Error("Claude not enabled — caller should fall back to heuristic");
  }
  const caption = (post?.caption || "").trim();
  const cacheKey = hashOf(caption);
  const cachePath = `/analytics/_aiCache/format/${cacheKey}`;

  const cached = await fbGet(cachePath);
  if (cached && cached.format && cached.formatConfidence) {
    return { ...cached, source: "claude", cacheHit: true };
  }

  const userMessage = caption
    ? `Caption:\n${caption.slice(0, 1500)}\n\nClassify this post.`
    : "Caption: (empty)\n\nClassify this post.";

  const raw = await callClaude({
    model: MODEL_CLASSIFY,
    systemPrompt: FORMAT_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 80,
  });
  const parsed = parseJSON(raw);
  let format = parsed?.format;
  let confidence = parsed?.confidence;
  if (!FORMAT_KEYS.includes(format)) format = "other";
  if (!["high", "med", "low"].includes(confidence)) confidence = "low";

  const result = {
    format,
    formatConfidence: confidence,
    source: "claude",
    claudeReason: "Sonnet caption-only classifier",
    classifiedAt: new Date().toISOString(),
  };
  // Cache the bare values — we strip source/cacheHit on read.
  await fbSet(cachePath, {
    format: result.format,
    formatConfidence: result.formatConfidence,
    claudeReason: result.claudeReason,
    classifiedAt: result.classifiedAt,
  });
  return result;
}

// ─── Niche takes ──────────────────────────────────────────────────

const NICHE_TAKE_SYSTEM_PROMPT = `You are a content strategy advisor for a video production agency.
You're given a single competitor post that's performing well.
In TWO short sentences, write:
1. Why this post is working (be specific — hook style, format choice, audience appeal).
2. How a different account in the same niche could apply the same idea.

Be direct. No filler. Don't praise the post; analyse it. Output PLAIN TEXT, no JSON, no markdown.`;

/**
 * nicheTakeForCompetitorPost(post) → { take, generatedAt }
 *
 * Caches by hash(caption + handle). Re-runs only when post content
 * or handle changes.
 */
export async function nicheTakeForCompetitorPost(post, handle) {
  if (!isClaudeEnabled()) {
    throw new Error("Claude not enabled");
  }
  const caption = (post?.caption || "").trim();
  const cacheKey = hashOf(`${handle}:${caption}`);
  const cachePath = `/analytics/_aiCache/nicheTake/${cacheKey}`;
  const cached = await fbGet(cachePath);
  if (cached?.take) return { take: cached.take, generatedAt: cached.generatedAt, cacheHit: true };

  const userMessage = `Competitor: ${handle}\nCaption:\n${caption.slice(0, 1500)}`;
  const raw = await callClaude({
    model: MODEL_TAKES,
    systemPrompt: NICHE_TAKE_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 200,
  });
  const take = (raw || "").trim();
  const generatedAt = new Date().toISOString();
  if (take) await fbSet(cachePath, { take, generatedAt });
  return { take, generatedAt };
}

// ─── Weekly Summary (Phase 8 stretch) ─────────────────────────────

const WEEKLY_SUMMARY_SYSTEM_PROMPT = `You are a content strategy advisor for a video production agency.
You are given a structured snapshot of a single client's analytics for the past week.
In ONE short paragraph (3–4 sentences max) write:
- What worked / what didn't this week. Quote ONE concrete number from the snapshot.
- One concrete recommendation for next week — match what the data supports.

Be direct. No filler. No second-person ("you should…") — write as an internal advisor reading the data, e.g. "the founder talking-head posts pulled 1.8x median, while explainers underperformed; lean into talking-head format next week, hold off on explainers."

Output PLAIN TEXT, no markdown, no JSON, no headings.`;

/**
 * weeklySummary(snapshot) → { paragraph, generatedAt }
 *
 * Caller assembles a structured snapshot of the week's state
 * (status + momentum + winning videos + decay alerts + top recs).
 * Caches by hash(JSON.stringify(snapshot)) so re-runs on the same
 * data hit the cache.
 */
export async function weeklySummary(snapshot) {
  if (!isClaudeEnabled()) throw new Error("Claude not enabled");
  const cacheKey = hashOf(JSON.stringify(snapshot));
  const cachePath = `/analytics/_aiCache/weeklySummary/${cacheKey}`;
  const cached = await fbGet(cachePath);
  if (cached?.paragraph) {
    return { paragraph: cached.paragraph, generatedAt: cached.generatedAt, cacheHit: true };
  }
  const userMessage = `Snapshot:\n${JSON.stringify(snapshot, null, 2)}`;
  const raw = await callClaude({
    model: MODEL_TAKES,
    systemPrompt: WEEKLY_SUMMARY_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 280,
  });
  const paragraph = (raw || "").trim();
  const generatedAt = new Date().toISOString();
  if (paragraph) await fbSet(cachePath, { paragraph, generatedAt });
  return { paragraph, generatedAt };
}

// ─── Niche pulse ──────────────────────────────────────────────────

const NICHE_PULSE_SYSTEM_PROMPT = `You are a content strategy advisor for a video production agency.
You're given a batch of recent posts from a client's competitor cohort.
Identify the 1–2 most clear patterns across the batch and output them as bullet points.

Rules:
- MAX 2 dot-points.
- Each dot-point is one short sentence. Be specific (name the format or topic).
- Don't list more than 2. If only one strong pattern, return one.
- If nothing is clear, return an empty array.

Output JSON: { "pulse": ["...", "..."] }
Nothing else. No prose, no markdown.`;

/**
 * nichePulse(competitorPosts) → { pulse: string[], generatedAt }
 *
 * Caches by hash of the concatenated captions (sorted for stability).
 * Re-runs only when the batch changes.
 */
export async function nichePulse(competitorPosts) {
  if (!isClaudeEnabled()) {
    throw new Error("Claude not enabled");
  }
  const captions = (competitorPosts || [])
    .map(p => (p?.caption || "").trim())
    .filter(Boolean)
    .sort();
  if (captions.length === 0) {
    return { pulse: [], generatedAt: new Date().toISOString() };
  }
  const cacheKey = hashOf(captions.join("\n"));
  const cachePath = `/analytics/_aiCache/nichePulse/${cacheKey}`;
  const cached = await fbGet(cachePath);
  if (cached?.pulse) return { pulse: cached.pulse, generatedAt: cached.generatedAt, cacheHit: true };

  const userMessage = captions.slice(0, 30).map((c, i) => `[${i + 1}] ${c.slice(0, 400)}`).join("\n\n");
  const raw = await callClaude({
    model: MODEL_TAKES,
    systemPrompt: NICHE_PULSE_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 200,
  });
  const parsed = parseJSON(raw);
  const pulse = Array.isArray(parsed?.pulse) ? parsed.pulse.slice(0, 2).map(s => String(s).trim()).filter(Boolean) : [];
  const generatedAt = new Date().toISOString();
  await fbSet(cachePath, { pulse, generatedAt });
  return { pulse, generatedAt };
}
