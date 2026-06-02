// api/cron/zernio-analytics-pull.js — Vercel cron: pull first-party
// analytics from Zernio for every enabled analytics client, across all
// connected platforms, and feed the existing scoring engine.
//
// This is the multi-platform replacement for the Apify scrape path
// (api/cron/analytics-schedule.js). Apify gave us Instagram only; Zernio
// gives us LinkedIn / Instagram / YouTube / Facebook / TikTok first-party
// metrics for accounts the client has connected through Zernio (which we
// already use for posting).
//
// ── Schedule ──────────────────────────────────────────────────────────
// UTC; target ~4am Sydney like the Apify cron. Runs daily — each run
// appends one snapshot per post (Zernio returns each post's CURRENT
// cumulative analytics), building the per-post time series the engine
// reads via latestSnapshot().
//
// ── What it does, per enabled client ──────────────────────────────────
//   1. Resolve the client's Zernio profile (/zernio/profiles/{clientId}).
//   2. listAccounts(profileId) → resolve {platform, accountId} for each
//      enabled platform (reuses _zernio.mapPlatformsToAccounts; fails
//      closed on disconnected accounts).
//   3. For each resolved platform: getAnalytics(source:"all") paginated,
//      normalise, bulk-write posts + today's snapshot into
//      /analytics/videos/{clientId}/{platform}, and write a follower
//      snapshot from follower-stats.
//   4. recomputeClientAnalytics(clientId) — the one existing spine.
//
// ── Auth ──────────────────────────────────────────────────────────────
// Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. Fail closed.
//
// ── Add-on gate ───────────────────────────────────────────────────────
// Zernio Analytics is a paid add-on. The first AnalyticsAddonError (402)
// is plan-wide, so we abort the whole run and report it rather than
// hammering every account with calls that will all 402.

import { adminGet, adminSet, adminPatch, getAdmin } from "../_fb-admin.js";
import { listAccounts, mapPlatformsToAccounts } from "../_zernio.js";
import {
  getAnalytics,
  getFollowerStats,
  normaliseZernioPost,
  checkAnalyticsAccess,
  AnalyticsAddonError,
} from "../_zernioAnalytics.js";
import { platformMetrics } from "../_platformMetrics.js";
import { recomputeClientAnalytics } from "../_analyticsScoring.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
}

// Zernio's history window caps at 366 days. Pull the full window so the
// first report has maximum depth; daily runs refresh recent posts' counts.
function fullWindowFromDate(now) {
  const d = new Date(now - 365 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// follower-stats shape isn't pinned in the spec excerpt; read defensively.
function extractFollowerCount(stats) {
  if (stats == null) return null;
  const cands = [stats.followers, stats.followerCount, stats.count, stats.total,
                 stats?.data?.followers, stats?.audience?.followers];
  for (const c of cands) if (typeof c === "number" && Number.isFinite(c)) return c;
  return null;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: "CRON_SECRET not configured; refusing to run." });
    return;
  }
  if ((req.headers.authorization || "") !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!process.env.ZERNIO_API_KEY) {
    res.status(500).json({ error: "ZERNIO_API_KEY not configured" });
    return;
  }

  const now = Date.now();
  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const fromDate = fullWindowFromDate(now);

  // ── Add-on preflight (Codex r3) ─────────────────────────────────────
  // The Analytics add-on is plan-wide, so check it ONCE before touching
  // any client data. A 402 here aborts cleanly with zero writes — no
  // half-written client left with stale derived state.
  try {
    await checkAnalyticsAccess();
  } catch (err) {
    if (err instanceof AnalyticsAddonError) {
      res.status(200).json({
        ok: false,
        reason: "analytics_addon_required",
        detail: "Zernio Analytics add-on is not active on the plan; aborted before any writes. Enable it, then re-run.",
      });
      return;
    }
    // A non-402 preflight failure (network/auth) — surface, don't half-run.
    res.status(502).json({ ok: false, reason: "preflight_failed", detail: err.message });
    return;
  }

  const clients = (await fbGet("/analytics/clients")) || {};
  const summary = {
    walkedClients: 0, enabledClients: 0, clientsPulled: 0,
    platformsPulled: 0, postsWritten: 0, postsDropped: 0, recomputed: 0,
    skipped: {}, errors: [], addonMissing: false,
  };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };

  for (const [clientId, record] of Object.entries(clients)) {
    summary.walkedClients++;
    const config = record?.config;
    if (!config || !config.enabled) { skip("not_enabled"); continue; }
    summary.enabledClients++;

    const enabledPlatforms = Object.keys(config.platforms || {}).filter((p) => config.platforms[p]);
    if (enabledPlatforms.length === 0) { skip("no_platforms"); continue; }

    // Resolve the Zernio profile + connected accounts for this client.
    const profile = await fbGet(`/zernio/profiles/${clientId}`);
    const profileId = profile?.profileId;
    if (!profileId) { skip("no_zernio_profile"); continue; }

    let resolved, missing;
    try {
      const accountsResp = await listAccounts(profileId);
      ({ resolved, missing } = mapPlatformsToAccounts(accountsResp, enabledPlatforms));
    } catch (err) {
      summary.errors.push({ clientId, scope: "listAccounts", error: err.message });
      continue;
    }
    if (missing && missing.length) {
      summary.errors.push({ clientId, scope: "unconnected_platforms", platforms: missing });
    }
    if (!resolved.length) { skip("no_connected_accounts"); continue; }

    let pulledAnyForClient = false;
    for (const { platform, accountId } of resolved) {
      try {
        const { posts } = await getAnalytics({
          accountId, platform, source: "all", fromDate, toDate: todayUtc,
        });

        const batch = {};
        let writtenForPlatform = 0;
        let droppedForPlatform = 0;
        for (const zp of posts) {
          const n = normaliseZernioPost(zp, platform);
          if (!n) { droppedForPlatform++; continue; }
          batch[`${n.videoId}/post`] = n.post;
          batch[`${n.videoId}/snapshots/${todayUtc}`] = n.snapshot;
          writtenForPlatform++;
        }
        // Surface drops so silent loss is visible. Some drops are
        // legitimate (non-video on a video-only platform); a HIGH drop
        // ratio is the signal that the live payload shape differs from
        // what normaliseZernioPost expects.
        summary.postsDropped += droppedForPlatform;
        if (posts.length > 0 && droppedForPlatform / posts.length > 0.5) {
          summary.errors.push({
            clientId, platform, scope: "high_drop_ratio",
            detail: `${droppedForPlatform}/${posts.length} posts dropped by normaliser — check Zernio payload shape.`,
          });
        }
        if (writtenForPlatform > 0) {
          await fbPatch(`/analytics/videos/${clientId}/${platform}`, batch);
          summary.postsWritten += writtenForPlatform;
          summary.platformsPulled++;
          pulledAnyForClient = true;
        }

        // Follower snapshot (only where the platform has a meaningful
        // follower count — TikTok is gated off via platformMetrics).
        if (platformMetrics(platform).hasFollowers) {
          try {
            const stats = await getFollowerStats(accountId);
            const count = extractFollowerCount(stats);
            if (count != null) {
              await fbSet(`/analytics/followers/${clientId}/${platform}/${todayUtc}`, { count });
            }
          } catch (err) {
            if (err instanceof AnalyticsAddonError) throw err;
            summary.errors.push({ clientId, platform, scope: "follower-stats", error: err.message });
          }
        }
      } catch (err) {
        if (err instanceof AnalyticsAddonError) {
          // Plan-wide gate — stop the whole run, report clearly.
          summary.addonMissing = true;
          summary.errors.push({ clientId, platform, scope: "addon", error: err.message });
          res.status(200).json({
            ok: false,
            reason: "analytics_addon_required",
            detail: "Zernio Analytics add-on is not active on the plan; every analytics call 402s. Enable it, then re-run.",
            summary,
          });
          return;
        }
        summary.errors.push({ clientId, platform, scope: "getAnalytics", error: err.message });
      }
    }

    if (pulledAnyForClient) {
      summary.clientsPulled++;
      try {
        await recomputeClientAnalytics(clientId);
        summary.recomputed++;
      } catch (err) {
        summary.errors.push({ clientId, scope: "recompute", error: err.message });
      }
    }
  }

  res.status(200).json({ ok: true, summary });
}
