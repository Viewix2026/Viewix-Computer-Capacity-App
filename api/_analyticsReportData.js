// api/_analyticsReportData.js — buildReportData(clientId)
//
// The deck-data assembler (Codex r2: the engine output is NOT slide-
// ready). recomputeClientAnalytics writes raw per-platform video records
// + per-platform scoring + per-platform status/momentum + baselines. The
// IG-only client projection strips platform identity, so it can't drive a
// multi-platform deck. This module reads the raw engine output and shapes
// it for slides — preserving platform labels, per-platform metric names,
// the date window, top posts per platform, and a side-by-side (NOT
// blended) cross-platform summary.
//
// Internal use only (all fields, no client redaction). Distinct from:
//   - _analyticsClientProjection.js (IG-only, client-redacted, portal)
//   - the future multi-platform portal projection (Phase 4)
//
// Pure shaping over an injected reader so it unit-tests without Firebase.

import { adminGet, getAdmin } from "./_fb-admin.js";
import { platformMetrics, metricNoun, primaryMetricValue } from "./_platformMetrics.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function defaultFbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

function latestSnapshot(video) {
  const snaps = video?.snapshots || {};
  const keys = Object.keys(snaps).sort();
  if (!keys.length) return null;
  return snaps[keys[keys.length - 1]];
}

function latestFollower(followersForPlatform) {
  const map = followersForPlatform || {};
  const keys = Object.keys(map).sort();
  if (!keys.length) return { count: null, date: null };
  const last = keys[keys.length - 1];
  return { count: map[last]?.count ?? null, date: last };
}

// Follower count from ~30 days before the latest, for a delta.
function follower30dAgo(followersForPlatform, latestDate) {
  const map = followersForPlatform || {};
  const keys = Object.keys(map).sort();
  if (!keys.length || !latestDate) return null;
  const targetMs = new Date(latestDate).getTime() - 30 * 24 * 3600 * 1000;
  let pick = null;
  for (const k of keys) {
    if (new Date(k).getTime() <= targetMs) pick = k; else break;
  }
  return pick ? (map[pick]?.count ?? null) : null;
}

const day = 24 * 3600 * 1000;

/**
 * buildReportData(clientId, { fbGet } = {})
 * Returns the slide-ready, internal report object. `fbGet` is injectable
 * for tests; defaults to the admin-or-REST reader.
 */
export async function buildReportData(clientId, { fbGet = defaultFbGet, now = Date.now(), topN = 5 } = {}) {
  if (!clientId) throw new Error("buildReportData: missing clientId");

  const client = (await fbGet(`/analytics/clients/${clientId}`)) || {};
  const config = client.config || {};
  const baselines = client.baselines || {};
  const perPlatform = client.platforms || {};
  const enabledPlatforms = Object.keys(config.platforms || {}).filter((p) => config.platforms[p]);

  const videosRoot = (await fbGet(`/analytics/videos/${clientId}`)) || {};
  const followersRoot = (await fbGet(`/analytics/followers/${clientId}`)) || {};

  const toDate = new Date(now).toISOString().slice(0, 10);
  let oldestTs = now;

  const platforms = [];
  for (const platform of enabledPlatforms) {
    const meta = platformMetrics(platform);
    const noun = metricNoun(platform);
    const vids = videosRoot[platform] || {};
    const list = Object.entries(vids).map(([videoId, v]) => ({ videoId, ...v }));
    if (list.length === 0) {
      platforms.push({
        platform, primaryMetric: meta.primary, metricNoun: noun,
        hasImpressions: meta.hasImpressions, hasFollowers: meta.hasFollowers,
        status: perPlatform[platform]?.status || null,
        momentum: perPlatform[platform]?.momentum || null,
        followerCount: null, followerDelta30d: null,
        totals: { posts: 0, primaryMetricSum30d: 0, engagementRateAvg: null },
        topPosts: [],
      });
      continue;
    }

    const win30 = now - 30 * day;
    let primarySum30 = 0, erSum = 0, erN = 0;
    const enriched = [];
    for (const v of list) {
      const snap = latestSnapshot(v);
      if (!snap) continue;
      const ts = v.post?.timestamp ? new Date(v.post.timestamp).getTime() : null;
      if (ts && ts < oldestTs) oldestTs = ts;
      const primary = primaryMetricValue(snap, platform) || 0;
      if (ts && ts >= win30) primarySum30 += primary;
      if (snap.engagementRate != null) { erSum += snap.engagementRate; erN++; }
      enriched.push({ v, snap, ts, primary });
    }

    // Top posts by the platform's primary metric (impressions for
    // LinkedIn/FB, views for IG/YT/TikTok). Repeatability/overperformance
    // labels carried straight from scoring.
    const topPosts = enriched
      .sort((a, b) => (b.primary || 0) - (a.primary || 0))
      .slice(0, topN)
      .map(({ v, snap, primary }) => ({
        url: v.post?.url || null,
        caption: (v.post?.caption || "").slice(0, 240),
        thumbnail: v.post?.thumbnail || null,
        mediaType: v.post?.mediaType || null,
        timestamp: v.post?.timestamp || null,
        format: v.classifications?.format || null,
        primaryMetric: meta.primary,
        primaryValue: primary,
        metrics: {
          impressions: snap.impressions ?? null,
          reach: snap.reach ?? null,
          views: snap.views ?? null,
          likes: snap.likes ?? null,
          comments: snap.comments ?? null,
          shares: snap.shares ?? null,
          engagementRate: snap.engagementRate ?? null,
        },
        overperformanceLabel: v.scoring?.overperformanceLabel || null,
        repeatabilityLabel: v.scoring?.repeatabilityLabel || null,
      }));

    const { count: followerCount, date: followerDate } = latestFollower(followersRoot[platform]);
    const prevFollower = follower30dAgo(followersRoot[platform], followerDate);
    const followerDelta30d =
      followerCount != null && prevFollower != null && prevFollower > 0
        ? +(((followerCount - prevFollower) / prevFollower) * 100).toFixed(1)
        : null;

    platforms.push({
      platform,
      primaryMetric: meta.primary,
      metricNoun: noun,
      hasImpressions: meta.hasImpressions,
      hasFollowers: meta.hasFollowers,
      status: perPlatform[platform]?.status || null,
      momentum: perPlatform[platform]?.momentum || null,
      followerCount,
      followerDelta30d,
      medianPrimary: baselines.medianViews?.[platform] ?? null,
      totals: {
        posts: list.length,
        primaryMetricSum30d: primarySum30,
        engagementRateAvg: erN ? +(erSum / erN).toFixed(3) : null,
      },
      topPosts,
    });
  }

  // Cross-platform summary: side-by-side headline per platform. NEVER a
  // sum/blend across platforms (metrics aren't comparable). Ordered with
  // the configured primary platform first (the report's focus).
  const primaryPlatform = client.primaryPlatform || config.primaryPlatform || enabledPlatforms[0] || null;
  const order = [...platforms].sort((a, b) => {
    if (a.platform === primaryPlatform) return -1;
    if (b.platform === primaryPlatform) return 1;
    return 0;
  });
  const crossPlatform = {
    primaryPlatform,
    perPlatform: order.map((p) => ({
      platform: p.platform,
      headlineMetric: p.primaryMetric,
      headlineMetricNoun: p.metricNoun,
      headlineSum30d: p.totals.primaryMetricSum30d,
      posts: p.totals.posts,
      momentumScore: p.momentum?.score ?? null,
      statusState: p.status?.state ?? null,
      followerCount: p.followerCount,
      followerDelta30d: p.followerDelta30d,
    })),
  };

  const fromDate = oldestTs < now ? new Date(oldestTs).toISOString().slice(0, 10) : toDate;

  return {
    clientId,
    companyName: config.companyName || clientId,
    generatedAt: new Date(now).toISOString(),
    dateWindow: { fromDate, toDate },
    primaryPlatform,
    platforms: order,
    crossPlatform,
  };
}
