// api/_zernioPull.js — the per-client Zernio analytics pull, shared by:
//   - api/cron/zernio-analytics-pull.js  (daily cron, walks all clients)
//   - api/analytics.js  action "pullZernio"  (founder-triggered, one client)
//
// Extracted from the cron so the manual trigger and the scheduled run are
// guaranteed to behave identically — one pull path, two callers.
//
// ── Smart windows (why we don't pull 366 days every day) ──────────────
// Zernio returns each post's CURRENT cumulative analytics, so a daily
// full-history pull mostly re-reads numbers that no longer move (a post's
// views barely change once it's weeks old). Mirrors the Apify scheduler's
// initial/daily/weekly pattern (_analyticsScrape.decideRefreshMode):
//
//   full   (366d window)  — first ever pull for a (client, platform), and
//                           then refreshed WEEKLY so long-tail counts
//                           still update.
//   recent (30d window)   — every other daily run. Cheap: 1-2 pages.
//
// Pull history lives at /analytics/zernioPullMeta/{clientId}/{platform} =
//   { lastPullAt, lastFullPullAt }  (epoch ms). Meta is written AFTER the
// platform's posts write succeeds, so a failed pull naturally retries the
// same window next run. `force: "full"` overrides (manual button option).

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { listAccounts, mapPlatformsToAccounts } from "./_zernio.js";
import {
  getAnalytics,
  getFollowerStats,
  normaliseZernioPost,
  AnalyticsAddonError,
} from "./_zernioAnalytics.js";
import { platformMetrics } from "./_platformMetrics.js";
import { recomputeClientAnalytics } from "./_analyticsScoring.js";

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

const DAY = 24 * 3600 * 1000;
const FULL_WINDOW_DAYS = 365;   // Zernio caps history at 366d
const RECENT_WINDOW_DAYS = 30;
const FULL_REFRESH_EVERY_DAYS = 7;

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Decide the pull window for one (client, platform). Pure given meta.
// Exported for tests.
export function decidePullWindow({ meta, now, force = null }) {
  if (force === "full") {
    return { mode: "full", fromDate: dateStr(now - FULL_WINDOW_DAYS * DAY) };
  }
  const lastFullAt = meta?.lastFullPullAt || null;
  const needFull = !lastFullAt || (now - lastFullAt) > FULL_REFRESH_EVERY_DAYS * DAY;
  return needFull
    ? { mode: "full",   fromDate: dateStr(now - FULL_WINDOW_DAYS * DAY) }
    : { mode: "recent", fromDate: dateStr(now - RECENT_WINDOW_DAYS * DAY) };
}

// follower-stats shape isn't pinned in the spec excerpt; read defensively.
function extractFollowerCount(stats) {
  if (stats == null) return null;
  const cands = [stats.followers, stats.followerCount, stats.count, stats.total,
                 stats?.data?.followers, stats?.audience?.followers];
  for (const c of cands) if (typeof c === "number" && Number.isFinite(c)) return c;
  return null;
}

/**
 * Pull Zernio analytics for ONE client across its enabled+connected
 * platforms, write snapshots, and recompute. The caller is responsible
 * for the plan-wide add-on preflight (checkAnalyticsAccess) — this
 * function assumes the add-on is active.
 *
 * Returns a result object; never throws for per-platform errors (they're
 * collected in result.errors). Throws only on malformed input.
 *
 * opts.force: "full" → pull the 366d window on every platform regardless
 * of pull history (the manual button uses this for first-time setups).
 */
export async function pullZernioForClient(clientId, { now = Date.now(), force = null } = {}) {
  if (!clientId) throw new Error("pullZernioForClient: missing clientId");

  const todayUtc = dateStr(now);
  const result = {
    clientId,
    pulled: false,
    platformsPulled: 0,
    postsWritten: 0,
    postsDropped: 0,
    recomputed: false,
    windows: {},          // platform -> "full" | "recent"
    skipped: null,        // reason string when nothing was attempted
    errors: [],
    addonMidloop: false,
  };

  const config = await fbGet(`/analytics/clients/${clientId}/config`);
  if (!config || !config.enabled) { result.skipped = "not_enabled"; return result; }

  const enabledPlatforms = Object.keys(config.platforms || {}).filter((p) => config.platforms[p]);
  if (enabledPlatforms.length === 0) { result.skipped = "no_platforms"; return result; }

  const profile = await fbGet(`/zernio/profiles/${clientId}`);
  const profileId = profile?.profileId;
  if (!profileId) { result.skipped = "no_zernio_profile"; return result; }

  let resolved, missing;
  try {
    const accountsResp = await listAccounts(profileId);
    ({ resolved, missing } = mapPlatformsToAccounts(accountsResp, enabledPlatforms));
  } catch (err) {
    result.skipped = "listAccounts_failed";
    result.errors.push({ scope: "listAccounts", error: err.message });
    return result;
  }
  if (missing && missing.length) {
    result.errors.push({ scope: "unconnected_platforms", platforms: missing });
  }
  if (!resolved.length) { result.skipped = "no_connected_accounts"; return result; }

  for (const { platform, accountId } of resolved) {
    try {
      const meta = await fbGet(`/analytics/zernioPullMeta/${clientId}/${platform}`);
      const { mode, fromDate } = decidePullWindow({ meta, now, force });
      result.windows[platform] = mode;

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
      // ratio signals the live payload shape differs from what
      // normaliseZernioPost expects.
      result.postsDropped += droppedForPlatform;
      if (posts.length > 0 && droppedForPlatform / posts.length > 0.5) {
        result.errors.push({
          platform, scope: "high_drop_ratio",
          detail: `${droppedForPlatform}/${posts.length} posts dropped by normaliser — check Zernio payload shape.`,
        });
      }
      if (writtenForPlatform > 0) {
        await fbPatch(`/analytics/videos/${clientId}/${platform}`, batch);
        result.postsWritten += writtenForPlatform;
        result.platformsPulled++;
        result.pulled = true;
      }

      // Pull meta — written after the posts write succeeds so a failed
      // pull retries the same window next run. Recorded even when zero
      // posts were written (an empty-but-successful pull is still a
      // successful pull; don't re-do a full window daily on a quiet
      // account).
      const metaPatch = { lastPullAt: now };
      if (mode === "full") metaPatch.lastFullPullAt = now;
      await fbPatch(`/analytics/zernioPullMeta/${clientId}/${platform}`, metaPatch);

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
          result.errors.push({ platform, scope: "follower-stats", error: err.message });
        }
      }
    } catch (err) {
      if (err instanceof AnalyticsAddonError) {
        // Plan-wide gate is preflighted by the caller BEFORE any writes;
        // a mid-loop 402 is an anomaly — stop pulling further platforms
        // for this client but fall through to the recompute so whatever
        // we wrote gets consistent derived state.
        result.addonMidloop = true;
        result.errors.push({ platform, scope: "addon_midloop", error: err.message });
        break;
      }
      result.errors.push({ platform, scope: "getAnalytics", error: err.message });
    }
  }

  // INVARIANT: if anything was written for this client this run, a
  // recompute ALWAYS follows — no partial post data is ever left with
  // stale derived state.
  if (result.pulled) {
    try {
      await recomputeClientAnalytics(clientId);
      result.recomputed = true;
    } catch (err) {
      result.errors.push({ scope: "recompute", error: err.message });
    }
  }

  return result;
}
