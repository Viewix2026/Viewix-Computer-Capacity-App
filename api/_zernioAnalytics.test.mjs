// Per-platform fixtures for normaliseZernioPost — pins each platform's
// metric mapping so a future change can't silently (a) drop LinkedIn/FB
// text posts, (b) invent impressions on YT/TikTok, or (c) compare
// Zernio engagementRate against legacy IG follower-normalised values.
//
// No test runner in this repo (vite only) — standalone node script:
//   node api/_zernioAnalytics.test.mjs
// Exits non-zero on any failure (CI-gateable).

import {
  normaliseZernioPost,
  primaryMetric,
  platformMetrics,
} from "./_zernioAnalytics.js";

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Build a raw Zernio analytics post (list-endpoint shape) for a platform.
function zPost({ platform, mediaType, content = "hi", analytics, isExternal = true, id = "p1" }) {
  return {
    _id: `zer_${id}`,
    content,
    publishedAt: "2026-05-01T10:00:00Z",
    status: "published",
    platform,
    platformPostUrl: `https://example.com/${platform}/${id}`,
    thumbnailUrl: "https://cdn.example.com/t.jpg",
    mediaType,
    isExternal,
    platforms: [
      {
        platform,
        platformPostId: `ext_${id}`,
        accountUsername: `@acme_${platform}`,
        platformPostUrl: `https://example.com/${platform}/${id}`,
        analytics,
      },
    ],
  };
}

const richAnalytics = {
  impressions: 15420, reach: 12350, likes: 342, comments: 28, shares: 45,
  saves: 10, clicks: 189, views: 0, engagementRate: 2.78, lastUpdated: "2026-05-02T08:30:00Z",
};
const limitedAnalytics = { // YT/TikTok shape — no impressions/reach
  impressions: undefined, reach: undefined, likes: 500, comments: 40, shares: 12,
  saves: undefined, clicks: undefined, views: 90000, engagementRate: 1.4, lastUpdated: "2026-05-02T08:30:00Z",
};

// ── 1. LinkedIn TEXT post (no video, no views) must be KEPT ───────────
{
  console.log("LinkedIn text post");
  const n = normaliseZernioPost(zPost({ platform: "linkedin", mediaType: "text", analytics: richAnalytics }), "linkedin");
  check("kept (not dropped despite non-video)", n !== null);
  check("primary metric is impressions", primaryMetric("linkedin") === "impressions");
  check("impressions populated", n?.snapshot.impressions === 15420);
  check("views present but not primary", n?.snapshot.views === 0);
  check("engagementRateSource = zernio", n?.snapshot.engagementRateSource === "zernio");
  check("videoId namespaced by platform", n?.videoId === "linkedin_ext_p1");
  check("isExternal carried (organic)", n?.post.isExternal === true);
}

// ── 2. LinkedIn VIDEO post — views present ────────────────────────────
{
  console.log("LinkedIn video post");
  const n = normaliseZernioPost(zPost({ platform: "linkedin", mediaType: "video", analytics: { ...richAnalytics, views: 8000 } }), "linkedin");
  check("kept", n !== null);
  check("views populated for video", n?.snapshot.views === 8000);
  check("isVideo true", n?.post.isVideo === true);
}

// ── 3. YouTube — limited metrics, impressions must be NULL not 0 ───────
{
  console.log("YouTube post");
  check("hasImpressions false", platformMetrics("youtube").hasImpressions === false);
  const n = normaliseZernioPost(zPost({ platform: "youtube", mediaType: "video", analytics: limitedAnalytics }), "youtube");
  check("kept", n !== null);
  check("impressions NULL (not invented)", n?.snapshot.impressions === null);
  check("reach NULL (not invented)", n?.snapshot.reach === null);
  check("views populated", n?.snapshot.views === 90000);
  check("primary metric is views", primaryMetric("youtube") === "views");
}

// ── 4. TikTok — no follower relevance, no impressions ─────────────────
{
  console.log("TikTok post");
  check("hasFollowers false", platformMetrics("tiktok").hasFollowers === false);
  const n = normaliseZernioPost(zPost({ platform: "tiktok", mediaType: "video", analytics: limitedAnalytics }), "tiktok");
  check("impressions NULL", n?.snapshot.impressions === null);
  check("views populated", n?.snapshot.views === 90000);
}

// ── 5. Instagram — back-compat: primary stays views ───────────────────
{
  console.log("Instagram reel");
  check("primary metric stays views (back-compat)", primaryMetric("instagram") === "views");
  const n = normaliseZernioPost(zPost({ platform: "instagram", mediaType: "reel", analytics: { ...richAnalytics, views: 24000 } }), "instagram");
  check("kept", n !== null);
  check("views primary populated", n?.snapshot.views === 24000);
  check("impressions also captured", n?.snapshot.impressions === 15420);
}

// ── 6. Instagram IMAGE post — videoOnly platform → DROPPED ────────────
{
  console.log("Instagram image post (should drop)");
  const n = normaliseZernioPost(zPost({ platform: "instagram", mediaType: "image", analytics: richAnalytics }), "instagram");
  check("dropped (non-video on videoOnly platform)", n === null);
}

// ── 7. Facebook — keeps non-video, has impressions ───────────────────
{
  console.log("Facebook text post");
  check("videoOnly false", platformMetrics("facebook").videoOnly === false);
  const n = normaliseZernioPost(zPost({ platform: "facebook", mediaType: "text", analytics: richAnalytics }), "facebook");
  check("kept", n !== null);
  check("primary metric impressions", primaryMetric("facebook") === "impressions");
}

// ── 8. Guard rails — junk in → null, never throw ─────────────────────
{
  console.log("Guard rails");
  check("null post → null", normaliseZernioPost(null, "linkedin") === null);
  check("missing url → null", normaliseZernioPost({ publishedAt: "2026-01-01", platforms: [] }, "linkedin") === null);
  check("unknown platform → default config", platformMetrics("mastodon").primary === "views");
}

// ── 9. Shape tolerance (Codex r3) — metrics directly on entry ────────
{
  console.log("Metrics directly on platform entry (no nested .analytics)");
  const raw = {
    _id: "zer_x", content: "flat shape", publishedAt: "2026-05-01T10:00:00Z",
    mediaType: "video", platformPostUrl: "https://example.com/li/x",
    platforms: [{
      platform: "linkedin", platformPostId: "ext_x",
      platformPostUrl: "https://example.com/li/x",
      // metrics live directly here, NOT under .analytics
      impressions: 7777, likes: 50, comments: 5, shares: 2, engagementRate: 0.9,
    }],
  };
  const n = normaliseZernioPost(raw, "linkedin");
  check("extracted from entry-level metrics", n?.snapshot.impressions === 7777);
  check("not all-null", n?.snapshot.likes === 50);
}

// ── 10. videoId idempotency fallback to URL hash ─────────────────────
{
  console.log("videoId fallback — no platform-native id");
  const mk = () => normaliseZernioPost({
    content: "no id", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
    platformPostUrl: "https://example.com/li/stable", analytics: { impressions: 10 },
    platforms: [{ platform: "linkedin", platformPostUrl: "https://example.com/li/stable", analytics: { impressions: 10 } }],
  }, "linkedin");
  const a = mk(), b = mk();
  check("videoId present from url hash", !!a?.videoId && a.videoId.startsWith("linkedin_u"));
  check("deterministic across runs (idempotent)", a.videoId === b.videoId);
}

// ── 11. lastUpdated is NOT used as post timestamp (Codex r4) ──────────
{
  console.log("dateless post is dropped, NOT dated by lastUpdated");
  const n = normaliseZernioPost({
    content: "no date", mediaType: "video", platformPostUrl: "https://example.com/li/z",
    platforms: [{ platform: "linkedin", platformPostId: "ext_z", platformPostUrl: "https://example.com/li/z",
                  analytics: { impressions: 1, lastUpdated: "2026-05-02T08:00:00Z" } }],
  }, "linkedin");
  check("dropped (no real post date)", n === null);
  // ...but a real date still works, and lastUpdated is stored separately
  const m = normaliseZernioPost({
    content: "dated", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
    platformPostUrl: "https://example.com/li/z2",
    platforms: [{ platform: "linkedin", platformPostId: "ext_z2", platformPostUrl: "https://example.com/li/z2",
                  analytics: { impressions: 1, lastUpdated: "2026-05-02T08:00:00Z" } }],
  }, "linkedin");
  check("dated post kept", m !== null);
  check("timestamp = real post date (not lastUpdated)", m?.post.timestamp === "2026-05-01T10:00:00Z");
  check("analyticsLastUpdated stored separately", m?.snapshot.analyticsLastUpdated === "2026-05-02T08:00:00Z");
}

// ── 12. account-level lone `likes` must NOT masquerade as post analytics
{
  console.log("account metadata does not masquerade as post analytics (Codex r4)");
  const n = normaliseZernioPost({
    content: "post", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
    platformPostUrl: "https://example.com/li/m",
    // post-level metrics live flat on the post...
    impressions: 5000, likes: 40, comments: 6, engagementRate: 1.1,
    // ...but the platform entry carries only an account-total `likes`.
    platforms: [{ platform: "linkedin", platformPostId: "ext_m",
                  platformPostUrl: "https://example.com/li/m", likes: 999999 }],
  }, "linkedin");
  check("picked POST metrics, not account likes", n?.snapshot.impressions === 5000);
  check("post-level likes used (40, not 999999)", n?.snapshot.likes === 40);
}

// ── 13. canonical URL → utm variants map to the same videoId ─────────
{
  console.log("canonical URL idempotency (Codex r4)");
  const mk = (u) => normaliseZernioPost({
    content: "x", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
    platformPostUrl: u,
    platforms: [{ platform: "linkedin", platformPostUrl: u, analytics: { impressions: 9, likes: 1 } }],
  }, "linkedin");
  const a = mk("https://example.com/li/canon");
  const b = mk("https://example.com/li/canon?utm_source=newsletter&fbclid=123");
  const c = mk("https://example.com/li/canon#section");
  check("bare and ?utm variant → same videoId", a?.videoId === b?.videoId);
  check("bare and #fragment variant → same videoId", a?.videoId === c?.videoId);
}

// ── 14. identity query params are PRESERVED (Codex r3) ───────────────
{
  console.log("identity query params not stripped (YouTube ?v=, FB story_fbid)");
  const ytA = normaliseZernioPost({
    content: "yt a", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
    platformPostUrl: "https://www.youtube.com/watch?v=AAA&utm_source=x",
    platforms: [{ platform: "youtube", platformPostUrl: "https://www.youtube.com/watch?v=AAA&utm_source=x", analytics: { views: 1, likes: 1 } }],
  }, "youtube");
  const ytB = normaliseZernioPost({
    content: "yt b", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
    platformPostUrl: "https://www.youtube.com/watch?v=BBB",
    platforms: [{ platform: "youtube", platformPostUrl: "https://www.youtube.com/watch?v=BBB", analytics: { views: 1, likes: 1 } }],
  }, "youtube");
  check("different ?v= → different videoId (NOT collapsed)", ytA?.videoId !== ytB?.videoId);
  check("tracking param still stripped (?v=AAA&utm == ?v=AAA)",
    ytA?.videoId === normaliseZernioPost({
      content: "yt a2", publishedAt: "2026-05-01T10:00:00Z", mediaType: "video",
      platformPostUrl: "https://www.youtube.com/watch?v=AAA",
      platforms: [{ platform: "youtube", platformPostUrl: "https://www.youtube.com/watch?v=AAA", analytics: { views: 1, likes: 1 } }],
    }, "youtube")?.videoId);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
