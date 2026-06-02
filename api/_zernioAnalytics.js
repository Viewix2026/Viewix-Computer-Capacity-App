// api/_zernioAnalytics.js — Zernio analytics pull + normalisation.
//
// This is the multi-platform analytics data layer. It reads first-party
// metrics from Zernio's analytics API (GET /v1/analytics + a couple of
// per-account helpers) and normalises them into the existing
// /analytics/videos/{clientId}/{platform}/{videoId} {post, snapshot}
// shape so the scoring spine in _analyticsScoring.js can consume them.
//
// Why a separate module (not folded into _zernio.js): _zernio.js is the
// posting client and is touched by the scheduled-posting work; keeping
// analytics here minimises cross-stream conflict. We reuse _zernio.js's
// exported `zernio()` core so auth/timeout/error handling stay identical.
//
// ─── Response-state handling (from the OpenAPI spec) ───────────────────
//   200 → analytics returned.
//   202 → analytics sync pending (single-post lookups). `resp.ok` is
//         true so zernio() returns the body; we detect syncStatus.
//   402 → Analytics add-on required (legacy plans). zernio() throws with
//         err.status 402 → we rethrow as AnalyticsAddonError so callers
//         can surface a clear "enable the add-on" message.
//   424 → post failed on all platforms (single-post). Throws; we skip.
//
// ─── Per-platform metric reality (Zernio KPI matrix) ───────────────────
//   IG/FB/LinkedIn: impressions, reach, likes, comments, shares (rich).
//   LinkedIn `views` only on video posts.
//   YouTube/TikTok: views, likes, comments, shares — NO impressions/reach.
//   So "primary metric" differs per platform; see PLATFORM_METRICS.

import { zernio } from "./_zernio.js";
// Per-platform metric semantics live in one pure module shared with the
// scoring engine (avoids coupling the engine to this Zernio client).
import { PLATFORM_METRICS, platformMetrics, primaryMetric } from "./_platformMetrics.js";

export { PLATFORM_METRICS, platformMetrics, primaryMetric };

// ─── Errors ───────────────────────────────────────────────────────────

export class AnalyticsAddonError extends Error {
  constructor(message) {
    super(message || "Zernio Analytics add-on required (402). Enable it on the plan.");
    this.name = "AnalyticsAddonError";
    this.code = "ZERNIO_ANALYTICS_ADDON_REQUIRED";
  }
}

// ─── Pagination safety ────────────────────────────────────────────────
// Hard cap so a misbehaving account or a huge history can't spin the
// cron forever. 100/page × 50 pages = 5,000 posts per (account,platform)
// — far beyond any real client's 366-day window.
const MAX_PAGES = 50;
const PAGE_LIMIT = 100;

// ─── getAnalytics — paginated post analytics for one account ──────────
//
// Returns { posts, overview, accounts, hasAnalyticsAccess, pages }.
// `posts` is the flattened union across pages (raw Zernio post objects;
// normalise separately so callers can inspect raw shape in the smoke
// test). Throws AnalyticsAddonError on 402.
//
// opts:
//   accountId  (required for scoping; "all" pulls everything on the plan)
//   platform   default "all"
//   source     "all" | "late" | "external"  (default "all")
//   fromDate / toDate  YYYY-MM-DD (Zernio defaults 90d, max 366d)
//   sortBy / order
export async function getAnalytics({
  accountId,
  platform = "all",
  source = "all",
  fromDate,
  toDate,
  sortBy = "date",
  order = "desc",
} = {}) {
  const allPosts = [];
  let overview = null;
  let accounts = null;
  let hasAnalyticsAccess = null;
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      platform: String(platform),
      source: String(source),
      sortBy: String(sortBy),
      order: String(order),
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    if (accountId) qs.set("accountId", String(accountId));
    if (fromDate) qs.set("fromDate", String(fromDate));
    if (toDate) qs.set("toDate", String(toDate));

    let resp;
    try {
      resp = await zernio(`/analytics?${qs.toString()}`);
    } catch (err) {
      if (err.status === 402 || err.zernioCode === "analytics_addon_required") {
        throw new AnalyticsAddonError(err.message);
      }
      throw err; // network/auth/5xx — let the caller decide
    }

    if (resp && typeof resp === "object") {
      if (resp.hasAnalyticsAccess != null) hasAnalyticsAccess = resp.hasAnalyticsAccess;
      if (resp.overview && !overview) overview = resp.overview;
      if (resp.accounts && !accounts) accounts = resp.accounts;
    }

    const pagePosts = Array.isArray(resp?.posts) ? resp.posts : [];
    allPosts.push(...pagePosts);

    // Stop when the API signals we've reached the last page, or a short
    // page came back (fewer than a full page = no more).
    const pg = resp?.pagination;
    const lastPage = pg && Number.isFinite(pg.pages) ? page >= pg.pages : pagePosts.length < PAGE_LIMIT;
    if (lastPage || pagePosts.length === 0) break;
  }

  return {
    posts: allPosts,
    overview,
    accounts,
    hasAnalyticsAccess,
    pages: Math.min(page, MAX_PAGES),
    truncated: page > MAX_PAGES,
  };
}

// ─── follower-stats — current follower/audience counts ────────────────
// Used for follower-normalised reach on platforms where it's meaningful
// (gated by PLATFORM_METRICS.hasFollowers). Best-effort: returns null on
// any error so a missing follower count never breaks a pull.
export async function getFollowerStats(accountId) {
  if (!accountId) return null;
  try {
    const qs = new URLSearchParams({ accountId: String(accountId) });
    return await zernio(`/accounts/follower-stats?${qs.toString()}`);
  } catch (err) {
    if (err.status === 402 || err.zernioCode === "analytics_addon_required") {
      throw new AnalyticsAddonError(err.message);
    }
    console.warn(`[zernioAnalytics] follower-stats failed for ${accountId}: ${err.message}`);
    return null;
  }
}

// ─── Normalisation: raw Zernio post → {videoId, post, snapshot} ───────
//
// Maps Zernio's unified analytics object onto the existing
// /analytics/videos schema. One shell; the per-platform metric config
// (PLATFORM_METRICS) drives the differences (primary metric, video
// filtering, follower relevance) rather than five separate normalisers.
//
// Returns null for posts that should be skipped for this platform
// (e.g. a non-video post on a videoOnly platform, or a post with no
// usable timestamp/url).
export function normaliseZernioPost(zPost, platform) {
  if (!zPost || typeof zPost !== "object") return null;
  const cfg = platformMetrics(platform);

  // Per-platform analytics: prefer the platform-scoped entry if present
  // (multi-platform posts carry a platforms[]/platformAnalytics[] array),
  // else the top-level analytics object.
  const platformEntry = pickPlatformEntry(zPost, platform);
  const a = platformEntry?.analytics || zPost.analytics || {};

  const url = platformEntry?.platformPostUrl || zPost.platformPostUrl || null;
  const timestamp = zPost.publishedAt || zPost.scheduledFor || null;
  if (!url || !timestamp) return null;

  const mediaType = zPost.mediaType || null;
  const isVideo = mediaType === "video" || mediaType === "reel" || mediaType === "reels";
  if (cfg.videoOnly && mediaType && !isVideo) return null; // drop non-video on video surfaces

  const platformPostId =
    platformEntry?.platformPostId || zPost.platformPostId || zPost._id || zPost.postId || null;
  if (!platformPostId) return null;
  const videoId = `${String(platform).toLowerCase()}_${platformPostId}`;

  const num = (v) => (v == null || Number.isNaN(+v) ? null : +v);

  const snapshot = {
    impressions: cfg.hasImpressions ? num(a.impressions) : null,
    reach:       cfg.hasImpressions ? num(a.reach) : null,
    views:       num(a.views),
    likes:       num(a.likes),
    comments:    num(a.comments),
    shares:      num(a.shares),
    saves:       num(a.saves),
    clicks:      num(a.clicks),
    // Use Zernio's own engagementRate — do NOT recompute from followers.
    // Tag the source so it's never silently compared against the engine's
    // legacy follower-normalised IG values stored under the same key.
    engagementRate: num(a.engagementRate),
    engagementRateSource: "zernio",
    // Convenience: the platform's headline metric value, so scoring can
    // read snapshot[primaryMetric(platform)] without re-deriving.
    primaryMetric: cfg.primary,
  };

  const post = {
    url,
    caption: typeof zPost.content === "string" ? zPost.content.slice(0, 2200) : "",
    thumbnail: zPost.thumbnailUrl || null,
    timestamp,
    mediaType,
    isVideo,
    platform: String(platform).toLowerCase(),
    handle: platformEntry?.accountUsername || zPost.accountUsername || null,
    isExternal: zPost.isExternal === true,        // organic (synced) vs posted-via-Zernio
    // Classifier slots filled later by the scoring spine (caption-based).
    format: null,
    hookType: null,
  };

  return { videoId, post, snapshot };
}

// Pick the platforms[]/platformAnalytics[] entry matching `platform`,
// tolerating both response shapes in the spec (list endpoint uses
// `platforms`, single-post uses `platformAnalytics`).
function pickPlatformEntry(zPost, platform) {
  const want = String(platform || "").toLowerCase();
  const arr = Array.isArray(zPost.platforms)
    ? zPost.platforms
    : Array.isArray(zPost.platformAnalytics)
    ? zPost.platformAnalytics
    : [];
  return arr.find((p) => String(p?.platform || "").toLowerCase() === want) || null;
}
