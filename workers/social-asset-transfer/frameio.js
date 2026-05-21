// Frame.io API client — minimal surface for "give me a fresh signed
// CloudFront URL for this file's original media." That's the only
// thing the worker needs from Frame.io. The 24h TTL on the returned
// URL is irrelevant to us because Zernio fetches it within seconds
// during the streaming-upload step (or we download it to /tmp first).

const BASE = "https://api.frame.io/v4";

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

// Returns the original media's download_url (pre-signed CloudFront,
// 24h TTL). The shape Frame.io documents is:
//   { id, name, media_links: { original: { download_url, ... } }, ... }
// We tolerate minor drift by walking both `media_links.original` and
// the deprecated `original` field.
export async function getOriginalMediaUrl(fileId) {
  if (!fileId) throw new Error("getOriginalMediaUrl: fileId required");
  const url = `${BASE}/accounts/${encodeURIComponent(accountId())}/files/${encodeURIComponent(fileId)}?include=media_links.original`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Frame.io GET file ${fileId} ${resp.status}: ${text.slice(0, 300)}`);
    err.code = `FRAMEIO_${resp.status}`;
    err.status = resp.status;
    throw err;
  }
  const json = await resp.json();
  const downloadUrl =
    json?.media_links?.original?.download_url ||
    json?.original?.download_url ||
    null;
  if (!downloadUrl) {
    const err = new Error(`Frame.io file ${fileId} response missing media_links.original.download_url`);
    err.code = "FRAMEIO_NO_DOWNLOAD_URL";
    err.body = json;
    throw err;
  }
  return {
    downloadUrl,
    name: json.name || null,
    versionId: json.current_version_id || json.version_id || null,
    fileType: json.file_type || json.mime_type || null,
    fileSize: typeof json.file_size === "number" ? json.file_size : null,
  };
}
