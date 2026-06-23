// api/motion-graphics.js
// Vercel Serverless Function: Motion Graphics Generator (Editors toolkit).
//
// An editor describes a motion graphic in plain language; Claude (Opus 4.7)
// returns a self-contained animated HTML *fragment*, which we wrap in a
// locked-down shell and render in a sandboxed iframe on the dashboard. Good
// ones are saved to a shared library. The editor screen-records the preview
// into the video.
//
// Actions (POST body { action }):
//   generate — prompt -> Opus -> guarded HTML + usage + per-generation cost.
//              Writes an authoritative cost ledger at /aiUsage/motionGraphics/*.
//   save     — persist a generation to the shared library (server-stamped
//              creator + authoritative cost looked up by generationId).
//   archive  — soft-delete a library item.
//
// Security model (hardened via two Codex adversarial review rounds — see
// docs/plans/motion-graphics-generator-scope-packet.md):
//   · The generated HTML is UNTRUSTED. It only ever renders inside an
//     <iframe sandbox="allow-scripts"> (no allow-same-origin) carrying a strict
//     CSP we inject — `injectGuard` is the single trust boundary.
//   · Claude returns a FRAGMENT; we own the document shell, so the CSP meta is
//     always first in <head> and the model can't loosen it.
//   · Library writes are server-only (RTDB rule write:false); cost is read from
//     the ledger, never trusted from the client.
//   · Deactivated users are already blocked by requireRole's revocation check
//     (verifyIdToken(token, true) + revokeRefreshTokens on deactivate).

import { adminGet, adminPatch, getAdmin, runRtdbTransaction } from "./_fb-admin.js";
import { actorFrom, handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { normalizeRole } from "./_roles.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

// Per-MTok rates for the cost ledger. Verified against the claude-api skill
// 2026-06-23 (Opus 4.7: $5 input / $25 output per MTok; ephemeral cache write
// 1.25x input, read 0.1x input). Stamped onto every ledger record so historical
// cost stays correct if these rates later change.
const PRICE = {
  inPerMTok: 5.0,
  outPerMTok: 25.0,
  cacheWritePerMTok: 6.25,
  cacheReadPerMTok: 0.5,
  pricedAt: "2026-06-23",
  model: MODEL,
};

// Roles allowed to spend Opus money. `trial` is intentionally excluded; `closer`
// is sales (no Editors tab). These map through _roles.js normalizeRole.
const GENERATE_ROLES = ["founders", "manager", "lead", "editor"];

// Whitelisted output dimensions — arbitrary W×H is rejected (bounds abuse + keeps
// the preview/library predictable).
const DIMENSIONS = {
  "1080x1920": { width: 1080, height: 1920 },
  "1920x1080": { width: 1920, height: 1080 },
  "1080x1080": { width: 1080, height: 1080 },
};

const LIMITS = {
  prompt: 2000,
  refineInstruction: 1000,
  previousFragment: 100 * 1024, // 100KB
  outputHtml: 200 * 1024,       // 200KB guarded doc ceiling
  dailyPerUser: 100,            // runaway-loop circuit breaker, not a budget
};

// Strict CSP injected into every rendered/saved doc. No connect-src (falls back
// to default-src 'none') kills fetch/XHR/beacon/WebSocket exfiltration. Inline
// script/style allowed (animations need them); Google Fonts is the only external
// origin. media/worker explicitly 'none' so they fail predictably, not silently.
const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; " +
  "img-src data: blob:; " +
  "media-src 'none'; worker-src 'none'; " +
  "base-uri 'none'; form-action 'none'; navigate-to 'none'";

const FONTS_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800&family=JetBrains+Mono:wght@600;700&display=swap');";

// ─── Firebase helpers (admin SDK; server-only-write nodes need admin) ──────────
async function fbGet(path) {
  return adminGet(path);
}
async function fbPatchMulti(path, updates) {
  return adminPatch(path, updates);
}

// Write the cost ledger resiliently: one idempotent retry (same deterministic
// id → no duplicate), then log the full record so the spend is still recoverable
// from Vercel logs. Never throws — a ledger blip must not discard a successful
// generation the user (and Anthropic) already paid for.
async function writeLedgerSafe(id, payload) {
  try {
    await fbPatchMulti(`/aiUsage/motionGraphics/${id}`, payload);
  } catch (e1) {
    try {
      await fbPatchMulti(`/aiUsage/motionGraphics/${id}`, payload);
    } catch (e2) {
      console.error("motion-graphics ledger write failed (spend recoverable from this log):", id, JSON.stringify(payload), e2);
    }
  }
}

// ─── injectGuard — THE trust boundary ─────────────────────────────────────────
// Takes Claude's raw output, reduces it to a body fragment, and wraps it in a
// shell WE fully control: our CSP meta FIRST, our font @import + size reset, then
// the fragment in <body>. Never trusts the model's document structure.
//
// The security boundary is the sandbox (no allow-same-origin) + this shell's CSP
// — NOT the unwrapping. So we only unwrap when the model clearly returned a full
// document (against instructions); a genuine fragment passes through untouched,
// so content that merely *mentions* "</body>" or "<head>" in a JS string or CSS
// value is never corrupted.
export function injectGuard(raw, { width, height }) {
  if (typeof raw !== "string") throw new Error("No HTML returned");
  let s = raw.trim();

  // 1. Strip a single ``` fence wrapper if present; reject ambiguous multi-block.
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  if (s.includes("```")) {
    throw new Error("Model returned multiple code blocks; expected one fragment");
  }

  // 2. Only if it's CLEARLY a full document (starts with <!doctype or <html),
  //    extract the body fragment. Otherwise treat it as a fragment verbatim.
  if (/^\s*<!doctype/i.test(s) || /^\s*<html[\s>]/i.test(s)) {
    // Greedy to the LAST </body> so a literal "</body>" inside the body's CSS/JS
    // doesn't truncate the extraction.
    const bodyMatch = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      s = bodyMatch[1];
    } else {
      s = s.replace(/^[\s\S]*?<\/head>/i, ""); // drop everything up to </head>
      s = s.replace(/<\/?html[^>]*>/gi, "");
    }
    // Drop any model CSP / refresh metas that rode along in the extracted body.
    s = s.replace(/<meta[^>]*http-equiv\s*=\s*["']?(content-security-policy|refresh)["']?[^>]*>/gi, "");
  }

  const fragment = s.trim();
  if (!fragment) throw new Error("Model returned an empty graphic");

  const html =
    "<!DOCTYPE html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    '<meta charset="utf-8">' +
    `<style>${FONTS_IMPORT}html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${width}px;height:${height}px}</style>` +
    "</head><body>" +
    fragment +
    "</body></html>";

  if (Buffer.byteLength(html, "utf8") > LIMITS.outputHtml) {
    throw new Error("Generated graphic is too large (over 200KB)");
  }
  return html;
}

function buildSystemPrompt(width, height, durationSec) {
  return `You generate motion graphics for Viewix Video Production, a Sydney video agency. Output a single self-contained animated graphic that will be rendered at exactly ${width}x${height} pixels and screen-recorded into a video.

VIEWIX BRAND:
- Primary blue #0082FA, bright blue #3DA2FF, orange #F87700, near-black #0A0E17, off-white #EAEEF6.
- Fonts: 'DM Sans' (headings/body), 'JetBrains Mono' (numbers/labels). Both are available — use them.

HARD OUTPUT RULES (a wrapper enforces the exact size, a transparent background, fonts, and security — follow these so it renders correctly):
- Return ONLY an HTML fragment: a <style> block, the markup, and a <script> block. Do NOT include <!DOCTYPE>, <html>, <head>, or <body> tags. Do NOT wrap the output in markdown code fences.
- Transparent background — do not paint a full-bleed opaque background unless the user explicitly asks. The graphic composites over video.
- Design to exactly ${width}x${height}. Keep important content inside a ~8% safe margin.
- Animate with CSS animations and/or inline JS (requestAnimationFrame). The animation MUST loop cleanly about every ${durationSec} seconds.
- Everything inline: CSS, SVG, data: URIs. NO network calls (no fetch/XHR), NO external scripts, NO external images. (Google Fonts is already loaded for you.)
- Self-contained and running immediately on load.`;
}

function computeCost(usage) {
  const u = usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cost =
    (inTok * PRICE.inPerMTok +
      outTok * PRICE.outPerMTok +
      cacheWrite * PRICE.cacheWritePerMTok +
      cacheRead * PRICE.cacheReadPerMTok) /
    1_000_000;
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    costUsd: Number(cost.toFixed(6)),
  };
}

// Raw-fetch Anthropic call (no SDK in this repo). Returns { text, usage,
// stopReason }. Own timeout so we return JSON before Vercel kills the function.
async function callClaude(systemPrompt, userContent, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100_000);
  let resp;
  try {
    resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Generation timed out — try a simpler prompt");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    text: data.content?.[0]?.text || "",
    usage: data.usage || {},
    stopReason: data.stop_reason || null,
  };
}

function genId() {
  return `mg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Client-supplied ids become RTDB path segments, so a "/" (or RTDB-illegal char)
// could patch inside another record. Only our own genId shape is allowed.
const ID_RE = /^mg_[a-z0-9_]+$/i;
const validId = s => typeof s === "string" && s.length <= 64 && ID_RE.test(s);

// ─── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try {
    decoded = await requireRole(req, GENERATE_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }
  req._actor = actorFrom(decoded);

  const { err: adminErr } = getAdmin();
  if (adminErr) return res.status(500).json({ error: "Server storage not configured" });

  // Fresh authority check for EVERY action (generate spends Opus; save/assign/
  // archive mutate the shared library). The token's role claim lags up to ~1h
  // after a demotion (setRole doesn't revokeRefreshTokens), so re-check the
  // synchronously-updated RTDB record rather than trust requireRole's claim alone.
  try {
    const rec = await fbGet(`/users/${req._actor.uid}`);
    if (!rec || rec.active === false || !GENERATE_ROLES.includes(normalizeRole(rec.role))) {
      return res.status(403).json({ error: "Your account can't use motion graphics" });
    }
  } catch (e) {
    console.error("motion-graphics role check failed:", e);
    return res.status(500).json({ error: "Request failed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const action = body.action;

  try {
    if (action === "generate") return await handleGenerate(req, res, body);
    if (action === "save") return await handleSave(req, res, body);
    if (action === "archive") return await handleArchive(req, res, body);
    if (action === "assign") return await handleAssign(req, res, body);
    return res.status(400).json({ error: `Unknown action: ${action || "(none)"}` });
  } catch (e) {
    // Don't leak Anthropic/Firebase internals to the client — log + opaque message.
    console.error("motion-graphics error:", e);
    const msg = action === "generate" ? "Generation failed" : action === "save" ? "Save failed" : "Request failed";
    return res.status(500).json({ error: msg });
  }
}

async function handleGenerate(req, res, body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Generation is not configured" });

  const { prompt, dimension, durationSec, previousFragment, refineInstruction } = body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Missing prompt" });
  }
  if (prompt.length > LIMITS.prompt) {
    return res.status(400).json({ error: `Prompt too long (max ${LIMITS.prompt} chars)` });
  }
  const dims = DIMENSIONS[dimension];
  if (!dims) {
    return res.status(400).json({ error: "Invalid dimension (use 1080x1920, 1920x1080, or 1080x1080)" });
  }
  const dur = Math.max(2, Math.min(20, Number(durationSec) || 5));
  if (refineInstruction && String(refineInstruction).length > LIMITS.refineInstruction) {
    return res.status(400).json({ error: "Refine instruction too long" });
  }
  if (previousFragment && String(previousFragment).length > LIMITS.previousFragment) {
    return res.status(400).json({ error: "Previous graphic too large to refine" });
  }

  // Daily circuit breaker (atomic — aborts at the cap, no read-then-write race).
  const day = new Date().toISOString().slice(0, 10);
  const capPath = `/aiUsage/dailyCount/${req._actor.uid}/${day}`;
  const capResult = await runRtdbTransaction(capPath, (n) => {
    const cur = n || 0;
    if (cur >= LIMITS.dailyPerUser) return undefined; // abort → cap hit
    return cur + 1;
  });
  if (!capResult.committed) {
    return res.status(429).json({ error: "Daily generation limit reached — try again tomorrow" });
  }

  const systemPrompt = buildSystemPrompt(dims.width, dims.height, dur);
  let userContent;
  if (refineInstruction && previousFragment) {
    userContent = `Here is the current motion graphic fragment:\n\n${previousFragment}\n\nAdjust it as follows: ${refineInstruction}\n\nReturn the full updated fragment (same rules — fragment only, no <html>/<head>/<body>, no code fences).`;
  } else {
    userContent = prompt.trim();
  }

  // Call Claude. A failure here means Anthropic may or may not have billed us,
  // but we have no usage to ledger — return an opaque error.
  let claude;
  try {
    claude = await callClaude(systemPrompt, userContent, apiKey);
  } catch (e) {
    console.error("motion-graphics Claude call failed:", e);
    return res.status(502).json({ error: "The generation service is unavailable — try again" });
  }

  // From here Anthropic HAS billed us (usage is present), so we ALWAYS write the
  // cost ledger — even when the output is unusable (truncated / rejected) — so
  // the Founders Statistics tab never under-counts spend.
  const { text, usage, stopReason } = claude;
  const cost = computeCost(usage);
  const id = genId();

  let html = null;
  let status = "ok";
  let clientErr = null;
  if (stopReason === "max_tokens") {
    status = "truncated";
    clientErr = { code: 422, msg: "Graphic was too complex and got cut off — simplify the prompt" };
  } else {
    try {
      html = injectGuard(text, dims); // throws a safe, user-facing message on bad/oversized output
    } catch (e) {
      status = "rejected";
      clientErr = { code: 422, msg: e.message };
    }
  }

  await writeLedgerSafe(id, {
    id,
    model: MODEL,
    rate: PRICE,
    dimension,
    durationSec: dur,
    refined: !!(refineInstruction && previousFragment),
    status,
    ...cost,
    createdBy: req._actor,
    createdAt: new Date().toISOString(),
  });

  if (clientErr) return res.status(clientErr.code).json({ error: clientErr.msg });

  return res.status(200).json({
    id,
    html,
    fragment: text, // raw fragment for the next "refine" round
    dimension,
    durationSec: dur,
    usage: cost,
    cost: cost.costUsd,
    model: MODEL,
  });
}

async function handleSave(req, res, body) {
  const { generationId, html, fragment, name } = body;
  if (!validId(generationId)) {
    return res.status(400).json({ error: "Missing or invalid generationId" });
  }

  // Authoritative cost + dims come from the ledger, never the client.
  const ledger = await fbGet(`/aiUsage/motionGraphics/${generationId}`);
  if (!ledger) {
    return res.status(404).json({ error: "Unknown generation — regenerate before saving" });
  }
  if (ledger.status && ledger.status !== "ok") {
    return res.status(400).json({ error: "That generation didn't produce a usable graphic" });
  }
  const dims = DIMENSIONS[ledger.dimension];
  if (!dims) return res.status(400).json({ error: "Ledger record has invalid dimensions" });

  // Re-run the trust boundary on whatever HTML the client sends. Prefer the raw
  // fragment if provided (re-wrap), else re-guard the full doc.
  let guarded;
  try {
    guarded = injectGuard(typeof fragment === "string" && fragment ? fragment : html, dims);
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }

  const id = genId();
  const now = new Date().toISOString();
  const cleanName =
    typeof name === "string" && name.trim()
      ? name.trim().slice(0, 80)
      : `Motion graphic ${now.slice(0, 10)}`;
  const client = typeof body.client === "string" && body.client.trim() ? body.client.trim().slice(0, 80) : null;

  // Atomic multi-path write: meta + html together (no orphaned-meta state).
  await fbPatchMulti("/motionGraphicsLibrary", {
    [`meta/${id}`]: {
      id,
      name: cleanName,
      dimension: ledger.dimension,
      durationSec: ledger.durationSec || null,
      generationId,
      costUsd: ledger.costUsd || 0,
      client,
      createdBy: req._actor,
      createdAt: now,
      archived: false,
    },
    [`html/${id}`]: guarded,
  });

  return res.status(200).json({ id, name: cleanName, client });
}

// Assign (or clear) the client a saved graphic belongs to. Client is a free
// label sanitised to <=80 chars; null clears it. Server-only write.
async function handleAssign(req, res, body) {
  const { id } = body;
  if (!validId(id)) return res.status(400).json({ error: "Missing or invalid id" });
  const client = typeof body.client === "string" && body.client.trim() ? body.client.trim().slice(0, 80) : null;
  const meta = await fbGet(`/motionGraphicsLibrary/meta/${id}`);
  if (!meta) return res.status(404).json({ error: "Library item not found" });
  await fbPatchMulti(`/motionGraphicsLibrary/meta/${id}`, {
    client,
    assignedBy: req._actor,
    assignedAt: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true, client });
}

async function handleArchive(req, res, body) {
  const { id } = body;
  if (!validId(id)) return res.status(400).json({ error: "Missing or invalid id" });
  const meta = await fbGet(`/motionGraphicsLibrary/meta/${id}`);
  if (!meta) return res.status(404).json({ error: "Library item not found" });
  await fbPatchMulti(`/motionGraphicsLibrary/meta/${id}`, {
    archived: true,
    archivedBy: req._actor,
    archivedAt: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true });
}
