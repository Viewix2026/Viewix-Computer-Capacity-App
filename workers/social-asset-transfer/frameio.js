// Frame.io API client — minimal surface for "give me a fresh signed
// CloudFront URL for this file's original media." That's the only
// thing the worker needs from Frame.io. The 24h TTL on the returned
// URL is irrelevant to us because Zernio fetches it within seconds
// during the streaming-upload step (or we download it to /tmp first).

const BASE = "https://api.frame.io/v4";

// ─── Auth mode ──────────────────────────────────────────────────────
// Viewix's Frame.io account is V4-migrated AND Frame-managed (it is NOT
// administered through the Adobe Admin Console — verified 2026-05-21).
// The supported auth path for that account type is a *Legacy Developer
// Token*: a non-expiring token generated on the Frame.io developer site
// that authenticates against the V4 API ONLY when the request also
// carries the header `x-frameio-legacy-token-auth: true`. Confirmed live
// (`GET /v4/accounts` → 200 with that header).
//
//   FRAMEIO_AUTH_MODE=legacy (default) — Bearer token + the legacy header.
//   FRAMEIO_AUTH_MODE=s2s              — Adobe IMS Server-to-Server. NOT
//     implemented. Only relevant if the Frame.io account is ever moved
//     under the Adobe Admin Console; selecting it throws rather than
//     silently misbehaving.
function authMode() {
  return (process.env.FRAMEIO_AUTH_MODE || "legacy").toLowerCase();
}

function token() {
  const t = process.env.FRAMEIO_DEVELOPER_TOKEN;
  if (!t) {
    const err = new Error("FRAMEIO_DEVELOPER_TOKEN env var not set");
    err.code = "FRAMEIO_NO_TOKEN";
    throw err;
  }
  return t;
}

function accountId() {
  const a = process.env.FRAMEIO_ACCOUNT_ID;
  if (!a) {
    const err = new Error("FRAMEIO_ACCOUNT_ID env var not set");
    err.code = "FRAMEIO_NO_ACCOUNT";
    throw err;
  }
  return a;
}

// Build the auth headers for a V4 request based on FRAMEIO_AUTH_MODE.
// Centralised so every Frame.io call (worker + preflight) signs the
// same way and a future S2S switch lands in one place.
export function authHeaders() {
  const mode = authMode();
  if (mode === "legacy") {
    return {
      Authorization: `Bearer ${token()}`,
      // REQUIRED for legacy developer tokens to work on the V4 API.
      "x-frameio-legacy-token-auth": "true",
      Accept: "application/json",
    };
  }
  if (mode === "s2s") {
    const err = new Error(
      "FRAMEIO_AUTH_MODE=s2s (Adobe IMS Server-to-Server) is not implemented. " +
      "Viewix's account is Frame-managed — use FRAMEIO_AUTH_MODE=legacy. S2S only " +
      "becomes relevant if the Frame.io account is migrated under the Adobe Admin Console."
    );
    err.code = "FRAMEIO_S2S_NOT_IMPLEMENTED";
    throw err;
  }
  const err = new Error(`Unknown FRAMEIO_AUTH_MODE "${mode}" (expected "legacy" or "s2s")`);
  err.code = "FRAMEIO_BAD_AUTH_MODE";
  throw err;
}

// List the accounts this token can see (GET /v4/accounts). The worker
// proper doesn't need this — it's here so preflight-frameio.mjs can
// prove auth and surface the account id without a file id in hand.
export async function getAccounts() {
  const resp = await fetch(`${BASE}/accounts`, { headers: authHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Frame.io GET /accounts ${resp.status}: ${text.slice(0, 300)}`);
    err.code = `FRAMEIO_${resp.status}`;
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Returns the original media's download_url (pre-signed CloudFront,
// 24h TTL). The shape Frame.io documents is:
//   { id, name, media_links: { original: { download_url, ... } }, ... }
// We tolerate minor drift by walking both `media_links.original` and
// the deprecated `original` field.
export async function getOriginalMediaUrl(fileId) {
  if (!fileId) throw new Error("getOriginalMediaUrl: fileId required");
  const url = `${BASE}/accounts/${encodeURIComponent(accountId())}/files/${encodeURIComponent(fileId)}?include=media_links.original`;
  const resp = await fetch(url, { headers: authHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Frame.io GET file ${fileId} ${resp.status}: ${text.slice(0, 300)}`);
    err.code = `FRAMEIO_${resp.status}`;
    err.status = resp.status;
    throw err;
  }
  const json = await resp.json();
  // V4 wraps the entity in a `data` envelope (same shape GET /v4/accounts
  // returns). Read media_links + metadata from `data`; tolerate a bare
  // object too, in case of response-shape drift.
  const file = json?.data || json;
  const downloadUrl =
    file?.media_links?.original?.download_url ||
    file?.original?.download_url ||
    null;
  if (!downloadUrl) {
    const err = new Error(`Frame.io file ${fileId} response missing data.media_links.original.download_url`);
    err.code = "FRAMEIO_NO_DOWNLOAD_URL";
    err.body = json;
    throw err;
  }
  return {
    downloadUrl,
    name: file.name || null,
    versionId: file.current_version_id || file.version_id || null,
    fileType: file.file_type || file.media_type || file.mime_type || null,
    fileSize: typeof file.file_size === "number" ? file.file_size : null,
  };
}
