// api/_platformMetrics.js — the single source of truth for per-platform
// metric semantics. Pure config + helpers, no I/O, no env, no deps.
//
// Both the scoring engine (_analyticsScoring.js) and the Zernio analytics
// layer (_zernioAnalytics.js) import from here so "what is LinkedIn's
// headline metric / does TikTok have followers" is answered in exactly
// one place.
//
// Why this matters (Codex review): the engine was views-first — it scored
// a field literally named `views` and summed it across platforms. That's
// meaningless for LinkedIn (impressions, no views on text posts) and
// TikTok (views, no follower count). `primaryMetric(platform)` lets
// scoring read the right headline number per platform; the rest of the
// flags gate follower-normalised reach, impressions rendering, and
// video-only filtering.

export const PLATFORM_METRICS = {
  // IG stays on `views` so the existing Instagram pilot's numbers and
  // stored baselines are byte-identical after this refactor.
  instagram: { primary: "views",       noun: "views",       hasFollowers: true,  hasImpressions: true,  videoOnly: true  },
  facebook:  { primary: "impressions", noun: "impressions", hasFollowers: true,  hasImpressions: true,  videoOnly: false },
  linkedin:  { primary: "impressions", noun: "impressions", hasFollowers: true,  hasImpressions: true,  videoOnly: false },
  youtube:   { primary: "views",       noun: "views",       hasFollowers: true,  hasImpressions: false, videoOnly: true  },
  tiktok:    { primary: "views",       noun: "views",       hasFollowers: false, hasImpressions: false, videoOnly: true  },
};

const DEFAULT_METRICS = { primary: "views", noun: "views", hasFollowers: false, hasImpressions: false, videoOnly: false };

export function platformMetrics(platform) {
  return PLATFORM_METRICS[String(platform || "").toLowerCase()] || DEFAULT_METRICS;
}

// The metric scoring should treat as the headline number for a platform
// (medians, overperformance). IG/YT/TikTok → "views"; LinkedIn/FB →
// "impressions".
export function primaryMetric(platform) {
  return platformMetrics(platform).primary;
}

// Human noun for the headline metric, used in labels like
// "4.8x usual views" / "3.1x usual impressions".
export function metricNoun(platform) {
  return platformMetrics(platform).noun;
}

// Read the platform's headline metric value off a snapshot, falling back
// to `views` so legacy IG snapshots (which only carried views) keep
// working unchanged.
export function primaryMetricValue(snapshot, platform) {
  if (!snapshot) return null;
  const key = primaryMetric(platform);
  const v = snapshot[key];
  if (v != null) return v;
  return snapshot.views != null ? snapshot.views : null;
}
