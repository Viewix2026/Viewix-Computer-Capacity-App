// Zernio media-upload client — separate file from api/_zernio.js
// because this one runs on the Mac Mini, not in Vercel. The Vercel
// wrapper handles metadata-only calls (createPost, getProfile, etc.).
// This wrapper handles the heavy-lifting binary path: ask for a
// presigned upload URL, then PUT the bytes.
//
// RECONCILED against the real Zernio contract (llms.txt, 2026-05-21):
//   POST /media/presign
//     body: { filename, contentType }
//     resp: { uploadUrl, publicUrl, expires }
//   Then PUT the file bytes to `uploadUrl` (S3/GCS-style presigned PUT,
//   up to 5GB). `publicUrl` is the durable handle we hand to Zernio
//   createPost as the media URL — the bytes now live in Zernio's own
//   store, so there's no Frame.io URL-expiry risk at publish time.
//
// Base URL is https://zernio.com/api/v1 (NOT api.zernio.com).

const DEFAULT_BASE = "https://zernio.com/api/v1";

function baseUrl() {
  return process.env.ZERNIO_BASE_URL || DEFAULT_BASE;
}

function apiKey() {
  const k = process.env.ZERNIO_API_KEY;
  if (!k) {
    const err = new Error("ZERNIO_API_KEY env var not set");
    err.code = "ZERNIO_NO_API_KEY";
    throw err;
  }
  return k;
}

// Request a presigned upload target. Returns:
//   {
//     uploadUrl:  string,  // PUT target
//     publicUrl:  string,  // hand to createPost as the media URL
//     expires:    string|number|null,  // presign TTL — sanity only
//   }
export async function presignUpload({ fileType, fileName } = {}) {
  if (!fileType) throw new Error("presignUpload: fileType required");
  const url = `${baseUrl()}/media/presign`;
  const body = {
    filename: fileName || "asset.mp4",
    contentType: fileType,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Zernio presign ${resp.status}: ${text.slice(0, 300)}`);
    err.code = `ZERNIO_PRESIGN_${resp.status}`;
    throw err;
  }
  const json = await resp.json();
  return {
    uploadUrl: json.uploadUrl || json.upload_url,
    publicUrl: json.publicUrl || json.public_url || json.url,
    expires:   json.expires   || json.expiresAt || json.expires_at || null,
  };
}

// PUT the body to the presigned upload URL. Body is a readable stream
// OR a Buffer. The presigned PUT is the underlying S3/GCS target; it
// expects Content-Type and (for stream bodies) Content-Length.
export async function uploadToPresigned({ uploadUrl, body, contentType, contentLength }) {
  if (!uploadUrl) throw new Error("uploadToPresigned: uploadUrl required");
  if (body == null) throw new Error("uploadToPresigned: body required");
  const headers = {
    "Content-Type": contentType || "application/octet-stream",
  };
  if (typeof contentLength === "number") {
    headers["Content-Length"] = String(contentLength);
  }
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body,
    // Node fetch needs this for stream bodies in newer versions.
    duplex: "half",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Zernio upload PUT ${resp.status}: ${text.slice(0, 300)}`);
    err.code = `ZERNIO_UPLOAD_${resp.status}`;
    throw err;
  }
  return { ok: true };
}
