// api/analytics-webhook.js — Apify webhook receiver for the Analytics
// tab. Separate endpoint from api/apify-webhook.js (which serves
// preproduction) so the two systems can evolve independently per
// Jeremy's locked decision.
//
// Validation: requires the shared-secret `APIFY_ANALYTICS_WEBHOOK_SECRET`
// to match (Apify sends it as a query param on the configured webhook
// URL — see api/_analyticsScrape.js for how runs are registered).
//
// Webhook handler is DETERMINISTIC and DUMB on purpose. It only:
//   1. Validates the shared secret.
//   2. Reads the sidecar at /analytics/runs/{runId} to know what this
//      run was for (clientId, platform, mode, target, handle).
//   3. Pulls dataset items from Apify.
//   4. Normalises + writes posts to /analytics/videos/{clientId}/... or
//      /analytics/competitors/{clientId}/... .
//   5. Appends a snapshot per video (idempotent — same UTC date key
//      means the same snapshot slot, so re-running the webhook
//      doesn't double-count).
//   6. Writes follower count for the day.
//   7. Marks /analytics/runs/{runId} as completed with actual cost.
//   8. Calls recomputeClientAnalytics(clientId).
//
// Nothing else. No status flips, no insight regeneration, no AI calls.
// All derived state lives behind recomputeClientAnalytics — see
// _analyticsScoring.js.

import { recomputeClientAnalytics, _fb } from "./_analyticsScoring.js";
import { APIFY_IG_COST_PER_RESULT_USD, safeHandleKey } from "./_analyticsScrape.js";

const APIFY_BASE = "https://api.apify.com/v2";
const { fbGet, fbSet, fbPatch } = _fb;

// ─── Apify dataset fetcher ─────────────────────────────────────────

async function fetchDatasetItems(datasetId, token) {
  const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true&limit=500`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Apify dataset ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// ─── Normalisation ─────────────────────────────────────────────────

// v1 stores views/likes/comments/engagementRate ONLY per Phase 14
// decision in the plan. No saves, no shares — IG public scrapes don't
// reliably return them. Schema can be extended in v1.1 once the actor
// is confirmed to return those fields.
function normaliseIgPost(raw, handleHint) {
  const shortCode = raw.shortCode || raw.shortcode || null;
  const videoId = shortCode ? `ig_${shortCode}` : `ig_${Math.random().toString(36).slice(2, 10)}`;
  const owner = (raw.ownerUsername || raw.owner?.username || handleHint || "unknown").toLowerCase();
  const isVideo = raw.isVideo ?? (raw.type === "Video") ?? false;
  const views = raw.videoViewCount ?? raw.videoPlayCount ?? null;
  const likes = raw.likesCount ?? 0;
  const comments = raw.commentsCount ?? 0;
  const followers = raw.ownerFollowersCount ?? raw.owner?.followersCount ?? null;
  const engagementRate = followers && followers > 0
    ? +(((likes + comments) / followers) * 100).toFixed(3)
    : null;
  return {
    videoId,
    post: {
      url: raw.url || (shortCode ? `https://www.instagram.com/p/${shortCode}/` : null),
      caption: (raw.caption || "").slice(0, 2200),
      thumbnail: raw.displayUrl || null,
      timestamp: raw.timestamp || null,
      isVideo: !!isVideo,
      handle: `@${owner}`,
      // Format + hookType land in Phase 6 (heuristic) and Phase 7
      // (Claude). Schema slot is here from day one so adding the
      // classifier later is wiring, not redesign.
      format: null,
      hookType: null,
    },
    snapshot: {
      views: views ?? null,
      likes: likes ?? 0,
      comments: comments ?? 0,
      engagementRate: engagementRate ?? null,
    },
    rawFollowers: followers,
  };
}

// Extract the first non-null follower count from a batch of posts.
// IG returns the same number on every post (it's the owner's current
// count); first non-null wins.
function extractFollowerCount(items) {
  for (const item of items) {
    const f = item?.ownerFollowersCount
      ?? item?.owner?.followersCount
      ?? item?.owner?.edge_followed_by?.count
      ?? null;
    if (f != null) return f;
  }
  return null;
}

// ─── Webhook handler ───────────────────────────────────────────────

export default async function handler(req, res) {
  // Apify webhooks are POST. Bare GET / OPTIONS shouldn't 500.
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const expected = process.env.APIFY_ANALYTICS_WEBHOOK_SECRET;
  if (!expected) {
    res.status(500).json({ error: "APIFY_ANALYTICS_WEBHOOK_SECRET not configured" });
    return;
  }
  const provided = req.query?.secret || req.headers["x-apify-webhook-secret"];
  if (provided !== expected) {
    res.status(401).json({ error: "Invalid webhook secret" });
    return;
  }

  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) {
    res.status(500).json({ error: "APIFY_API_TOKEN not configured" });
    return;
  }

  // Apify's payloadTemplate gives us { runId, status, datasetId }.
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const { runId, status, datasetId } = body;
  if (!runId) {
    res.status(400).json({ error: "Missing runId" });
    return;
  }

  // Sidecar tells us where to route the result.
  const sidecar = await fbGet(`/analytics/runs/${runId}`);
  if (!sidecar || !sidecar.clientId || !sidecar.target) {
    // No sidecar = not an analytics run. Could be a stray call, an
    // already-processed run (sidecar nulled), or a wrong URL.
    // Acknowledge so Apify doesn't retry, but log.
    console.warn(`[analytics-webhook] no sidecar for run ${runId}`);
    res.status(200).json({ ok: true, ignored: true, reason: "no_sidecar" });
    return;
  }

  // Failure paths: mark the run failed, don't ingest anything.
  if (status !== "SUCCEEDED") {
    await fbPatch(`/analytics/runs/${runId}`, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Apify run ${status}`,
    });
    res.status(200).json({ ok: true, outcome: "marked_failed", status });
    return;
  }

  if (!datasetId) {
    // Apify says SUCCEEDED but no dataset yet — happens occasionally
    // when the run finalises slowly. Leave the sidecar in place; a
    // future webhook retry or manual replay will pick it up.
    res.status(200).json({ ok: true, outcome: "no_dataset_yet" });
    return;
  }

  // ─── Ingest ──────────────────────────────────────────────────────

  let items;
  try {
    items = await fetchDatasetItems(datasetId, apifyToken);
  } catch (err) {
    await fbPatch(`/analytics/runs/${runId}`, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Dataset fetch: ${err.message}`,
    });
    res.status(200).json({ ok: true, outcome: "dataset_fetch_failed" });
    return;
  }

  const { clientId, platform, mode, target, handle: sidecarHandle } = sidecar;
  if (platform !== "instagram") {
    // Only IG is supported in v1; the cron + manual refresh enforce
    // this, but defensive-check here too in case a stale sidecar
    // exists from a future schema.
    res.status(200).json({ ok: true, ignored: true, reason: "unsupported_platform" });
    return;
  }

  // Normalise + filter to actual posts (the actor occasionally
  // returns intermediate objects without shortCodes during hashtag
  // mode — we only ingest things that look like real posts).
  const normalised = items
    .map(raw => normaliseIgPost(raw, sidecarHandle))
    .filter(n => n.post.url && n.post.handle !== "@unknown");

  // Apply date filter post-ingest as the fallback per the plan —
  // if the actor's date filter dropped the ball, drop posts older
  // than the mode's window here. Initial mode keeps everything.
  const cutoffMs = (() => {
    if (mode === "daily")  return Date.now() - 7  * 24 * 3600 * 1000;
    if (mode === "weekly") return Date.now() - 90 * 24 * 3600 * 1000;
    return 0;
  })();
  const filtered = cutoffMs
    ? normalised.filter(n => {
        if (!n.post.timestamp) return true; // can't tell — keep
        return new Date(n.post.timestamp).getTime() >= cutoffMs;
      })
    : normalised;

  const todayUtc = new Date().toISOString().slice(0, 10);

  // Write each post + append today's snapshot. UTC date keys so
  // re-running the webhook on the same day overwrites the same
  // snapshot slot (idempotent), not appending a duplicate.
  let writtenCount = 0;
  if (target === "client") {
    for (const n of filtered) {
      await fbSet(
        `/analytics/videos/${clientId}/${platform}/${n.videoId}/post`,
        n.post,
      );
      await fbSet(
        `/analytics/videos/${clientId}/${platform}/${n.videoId}/snapshots/${todayUtc}`,
        n.snapshot,
      );
      writtenCount++;
    }
  } else if (target === "competitor") {
    const handleKey = safeHandleKey(sidecarHandle);
    await fbPatch(
      `/analytics/competitors/${clientId}/${platform}/${handleKey}/profile`,
      {
        displayName: sidecarHandle,
        lastScrapedAt: new Date().toISOString(),
      },
    );
    for (const n of filtered) {
      await fbSet(
        `/analytics/competitors/${clientId}/${platform}/${handleKey}/videos/${n.videoId}/post`,
        n.post,
      );
      await fbSet(
        `/analytics/competitors/${clientId}/${platform}/${handleKey}/videos/${n.videoId}/snapshots/${todayUtc}`,
        n.snapshot,
      );
      writtenCount++;
    }
  }

  // Follower count snapshot for the day. Only meaningful for client
  // runs (competitor follower trends could land in a later phase).
  if (target === "client") {
    const followers = extractFollowerCount(items);
    if (followers != null) {
      await fbSet(
        `/analytics/followers/${clientId}/${platform}/${todayUtc}`,
        { count: followers },
      );
    }
  } else if (target === "competitor") {
    const followers = extractFollowerCount(items);
    if (followers != null) {
      await fbPatch(
        `/analytics/competitors/${clientId}/${platform}/${safeHandleKey(sidecarHandle)}/profile`,
        { followerCount: followers },
      );
    }
  }

  // Mark the run completed with actual cost. Apify charges per result
  // returned (not per result we kept); use the raw items count.
  const actualCostUsd = +(items.length * APIFY_IG_COST_PER_RESULT_USD).toFixed(4);
  await fbPatch(`/analytics/runs/${runId}`, {
    status: "completed",
    completedAt: new Date().toISOString(),
    actualItems: items.length,
    actualCostUsd,
    writtenCount,
  });

  // Stamp the last-refreshed timestamp on the client config so the
  // UI can show "scraped 2h ago" without walking /analytics/runs.
  await fbPatch(`/analytics/clients/${clientId}/lastRefreshedAt`, {
    [platform]: new Date().toISOString(),
  });

  // Single, deterministic recompute path. Phase 2 stub; Phase 3
  // fills in the actual scoring math.
  try {
    await recomputeClientAnalytics(clientId);
  } catch (err) {
    console.error(`[analytics-webhook] recompute failed for ${clientId}:`, err);
    // Don't fail the webhook on recompute error — the raw data is
    // already written. Recompute can be retried.
  }

  res.status(200).json({
    ok: true,
    outcome: "processed",
    clientId,
    platform,
    mode,
    target,
    itemsReceived: items.length,
    written: writtenCount,
  });
}
