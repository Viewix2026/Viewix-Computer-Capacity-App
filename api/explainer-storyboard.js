// api/explainer-storyboard.js
// Vercel Serverless Function: Explainer Storyboard Generator (Editors toolkit).
//
// Stage 1 of the Vox-style explainer pipeline (see
// docs/plans/vox-explainer-remotion-scope-packet.md): the video's own words —
// "your script acts as the timeline… each beat maps to a visual." An editor
// describes a topic (and optionally pastes a rough script); Claude returns a
// STRUCTURED storyboard: a locked visual system + one scene per narration beat,
// each with the voiceover line, the foreground/midground assets, and an
// image-generation prompt for each. That table is the artifact a later Remotion
// build consumes — this feature just produces it, quickly and editably.
//
// Deliberately NOT the motion-graphics feature: the output here is plain data
// (JSON), never model-authored HTML, so there is no untrusted-render surface —
// no iframe, no CSP, no injectGuard. The trust boundary is `normalizeStoryboard`,
// which coerces Claude's JSON into a bounded, well-typed shape and drops anything
// unexpected.
//
// Actions (POST body { action }):
//   generate — topic (+ optional script/notes) -> Sonnet -> storyboard + usage +
//              per-generation cost. Writes a cost ledger at /aiUsage/storyboards/*.
//   save     — persist a generation to the shared library (server-stamped creator
//              + authoritative cost looked up by generationId).
//   archive  — soft-delete a library item.
//
// Security model mirrors motion-graphics' proven shape:
//   · requireRole(GENERATE_ROLES) + a fresh RTDB role/active re-check every action
//     (the token's role claim lags a demotion by up to ~1h).
//   · Library writes are server-only (RTDB rule write:false); cost is read from
//     the ledger, never trusted from the client.
//   · An atomic daily-count transaction is the runaway-loop circuit breaker.

import { adminGet, adminPatch, getAdmin, runRtdbTransaction } from "./_fb-admin.js";
import { actorFrom, handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { normalizeRole } from "./_roles.js";
import {
  MODEL, PRICE, LIMITS, TONES,
  clampStr, normalizeStoryboard, buildSystemPrompt, computeCost,
  genId, validId,
} from "./_explainerStoryboard.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// Roles allowed to spend AI money — same set as motion-graphics (trial excluded;
// closer is sales, no Editors tab). Mapped through _roles.js normalizeRole.
const GENERATE_ROLES = ["founders", "manager", "lead", "editor"];

// ─── Firebase helpers (admin SDK; server-only-write nodes need admin) ──────────
async function fbGet(path) { return adminGet(path); }
async function fbPatchMulti(path, updates) { return adminPatch(path, updates); }

// Resilient ledger write: one idempotent retry (same deterministic id → no
// duplicate), then log so the spend is recoverable from Vercel logs. Never
// throws — a ledger blip must not discard a generation Anthropic already billed.
async function writeLedgerSafe(id, payload) {
  try {
    await fbPatchMulti(`/aiUsage/storyboards/${id}`, payload);
  } catch (e1) {
    try {
      await fbPatchMulti(`/aiUsage/storyboards/${id}`, payload);
    } catch (e2) {
      console.error("explainer-storyboard ledger write failed (spend recoverable from this log):", id, JSON.stringify(payload), e2);
    }
  }
}

// ─── Claude call (raw fetch; no SDK in this repo) ─────────────────────────────
const CLAUDE_TIMEOUT_MS = 150_000;

async function callClaude(systemPrompt, userText, apiKey, opts = {}) {
  const payload = JSON.stringify({
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens || 8000,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  });
  const overallDeadline = Date.now() + 150_000;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = overallDeadline - Date.now();
    if (remaining < 3000) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(CLAUDE_TIMEOUT_MS, remaining));
    try {
      let resp;
      try {
        resp = await fetch(ANTHROPIC_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: payload,
          signal: controller.signal,
        });
      } catch (e) {
        if (e.name === "AbortError") throw Object.assign(new Error("timed out"), { kind: "timeout" });
        lastErr = Object.assign(new Error("network error"), { kind: "overloaded" });
        if (attempt === 0 && overallDeadline - Date.now() > 5000) { await new Promise(r => setTimeout(r, 1500)); continue; }
        throw lastErr;
      }
      if (resp.ok) {
        let data;
        try { data = await resp.json(); }
        catch (e) {
          if (e.name === "AbortError") throw Object.assign(new Error("timed out"), { kind: "timeout" });
          throw Object.assign(new Error("bad response from model"), { kind: "api" });
        }
        return { text: data.content?.[0]?.text || "", usage: data.usage || {}, stopReason: data.stop_reason || null };
      }
      const status = resp.status;
      let bodyText = ""; try { bodyText = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
      const transient = status === 429 || status === 529 || status >= 500;
      lastErr = Object.assign(new Error(`Anthropic ${status}: ${bodyText}`), { kind: status === 429 ? "ratelimit" : transient ? "overloaded" : "api" });
      if (transient && attempt === 0 && overallDeadline - Date.now() > 5000) { await new Promise(r => setTimeout(r, 1500)); continue; }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || Object.assign(new Error("Generation failed"), { kind: "api" });
}

function claudeErrorResponse(res, e, label) {
  console.error(`explainer-storyboard ${label} failed:`, e.kind, e.message);
  if (e.kind === "timeout") return res.status(504).json({ error: "That took too long — try again with a shorter script." });
  if (e.kind === "ratelimit") return res.status(429).json({ error: "Too many generations right now — wait a few seconds and try again." });
  if (e.kind === "overloaded") return res.status(503).json({ error: "The model is busy right now — try again in a moment." });
  return res.status(502).json({ error: "Generation failed — try again." });
}

// ─── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try { decoded = await requireRole(req, GENERATE_ROLES); }
  catch (e) { return sendAuthError(res, e); }
  req._actor = actorFrom(decoded);

  const { err: adminErr } = getAdmin();
  if (adminErr) return res.status(500).json({ error: "Server storage not configured" });

  // Fresh authority re-check for EVERY action — the role claim lags a demotion.
  try {
    const rec = await fbGet(`/users/${req._actor.uid}`);
    if (!rec || rec.active === false || !GENERATE_ROLES.includes(normalizeRole(rec.role))) {
      return res.status(403).json({ error: "Your account can't use the storyboard generator" });
    }
  } catch (e) {
    console.error("explainer-storyboard role check failed:", e);
    return res.status(500).json({ error: "Request failed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const action = body.action;

  try {
    if (action === "generate") return await handleGenerate(req, res, body);
    if (action === "save") return await handleSave(req, res, body);
    if (action === "archive") return await handleArchive(req, res, body);
    return res.status(400).json({ error: `Unknown action: ${action || "(none)"}` });
  } catch (e) {
    console.error("explainer-storyboard error:", e);
    const msg = action === "generate" ? "Generation failed" : action === "save" ? "Save failed" : "Request failed";
    return res.status(500).json({ error: msg });
  }
}

async function handleGenerate(req, res, body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Generation is not configured" });

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const script = typeof body.script === "string" ? body.script.trim() : "";
  const refineInstruction = typeof body.refineInstruction === "string" ? body.refineInstruction.trim() : "";
  const previous = body.previous && typeof body.previous === "object" ? body.previous : null;
  const isRefine = !!(refineInstruction && previous);

  if (!isRefine && !topic && !script) {
    return res.status(400).json({ error: "Describe a topic (or paste a script) to storyboard." });
  }
  if (topic.length > LIMITS.topic) return res.status(400).json({ error: `Topic too long (max ${LIMITS.topic} chars)` });
  if (script.length > LIMITS.script) return res.status(400).json({ error: `Script too long (max ${LIMITS.script} chars)` });
  if (refineInstruction.length > LIMITS.refineInstruction) return res.status(400).json({ error: "Refine instruction too long" });

  const tone = TONES.has(body.tone) ? body.tone : "vox";
  const targetSec = Math.max(10, Math.min(180, Number(body.targetSec) || 45));

  // Daily circuit breaker (atomic — aborts at the cap, no read-then-write race).
  const day = new Date().toISOString().slice(0, 10);
  const capResult = await runRtdbTransaction(`/aiUsage/dailyCount/${req._actor.uid}/${day}`, (n) => {
    const cur = n || 0;
    if (cur >= LIMITS.dailyPerUser) return undefined;
    return cur + 1;
  });
  if (!capResult.committed) {
    return res.status(429).json({ error: "Daily generation limit reached — try again tomorrow" });
  }

  const systemPrompt = buildSystemPrompt(tone, targetSec);
  let userText;
  if (isRefine) {
    // Reserialize our own normalized previous storyboard (not raw client JSON) so
    // the model revises a clean, bounded object.
    let prevNorm;
    try { prevNorm = normalizeStoryboard(previous); }
    catch { return res.status(400).json({ error: "The storyboard to refine looks invalid — generate a fresh one." }); }
    userText =
      `Here is the current storyboard as JSON:\n\n${JSON.stringify(prevNorm)}\n\n` +
      `Revise it as follows: ${refineInstruction}\n\n` +
      `Return the full updated storyboard as JSON in the same shape (JSON only, no prose, no code fences).`;
  } else {
    userText =
      (topic ? `Topic / angle:\n${topic}\n\n` : "") +
      (script ? `Rough script / notes to build the beats from:\n${script}\n\n` : "") +
      `Produce the storyboard as JSON in the required shape.`;
  }

  let claude;
  try { claude = await callClaude(systemPrompt, userText, apiKey); }
  catch (e) { return claudeErrorResponse(res, e, "generate"); }

  // Anthropic has now billed us — ALWAYS ledger the spend, even if the output is
  // unusable, so the Founders stats never under-count.
  const { text, usage, stopReason } = claude;
  const cost = computeCost(usage);
  const id = genId();

  let storyboard = null;
  let status = "ok";
  let clientErr = null;
  if (stopReason === "max_tokens") {
    status = "truncated";
    clientErr = { code: 422, msg: "The storyboard was too long and got cut off — try a shorter target or fewer beats." };
  } else {
    try { storyboard = normalizeStoryboard(text); }
    catch (e) { status = "rejected"; clientErr = { code: 422, msg: e.message }; }
  }

  await writeLedgerSafe(id, {
    id,
    type: "generate",
    model: MODEL,
    rate: PRICE,
    tone,
    targetSec,
    refined: isRefine,
    sceneCount: storyboard ? storyboard.sceneCount : 0,
    status,
    ...cost,
    createdBy: req._actor,
    createdAt: new Date().toISOString(),
  });

  if (clientErr) return res.status(clientErr.code).json({ error: clientErr.msg });

  return res.status(200).json({
    id,
    storyboard,
    tone,
    targetSec,
    usage: cost,
    cost: cost.costUsd,
    model: MODEL,
  });
}

// save — persist a generation to the shared library. Server-stamps the creator
// and reads the AUTHORITATIVE cost from the ledger by generationId (never trusts
// a client-supplied cost). Meta + data written in one atomic multi-path update.
async function handleSave(req, res, body) {
  const { generationId, name } = body;
  if (!validId(generationId)) return res.status(400).json({ error: "Invalid generation id" });

  let storyboard;
  try { storyboard = normalizeStoryboard(body.storyboard); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const blob = JSON.stringify(storyboard);
  if (Buffer.byteLength(blob, "utf8") > LIMITS.savedBlob) {
    return res.status(400).json({ error: "Storyboard is too large to save" });
  }

  // Authoritative cost/tone from the ledger record this generation wrote.
  const ledger = await fbGet(`/aiUsage/storyboards/${generationId}`);
  const cost = ledger && typeof ledger.costUsd === "number" ? ledger.costUsd : 0;

  const cleanName = clampStr(name, LIMITS.savedName) || storyboard.title || "Untitled storyboard";
  const savedAt = new Date().toISOString();

  await fbPatchMulti("/storyboardLibrary", {
    [`meta/${generationId}`]: {
      id: generationId,
      name: cleanName,
      sceneCount: storyboard.sceneCount,
      totalSec: storyboard.totalSec,
      cost,
      createdBy: req._actor,
      createdAt: savedAt,
    },
    [`data/${generationId}`]: storyboard,
  });

  return res.status(200).json({ id: generationId, name: cleanName });
}

async function handleArchive(req, res, body) {
  const { id } = body;
  if (!validId(id)) return res.status(400).json({ error: "Invalid id" });
  await fbPatchMulti(`/storyboardLibrary/meta/${id}`, { archived: true });
  return res.status(200).json({ ok: true });
}
