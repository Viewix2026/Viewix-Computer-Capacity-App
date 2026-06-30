// src/lib/thumbCache.js — client resolver for permanent reel/post stills.
//
// Server (api/_thumbCache.js) self-hosts IG/TikTok stills as base64 in
// /thumbCache/{platform}/{videoId}; YouTube needs no cache (hqdefault is
// permanent). This module turns a reel URL into the best poster src for a card:
//
//   YouTube hqdefault (permanent)  >  cached base64 still  >  the (maybe-expired)
//   scraped thumbnail  >  null (caller shows the branded gradient).
//
// HARD RULE: read /thumbCache by *exact child key only* (one fbGet per still),
// never attach a listener to the parent — that would stream every cached still
// at once. `loadCached` enforces this and memoises so each key is fetched once
// per session regardless of how many cards reference it.

import { useEffect, useState } from "react";
import { fbGet, authFetch } from "../firebase";
import { youTubeIdFromUrl } from "../components/shared/ReelPreview";

// Derive { platform, videoId } for the cacheable providers, or null.
// Mirrors api/_thumbCache.js#thumbKeyFromUrl — keep the two in sync.
export function thumbKeyFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const ig = s.match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (ig) return { platform: "ig", videoId: ig[1] };
  const tt = s.match(/tiktok\.com\/(?:@[^/]+\/)?video\/(\d+)/i);
  if (tt) return { platform: "tiktok", videoId: tt[1] };
  return null;
}

// Permanent YouTube still, or null. hqdefault is the reliable size
// (maxresdefault 404s for low-res uploads).
export function youTubePoster(url) {
  const id = youTubeIdFromUrl(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

// Stills are immutable per videoId, so a hit is cached for the whole session.
// A MISS is deliberately NOT cached: a card can render before its fire-and-forget
// capture write lands, and we want a later mount to re-read and upgrade rather
// than be stuck on the gradient until a full reload. `inflight` dedupes
// concurrent reads of the same key so many cards don't each fire an fbGet.
const resolved = new Map(); // key "platform/videoId" -> dataUri (hits only)
const inflight = new Map(); // key -> Promise<dataUri|null>
function loadCached(platform, videoId) {
  const k = `${platform}/${videoId}`;
  if (resolved.has(k)) return Promise.resolve(resolved.get(k));
  if (inflight.has(k)) return inflight.get(k);
  const p = fbGet(`/thumbCache/${platform}/${videoId}`)
    .then((r) => {
      const data = (r && r.data) || null;
      if (data) resolved.set(k, data);
      inflight.delete(k);
      return data;
    })
    .catch(() => { inflight.delete(k); return null; });
  inflight.set(k, p);
  return p;
}

// Synchronous best-guess used for SSR/first paint and by non-hook callers
// (e.g. pickPoster): YouTube hqdefault if derivable, else the supplied fallback
// (which may be an expiring URL), else null. The hook upgrades this to the
// cached still once it loads.
export function posterSrcSync(url, fallbackThumb = null) {
  return youTubePoster(url) || fallbackThumb || null;
}

/**
 * Resolve the best poster src for a reel/post url. Returns YouTube hqdefault
 * synchronously; for IG/TikTok it lazily loads the cached base64 still and
 * upgrades, falling back to `fallbackThumb` (the scraped, maybe-expired URL)
 * until/unless a cached still is found. Returns null when nothing is available
 * so the caller can render its gradient placeholder.
 */
export function useCachedPoster(url, fallbackThumb = null) {
  const yt = youTubePoster(url);
  const key = yt ? null : thumbKeyFromUrl(url);
  const platform = key?.platform || null;
  const videoId = key?.videoId || null;
  const [cached, setCached] = useState(null);

  useEffect(() => {
    if (!platform || !videoId) { setCached(null); return; }
    let alive = true;
    loadCached(platform, videoId).then((d) => { if (alive) setCached(d); });
    return () => { alive = false; };
  }, [platform, videoId]);

  if (yt) return yt;
  return cached || fallbackThumb || null;
}

// Fire-and-forget capture for freshly-added examples. `entries` is
// [{ url, knownStill? }] — pass the scraped thumbnail as knownStill when you
// have a fresh one so the server can skip an Apify refresh. Never throws.
export function captureThumbnails(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === "string" ? { url: e } : e))
    .filter((e) => e && e.url);
  if (!list.length) return;
  try {
    authFetch("/api/social-organic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "captureThumbnails", entries: list.slice(0, 60) }),
    }).catch(() => {});
  } catch {
    /* best-effort — a failed capture just leaves the gradient fallback */
  }
}
