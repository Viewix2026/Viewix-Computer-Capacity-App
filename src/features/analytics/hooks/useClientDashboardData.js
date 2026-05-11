// useClientDashboardData — single hook that owns every Firebase
// subscription the Phase 4 dashboard needs. Co-located so the
// AnalyticsClientDetail component pulls one thing, not five.
//
// Subscribes to:
//   /analytics/clients/{id}/status       — badge state + reason
//   /analytics/clients/{id}/momentum     — score + explainable reasonLine
//   /analytics/clients/{id}/baselines    — medians + follower count
//   /analytics/clients/{id}/lastRecomputeAt
//   /analytics/clients/{id}/lastRefreshedAt
//   /analytics/videos/{id}               — all platforms (object), each
//                                          with post + snapshots + scoring
//   /analytics/followers/{id}            — per-platform follower history
//
// Returns a shape that's safe to render before any subscription has
// fired: status/momentum/baselines are null when missing, videos and
// followers default to empty objects. The detail UI checks these
// nulls and renders empty / loading states accordingly.
//
// All values here are precomputed truth from the API. The dashboard
// never re-derives — see scoringDisplay/* for the display helpers.

import { useEffect, useState } from "react";
import { initFB, onFB, fbListen } from "../../../firebase";

export function useClientDashboardData(clientId) {
  const [data, setData] = useState({
    status: null,
    momentum: null,
    baselines: null,
    lastRecomputeAt: null,
    lastRefreshedAt: null,
    videos: {},      // { [platform]: { [videoId]: { post, snapshots, scoring } } }
    followers: {},   // { [platform]: { [YYYY-MM-DD]: { count } } }
    loading: true,
  });

  useEffect(() => {
    if (!clientId) return undefined;
    initFB();
    let cancelled = false;
    const unsubs = [];

    onFB(() => {
      if (cancelled) return;

      // Single client-record listener gets status, momentum,
      // baselines, lastRecomputeAt, lastRefreshedAt in one shot.
      // Cheaper than five listeners and avoids tearing between
      // them (e.g. status updated but momentum not yet — both
      // arrive together via this single ref).
      unsubs.push(fbListen(`/analytics/clients/${clientId}`, (record) => {
        setData(prev => ({
          ...prev,
          status: record?.status || null,
          momentum: record?.momentum || null,
          baselines: record?.baselines || null,
          lastRecomputeAt: record?.lastRecomputeAt || null,
          lastRefreshedAt: record?.lastRefreshedAt || null,
          loading: false,
        }));
      }));

      // Videos can grow large — Phase 4 reads them all and lets the
      // component filter. Acceptable at v1 scale (~60–200 videos
      // per client). If perf becomes a problem, switch to per-platform
      // listeners in Phase 4.1.
      unsubs.push(fbListen(`/analytics/videos/${clientId}`, (vs) => {
        setData(prev => ({ ...prev, videos: vs || {} }));
      }));

      unsubs.push(fbListen(`/analytics/followers/${clientId}`, (fs) => {
        setData(prev => ({ ...prev, followers: fs || {} }));
      }));
    });

    return () => {
      cancelled = true;
      unsubs.forEach(u => u && u());
    };
  }, [clientId]);

  return data;
}

// ─── Derived selectors ────────────────────────────────────────────
// These read precomputed data and pick / sort / filter. They do NOT
// score anything — that math is in api/_analyticsScoring.js.

// Flatten the videos shape into a single sortable list with the
// platform + videoId on each entry for keys + click handling.
export function flattenVideos(videosByPlatform) {
  const out = [];
  for (const [platform, group] of Object.entries(videosByPlatform || {})) {
    for (const [videoId, v] of Object.entries(group || {})) {
      if (!v || !v.post) continue;
      // Use the latest snapshot for sorting + display. The /scoring
      // sub-record was computed off this same snapshot upstream.
      const snaps = v.snapshots || {};
      const dates = Object.keys(snaps).sort();
      const latest = dates.length ? snaps[dates[dates.length - 1]] : null;
      out.push({
        platform,
        videoId,
        post: v.post,
        snapshot: latest,
        scoring: v.scoring || null,
      });
    }
  }
  return out;
}

// Pick the top-N winning videos by repeatabilityScore (best signal
// of "do this again"), falling back to overperformanceScore.
// Filters out the "one-off spike" hard-flag — we don't want a 4.8x
// algorithm push to show up as a "winner" the team thinks they can
// replicate.
export function selectWinningVideos(videos, limit = 5) {
  return videos
    .filter(v => v.scoring && v.scoring.repeatabilityLabel !== "One-off spike — don't chase")
    .filter(v => v.scoring.overperformanceScore != null && v.scoring.overperformanceScore >= 1.0)
    .sort((a, b) => {
      // Primary: repeatability score (do-this-again signal).
      // Tiebreak: overperformance (raw signal).
      const dr = (b.scoring.repeatabilityScore || 0) - (a.scoring.repeatabilityScore || 0);
      if (dr !== 0) return dr;
      return (b.scoring.overperformanceScore || 0) - (a.scoring.overperformanceScore || 0);
    })
    .slice(0, limit);
}

// Pick the bottom-N posts — the ones that landed below baseline.
// Used by Phase 8's Underperformer red flags; included here so the
// data shape is stable.
export function selectUnderperformers(videos, limit = 3) {
  return videos
    .filter(v => v.scoring && v.scoring.overperformanceScore != null && v.scoring.overperformanceScore < 0.6)
    .sort((a, b) => (a.scoring.overperformanceScore || 0) - (b.scoring.overperformanceScore || 0))
    .slice(0, limit);
}

// Latest follower count for a platform (newest YYYY-MM-DD key).
// Returns { current, prev30d } so the UI can render a delta.
export function selectFollowerSnapshot(followers, platform) {
  const map = (followers && followers[platform]) || {};
  const dates = Object.keys(map).sort();
  if (!dates.length) return { current: null, prev30d: null };
  const current = map[dates[dates.length - 1]]?.count ?? null;
  // 30d back — find the closest date AT OR BEFORE (today - 30d).
  const targetMs = Date.now() - 30 * 24 * 3600 * 1000;
  let prev30d = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (new Date(dates[i]).getTime() <= targetMs) {
      prev30d = map[dates[i]]?.count ?? null;
      break;
    }
  }
  return { current, prev30d };
}
