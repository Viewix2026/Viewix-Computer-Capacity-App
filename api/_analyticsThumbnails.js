// api/_analyticsThumbnails.js — persist scraped IG thumbnails into
// Firebase Storage so they survive past IG CDN expiry (~hours).
//
// Problem: apify~instagram-scraper returns `displayUrl` for each
// post — a CDN-signed URL that 403s within hours. Storing the raw
// URL meant scoring/dashboard cards rendered empty thumbnail boxes
// the day after a scrape.
//
// Fix: at ingest time, fetch each thumbnail's bytes server-side and
// upload to Firebase Storage at:
//   analytics-thumbnails/{clientId}/{platform}/{videoId}.jpg
// Then store the public Storage URL on post.thumbnail so the
// dashboard never has to talk to IG's CDN directly.
//
// Cost: ~30KB per thumb × 60 posts × 30 clients ≈ 54MB total. At
// Firebase Storage's $0.026/GB-month that's $0.0014/mo — rounding
// error. Bandwidth on view is ~$0.12/GB which still adds up to
// pennies for the pilot's traffic.
//
// Idempotency: callers should skip re-uploading if the post already
// has a Storage URL (we detect by URL prefix). Re-uploading on every
// daily snapshot would waste bandwidth.

import { getStorageBucket } from "./_fb-admin.js";

const STORAGE_URL_PREFIX = "https://storage.googleapis.com/";

// Returns true if the given URL is already a Firebase Storage URL
// (i.e. we've already persisted it — no need to re-upload).
export function isPersistedThumbnailUrl(url) {
  if (!url) return false;
  return String(url).startsWith(STORAGE_URL_PREFIX);
}

// Download a URL's bytes (with a basic IG-friendly UA so the CDN
// doesn't 403 us). Returns null on any failure — caller falls back
// to storing the original (expiring) URL.
async function downloadBytes(url) {
  try {
    const r = await fetch(url, {
      headers: {
        // Plain modern browser UA. IG's CDN doesn't gatekeep on
        // referrer for image bytes; a UA is enough.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 4 * 1024 * 1024) return null; // sanity: 4MB cap
    const contentType = r.headers.get("content-type") || "image/jpeg";
    return { buf, contentType };
  } catch {
    return null;
  }
}

/**
 * Upload a thumbnail's bytes to Firebase Storage and return the
 * public URL. Returns null on any failure — caller decides how to
 * fall back (typically: store the original CDN URL and accept that
 * it'll expire).
 *
 * Storage path: analytics-thumbnails/{clientId}/{platform}/{videoId}.jpg
 *
 * The uploaded object is made public-read so the dashboard can
 * <img src> it without auth. IG thumbnails are already public on
 * IG's CDN; this is the same exposure surface.
 */
export async function persistThumbnail({ clientId, platform, videoId, sourceUrl }) {
  if (!clientId || !platform || !videoId || !sourceUrl) return null;
  if (isPersistedThumbnailUrl(sourceUrl)) return sourceUrl;  // already persisted

  const bucket = getStorageBucket();
  if (!bucket) return null;  // admin SDK not configured

  const downloaded = await downloadBytes(sourceUrl);
  if (!downloaded) return null;

  const objectPath = `analytics-thumbnails/${clientId}/${platform}/${videoId}.jpg`;
  const file = bucket.file(objectPath);
  try {
    await file.save(downloaded.buf, {
      metadata: {
        contentType: downloaded.contentType,
        // Long cache — these objects are immutable per videoId.
        cacheControl: "public, max-age=31536000, immutable",
      },
      resumable: false,
      public: true,
    });
    // Public URL after makePublic / public:true. Same shape as the
    // GCS REST URL.
    return `${STORAGE_URL_PREFIX}${bucket.name}/${objectPath}`;
  } catch (err) {
    console.warn(`[analyticsThumbnails] upload failed for ${objectPath}: ${err.message}`);
    return null;
  }
}

/**
 * Bulk-persist many thumbnails in parallel. Returns a map of
 * videoId → persisted URL (or null on failure for that one). Caller
 * uses the map to rewrite each post.thumbnail before the bulk PATCH.
 *
 * Concurrency capped to avoid hammering IG's CDN — 8 parallel fetches
 * is comfortable and 60 posts × 200ms each ≈ 1.5s total wall-clock.
 */
export async function persistThumbnailsBulk({ clientId, platform, items }) {
  // items: [{ videoId, sourceUrl }]
  if (!Array.isArray(items) || items.length === 0) return {};
  const out = {};
  const LIMIT = 8;
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      const { videoId, sourceUrl } = items[idx];
      out[videoId] = await persistThumbnail({ clientId, platform, videoId, sourceUrl });
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, items.length) }, () => worker()));
  return out;
}
