// buildReportData fixtures — proves the deck assembler shapes engine
// output correctly: LinkedIn-primary ordering, per-platform top posts
// sorted by that platform's primary metric, and a side-by-side (never
// blended) cross-platform summary.
//
//   node api/_analyticsReportData.test.mjs

import { buildReportData } from "./_analyticsReportData.js";

let failures = 0;
const ck = (n, c, d) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

const NOW = Date.parse("2026-05-18T00:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const day10 = NOW - 10 * 86400000;

// Fake Firebase store keyed by path.
const STORE = {
  "/analytics/clients/acct-1": {
    config: {
      companyName: "Acme Pty Ltd",
      platforms: { linkedin: true, instagram: true, tiktok: true },
      primaryPlatform: "linkedin",
    },
    primaryPlatform: "linkedin",
    baselines: { medianViews: { linkedin: 4000, instagram: 9000, tiktok: 50000 }, primaryMetric: { linkedin: "impressions", instagram: "views", tiktok: "views" } },
    platforms: {
      linkedin:  { status: { state: "growing" }, momentum: { score: 72, reasonLine: "impressions up 30%" } },
      instagram: { status: { state: "flat" },    momentum: { score: 51, reasonLine: "views flat" } },
      tiktok:    { status: { state: "growing" }, momentum: { score: 80, reasonLine: "views up 120%" } },
    },
  },
  "/analytics/videos/acct-1": {
    linkedin: {
      li_a: { post: { url: "https://li/a", caption: "Founder thoughts", mediaType: "text", timestamp: iso(5) },
              snapshots: { "2026-05-15": { impressions: 12000, reach: 9000, likes: 100, comments: 20, shares: 8, views: 0, engagementRate: 1.2 } },
              scoring: { overperformanceLabel: "3.0x usual impressions", repeatabilityLabel: "Likely repeatable" },
              classifications: { format: "founder_talking_head" } },
      li_b: { post: { url: "https://li/b", caption: "Case study", mediaType: "video", timestamp: iso(12) },
              snapshots: { "2026-05-12": { impressions: 30000, reach: 21000, likes: 240, comments: 33, shares: 19, views: 8000, engagementRate: 1.6 } },
              scoring: { overperformanceLabel: "7.5x usual impressions", repeatabilityLabel: "Likely repeatable" },
              classifications: { format: "client_proof" } },
    },
    instagram: {
      ig_a: { post: { url: "https://ig/a", caption: "Reel", mediaType: "reel", timestamp: iso(8) },
              snapshots: { "2026-05-14": { views: 24000, likes: 800, comments: 30, engagementRate: 3.4 } },
              scoring: { overperformanceLabel: "2.6x usual views" } },
    },
    tiktok: {
      tt_a: { post: { url: "https://tt/a", caption: "Trend", mediaType: "video", timestamp: iso(3) },
              snapshots: { "2026-05-17": { views: 210000, likes: 5000, comments: 120 } },
              scoring: {} },
    },
  },
  "/analytics/followers/acct-1": {
    linkedin: { "2026-04-15": { count: 1800 }, "2026-05-15": { count: 2050 } },
    instagram: { "2026-05-15": { count: 12000 } },
    // tiktok: none (hasFollowers false anyway)
  },
};

const fakeFbGet = async (path) => STORE[path] ?? null;

const report = await buildReportData("acct-1", { fbGet: fakeFbGet, now: NOW });

console.log("Top-level");
ck("companyName", report.companyName === "Acme Pty Ltd");
ck("primaryPlatform linkedin", report.primaryPlatform === "linkedin");
ck("3 platforms", report.platforms.length === 3);
ck("date window toDate today", report.dateWindow.toDate === "2026-05-18");
ck("date window fromDate = oldest post", report.dateWindow.fromDate === new Date(day10 - 2 * 86400000).toISOString().slice(0, 10), report.dateWindow.fromDate);

console.log("Ordering — LinkedIn (primary) first");
ck("platforms[0] is linkedin", report.platforms[0].platform === "linkedin");
ck("crossPlatform[0] is linkedin", report.crossPlatform.perPlatform[0].platform === "linkedin");

console.log("LinkedIn section");
const li = report.platforms.find((p) => p.platform === "linkedin");
ck("primary metric impressions", li.primaryMetric === "impressions");
ck("top posts sorted by impressions (li_b 30k first)", li.topPosts[0].url === "https://li/b");
ck("top post primaryValue = impressions", li.topPosts[0].primaryValue === 30000);
ck("repeatability label carried", li.topPosts[0].repeatabilityLabel === "Likely repeatable");
ck("follower delta computed (+13.9%)", li.followerDelta30d === 13.9, String(li.followerDelta30d));
ck("momentum carried", li.momentum.score === 72);

console.log("TikTok section — no followers");
const tt = report.platforms.find((p) => p.platform === "tiktok");
ck("hasFollowers false", tt.hasFollowers === false);
ck("followerCount null", tt.followerCount === null);
ck("hasImpressions false", tt.hasImpressions === false);
ck("top post by views", tt.topPosts[0].primaryValue === 210000);

console.log("Cross-platform — side-by-side, NOT blended");
const sums = report.crossPlatform.perPlatform.map((p) => p.headlineSum30d);
ck("each platform has its own headline sum", sums.length === 3 && sums.every((s) => typeof s === "number"));
ck("no top-level blended total exists", report.crossPlatform.total === undefined && report.crossPlatform.blended === undefined);
ck("linkedin headline metric is impressions", report.crossPlatform.perPlatform[0].headlineMetric === "impressions");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
