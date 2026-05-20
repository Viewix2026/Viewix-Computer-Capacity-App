// Zernio media-upload client — separate file from api/_zernio.js
// because this one runs on the Mac Mini, not in Vercel. The Vercel
// wrapper handles metadata-only calls (createPost, getProfile, etc.).
// This wrapper handles the heavy-lifting binary path: ask for a
// presigned upload URL, then PUT the bytes.
//
// Per Zernio docs (verify against live):
//   POST /media/presign
//     body: { content_type, filename }
//     resp: { upload_url, public_url, media_id, expires_at, headers? }
//
// The `upload_url` is a presigned PUT target (usually S3-style). We
// stream the file body to it with whatever headers Zernio specifies
// (typically just Content-Type + Content-Length, but some setups
// require x-amz-* headers — we respect whatever they return in
// `headers`).

const DEFAULT_BASE = "https://api.zernio.com/v1";

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
//     uploadUrl:   string,  // PUT target
//     publicUrl:   string,  // what we hand to Zernio createPost as mediaUrl
//     mediaId:     string,  // Zernio's internal handle (stored for cleanup)
//     headers:     object,  // any required upload headers
//     expiresAt:   number,  // ms epoch — for sanity checks
//   }
export async function presignUpload({ contentType, filename, fileSize } = {}) {
  if (!contentType) throw new Error("presignUpload: contentType required");
  const url = `${baseUrl()}/media/presign`;
  const body = {
    content_type: contentType,
    filename: filename || "asset.mp4",
  };
  if (typeof fileSize === "number") body.file_size = fileSize;
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
    uploadUrl: json.upload_url || json.uploadUrl,
    publicUrl: json.public_url || json.publicUrl || json.url,
    mediaId:   json.media_id   || json.mediaId   || json.id,
    headers:   json.headers    || {},
    expiresAt: json.expires_at || json.expiresAt || null,
  };
}

// PUT the body to the presigned upload URL. Body is a readable stream
// OR a Buffer. Zernio's upload endpoint is the underlying S3-style PUT;
// it expects Content-Length for chunked uploads on most configurations.
export async function uploadToPresigned({ uploadUrl, body, contentType, contentLength, extraHeaders }) {
  if (!uploadUrl) throw new Error("uploadToPresigned: uploadUrl required");
  if (body == null) throw new Error("uploadToPresigned: body required");
  const headers = {
    "Content-Type": contentType || "application/octet-stream",
    ...(extraHeaders || {}),
  };
  if (typeof contentLength === "number") {
    headers["Content-Length"] = String(contentLength);
  }
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body,
    // Node fetch needs this for stream bodies in newer versions
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
