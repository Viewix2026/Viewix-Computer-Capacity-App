// api/_http.js
//
// Shared `fetchWithTimeout` so every outbound HTTP call (Anthropic,
// OpenAI, Google Docs, Apify, Attio, Slack) has a hard ceiling. Before
// this, none of those calls used `AbortController`, so a slow upstream
// would hang the entire Vercel function until `maxDuration` (60-300s)
// expired — particularly painful for the every-minute flag-flusher,
// where one stalled Anthropic call could stack across the next minute's
// scheduled invocation.
//
// Returns the native `Response`. On timeout, rejects with an
// AbortError whose message includes the URL host so the upstream log
// is actionable. On any other fetch error, re-throws verbatim.

const DEFAULT_TIMEOUT_MS = 20000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      let host = "unknown-host";
      try { host = new URL(url).host; } catch { /* ignore */ }
      const e = new Error(`fetchWithTimeout: ${host} aborted after ${timeoutMs}ms`);
      e.name = "AbortError";
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Common upstream-call sizes. Anthropic / OpenAI typical response is
// under 30s; Google Docs export under 10s. Tune per-call if a specific
// endpoint genuinely needs longer.
export const TIMEOUTS = {
  anthropic: 30000,
  openai: 30000,
  google: 15000,
  apify: 20000,
  attio: 15000,
  slack: 10000,
};
