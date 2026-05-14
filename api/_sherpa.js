// api/_sherpa.js
// Shared loader for the Client Sherpa Google Doc — used by Brand Truth,
// script, and cell-rewrite handlers in api/social-organic.js and
// api/meta-ads.js to ground AI generations in the client's brief.
//
// Cache layout (server writes both, frontend only sees the meta record):
//   /sherpaCache/{clientId}      → { text }                 (server-only)
//   /sherpaCacheMeta/{clientId}  → { fetchedAt, sourceUrl,  (client-visible)
//                                    docId, byteSize,
//                                    truncated, lastRetryAt,
//                                    error? }
//
// Errors are returned as a fixed set of codes. Transient errors
// (timeout / rate_limited / fetch_failed) preserve the prior `text`
// when one exists; terminal errors (not_shared / empty / malformed_url)
// blank `text` and surface the failure to the producer via the meta
// record.

import { adminGet, adminSet, adminPatch } from "./_fb-admin.js";

const MAX_TEXT_CHARS = 25_000;
const HEAD_KEEP = 20_000;
const TAIL_KEEP = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_TTL_MS = 60_000;

// ─── docId extraction ─────────────────────────────────────────────
// Google Doc URLs are docs.google.com/document/d/{ID}/{anything}
// where ID is [A-Za-z0-9_-]+. Anything else is malformed.
export function extractDocId(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── Client resolver ──────────────────────────────────────────────
// Mirrors src/utils.js matchSherpaForName (server can't import from
// src/). Preference order:
//   0. Exact attioId match on a client record (only set on records
//      created or self-healed by api/webhook-deal-won.js).
//   1. Exact case-insensitive name match.
//   2. Bidirectional startsWith with a 4-char floor (only accepts a
//      single unambiguous winner).
//   3. First-word match (4-char floor, single winner only).
export function matchSherpaClient({ companyName, attioCompanyId, clients }) {
  const list = Array.isArray(clients) ? clients : Object.values(clients || {}).filter(Boolean);

  if (attioCompanyId) {
    const byAttio = list.find(c => c?.attioId && c.attioId === attioCompanyId);
    if (byAttio) return byAttio;
  }

  if (!companyName) return null;
  const lc = companyName.trim().toLowerCase();
  if (!lc) return null;

  let m = list.find(c => (c?.name || "").trim().toLowerCase() === lc);
  if (m) return m;

  const swMatches = list.filter(c => {
    const cn = (c?.name || "").trim().toLowerCase();
    if (cn.length < 4 || lc.length < 4) return false;
    return cn.startsWith(lc) || lc.startsWith(cn);
  });
  if (swMatches.length === 1) return swMatches[0];

  const fwTarget = lc.split(/\s+/)[0];
  if (!fwTarget || fwTarget.length < 4) return null;
  const fwMatches = list.filter(c => {
    const cn = (c?.name || "").trim().toLowerCase();
    return cn.split(/\s+/)[0] === fwTarget;
  });
  if (fwMatches.length === 1) return fwMatches[0];
  return null;
}

// ─── Google Doc fetcher ───────────────────────────────────────────
// Public export endpoint. When the doc is not shared "Anyone with the
// link" Google returns HTTP 200 with an HTML sign-in interstitial, so
// the content-type check is load-bearing — non-text/plain means the
// fetch did not actually return doc body.
async function fetchGoogleDocText(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") {
      throw { code: "timeout", message: `Google Docs fetch timed out after ${FETCH_TIMEOUT_MS}ms` };
    }
    throw { code: "fetch_failed", message: e?.message || "fetch error" };
  }
  clearTimeout(timer);

  if (res.status === 429) {
    throw { code: "rate_limited", message: "Google Docs returned 429" };
  }
  if (!res.ok) {
    throw { code: "fetch_failed", message: `Google Docs returned HTTP ${res.status}` };
  }

  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("text/html")) {
    throw { code: "not_shared", message: "Doc is not shared publicly (\"Anyone with the link\")" };
  }

  let raw = await res.text();
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
  if (!raw.trim()) {
    throw { code: "empty", message: "Google Doc body is empty" };
  }

  const byteSize = Buffer.byteLength(raw, "utf8");
  let text = raw;
  let truncated = false;
  if (raw.length > MAX_TEXT_CHARS) {
    text =
      raw.slice(0, HEAD_KEEP) +
      `\n\n[…middle truncated, original ${byteSize}B…]\n\n` +
      raw.slice(raw.length - TAIL_KEEP);
    truncated = true;
  }
  return { text, byteSize, truncated };
}

// ─── Main entry point ─────────────────────────────────────────────
// Resolves the client for a project, reads cache, checks for docId
// drift (someone changed /clients/{id}.docUrl), and either returns
// cached text or fetches fresh. Never throws — all failure modes are
// returned as { text, source, error? }.
//
// Returned `source` values:
//   "cache"  — served from /sherpaCache, cache was valid and current
//   "fresh"  — fetched from Google just now
//   "stale"  — fetch failed transient-style, prior cache.text preserved
//   "none"   — no usable Sherpa text (client not linked, error, etc.)
export async function loadSherpaContext({ companyName, attioCompanyId, forceRefresh = false }) {
  let clients;
  try {
    clients = await adminGet("/clients");
  } catch (e) {
    return { text: "", source: "none", error: { code: "fetch_failed", message: `Could not read /clients: ${e.message}` } };
  }
  const client = matchSherpaClient({ companyName, attioCompanyId, clients });

  if (!client) {
    return { text: "", source: "none", error: { code: "not_linked", message: "No /clients record matched this company" } };
  }
  if (!client.docUrl) {
    return { text: "", source: "none", clientId: client.id, error: { code: "not_linked", message: "Client record has no docUrl" } };
  }

  const docId = extractDocId(client.docUrl);
  if (!docId) {
    const err = { code: "malformed_url", message: "Sherpa docUrl is not a recognisable Google Docs URL", at: new Date().toISOString() };
    await writeError(client.id, client.docUrl, null, err);
    return { text: "", source: "none", clientId: client.id, error: err };
  }

  let cacheText = "";
  let cacheMeta = null;
  try {
    const [t, m] = await Promise.all([
      adminGet(`/sherpaCache/${client.id}/text`),
      adminGet(`/sherpaCacheMeta/${client.id}`),
    ]);
    cacheText = typeof t === "string" ? t : "";
    cacheMeta = m && typeof m === "object" ? m : null;
  } catch {
    // Treat unreadable cache as a miss — fetch fresh.
  }

  const driftDetected = cacheMeta && cacheMeta.docId !== docId;

  if (!forceRefresh && cacheText && cacheMeta && !driftDetected && !cacheMeta.error) {
    return {
      text: cacheText,
      source: "cache",
      clientId: client.id,
      fetchedAt: cacheMeta.fetchedAt || null,
    };
  }

  // Skip auto-retry for very-recent failures to keep a broken doc from
  // re-hitting Google on every Brand Truth click. Only applies when we
  // have no good cached text to fall back on — if we have stale text
  // we'd otherwise serve it anyway, so the TTL is moot.
  if (!forceRefresh && !cacheText && cacheMeta?.error && cacheMeta?.lastRetryAt) {
    const sinceRetry = Date.now() - new Date(cacheMeta.lastRetryAt).getTime();
    if (sinceRetry < RETRY_TTL_MS && cacheMeta.docId === docId) {
      return { text: "", source: "none", clientId: client.id, error: cacheMeta.error };
    }
  }

  let fetched;
  try {
    fetched = await fetchGoogleDocText(docId);
  } catch (err) {
    const errRecord = {
      code: err?.code || "fetch_failed",
      message: err?.message || "unknown error",
      at: new Date().toISOString(),
    };
    const transient = errRecord.code === "timeout" || errRecord.code === "rate_limited" || errRecord.code === "fetch_failed";
    if (transient && cacheText && cacheMeta?.docId === docId) {
      // Preserve prior good text, only update meta.
      await adminPatch(`/sherpaCacheMeta/${client.id}`, {
        error: errRecord,
        lastRetryAt: new Date().toISOString(),
      });
      return {
        text: cacheText,
        source: "stale",
        clientId: client.id,
        fetchedAt: cacheMeta?.fetchedAt || null,
        error: errRecord,
      };
    }
    // Terminal: blank cache, surface error.
    await writeError(client.id, client.docUrl, docId, errRecord);
    return { text: "", source: "none", clientId: client.id, error: errRecord };
  }

  const fetchedAt = new Date().toISOString();
  // Write both paths. Sequential is fine — meta is the watched record so
  // the UI updates when it lands, and text being written first means a
  // simultaneous reader can't see stale meta paired with new text.
  await adminSet(`/sherpaCache/${client.id}`, { text: fetched.text });
  await adminSet(`/sherpaCacheMeta/${client.id}`, {
    clientId: client.id,
    fetchedAt,
    sourceUrl: client.docUrl,
    docId,
    byteSize: fetched.byteSize,
    truncated: fetched.truncated,
    lastRetryAt: null,
    error: null,
  });

  return {
    text: fetched.text,
    source: "fresh",
    clientId: client.id,
    fetchedAt,
  };
}

async function writeError(clientId, sourceUrl, docId, errRecord) {
  await adminSet(`/sherpaCache/${clientId}`, { text: "" });
  await adminSet(`/sherpaCacheMeta/${clientId}`, {
    clientId,
    fetchedAt: null,
    sourceUrl: sourceUrl || null,
    docId: docId || null,
    byteSize: 0,
    truncated: false,
    lastRetryAt: new Date().toISOString(),
    error: errRecord,
  });
}

// ─── Prompt block helper ──────────────────────────────────────────
// Builds the "SHERPA DOC (full client brief)" block consumers paste
// into Claude prompts. Empty string when there's no usable text so
// callers can interpolate without conditional logic.
export function buildSherpaPromptBlock(ctx) {
  if (!ctx || !ctx.text) return "";
  return `\nSHERPA DOC (full client brief — authoritative):\n"""\n${ctx.text}\n"""\n`;
}
