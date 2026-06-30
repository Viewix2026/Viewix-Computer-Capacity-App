// api/_thumbCache.js — permanent reel/post stills, self-hosted as base64 in RTDB.
//
// Problem: Apify's instagram-scraper returns `displayUrl` — a CDN-signed URL
// that 403s within hours. Storing the raw URL means cards render blank a day
// after a scrape. TikTok oEmbed thumbnails expire the same way. (YouTube is the
// exception — `i.ytimg.com/.../hqdefault.jpg` is permanent and free, so we never
// cache YouTube; callers derive it at render time.)
//
// Fix: while a provider URL is still valid (at scrape, at example-add, or via an
// Apify refresh), download the bytes server-side and store a small base64 JPEG
// at:
//   /thumbCache/{platform}/{videoId} = { data, bytes, sourceUrl, capturedAt }
//
// Why base64-in-RTDB and not Firebase Storage / Vercel Blob:
//   - Firebase Storage forces a Blaze upgrade (PR #128 reverted exactly that).
//   - Vercel Blob works but adds a vendor + token and lands on the Vercel
//     on-demand meter. At this scale (dozens-to-low-hundreds of formats, stills
//     ~30-80KB) base64 in a *separate* RTDB node is free, self-contained (the
//     data URI travels with an exported proposal), and mirrors the Motion
//     Graphics image-slot precedent.
//
// HARD RULE for callers: read /thumbCache by *exact child key only* — never
// attach a listener to the /thumbCache parent or to /thumbCache/{platform}.
// Pulling the whole node would stream every still at once (the one real hazard
// at this scale). The client hook in src/lib/thumbCache.js enforces this.

import { adminGet, adminSet } from "./_fb-admin.js";

// Cap a single cached still. IG stills are typically ~30-80KB; a hard ceiling
// keeps any one RTDB value tiny (well under the 10MB string limit) and stops a
// freak full-res image from bloating the node. We deliberately do NOT pull in
// `sharp` to downscale — a byte cap + skip-if-over keeps this dependency-free.
// Sources over the cap are skipped (logged, left to the gradient fallback)
// rather than stored oversized.
export const MAX_THUMB_BYTES = 200 * 1024; // 200KB of raw image bytes

// Derive { platform, videoId } for the cacheable providers, or null.
// - Instagram /p/ /reel/ /reels/  -> { platform: "ig", videoId: <shortCode> }
// - TikTok     /video/<digits>    -> { platform: "tiktok", videoId: <id> }
// - YouTube                       -> null  (permanent hqdefault, never cached)
// - anything else                 -> null
// Returned videoIds are RTDB-key-safe: IG shortcodes are [A-Za-z0-9_-] and
// TikTok ids are digits — neither contains the forbidden . $ # [ ] / chars.
export function thumbKeyFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const ig = s.match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (ig) return { platform: "ig", videoId: ig[1] };
  const tt = s.match(/tiktok\.com\/(?:@[^/]+\/)?video\/(\d+)/i);
  if (tt) return { platform: "tiktok", videoId: tt[1] };
  return null;
}

// Mirror of ReelPreview.youTubeIdFromUrl — used here only to *skip* YouTube
// (its still is permanent and free, so it never needs caching).
export function youTubeIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i
  );
  return m ? m[1] : null;
}

// We only ever download stills from these provider CDNs. Restricting the fetch
// target to this allowlist closes the SSRF hole: a caller-supplied `knownStill`
// can't make the server fetch an internal/metadata URL. (YouTube is never
// downloaded — its hqdefault is derived at render — so ytimg isn't listed.)
const ALLOWED_STILL_HOST_SUFFIXES = [
  "cdninstagram.com", "fbcdn.net",                                  // Instagram / FB CDN
  "tiktokcdn.com", "tiktokcdn-us.com", "ibyteimg.com", "ttwstatic.com", // TikTok CDNs
];

// True only for an https URL on an allowlisted provider CDN host. Rejects
// literal IP hosts (blocks private/loopback/link-local SSRF targets) and any
// non-provider host. Hostname-based: an attacker can't point cdninstagram.com
// at an internal IP without controlling DNS for that domain.
export function isAllowedImageHost(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false; // IPv4 / IPv6 literal
  return ALLOWED_STILL_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

// Download a still's bytes from an allowlisted provider CDN with a browser-ish
// UA (IG's CDN 403s some default agents). Returns { buf, contentType } or null
// on any failure. Hardened: provider-host allowlist (SSRF), an 8s timeout, an
// up-front Content-Length reject, a streaming read that aborts the moment it
// exceeds the cap (so a multi-MB body is never fully buffered), and a magic-byte
// check that ignores the header (a CDN error page mislabelled image/jpeg won't
// get cached).
export async function downloadImageBytes(url, { maxBytes = MAX_THUMB_BYTES } = {}) {
  if (!url || !isAllowedImageHost(url)) return null;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
      // Don't follow redirects: the allowlist only vetted the INITIAL host, so a
      // 30x to a non-allowlisted/internal host would otherwise slip the SSRF
      // guard. Provider CDN stills are served directly (200), so this never
      // costs us a real thumbnail — a redirecting URL just falls back to gradient.
      redirect: "error",
    });
    if (!r.ok) return null;
    const declared = Number(r.headers.get("content-length"));
    if (declared && declared > maxBytes) return null;

    let buf;
    const reader = r.body && typeof r.body.getReader === "function" ? r.body.getReader() : null;
    if (reader) {
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
        chunks.push(Buffer.from(value));
      }
      buf = Buffer.concat(chunks, total);
    } else {
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) return null;
    }
    if (buf.length === 0) return null;
    const contentType = sniffImageType(buf);
    if (!contentType) return null; // not a recognised image — don't cache it
    return { buf, contentType };
  } catch {
    return null;
  }
}

// Magic-byte sniff for the formats IG/TikTok/YouTube CDNs actually serve.
// Beats trusting Content-Type (CDNs sometimes mislabel) and rejects HTML error
// bodies. Returns a MIME string or null.
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  // WEBP: "RIFF"...."WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

// Build a `data:` URI from downloaded bytes, or null if over the cap.
export function toDataUri(buf, contentType, { maxBytes = MAX_THUMB_BYTES } = {}) {
  if (!buf || buf.length === 0 || buf.length > maxBytes) return null;
  const ct = contentType && contentType.startsWith("image/") ? contentType : "image/jpeg";
  return `data:${ct};base64,${buf.toString("base64")}`;
}

const cachePath = (platform, videoId) => `/thumbCache/${platform}/${videoId}`;

// Read a single cached still by exact key. Never reads a parent node.
export async function getCachedThumb(platform, videoId) {
  if (!platform || !videoId) return null;
  return (await adminGet(cachePath(platform, videoId))) || null;
}

/**
 * Idempotently persist a still into /thumbCache/{platform}/{videoId}.
 *
 *  - If a cache entry already exists, returns it untouched (no re-download).
 *  - Otherwise downloads `stillUrl`'s bytes, validates + caps them, writes the
 *    base64 record, and returns it.
 *  - Returns { skipped:true } when there's nothing cacheable (download failed /
 *    over cap), so callers can record an audit miss without throwing.
 *
 * `sourceUrl` is the canonical post URL (for provenance / re-resolve); `stillUrl`
 * is the actual image URL to fetch (often the same, but for an Apify refresh the
 * stillUrl is the fresh displayUrl while sourceUrl stays the reel link).
 */
export async function persistThumb({ platform, videoId, sourceUrl, stillUrl, capturedAt }) {
  if (!platform || !videoId) return { skipped: true, reason: "no-key" };
  const existing = await getCachedThumb(platform, videoId);
  if (existing && existing.data) return { ...existing, cached: false, alreadyHad: true };

  const dl = await downloadImageBytes(stillUrl || sourceUrl);
  if (!dl) return { skipped: true, reason: "download-failed" };
  const data = toDataUri(dl.buf, dl.contentType);
  if (!data) return { skipped: true, reason: "over-cap" };

  const record = {
    data,
    bytes: dl.buf.length,
    sourceUrl: sourceUrl || stillUrl || null,
    capturedAt: capturedAt || new Date().toISOString(),
  };
  await adminSet(cachePath(platform, videoId), record);
  return { ...record, cached: true };
}

// Resolve a fresh still URL for a TikTok post via its public oEmbed endpoint
// (no token required). The returned thumbnail_url is itself a CDN URL that
// expires — caller downloads it immediately. Returns null on any failure.
export async function resolveTikTokStillUrl(postUrl) {
  if (!postUrl) return null;
  try {
    const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(postUrl)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ViewixDashboard/1.0)" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j.thumbnail_url === "string" ? j.thumbnail_url : null;
  } catch {
    return null;
  }
}
