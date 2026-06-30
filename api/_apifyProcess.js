// Shared helper: take a completed Apify run + its sidecar, fetch the
// dataset items, route them to the right Firebase paths, delete the
// sidecar. Used by:
//   - api/apify-webhook.js  (when Apify's direct callback hits us)
//   - api/social-organic.js (when the frontend's auto-poll refreshes)
//
// Keeping this module HTTP-free means the refresh path doesn't need
// Vercel Deployment Protection disabled — it just calls JS directly.

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

async function fetchDatasetItems(datasetId, token) {
  const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true&limit=500`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Apify dataset ${r.status}: ${body.slice(0, 300)}`);
  }
  return await r.json();
}

// Webhook callback URL for fallback runs we fire from here. Mirrors
// apifyWebhookBase() in social-organic.js — kept local so this module
// stays HTTP-free and doesn't import (and circular-depend on) that file.
function apifyWebhookBase() {
  const fromEnv = process.env.APIFY_WEBHOOK_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return "https://planner.viewix.com.au";
}

// Fire an async Apify run + write a sidecar so the webhook can route the
// callback back to this project + purpose. Minimal twin of social-organic.js's
// startApifyRun, used only for the in-process IG follower fallback below.
// Returns the runId, or throws.
async function startApifyRunFallback({ actorId, input, token, projectId, purpose, extraSidecar = {} }) {
  const SECRET = process.env.APIFY_WEBHOOK_SECRET;
  if (!SECRET) throw new Error("APIFY_WEBHOOK_SECRET not configured");
  const webhookUrl = `${apifyWebhookBase()}/api/apify-webhook?secret=${encodeURIComponent(SECRET)}`;
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
    requestUrl: webhookUrl,
    payloadTemplate: `{"runId":"{{resource.id}}","status":"{{resource.status}}","datasetId":"{{resource.defaultDatasetId}}"}`,
  }];
  const webhooksB64 = Buffer.from(JSON.stringify(webhooks)).toString("base64");
  const url = `${APIFY_BASE}/acts/${actorId}/runs?token=${encodeURIComponent(token)}&webhooks=${encodeURIComponent(webhooksB64)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Apify run start ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const runId = data.data?.id;
  if (!runId) throw new Error("Apify didn't return a run id");
  await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, {
    projectId, purpose, actorId,
    startedAt: new Date().toISOString(),
    ...extraSidecar,
  });
  return runId;
}

// Recursively replace every `undefined` with `null` — Firebase rejects
// undefined values, but accepts null. Saves us from having to remember
// `?? null` on every single field.
function cleanUndefined(obj) {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = cleanUndefined(v);
  return out;
}

function normaliseInstagramPost(raw, handleHint) {
  const shortCode = raw.shortCode || raw.shortcode || null;
  const id = shortCode ? `ig_${shortCode}` : `ig_${Math.random().toString(36).slice(2, 10)}`;
  const owner = raw.ownerUsername || raw.owner?.username || handleHint || "unknown";
  const isVideo = raw.isVideo ?? (raw.type === "Video") ?? false;
  const views = raw.videoViewCount ?? raw.videoPlayCount ?? null;
  const likes = raw.likesCount ?? 0;
  const comments = raw.commentsCount ?? 0;
  const followers = raw.ownerFollowersCount ?? raw.owner?.followersCount ?? null;
  const engagementRate = followers && followers > 0 ? +(((likes + comments) / followers) * 100).toFixed(3) : null;
  // Diagnostic logging gated on APIFY_DEBUG so producers can verify
  // scraped numbers against instagram.com for one handle without
  // permanently spamming Vercel logs. Dumps raw keys + extracted
  // engagement so a field rename in Apify's response shows up
  // immediately. Set env APIFY_DEBUG=true on the Vercel project,
  // re-scrape the affected handle, pull the logs.
  if (process.env.APIFY_DEBUG === "true") {
    console.log("apifyProcess.normaliseInstagramPost", JSON.stringify({
      shortCode,
      owner,
      isVideo,
      extracted: { views, likes, comments, followers, engagementRate },
      rawCandidateKeys: {
        videoViewCount: raw.videoViewCount ?? null,
        videoPlayCount: raw.videoPlayCount ?? null,
        viewsCount: raw.viewsCount ?? null,
        playCount: raw.playCount ?? null,
        likesCount: raw.likesCount ?? null,
        commentsCount: raw.commentsCount ?? null,
        ownerFollowersCount: raw.ownerFollowersCount ?? null,
      },
    }));
  }
  // Every field defaulted to a non-undefined value. Firebase-safe out of
  // the box, no post-processing required.
  return {
    id,
    handle: `@${owner.toLowerCase()}`,
    url: raw.url || (shortCode ? `https://www.instagram.com/p/${shortCode}/` : null),
    shortCode: shortCode || null,
    type: raw.type || null,
    isVideo: !!isVideo,
    thumbnail: raw.displayUrl || null,
    caption: raw.caption || "",
    timestamp: raw.timestamp || null,
    views: views ?? null,
    likes: likes ?? 0,
    comments: comments ?? 0,
    engagementRate: engagementRate ?? null,
    overperformanceScore: null,
  };
}

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

function extractFollowerCount(items, purpose) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0];
  if (purpose === "clientProfileIG") {
    return first.followersCount ?? first.followers ?? first.edge_followed_by?.count ?? null;
  }
  if (purpose === "clientProfileTT") {
    return first.authorMeta?.fans ?? first.followerCount ?? first.followers ?? null;
  }
  if (purpose === "clientProfileYT") {
    return first.subscriberCount ?? first.numberOfSubscribers ?? first.subscribers ?? null;
  }
  return null;
}

// Main entry point. Given the outcome of an Apify run, route the results to
// Firebase and clean up the sidecar. Throws on error so the caller can
// surface it; does NOT swallow failures.
//
// Safe to call multiple times for the same runId — the sidecar is deleted
// at the end, so a second call will find no sidecar and no-op.
export async function processApifyRun({ runId, status, datasetId, apifyToken }) {
  if (!runId) throw new Error("Missing runId");
  if (!apifyToken) throw new Error("Missing apifyToken");

  const sidecar = await fbGet(`/preproduction/socialOrganic/_apifyRuns/${runId}`);
  if (!sidecar || !sidecar.projectId || !sidecar.purpose) {
    return { ignored: true, reason: "no_sidecar" };
  }
  const { projectId, purpose } = sidecar;

  // ─── Tombstone guard ─────────────────────────────────────────────
  // If the producer deleted this project while the Apify run was still
  // in flight, the project record at /preproduction/socialOrganic/{id}
  // is gone. Any fbPatch we'd do here would resurrect it (Firebase
  // patches non-existent paths back into existence). Bail early and
  // clean up the sidecar.
  //
  // We don't check this for the failure path below — error patches on
  // a deleted project don't recreate enough to make it visible in the
  // list (no `id` field gets restored), but they still leave debris,
  // so the same guard runs there too.
  const projectExists = await fbGet(`/preproduction/socialOrganic/${projectId}/id`);
  if (!projectExists) {
    await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
    return { ignored: true, reason: "project_deleted", projectId };
  }

  // Failure paths: flip the scrape bundle to "error" so the UI surfaces it.
  if (status !== "SUCCEEDED") {
    if (purpose === "verifyCompetitors") {
      // A failed verification run must NOT clobber competitorScrape —
      // that's the posts scrape's status. Resolve still-pending AI chips
      // (verified === null renders as "⋯" forever) to the established
      // verifier_unavailable fallback, then drop the sidecar.
      const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
      const competitors = Array.isArray(project?.research?.competitors)
        ? project.research.competitors : [];
      if (competitors.some(c => c?.source === "ai" && c.verified == null)) {
        const updated = competitors.map(c =>
          c?.source === "ai" && c.verified == null
            ? { ...c, verified: false, verifyMeta: { reason: "verifier_unavailable" } }
            : c
        );
        await fbSet(`/preproduction/socialOrganic/${projectId}/research/competitors`, updated);
      }
      await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
      return { outcome: "verify_failed", status };
    }
    // Profile scrapes (IG follower fallback + TT/YT) are nice-to-haves —
    // a failed one must NOT clobber the posts bundle's "done" status (the
    // posts run owns clientScrape.status). Just drop the sidecar and bail.
    const PROFILE_PURPOSES = new Set(["clientProfileIG", "clientProfileTT", "clientProfileYT"]);
    if (PROFILE_PURPOSES.has(purpose)) {
      await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
      return { outcome: "profile_scrape_failed", purpose, status };
    }
    const errField = purpose.startsWith("client") && purpose !== "competitorPosts" ? "clientScrape" : "competitorScrape";
    await fbPatch(`/preproduction/socialOrganic/${projectId}/${errField}`, {
      status: "error",
      error: `Apify run ${status}`,
      finishedAt: new Date().toISOString(),
    });
    await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
    return { outcome: "marked_error", status };
  }

  if (!datasetId) {
    // Run succeeded but no dataset yet — Apify's still finalising. Leave the
    // sidecar in place so the next refresh can retry.
    return { outcome: "no_dataset_yet" };
  }

  const items = await fetchDatasetItems(datasetId, apifyToken);

  if (purpose === "clientPosts") {
    const handle = sidecar.handle || "";
    const posts = items.map(raw => normaliseInstagramPost(raw, handle)).filter(p => p.isVideo);
    const views = posts.map(p => p.views || 0).filter(v => v > 0).sort((a, b) => a - b);
    const avgViews = views.length ? Math.round(views.reduce((s, v) => s + v, 0) / views.length) : 0;
    const medianViews = views.length ? views[Math.floor(views.length / 2)] : 0;
    const topByViews = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5).map(p => p.id);

    let igFollowers = null;
    for (const raw of items) {
      const f = raw?.ownerFollowersCount ?? raw?.owner?.followersCount ?? raw?.owner?.edge_followed_by?.count ?? null;
      if (f != null) { igFollowers = f; break; }
    }

    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape`, cleanUndefined({ posts, topByViews }));
    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile`, cleanUndefined({ avgViews, medianViews }));
    if (igFollowers != null) {
      await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, { instagram: igFollowers });
    } else if (handle) {
      // The posts actor often omits ownerFollowersCount on newer / smaller
      // accounts, leaving the IG follower number blank. Fire a dedicated
      // profile scrape as a fallback so the count fills in. Fires at most
      // once per posts run (this branch only runs while the sidecar exists,
      // and the sidecar is deleted before this function returns). The
      // clientProfileIG result lands via the branch below — no loop back here.
      // Best-effort: a fallback failure must never break posts processing.
      try {
        const cleanHandle = handle.replace(/^@+/, "").trim();
        if (cleanHandle) {
          await startApifyRunFallback({
            actorId: "apify~instagram-profile-scraper",
            input: { usernames: [cleanHandle], resultsLimit: 1 },
            token: apifyToken,
            projectId,
            purpose: "clientProfileIG",
            extraSidecar: { handle: cleanHandle },
          });
        }
      } catch (e) {
        console.warn(`[apify-process] IG follower fallback failed for ${projectId}:`, e.message);
      }
    }
  } else if (purpose === "clientProfileIG") {
    const followers = extractFollowerCount(items, purpose);
    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, { instagram: followers });
  } else if (purpose === "clientProfileTT") {
    const followers = extractFollowerCount(items, purpose);
    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, { tiktok: followers });
  } else if (purpose === "clientProfileYT") {
    const followers = extractFollowerCount(items, purpose);
    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape/profile/followers`, { youtube: followers });
  } else if (purpose === "competitorPosts") {
    // Drop any items Apify returned that don't look like real posts —
    // the hashtag-search mode can include intermediate objects without
    // shortCodes, which aren't useful for video review and just break
    // downstream Firebase writes.
    //
    // Sidecar may carry:
    //   mode: "initial" | "append"   — append merges into existing posts
    //                                  (dedupe by id) instead of replacing.
    //   source: "handle" | "hashtag" — stamped on each post so the UI can
    //                                  distinguish where each came from.
    // Append-mode runs are how the "+ Add competitor" + "↻ Refresh widens"
    // flows extend the candidate pool without wiping the producer's
    // existing tick/cross history.
    const mode = sidecar.mode || "initial";
    const source = sidecar.source || "handle";
    const stampTime = new Date().toISOString();
    const newPosts = items
      .map(raw => normaliseInstagramPost(raw, null))
      .filter(p => p.url && p.handle !== "@unknown")
      .map(p => ({ ...p, source, firstSeenAt: stampTime }));

    let mergedPosts;
    if (mode === "append") {
      // Read existing posts and merge. Keep the older firstSeenAt /
      // source on duplicates (so a post that was already in the pool
      // doesn't get re-tagged as new).
      const existing = await fbGet(`/preproduction/socialOrganic/${projectId}/competitorScrape/posts`);
      const existingArr = Array.isArray(existing) ? existing : Object.values(existing || {});
      const byId = new Map(existingArr.filter(p => p && p.id).map(p => [p.id, p]));
      for (const np of newPosts) {
        if (!byId.has(np.id)) byId.set(np.id, np);
      }
      mergedPosts = [...byId.values()];
    } else {
      mergedPosts = newPosts;
    }

    const handleStats = computeHandleStatsAndScore(mergedPosts);
    const topOverperformers = [...mergedPosts]
      .filter(p => p.isVideo && p.overperformanceScore != null)
      .sort((a, b) => (b.overperformanceScore || 0) - (a.overperformanceScore || 0))
      .slice(0, 50)
      .map(p => p.id);
    await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, cleanUndefined({
      posts: mergedPosts, handleStats, topOverperformers,
      lastRefreshAt: stampTime,
    }));
  } else if (purpose === "verifyCompetitors") {
    // Bulk handle verification for AI-suggested competitors. The Apify
    // run was kicked off by handleSuggestCompetitors with a list of
    // usernames; the response carries the IG profile shape — username,
    // followersCount, postsCount, isPrivate, fullName, biography.
    //
    // The old version flipped `verified` to true if Apify returned the
    // username at all. That under-checks: if Claude hallucinates an
    // @handle that happens to match someone's personal account with 20
    // followers and zero posts, that account exists, so verified=true,
    // and the producer follows the link to a dead end. (Exactly the bug
    // Jeremy hit on the offshoring-company example.)
    //
    // Tighter check — verified=true only if all of:
    //   - profile exists
    //   - followers >= MIN_FOLLOWERS_FOR_VERIFIED (treat anything
    //     below as "almost certainly not a real competitor")
    //   - postsCount > 0 (no posts = dead account / nothing to research)
    //   - not private (a private account is impossible to research
    //     against, even if it's the right brand)
    // Profiles that exist but flunk these signals get verified=false +
    // a `verifyMeta` blob the UI can surface so the producer sees
    // "Account exists but only 17 followers, 0 posts — likely wrong
    // handle" instead of just a green checkmark.
    //
    // Only AI-suggested entries are touched. Manual-add chips are
    // authoritative — the producer typed them in, they don't need our
    // second-guessing.
    const MIN_FOLLOWERS_FOR_VERIFIED = 200;
    const profileByUsername = new Map();
    for (const item of items) {
      const u = (item.username || item.ownerUsername || "").toLowerCase();
      if (!u) continue;
      profileByUsername.set(u, {
        followers: Number(item.followersCount ?? 0) || 0,
        posts: Number(item.postsCount ?? 0) || 0,
        isPrivate: !!item.isPrivate,
        fullName: item.fullName || "",
      });
    }
    const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
    const competitors = Array.isArray(project?.research?.competitors)
      ? project.research.competitors : [];
    if (competitors.length > 0) {
      const updated = competitors.map(c => {
        if (c.source !== "ai") return c;
        const h = (c.handle || "").replace(/^@/, "").toLowerCase();
        const profile = profileByUsername.get(h);
        if (!profile) {
          return { ...c, verified: false, verifyMeta: { reason: "profile_not_found" } };
        }
        const passes = profile.followers >= MIN_FOLLOWERS_FOR_VERIFIED
          && profile.posts > 0
          && !profile.isPrivate;
        const verifyMeta = {
          followers: profile.followers,
          posts: profile.posts,
          isPrivate: profile.isPrivate,
          fullName: profile.fullName,
          reason: passes ? "ok"
            : profile.isPrivate ? "account_private"
            : profile.posts === 0 ? "no_posts"
            : "low_followers",
        };
        return { ...c, verified: passes, verifyMeta };
      });
      await fbSet(`/preproduction/socialOrganic/${projectId}/research/competitors`, updated);
    }
  } else {
    console.warn(`[apify-process] Unknown purpose ${purpose} for run ${runId}`);
  }

  // Flip scrape bundle status to "done" on the main posts-runs only.
  // Profile runs are nice-to-haves and shouldn't gate the next tab.
  if (purpose === "clientPosts") {
    await fbPatch(`/preproduction/socialOrganic/${projectId}/clientScrape`, {
      status: "done",
      finishedAt: new Date().toISOString(),
    });
  } else if (purpose === "competitorPosts") {
    await fbPatch(`/preproduction/socialOrganic/${projectId}/competitorScrape`, {
      status: "done",
      finishedAt: new Date().toISOString(),
    });
  }

  await fbSet(`/preproduction/socialOrganic/_apifyRuns/${runId}`, null);
  return { outcome: "processed", purpose, items: items.length };
}
