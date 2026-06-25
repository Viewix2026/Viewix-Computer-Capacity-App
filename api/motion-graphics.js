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
//   port     — paste a component/code snippet -> Opus ports it to a guarded,
//              self-contained recordable fragment (ledger type "port").
//   save     — persist a generation to the shared library (server-stamped
//              creator + authoritative cost looked up by generationId).
//   update   — overwrite an existing library item's content with a revision
//              ("Update original"); same trust boundary, content leaves only.
//   archive  — soft-delete a library item.
//   assign   — set/clear the client a saved graphic belongs to.
//   enhance  — expand a rough prompt into a vivid one (cheap Sonnet call).
//   templateSave / templateDelete / templateFeedback / templateFeedbackDelete
//            — team-editable "Start from a preset" rail: override built-ins, add
//              custom templates, and leave feedback (server-only write).
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

import dns from "dns";
import net from "net";
import http from "http";
import https from "https";
import { adminGet, adminPatch, getAdmin, runRtdbTransaction } from "./_fb-admin.js";
import { actorFrom, handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { normalizeRole } from "./_roles.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";
const ENHANCE_MODEL = "claude-sonnet-4-6"; // cheap/fast prompt-expansion, not the heavy generation

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
// Sonnet 4.6 rates for the cheap "enhance" call (claude-api skill: $3/$15 per MTok).
const ENHANCE_PRICE = {
  inPerMTok: 3.0,
  outPerMTok: 15.0,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
  pricedAt: "2026-06-24",
  model: ENHANCE_MODEL,
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
  previousFragment: 200 * 1024, // 200KB — match outputHtml so any saved graphic (guarded ≤200KB) can be revised
  outputHtml: 200 * 1024,       // 200KB guarded doc ceiling
  dailyPerUser: 100,            // runaway-loop circuit breaker, not a budget
  brandUrl: 2000,
  brandHtml: 1024 * 1024,       // cap the fetched site HTML at 1MB
  brandFetchMs: 8000,
  referenceImageBytes: 2 * 1024 * 1024, // decoded cap — kept well under Vercel's 4.5MB body limit even alongside a near-cap previousFragment; the client downscales to ~tiny anyway
  sourceCode: 50 * 1024,        // 50KB — pasted component/code to port (plenty for a single component, far under the body limit)
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

// ─── Brand pull from a client website (SSRF-guarded) ──────────────────────────
// Reject anything that resolves to a private/reserved address so an editor can't
// point this at internal services or cloud metadata. The fetched HTML is parsed
// for og:image / theme-color only; the image URL is later handed to Anthropic
// (its fetch, not ours) for the vision reference.
const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^192\.0\.0\./, /^192\.0\.2\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./, /^198\.51\.100\./, /^203\.0\.113\./, /^(22[4-9]|23\d|24\d|25[0-5])\./,
];
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some(re => re.test(ip));
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("fc") || x.startsWith("fd")) return true; // fc00::/7 ULA
    const first = parseInt(x.split(":")[0] || "0", 16);
    if (!Number.isNaN(first) && (first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local (fe80–febf)
    if (x.startsWith("::ffff:")) { const v4 = x.split(":").pop(); if (net.isIPv4(v4)) return isPrivateIp(v4); return true; }
    return false;
  }
  return true;
}
function safeHostname(h) {
  const x = (h || "").toLowerCase();
  if (!x) return false;
  if (x === "localhost" || x.endsWith(".localhost") || x.endsWith(".local") || x.endsWith(".internal") || x.endsWith(".lan")) return false;
  return true;
}
// Pin the connection to a vetted PUBLIC ip: the http/https `lookup` option runs
// at CONNECT time and only ever hands back a public address, so DNS rebinding
// (public at check time, private at connect time) can't reach an internal host.
function vettedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const safe = (addrs || []).filter(a => !isPrivateIp(a.address));
    if (!safe.length) return cb(new Error("blocked private address"));
    if (options && options.all) return cb(null, safe); // Node may request the array form
    cb(null, safe[0].address, safe[0].family);
  });
}
// GET with the ip pinned + a hard byte cap + a timeout. Resolves { html, base }
// on 2xx or { redirect } on 3xx; throws our own (safe) error otherwise.
function httpGetCapped(u, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    let settled = false;
    const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
    const req = mod.request(u, { method: "GET", lookup: vettedLookup, timeout: Math.max(500, timeoutMs || LIMITS.brandFetchMs),
      headers: { "User-Agent": "ViewixMotionGraphics/1.0 (brand-extract)", "Accept": "text/html" } }, (resp) => {
      const status = resp.statusCode || 0;
      if (status >= 300 && status < 400 && resp.headers.location) { resp.destroy(); if (!settled) { settled = true; resolve({ redirect: resp.headers.location }); } return; }
      if (status < 200 || status >= 300) { resp.destroy(); return fail(`site returned ${status}`); }
      const cl = Number(resp.headers["content-length"] || 0);
      if (cl && cl > LIMITS.brandHtml * 4) { resp.destroy(); return fail("site response too large"); }
      const chunks = []; let received = 0; let capped = false;
      const finish = () => { if (!settled) { settled = true; resolve({ html: Buffer.concat(chunks).toString("utf8").slice(0, LIMITS.brandHtml), base: u.toString() }); } };
      resp.on("data", (c) => { if (capped) return; received += c.length; chunks.push(c); if (received > LIMITS.brandHtml) { capped = true; resp.destroy(); } });
      resp.on("end", finish);
      resp.on("close", () => { if (capped) finish(); });
      resp.on("error", () => fail("couldn't read the site"));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => {
      const msg = String((e && e.message) || "");
      if (/blocked private address/.test(msg)) fail("that host resolves to a private address");
      else if (/timed out/.test(msg)) fail("site timed out");
      else fail("couldn't reach the site");
    });
    req.end();
  });
}
async function safeFetchHtml(rawUrl, depth = 0, deadline = Date.now() + LIMITS.brandFetchMs) {
  if (depth > 2) throw new Error("too many redirects");
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("must be an http(s) URL");
  if (!safeHostname(u.hostname)) throw new Error("that host isn't allowed");
  // IP literals skip the lookup (Node connects to them directly), so vet them here.
  // URL.hostname keeps IPv6 brackets ("[::1]"), so strip them before net.isIP.
  const hostLiteral = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostLiteral) && isPrivateIp(hostLiteral)) throw new Error("that host resolves to a private address");
  const r = await httpGetCapped(u, deadline - Date.now());
  if (r.redirect) return safeFetchHtml(new URL(r.redirect, u).toString(), depth + 1, deadline); // re-validate + share the deadline
  return r;
}
function metaContent(html, key) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i"));
  if (!m) return null;
  const c = m[0].match(/content=["']([^"']*)["']/i);
  return c ? c[1].trim() : null;
}
async function fetchBrand(rawUrl) {
  const { html, base } = await safeFetchHtml(rawUrl);
  let imageUrl = metaContent(html, "og:image") || metaContent(html, "og:image:url") || metaContent(html, "twitter:image") || metaContent(html, "twitter:image:src");
  if (imageUrl) { try { imageUrl = new URL(imageUrl, base).toString(); } catch { imageUrl = null; } }
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) imageUrl = null;
  const themeColor = metaContent(html, "theme-color");
  const siteName = metaContent(html, "og:site_name") || (html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] || "").trim() || null;
  if (!imageUrl && !themeColor) throw new Error("no brand image or colour found on that site");
  return { imageUrl, themeColor, siteName, sourceUrl: base };
}

// ─── Uploaded reference image (vision) ────────────────────────────────────────
// An editor can upload their own image (style frame, logo, moodboard) instead of
// a website; it's handed to Anthropic as a base64 vision block and never stored.
// The client downscales to a small JPEG, but we still validate hard here: a
// whitelisted media type, a clean base64 charset, and a decoded-size cap so a
// malformed/huge body can't slip through to Anthropic.
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Magic-byte sniff: confirm the decoded bytes actually ARE the declared type, so
// a mis-declared or garbage payload is rejected here (clean 400) instead of
// burning an Opus call that Anthropic would reject.
function imageMagicOk(mediaType, buf) {
  if (mediaType === "image/jpeg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mediaType === "image/png")  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mediaType === "image/gif")  return buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a");
  if (mediaType === "image/webp") return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  return false;
}
function parseReferenceImage(body) {
  const ri = body.referenceImage;
  if (ri === undefined || ri === null || ri === "") return null;
  let mediaType, data;
  if (typeof ri === "string") {
    const m = ri.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
    if (!m) throw new Error("must be a base64 data URL");
    mediaType = m[1].toLowerCase();
    data = m[2];
  } else if (typeof ri === "object" && typeof ri.data === "string") {
    mediaType = String(ri.mediaType || ri.media_type || "").toLowerCase();
    data = ri.data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  } else {
    throw new Error("invalid reference image");
  }
  data = data.replace(/\s/g, "");
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) throw new Error("must be a JPEG, PNG, GIF, or WebP");
  if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("isn't valid base64");
  const buf = Buffer.from(data, "base64");
  if (buf.length < 100) throw new Error("is empty");
  if (buf.length > LIMITS.referenceImageBytes) throw new Error("is too large — pick a smaller image");
  if (!imageMagicOk(mediaType, buf)) throw new Error(`doesn't look like a real ${mediaType.split("/")[1].toUpperCase()} image`);
  return { mediaType, data };
}

function buildSystemPrompt(width, height, durationSec, brand, hasUploadedReference) {
  const brandBlock = brand
    ? `BRAND — match the CLIENT'S brand${brand.siteName ? ` (${brand.siteName})` : ""}, not Viewix:
${brand.imageUrl ? "- A reference image of the client's brand is attached as the first message item. Pull the colour palette, type feel, and overall visual style from it.\n" : ""}${brand.themeColor ? `- Their primary brand colour is approximately ${brand.themeColor}.\n` : ""}- Use the client's colours and visual feel throughout. Do NOT use Viewix blue/orange unless they genuinely match the client. 'DM Sans' and 'JetBrains Mono' are available for clean type.`
    : hasUploadedReference
    ? `REFERENCE IMAGE — a reference image is attached as the first message item:
- Match its visual style: colour palette, typography feel, shapes, and overall mood. Build the graphic to look like it belongs with that reference.
- Do NOT default to Viewix blue/orange unless the reference actually uses them. 'DM Sans' and 'JetBrains Mono' are available for clean type.`
    : `VIEWIX BRAND:
- Primary blue #0082FA, bright blue #3DA2FF, orange #F87700, near-black #0A0E17, off-white #EAEEF6.
- Fonts: 'DM Sans' (headings/body), 'JetBrains Mono' (numbers/labels). Both are available — use them.`;
  return `You generate motion graphics for Viewix Video Production, a Sydney video agency. Output a single self-contained animated graphic that will be rendered at exactly ${width}x${height} pixels and screen-recorded into a video.

${brandBlock}

HARD OUTPUT RULES (a wrapper enforces the exact size, a transparent background, fonts, and security — follow these so it renders correctly):
- Return ONLY an HTML fragment: a <style> block, the markup, and a <script> block. Do NOT include <!DOCTYPE>, <html>, <head>, or <body> tags. Do NOT wrap the output in markdown code fences.
- NO visible code comments, TODOs, or placeholder chrome in the rendered output. Never render text like "// END CARD", an HTML comment, "PLACEHOLDER", or section labels — only the finished graphic the viewer should see.
- Transparent background — do not paint a full-bleed opaque background unless the user explicitly asks. The graphic composites over video.
- Design to exactly ${width}x${height}. Keep important content inside a ~8% safe margin.
- Animate with CSS animations and/or inline JS (requestAnimationFrame). The animation MUST loop cleanly about every ${durationSec} seconds.
- Everything inline: CSS, SVG, data: URIs. NO network calls (no fetch/XHR), NO external scripts, NO external images. (Google Fonts is already loaded for you.)
- Self-contained and running immediately on load.`;
}

function computeCost(usage, price = PRICE) {
  const u = usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cost =
    (inTok * price.inPerMTok +
      outTok * price.outPerMTok +
      cacheWrite * price.cacheWritePerMTok +
      cacheRead * price.cacheReadPerMTok) /
    1_000_000;
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    costUsd: Number(cost.toFixed(6)),
  };
}

const CLAUDE_TIMEOUT_MS = 150_000; // own timeout so we return JSON before Vercel kills the function

// Raw-fetch Anthropic call (no SDK in this repo). Returns { text, usage,
// stopReason }. Retries ONCE on a transient failure (429/529/5xx/network) with a
// short backoff, and throws errors tagged with `.kind` (timeout/ratelimit/
// overloaded/api) so the handler can give a clear, cause-specific message — the
// old version surfaced any failure as a single opaque "service unavailable".
async function callClaude(systemPrompt, userContent, apiKey, opts = {}) {
  const model = opts.model || MODEL;
  const maxTokens = opts.maxTokens || 8000;
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  });
  const overallDeadline = Date.now() + 150_000; // bound the whole call (incl. retry) so we return before the client/Vercel give up
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
        try { data = await resp.json(); } // timer stays armed — a stalled body aborts
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

// Map a callClaude error to a clear, cause-specific client message + status.
function claudeErrorResponse(res, e, label) {
  console.error(`motion-graphics ${label} failed:`, e.kind, e.message);
  if (e.kind === "timeout") return res.status(504).json({ error: "That took too long — try a simpler prompt or a shorter loop." });
  if (e.kind === "ratelimit") return res.status(429).json({ error: "Too many generations right now — wait a few seconds and try again." });
  if (e.kind === "overloaded") return res.status(503).json({ error: "The model is busy right now — try again in a moment." });
  return res.status(502).json({ error: "Generation failed — try again." });
}

function genId() {
  return `mg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Client-supplied ids become RTDB path segments, so a "/" (or RTDB-illegal char)
// could patch inside another record. Only our own genId shape is allowed.
const ID_RE = /^mg_[a-z0-9_]+$/i;
const validId = s => typeof s === "string" && s.length <= 64 && ID_RE.test(s);

// Preset templates ("Start from a preset" rail). Built-in overrides are keyed
// `mgt_<presetKey>`; customs are `mgt_<ts>_<rand>`. Same path-injection guard as
// validId, distinct prefix so a template id can't address a library/ledger node.
const TEMPLATE_ID_RE = /^mgt_[a-z0-9_]+$/i;
const validTemplateId = s => typeof s === "string" && s.length <= 64 && TEMPLATE_ID_RE.test(s);
function genTemplateId() {
  return `mgt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
// Icons the picker offers — every name MUST exist in src/components/Icon.jsx, so a
// stored icon always renders. Format must be a real preview dimension.
const TEMPLATE_ICONS = new Set(["spark", "play", "analytics", "socials", "founders", "link2", "capacity", "editors", "sale", "nurture", "calendar", "bell"]);
const TEMPLATE_FMTS = new Set(["Portrait", "Landscape", "Square"]);
const TEMPLATE_LIMITS = { label: 60, feedback: 500 };

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
    if (action === "port") return await handlePort(req, res, body);
    if (action === "enhance") return await handleEnhance(req, res, body);
    if (action === "save") return await handleSave(req, res, body);
    if (action === "update") return await handleUpdate(req, res, body);
    if (action === "archive") return await handleArchive(req, res, body);
    if (action === "assign") return await handleAssign(req, res, body);
    if (action === "setType") return await handleSetType(req, res, body);
    if (action === "templateSave") return await handleTemplateSave(req, res, body);
    if (action === "templateDelete") return await handleTemplateDelete(req, res, body);
    if (action === "templateFeedback") return await handleTemplateFeedback(req, res, body);
    if (action === "templateFeedbackDelete") return await handleTemplateFeedbackDelete(req, res, body);
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

  // A refine is driven by the previous fragment + instruction, so the prompt is
  // optional there — revising a saved library graphic has no prompt to re-type.
  const isRefine = !!(refineInstruction && String(refineInstruction).trim() && previousFragment && String(previousFragment).trim());
  if (!isRefine && (!prompt || typeof prompt !== "string" || !prompt.trim())) {
    return res.status(400).json({ error: "Missing prompt" });
  }
  if (typeof prompt === "string" && prompt.length > LIMITS.prompt) {
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

  // Optional: pull the client's brand from their website (SSRF-guarded). Done
  // BEFORE the cap/Opus call so a bad URL doesn't burn quota or money.
  const brandUrl = typeof body.brandUrl === "string" ? body.brandUrl.trim() : "";
  if (brandUrl.length > LIMITS.brandUrl) return res.status(400).json({ error: "Brand URL too long" });
  let brand = null;
  if (brandUrl) {
    try { brand = await fetchBrand(brandUrl); }
    catch (e) { return res.status(422).json({ error: `Couldn't use that website's branding — ${e.message}` }); }
  }

  // Optional: an uploaded reference image (base64 vision). Website brand wins if
  // both somehow arrive (the UI only sends one). Validated, never stored.
  let referenceImage = null;
  if (!brand) {
    try { referenceImage = parseReferenceImage(body); }
    catch (e) { return res.status(400).json({ error: `Reference image ${e.message}` }); }
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

  const systemPrompt = buildSystemPrompt(dims.width, dims.height, dur, brand, !!referenceImage);
  const userText = isRefine
    ? `Here is the current motion graphic fragment:\n\n${previousFragment}\n\nAdjust it as follows: ${refineInstruction}\n\nReturn the full updated fragment (same rules — fragment only, no <html>/<head>/<body>, no code fences).`
    : prompt.trim();
  // Attach a vision reference: the website's brand image (URL) or the editor's
  // uploaded image (base64) — as the FIRST content item, then the text.
  const imageBlock = (brand && brand.imageUrl)
    ? { type: "image", source: { type: "url", url: brand.imageUrl } }
    : referenceImage
    ? { type: "image", source: { type: "base64", media_type: referenceImage.mediaType, data: referenceImage.data } }
    : null;
  const userContent = imageBlock ? [imageBlock, { type: "text", text: userText }] : userText;

  // Call Claude. A failure here means Anthropic may or may not have billed us,
  // but we have no usage to ledger — return an opaque error.
  let claude;
  try {
    claude = await callClaude(systemPrompt, userContent, apiKey);
  } catch (e) {
    return claudeErrorResponse(res, e, "generate");
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
    type: "generate",
    model: MODEL,
    rate: PRICE,
    dimension,
    durationSec: dur,
    refined: isRefine,
    status,
    brand: brand ? (brand.siteName || brand.sourceUrl) : (referenceImage ? "reference-image" : null),
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
    brand: brand ? { siteName: brand.siteName, sourceUrl: brand.sourceUrl } : null,
  });
}

// System prompt for the "Import" flow: turn pasted component/app code into a
// self-contained recordable fragment. Same OUTPUT RULES as a generation, plus
// explicit instructions to shed everything that belongs to a web app.
function buildPortSystemPrompt(width, height, durationSec) {
  return `You convert a pasted UI component or code snippet into a single self-contained animated graphic for Viewix Video Production, rendered at exactly ${width}x${height} pixels and screen-recorded into a video.

The pasted code may be a React/JSX component, plain HTML+CSS, or vanilla JS (e.g. from a components library). Reproduce its VISUAL OUTPUT and ANIMATION faithfully, then strip everything that belongs to a web app rather than a recorded graphic:
- Framework wiring: React/Vue/Svelte imports, hooks, props, state, exports, and JSX — re-express the result as plain HTML/SVG markup + a <style> block + an inline vanilla-JS <script> (use requestAnimationFrame / CSS animations).
- Interactivity meant for a user: drag/scroll/pointer/hover handlers, controls, buttons — keep only the autonomous animation.
- Page-shell baggage: full-viewport jackets (min-height:100vh), centering wrappers, and opaque page backgrounds.

Keep the component's OWN colours, type, and visual style — do NOT re-skin it to Viewix unless the code already uses Viewix colours. 'DM Sans' and 'JetBrains Mono' are available if the code needs a fallback font.

HARD OUTPUT RULES (a wrapper enforces the exact size, a transparent background, fonts, and security — follow these so it renders correctly):
- Return ONLY an HTML fragment: a <style> block, the markup, and a <script> block. Do NOT include <!DOCTYPE>, <html>, <head>, or <body> tags. Do NOT wrap the output in markdown code fences.
- NO visible code comments, TODOs, or placeholder chrome in the rendered output.
- Transparent background — do not paint a full-bleed opaque background. The graphic composites over video.
- Design to exactly ${width}x${height}. Keep important content inside a ~8% safe margin.
- The animation MUST loop cleanly about every ${durationSec} seconds.
- Everything inline: CSS, SVG, data: URIs. NO network calls, NO external scripts, NO external images, NO imports. (Google Fonts is already loaded for you.)
- Self-contained and running immediately on load.`;
}

// Import flow — port pasted code into a guarded fragment. Mirrors handleGenerate's
// cap + ledger + trust-boundary machinery; kept separate so the generate hot path
// is untouched. Ledger type "port".
async function handlePort(req, res, body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Generation is not configured" });

  const sourceCode = typeof body.sourceCode === "string" ? body.sourceCode : "";
  if (!sourceCode.trim()) return res.status(400).json({ error: "Paste some component code to import" });
  if (sourceCode.length > LIMITS.sourceCode) return res.status(400).json({ error: `That's too long to import (max ${Math.floor(LIMITS.sourceCode / 1024)}KB)` });
  const dims = DIMENSIONS[body.dimension];
  if (!dims) return res.status(400).json({ error: "Invalid dimension (use 1080x1920, 1920x1080, or 1080x1080)" });
  const dur = Math.max(2, Math.min(20, Number(body.durationSec) || 6));

  // Daily circuit breaker (atomic — shared with generate; counts toward the cap).
  const day = new Date().toISOString().slice(0, 10);
  const capResult = await runRtdbTransaction(`/aiUsage/dailyCount/${req._actor.uid}/${day}`, (n) => {
    const cur = n || 0;
    return cur >= LIMITS.dailyPerUser ? undefined : cur + 1;
  });
  if (!capResult.committed) return res.status(429).json({ error: "Daily generation limit reached — try again tomorrow" });

  const systemPrompt = buildPortSystemPrompt(dims.width, dims.height, dur);
  const userText = `Port this component/code into a self-contained, transparent, looping fragment (same rules — fragment only, no <html>/<head>/<body>, no code fences):\n\n${sourceCode}`;

  let claude;
  try {
    claude = await callClaude(systemPrompt, userText, apiKey);
  } catch (e) {
    return claudeErrorResponse(res, e, "port");
  }

  const { text, usage, stopReason } = claude;
  const cost = computeCost(usage);
  const id = genId();

  let html = null, status = "ok", clientErr = null;
  if (stopReason === "max_tokens") {
    status = "truncated";
    clientErr = { code: 422, msg: "That component was too complex to port in one pass — try a smaller snippet" };
  } else {
    try { html = injectGuard(text, dims); }
    catch (e) { status = "rejected"; clientErr = { code: 422, msg: e.message }; }
  }

  await writeLedgerSafe(id, {
    id, type: "port", model: MODEL, rate: PRICE, dimension: body.dimension, durationSec: dur, status,
    ...cost, createdBy: req._actor, createdAt: new Date().toISOString(),
  });

  if (clientErr) return res.status(clientErr.code).json({ error: clientErr.msg });

  return res.status(200).json({ id, html, fragment: text, dimension: body.dimension, durationSec: dur, usage: cost, cost: cost.costUsd, model: MODEL });
}

function buildEnhanceSystemPrompt(width, height, durationSec) {
  return `You turn a short, rough idea for a motion graphic into one vivid, specific prompt for an animation generator. The graphic will render at ${width}x${height} and loop about every ${durationSec} seconds.

Rewrite the user's idea into 2 to 4 sentences describing:
- WHAT animates and HOW it moves (the motion beats and timing),
- the LOOK (colours, style, type), and
- the key on-screen elements.

Stay true to the user's intent — sharpen it, don't replace it. Assume Viewix brand (blue #0082FA, orange #F87700, DM Sans) unless the idea implies otherwise. Keep it concrete and producible as a clean looping animation.

Output ONLY the improved prompt text — no preamble, no quotes, no markdown, no code.`;
}

// Expand a rough prompt into a vivid one (cheap Sonnet call). Returns { prompt }.
async function handleEnhance(req, res, body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Generation is not configured" });
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "Nothing to enhance — describe a graphic first" });
  if (prompt.length > LIMITS.prompt) return res.status(400).json({ error: `Prompt too long (max ${LIMITS.prompt} chars)` });
  const dims = DIMENSIONS[body.dimension] || DIMENSIONS["1080x1920"];
  const dur = Math.max(2, Math.min(20, Number(body.durationSec) || 5));

  let claude;
  try {
    claude = await callClaude(buildEnhanceSystemPrompt(dims.width, dims.height, dur), prompt, apiKey, { model: ENHANCE_MODEL, maxTokens: 700 });
  } catch (e) {
    return claudeErrorResponse(res, e, "enhance");
  }
  let out = (claude.text || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").replace(/^["']|["']$/g, "").trim();
  if (!out) return res.status(502).json({ error: "Couldn't enhance that — try again." });
  if (out.length > LIMITS.prompt) out = out.slice(0, LIMITS.prompt);

  // Light cost ledger (Sonnet rates) so the stats tab captures enhance spend too.
  const cost = computeCost(claude.usage, ENHANCE_PRICE);
  const id = genId();
  await writeLedgerSafe(id, { id, type: "enhance", model: ENHANCE_MODEL, rate: ENHANCE_PRICE, status: "ok", ...cost, createdBy: req._actor, createdAt: new Date().toISOString() });

  return res.status(200).json({ prompt: out });
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
  // Animation type (the library's primary split). Defaults to "Other" so an
  // untyped item always lands in a real bucket.
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim().slice(0, 80) : "Other";

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
      type,
      createdBy: req._actor,
      createdAt: now,
      archived: false,
    },
    [`html/${id}`]: guarded,
  });

  return res.status(200).json({ id, name: cleanName, client, type });
}

// Overwrite an existing library item's CONTENT in place with a revision (the
// "Update original" path). Same trust boundary + authoritative-cost rules as
// save, but keyed to an existing library id: only the content leaves change
// (html, dimension, durationSec, costUsd, generationId + an update stamp); name,
// client, createdBy/At are preserved by writing leaf paths, not the whole record.
async function handleUpdate(req, res, body) {
  const { id, generationId, html, fragment } = body;
  if (!validId(id)) return res.status(400).json({ error: "Missing or invalid id" });
  if (!validId(generationId)) return res.status(400).json({ error: "Missing or invalid generationId" });

  const meta = await fbGet(`/motionGraphicsLibrary/meta/${id}`);
  if (!meta) return res.status(404).json({ error: "Library item not found" });

  // Authoritative cost + dims come from the ledger, never the client.
  const ledger = await fbGet(`/aiUsage/motionGraphics/${generationId}`);
  if (!ledger) return res.status(404).json({ error: "Unknown generation — regenerate before updating" });
  if (ledger.status && ledger.status !== "ok") {
    return res.status(400).json({ error: "That generation didn't produce a usable graphic" });
  }
  const dims = DIMENSIONS[ledger.dimension];
  if (!dims) return res.status(400).json({ error: "Ledger record has invalid dimensions" });

  let guarded;
  try {
    guarded = injectGuard(typeof fragment === "string" && fragment ? fragment : html, dims);
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }

  const now = new Date().toISOString();
  await fbPatchMulti("/motionGraphicsLibrary", {
    [`meta/${id}/dimension`]: ledger.dimension,
    [`meta/${id}/durationSec`]: ledger.durationSec || null,
    [`meta/${id}/generationId`]: generationId,
    [`meta/${id}/costUsd`]: ledger.costUsd || 0,
    [`meta/${id}/updatedBy`]: req._actor,
    [`meta/${id}/updatedAt`]: now,
    [`html/${id}`]: guarded,
  });

  return res.status(200).json({ id, ok: true });
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

// Set the animation type a saved graphic is filed under (the library's primary
// split). Free label sanitised to <=80 chars; empty/blank falls back to "Other".
async function handleSetType(req, res, body) {
  const { id } = body;
  if (!validId(id)) return res.status(400).json({ error: "Missing or invalid id" });
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim().slice(0, 80) : "Other";
  const meta = await fbGet(`/motionGraphicsLibrary/meta/${id}`);
  if (!meta) return res.status(404).json({ error: "Library item not found" });
  await fbPatchMulti(`/motionGraphicsLibrary/meta/${id}`, {
    type,
    typedBy: req._actor,
    typedAt: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true, type });
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

// ─── Team-editable preset templates (the "Start from a preset" rail) ───────────
// Built-in presets live in the frontend as code defaults; these actions let the
// whole editing team override a built-in, add their own templates, remove/reset
// them, and leave feedback. Stored at /motionGraphicsTemplates/{id} (+ feedback
// at /motionGraphicsTemplateFeedback/{id}/*). Server-only write (rule write:false).
// The UI decides which ids are built-in (from its own PRESETS), so the server
// treats every template uniformly — no trusted "builtin" flag.

// Create a new custom template (no templateId) or update an existing one
// (templateId present — a built-in override or a custom). Last-writer-wins.
async function handleTemplateSave(req, res, body) {
  const incomingId = body.templateId;
  const isUpdate = incomingId != null && incomingId !== "";
  if (isUpdate && !validTemplateId(incomingId)) {
    return res.status(400).json({ error: "Invalid templateId" });
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const icon = typeof body.icon === "string" ? body.icon.trim() : "";
  const fmt = typeof body.fmt === "string" ? body.fmt.trim() : "";
  if (!label) return res.status(400).json({ error: "Template needs a label" });
  if (label.length > TEMPLATE_LIMITS.label) return res.status(400).json({ error: `Label too long (max ${TEMPLATE_LIMITS.label})` });
  if (!prompt) return res.status(400).json({ error: "Template needs a prompt" });
  if (prompt.length > LIMITS.prompt) return res.status(400).json({ error: `Prompt too long (max ${LIMITS.prompt})` });
  if (!TEMPLATE_ICONS.has(icon)) return res.status(400).json({ error: "Pick a valid icon" });
  if (!TEMPLATE_FMTS.has(fmt)) return res.status(400).json({ error: "Pick a valid format" });
  const order = Number.isFinite(Number(body.order)) ? Math.max(0, Math.min(99999, Math.round(Number(body.order)))) : 1000;

  const id = isUpdate ? incomingId : genTemplateId();
  const now = new Date().toISOString();
  const existing = await fbGet(`/motionGraphicsTemplates/${id}`);
  const record = {
    id, label, prompt, icon, fmt, order,
    createdBy: (existing && existing.createdBy) || req._actor,
    createdAt: (existing && existing.createdAt) || now,
    updatedBy: req._actor,
    updatedAt: now,
  };
  await fbPatchMulti("/motionGraphicsTemplates", { [id]: record });
  return res.status(200).json({ id, template: record });
}

// Hard-remove the override doc. A built-in id reverts to the code default in the
// UI ("Reset"); a custom id disappears ("Delete"). Idempotent — deleting an id
// with no doc is a harmless no-op. Feedback is left in place (cheap; a re-created
// custom gets a fresh id anyway).
async function handleTemplateDelete(req, res, body) {
  const { templateId } = body;
  if (!validTemplateId(templateId)) return res.status(400).json({ error: "Invalid templateId" });
  await fbPatchMulti("/motionGraphicsTemplates", { [templateId]: null });
  return res.status(200).json({ ok: true });
}

// Append a feedback note to a template (built-in or custom). Stored under a
// separate node so a built-in with no override still has an attach point.
async function handleTemplateFeedback(req, res, body) {
  const { templateId } = body;
  if (!validTemplateId(templateId)) return res.status(400).json({ error: "Invalid templateId" });
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return res.status(400).json({ error: "Write a note first" });
  if (note.length > TEMPLATE_LIMITS.feedback) return res.status(400).json({ error: `Note too long (max ${TEMPLATE_LIMITS.feedback})` });
  const fbId = genTemplateId();
  await fbPatchMulti(`/motionGraphicsTemplateFeedback/${templateId}`, {
    [fbId]: { id: fbId, note, by: req._actor, at: new Date().toISOString() },
  });
  return res.status(200).json({ ok: true, id: fbId });
}

// Remove a feedback note (e.g. once addressed). Both ids share the mgt_ shape.
async function handleTemplateFeedbackDelete(req, res, body) {
  const { templateId, feedbackId } = body;
  if (!validTemplateId(templateId) || !validTemplateId(feedbackId)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  await fbPatchMulti(`/motionGraphicsTemplateFeedback/${templateId}`, { [feedbackId]: null });
  return res.status(200).json({ ok: true });
}
