// api/_transcript-insights.js
// Shared lib: mines recurring Objections / Pain Points / Content Ideas
// out of a sales-call transcript and merges them into the weighted
// /transcriptInsights knowledge base (semantic dedup against the current
// canonical list). Called inline after runMeetingFeedbackAnalysis() and
// by the self-heal cron.
//
// This is a DEDICATED second Claude pass, deliberately NOT folded into the
// grader: the grader prompt is heavily tuned with a strict output contract,
// and the extractor reads the RAW transcript (the coaching analysis filters
// out raw objections/pain that didn't move the scorecard). Quotes are
// verbatim transcript spans, never summary paraphrases.

import { adminGet, adminSet, runRtdbTransaction } from "./_fb-admin.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// Self-contained — copied (not imported) from api/meeting-feedback.js to
// avoid a circular import and to keep this pass independent of the grader.
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
      max_tokens: 4000,
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
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleaned);
}

// ─── Severity ────────────────────────────────────────────────────────
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
const RANK_SEVERITY = { 1: "low", 2: "medium", 3: "high" };

function validSeverity(s) {
  return SEVERITY_RANK[s] ? s : "medium";
}

// Deterministic escalation — NOT the model's whim. Only raise when the
// extractor explicitly returns a higher reading, and at most one level
// per source. Never downgrade.
function escalate(cur, incoming) {
  const c = SEVERITY_RANK[validSeverity(cur)];
  const i = SEVERITY_RANK[validSeverity(incoming)];
  if (i > c) return RANK_SEVERITY[Math.min(i, c + 1)];
  return validSeverity(cur);
}

// Founder-merge severity combine: take the higher of the two (no +1 cap —
// a manual merge is an explicit human decision, not an auto-recurrence).
export function maxSeverity(a, b) {
  return SEVERITY_RANK[validSeverity(a)] >= SEVERITY_RANK[validSeverity(b)]
    ? validSeverity(a) : validSeverity(b);
}

export const SEVERITY_MULTIPLIER = { low: 1, medium: 3, high: 6 };

// ─── Helpers ─────────────────────────────────────────────────────────
const TYPES = ["objection", "painPoint", "contentIdea"];

function normalizeTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Token budget: the raw transcript is the primary input. Cap it, and if
// it's longer keep start 45% + middle 25% + end 30% — objections cluster
// in the open, the negotiation middle, and the close; tail chatter is the
// safe thing to drop. ~24k chars ≈ ~6k tokens (tunable).
function trimTranscript(t, cap = 24000) {
  const s = String(t || "");
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.45);
  const mid = Math.floor(cap * 0.25);
  const tail = cap - head - mid;
  const midStart = Math.floor(s.length / 2 - mid / 2);
  return (
    s.slice(0, head) +
    "\n\n[…trimmed…]\n\n" +
    s.slice(midStart, midStart + mid) +
    "\n\n[…trimmed…]\n\n" +
    s.slice(s.length - tail)
  );
}

export const EXTRACTION_SYSTEM_PROMPT = `You maintain a deduplicated, weighted knowledge base of sales-call insights that closers study to improve. You receive ONE sales call's transcript plus the current canonical list of insights already in the knowledge base. Your job: decide which insights in this call are genuinely NEW versus restatements of ones already on the list, and assign each a severity.

TAXONOMY — every insight is exactly one of:
- "objection": a reason or hesitation the prospect raised for NOT buying / not moving forward (price, timing, trust, "need to think", "talk to my partner", competitor, scope doubt, etc.).
- "painPoint": the prospect's underlying problem or its cost — what's actually hurting them or what bad outcome they're trying to avoid. The thing the product would relieve.
- "contentIdea": a topic, angle, question, or objection-handling moment that would make strong marketing/sales content for the seller (Viewix, a video production agency). Often a recurring question or a story that landed.

MATCHING RULES:
- Match on MEANING, not wording. "Too expensive", "can't justify the spend right now", "budget's tight this quarter" are the SAME objection.
- If a call's insight clearly restates one already on the canonical list, return it as an INCREMENT against that exact id — never create a near-duplicate.
- When genuinely unsure whether it matches an existing item, prefer creating a NEW item. A wrong merge is harder to undo than a near-duplicate.
- Generalise titles — strip the specific client's name and one-off specifics so the item is reusable ("Wants to see ROI proof before committing", not "Acme's CFO wants Q3 numbers").

SEVERITY (how deal-threatening / how strongly felt, as expressed IN THIS CALL):
- "high": deal-killing or near-deal-killing if unhandled; expressed firmly or repeatedly.
- "medium": real friction that slows the deal but is workable.
- "low": minor, raised in passing, or easily handled.

QUOTE: every insight MUST include a "quote" that is a VERBATIM span copied from the transcript (the closest single sentence/phrase that evidences it). Do not paraphrase, summarise, or invent. Keep it short.

LIMITS: at most 8 insights total across increments + new. Only surface insights that are actually useful to a closer — skip filler.

OUTPUT: STRICT JSON only, no markdown fences, no commentary. Exactly this shape:
{
  "increments": [ { "id": "<existing canonical id>", "quote": "<verbatim transcript span>", "severity": "low|medium|high" } ],
  "new": [ { "type": "objection|painPoint|contentIdea", "title": "<<=80 char canonical label>", "description": "<1-3 sentences: what it is + how a closer should handle/use it>", "quote": "<verbatim transcript span>", "severity": "low|medium|high" } ]
}
An empty result is valid and expected for low-signal calls: {"increments":[],"new":[]}.`;

// ─── Main ────────────────────────────────────────────────────────────
// Returns { added, incremented, skipped:false } on success, or
// { skipped:true } if the record was already processed (idempotent — no
// force path in v1). Throws on Claude/parse/admin failure so the caller
// can treat it non-fatally (marker is NOT written → self-heal retries).
export async function extractAndMergeInsights({
  feedbackId, transcript, analysisSummary,
  salesperson, clientName, meetingType, apiKey,
}) {
  if (!feedbackId || !transcript || !apiKey) {
    throw new Error("extractAndMergeInsights: missing feedbackId/transcript/apiKey");
  }

  // 1. Idempotency gate — marker present means this record already
  //    contributed. v1 never reprocesses.
  const marker = await adminGet(`/meetingFeedback/${feedbackId}/insightsExtracted`);
  if (marker) return { skipped: true };

  // 2. Current canonical list (active only).
  const itemsMap = (await adminGet("/transcriptInsights/items")) || {};
  const activeEntries = Object.entries(itemsMap).filter(([, v]) => v && v.status === "active");

  // Compact list for the model: {id,type,title}. Cap to ~150 by
  // weight×severity then recency once it grows past ~40 (token budget).
  let listForModel = activeEntries.map(([id, v]) => ({ id, type: v.type, title: v.title }));
  if (activeEntries.length > 150) {
    listForModel = activeEntries
      .map(([id, v]) => ({
        id, type: v.type, title: v.title,
        _score: (v.weight || 0) * (SEVERITY_MULTIPLIER[validSeverity(v.severity)] || 1),
        _seen: v.lastSeenAt || "",
      }))
      .sort((a, b) => (b._score - a._score) || String(b._seen).localeCompare(String(a._seen)))
      .slice(0, 150)
      .map(({ id, type, title }) => ({ id, type, title }));
  }

  // 3. Build the user message and call Claude.
  const fullTranscript = String(transcript);
  const userMessage =
    `Call meta: salesperson=${salesperson || "Unknown"} | client=${clientName || "Unknown"} | type=${meetingType || "general"}\n` +
    (analysisSummary ? `Analysis summary (context only): ${String(analysisSummary).slice(0, 600)}\n` : "") +
    `\nTRANSCRIPT:\n${trimTranscript(fullTranscript)}\n\n` +
    `CURRENT CANONICAL LIST (active items — match against these):\n` +
    (listForModel.length ? JSON.stringify(listForModel) : "[] (empty — first call)");

  const raw = await callClaude(EXTRACTION_SYSTEM_PROMPT, userMessage, apiKey);
  const result = parseJSON(raw); // throws on malformed → caught upstream, marker NOT written

  const increments = Array.isArray(result.increments) ? result.increments : [];
  const created = Array.isArray(result.new) ? result.new : [];

  const now = new Date().toISOString();
  const recordingUrl =
    (await adminGet(`/meetingFeedback/${feedbackId}/recordingUrl`).catch(() => null)) || "";
  const mkSource = (quote) => ({
    feedbackId,
    clientName: clientName || "",
    salesperson: salesperson || "",
    quote: String(quote || "").slice(0, 300),
    at: now,
    recordingUrl,
  });

  const applied = [];
  let added = 0, incremented = 0, skipped = 0;

  // Active map kept in sync with creations this call so a model that
  // emitted two near-identical "new" items doesn't double-insert.
  const activeById = new Map(activeEntries.map(([id, v]) => [id, v]));

  const bump = async (itemId, incomingSeverity, quote) => {
    const res = await runRtdbTransaction(`/transcriptInsights/items/${itemId}`, (cur) => {
      if (!cur || cur.status !== "active") return undefined;
      return {
        ...cur,
        weight: (cur.weight || 0) + 1,
        lastSeenAt: now,
        severity: escalate(cur.severity, incomingSeverity),
        sources: [mkSource(quote), ...(Array.isArray(cur.sources) ? cur.sources : [])].slice(0, 20),
      };
    });
    if (res.committed) {
      applied.push({ itemId, type: "increment", delta: 1 });
      incremented++;
      if (res.snapshot) activeById.set(itemId, res.snapshot);
      return true;
    }
    skipped++;
    return false;
  };

  // 4a. Increments — only against ids the model was actually shown.
  for (const inc of increments) {
    const id = inc && typeof inc.id === "string" ? inc.id : null;
    if (!id || !activeById.has(id)) { skipped++; continue; }
    await bump(id, inc.severity, inc.quote);
  }

  // 4b. New — local near-dup backstop (model may miss a dup if the list
  //     was capped). Same type + normalized-title match → increment.
  for (const item of created) {
    if (!item || !TYPES.includes(item.type) || !item.title) { skipped++; continue; }
    const norm = normalizeTitle(item.title);
    let dupId = null;
    for (const [id, v] of activeById) {
      if (v && v.status === "active" && v.type === item.type && normalizeTitle(v.title) === norm) {
        dupId = id; break;
      }
    }
    if (dupId) { await bump(dupId, item.severity, item.quote); continue; }

    const itemId = `ci-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id: itemId,
      type: item.type,
      title: String(item.title).slice(0, 80),
      description: String(item.description || "").slice(0, 600),
      severity: validSeverity(item.severity),
      weight: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "active",
      sources: [mkSource(item.quote)],
    };
    await adminSet(`/transcriptInsights/items/${itemId}`, record);
    activeById.set(itemId, record);
    applied.push({ itemId, type: "create" });
    added++;
  }

  // 5. Marker — only after the full diff applied without throwing. No
  //    quotes here (they live on item.sources); just enough to reverse.
  await adminSet(`/meetingFeedback/${feedbackId}/insightsExtracted`, {
    version: 1,
    at: now,
    applied,
  });

  return { added, incremented, skipped };
}
