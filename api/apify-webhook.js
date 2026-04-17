// api/apify-webhook.js
// Receives Apify's ACTOR.RUN.* callbacks when an async scrape finishes.
//
// Apify posts this shape (we configure it as the payload template when
// starting a run — see startApifyRun in api/social-organic.js):
//   { runId, status: "SUCCEEDED"|"FAILED"|..., datasetId }
//
// Secret is passed as a query param (?secret=...) so we can verify the
// caller without Apify signing logic. Set APIFY_WEBHOOK_SECRET in Vercel.
//
// Routing: we persisted a sidecar at /preproduction/socialOrganic/_apifyRuns/{runId}
// at start-time with { projectId, purpose } — this tells us where the
// dataset items belong and how to interpret them.
//
// Purposes:
//   clientPosts       — reels from the client's own IG; update clientScrape.posts
//   clientProfileIG   — IG profile; update clientScrape.profile.followers.instagram
//   clientProfileTT   — TikTok profile; update clientScrape.profile.followers.tiktok
//   clientProfileYT   — YouTube channel; update clientScrape.profile.followers.youtube
//   competitorPosts   — classify inline, write competitorScrape.posts + handleStats

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const APIFY_BASE = "https://api.apify.com/v2";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

// Pull dataset items in pages. Apify caps at 1000 per page; client posts
// and competitor scrapes are well under that but code defensively.
async function fetchDatasetItems(datasetId, token) {
  const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true&limit=500`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Apify dataset ${r.status}: ${body.slice(0, 300)}`);
  }
  return await r.json();
}

// Mirror of normaliseInstagramPost in api/social-organic.js — inlined here
// to avoid a cross-file import (Vercel can't split imports across routes
// cleanly without rollup config tweaks).
function normaliseInstagramPost(raw, handleHint) {
  const id = raw.shortCode ? `ig_${raw.shortCode}` : `ig_${Math.random().toString(36).slice(2, 10)}`;
  const owner = raw.ownerUsername || raw.owner?.username || handleHint || "unknown";
  const isVideo = raw.isVideo ?? (raw.type === "Video") ?? false;
  const views = raw.videoViewCount ?? raw.videoPlayCount ?? null;
  const likes = raw.likesCount ?? 0;
  const comments = raw.commentsCount ?? 0;
  const followers = raw.ownerFollowersCount ?? raw.owner?.followersCount ?? null;
  const engagementRate = followers && followers > 0 ? +(((likes + comments) / followers) * 100).toFixed(3) : null;
  return {
    id,
    handle: `@${owner.toLowerCase()}`,
    url: raw.url || `https://www.instagram.com/p/${raw.shortCode}/`,
    shortCode: raw.shortCode,
    type: raw.type,
    isVideo,
    thumbnail: raw.displayUrl || null,
    caption: raw.caption || "",
    timestamp: raw.timestamp,
    views,
    likes,
    comments,
    engagementRate,
    overperformanceScore: null,
  };
}

// Handle key sanitiser — dotted handles (e.g. @mannix.squiers) blow up
// Firebase keys. Same shape as api/social-organic.js:fbSafeHandleKey.
function fbSafeHandleKey(handle) {
  return String(handle || "").replace(/[.#$/\[\]]/g, "_");
}

function computeHandleStatsAndScore(posts) {
  const byHandle = {};
  posts.forEach(p => {
    if (!byHandle[p.handle]) byHandle[p.handle] = [];
    byHandle[p.handle].push(p);
  });
  const stats = {};
  Object.entries(byHandle).forEach(([handle, group]) => {
    const views = group.map(g => g.views || 0).filter(v => v > 0).sort((a, b) => a - b);
    const likes = group.map(g => g.likes || 0);
    const avgViews = views.length ? views.reduce((s, v) => s + v, 0) / views.length : 0;
    const avgLikes = likes.reduce((s, v) => s + v, 0) / (likes.length || 1);
    const medianViews = views.length ? views[Math.floor(views.length / 2)] : 0;
    stats[fbSafeHandleKey(handle)] = {
      handle,
      avgViews: Math.round(avgViews),
      avgLikes: Math.round(avgLikes),
      medianViews: Math.round(medianViews),
      postCount: group.length,
    };
    const baseline = medianViews || avgViews || 1;
    group.forEach(p => {
      p.overperformanceScore = p.views ? +((p.views / baseline)).toFixed(2) : null;
    });
  });
  return stats;
}

// Extract a follower count from each scraper's profile payload. Every actor
// returns a slightly different shape; we try known fields in order and fall
// back to null. Log unknown shapes so we can extend here later.
function extractFollowerCount(items, purpose) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0];
  if (purpose === "clientProfileIG") {
    return first.followersCount ?? first.followers ?? first.edge_followed_by?.count ?? null;
  }
  if (purpose === "clientProfileTT") {
    // clockworks/tiktok-profile-scraper: "fans" on authorMeta, or "followerCount"
    return first.authorMeta?.fans ?? first.followerCount ?? first.followers ?? null;
  }
  if (purpose === "clientProfileYT") {
    // streamers/youtube-channel-info returns "subscriberCount" on channel object
    return first.subscriberCount ?? first.numberOfSubscribers ?? first.subscribers ?? null;
  }
  return null;
}

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const SECRET = process.env.APIFY_WEBHOOK_SECRET;
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!SECRET) return res.status(500).json({ error: "APIFY_WEBHOOK_SECRET not configured" });
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const providedSecret = req.query.secret;
  if (providedSecret !== SECRET) {
    return res.status(401).json({ error: "Invalid secret" });
  }

  try {
    const payload = req.body || {};
    const runId = payload.runId || payload.resource?.id || req.query.runId;
    const status = payload.status || payload.resource?.status || "SUCCEEDED";
    const datasetId = payload.datasetId || payload.resource?.defaultDatasetId;

    if (!runId) return res.status(400).json({ error: "Missing runId" });

    const sidecar = await fbGet(`/preproduction/socialOrganic/_apifyRuns/${runId}`);
    if (!sidecar || !sidecar.projectId || !sidecar.purpose) {
      console.warn(`[apify-webhook] No sidecar for run ${runId} — ignoring`);
      return res.status(200).json({ ignored: true, reason: "no_sidecar" });
    }
    const { projectId, purpose } = sidecar;

    // Failure paths: flip status to "error" on the project so the UI surfaces
    // a retry affordance. We also record which purpose failed.
    if (status !== "SUCCEEDED") {
      console.warn(`[apify-webhook] Run ${runId} ended with status ${status} for ${projectId}/${purpose}`);
      const errField = purpose.startsWith("client") ? "clientScrape" : "competitorScrape";
      await fbPatch(`/preproduction/socialOrganic/${projectId}/${errField}`, {
        status: "error",
        error: `Apify run ${status}`,
        finishedAt: new Date().toISOString(),
      });
      await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
      return res.status(200).json({ ok: true, outcome: "marked_error" });
    }

    if (!datasetId) {
      console.warn(`[apify-webhook] Run ${runId} has no datasetId — Apify may still be finalising`);
      return res.status(200).json({ ok: true, outcome: "no_dataset" });
    }

    const items = await fetchDatasetItems(datasetId, APIFY_TOKEN);
    console.log(`[apify-webhook] ${purpose} run ${runId}: ${items.length} items`);

    // Route by purpose. Each branch is self-contained so adding a new purpose
    // doesn't need to touch the others.
    if (purpose === "clientPosts") {
      const handle = sidecar.handle || "";
      const posts = items.map(raw => normaliseInstagramPost(raw, handle)).filter(p => p.isVideo);  // reels only
      const views = posts.map(p => p.views || 0).filter(v => v > 0).sort((a, b) => a - b);
      const avgViews = views.length ? Math.round(views.reduce((s, v) => s + v, 0) / views.length) : 0;
      const medianViews = views.length ? views[Math.floor(views.length / 2)] : 0;
      const topByViews = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5).map(p => p.id);
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape`, {
        posts,
        topByViews,
        "profile/avgViews": avgViews,
        "profile/medianViews": medianViews,
      });
      // Firebase adminPatch doesn't support nested-slash keys in the same
      // call as direct keys reliably — explicitly patch the profile sub-path.
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile`, {
        avgViews, medianViews,
      });
    } else if (purpose === "clientProfileIG") {
      const followers = extractFollowerCount(items, purpose);
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, {
        instagram: followers,
      });
    } else if (purpose === "clientProfileTT") {
      const followers = extractFollowerCount(items, purpose);
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, {
        tiktok: followers,
      });
    } else if (purpose === "clientProfileYT") {
      const followers = extractFollowerCount(items, purpose);
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, {
        youtube: followers,
      });
    } else if (purpose === "competitorPosts") {
      const posts = items.map(raw => normaliseInstagramPost(raw, null));
      const handleStats = computeHandleStatsAndScore(posts);
      const topOverperformers = [...posts]
        .filter(p => p.isVideo && p.overperformanceScore != null)
        .sort((a, b) => (b.overperformanceScore || 0) - (a.overperformanceScore || 0))
        .slice(0, 25)
        .map(p => p.id);
      await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, {
        posts,
        handleStats,
        topOverperformers,
      });
      // Classification happens lazily in Tab 4 via the existing `classify`
      // action — we don't block the scrape-finished webhook on a 30-60s
      // Claude call. The UI can surface "classifying…" if the producer
      // clicks the Classify button.
    } else {
      console.warn(`[apify-webhook] Unknown purpose ${purpose} for run ${runId}`);
    }

    // Check whether this completion brings the scrape bundle to "done".
    // Client scrape has multiple runs (posts + profile per platform); we
    // only flip status to "done" once the main `posts` run is in. Follower
    // counts are nice-to-haves and shouldn't block the tab gate.
    const bundleKey = purpose.startsWith("client") ? "clientScrape" : "competitorScrape";
    if (purpose === "clientPosts" || purpose === "competitorPosts") {
      await fbPatch(`/preproduction/socialOrganic/${projectId}/${bundleKey}`, {
        status: "done",
        finishedAt: new Date().toISOString(),
      });
    }

    await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
    return res.status(200).json({ ok: true, items: items.length, purpose });
  } catch (err) {
    console.error("apify-webhook error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
