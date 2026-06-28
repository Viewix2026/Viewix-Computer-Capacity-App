// api/_xero.js
//
// Xero **Custom Connection** client (machine-to-machine OAuth2,
// grant_type=client_credentials) for the Stripe → Xero reconciliation
// bridge. Chosen over standard OAuth2 deliberately: a Custom Connection is
// bound to ONE Xero organisation, issues a short-lived access token with NO
// rotating refresh token and NO user-consent redirect, so there is nothing
// to persist and no rotation race to brick (Codex round-1 #5).
//
// Each cron run fetches a fresh ~30-min token; a single daily run never
// outlives it. Tokens are memoised at module scope only for the life of one
// warm invocation.
//
// Demo and live are SEPARATE Custom Connection apps with separate
// client_id/secret (Codex round-2 #7). Which org a token can touch is fixed
// by the credentials, and we additionally assert the connected org NAME
// matches XERO_ORG_NAME on every run so a stale demo credential can never
// post to live.
//
// Env:
//   XERO_CLIENT_ID, XERO_CLIENT_SECRET — the Custom Connection credentials.
//   XERO_ORG_NAME                      — exact org name to assert (e.g. "Demo Company (AU)").

const TOKEN_URL   = "https://identity.xero.com/connect/token";
const CONN_URL    = "https://api.xero.com/connections";
const API_BASE    = "https://api.xero.com/api.xro/2.0";
const SCOPES      = "accounting.transactions accounting.settings.read accounting.contacts.read";

// Module-scope memo for one warm invocation only. Never persisted.
let _tokenCache = null;   // { accessToken, expiresAt }
let _tenantCache = null;  // { tenantId, tenantName }

export class XeroError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "XeroError";
    this.status = status;
    this.body = body;
  }
}

function creds() {
  const id = process.env.XERO_CLIENT_ID || "";
  const secret = process.env.XERO_CLIENT_SECRET || "";
  if (!id || !secret) throw new XeroError("XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured");
  return { id, secret };
}

// Fetch (or reuse) a client_credentials access token. Refreshes ~60s before
// expiry so a long-ish run can't straddle the boundary.
export async function getXeroToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt - 60_000 > now) return _tokenCache.accessToken;

  const { id, secret } = creds();
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES }),
  });
  const text = await res.text();
  if (!res.ok) throw new XeroError(`token request failed: HTTP ${res.status}`, { status: res.status, body: text });
  let json;
  try { json = JSON.parse(text); } catch { throw new XeroError("token response not JSON", { body: text }); }
  if (!json.access_token) throw new XeroError("token response missing access_token", { body: text });

  _tokenCache = {
    accessToken: json.access_token,
    expiresAt: now + (Number(json.expires_in || 1800) * 1000),
  };
  return _tokenCache.accessToken;
}

// Resolve the tenant for this Custom Connection and assert its org name.
// Custom Connections are single-org; /connections returns exactly one entry.
// Halting on a name mismatch is the demo↔live guard.
export async function getXeroContext() {
  const accessToken = await getXeroToken();
  if (_tenantCache) return { accessToken, ...(_tenantCache) };

  const res = await fetch(CONN_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new XeroError(`connections lookup failed: HTTP ${res.status}`, { status: res.status, body: text });
  let conns;
  try { conns = JSON.parse(text); } catch { throw new XeroError("connections response not JSON", { body: text }); }
  if (!Array.isArray(conns) || conns.length === 0) throw new XeroError("Xero Custom Connection has no tenant");

  const conn = conns[0];
  const expectedName = process.env.XERO_ORG_NAME || "";
  if (expectedName && conn.tenantName && conn.tenantName.trim() !== expectedName.trim()) {
    throw new XeroError(
      `Xero org mismatch: connected to "${conn.tenantName}" but XERO_ORG_NAME="${expectedName}". Refusing to post (demo↔live guard).`
    );
  }
  _tenantCache = { tenantId: conn.tenantId, tenantName: conn.tenantName };
  return { accessToken, ..._tenantCache };
}

// Core request helper. `path` is relative to the Accounting API base
// (e.g. "/Invoices"). Adds auth + tenant + JSON + optional Idempotency-Key.
// Retries ONCE on a 401 with a force-refreshed token (covers a token that
// expired mid-run). Throws XeroError on non-2xx.
export async function xeroRequest(path, { method = "GET", query, body, idempotencyKey } = {}, _retried = false) {
  const { accessToken, tenantId } = await getXeroContext();
  let url = `${API_BASE}${path}`;
  if (query && typeof query === "string") url += `?${query}`;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Xero-tenant-id": tenantId,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();

  if (res.status === 401 && !_retried) {
    _tokenCache = null; // force refresh and retry once
    return xeroRequest(path, { method, query, body, idempotencyKey }, true);
  }
  if (!res.ok) throw new XeroError(`${method} ${path} failed: HTTP ${res.status}`, { status: res.status, body: text });
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new XeroError(`${method} ${path} response not JSON`, { body: text }); }
}

// Build a Xero `where` query string for an exact Reference match, URL-encoded.
// Used as the durable (>24h) idempotency pre-check on Payments + BankTransactions.
export function whereReference(ref) {
  return `where=${encodeURIComponent(`Reference=="${ref}"`)}`;
}

// Test seam: reset the warm-invocation caches between unit tests.
export function __resetXeroCaches() {
  _tokenCache = null;
  _tenantCache = null;
}
