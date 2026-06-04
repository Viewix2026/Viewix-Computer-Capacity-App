// Pins per-platform metric semantics + the Instagram back-compat
// guarantee the scoring refactor depends on: a legacy IG snapshot that
// only carried `views` must still resolve through primaryMetricValue
// unchanged, so the existing IG pilot's numbers don't move.
//
//   node api/_platformMetrics.test.mjs

import {
  primaryMetric, metricNoun, platformMetrics, primaryMetricValue, PLATFORM_METRICS,
} from "./_platformMetrics.js";

let failures = 0;
const ck = (n, c, d) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

console.log("Primary metric per platform");
ck("instagram → views (back-compat anchor)", primaryMetric("instagram") === "views");
ck("youtube → views", primaryMetric("youtube") === "views");
ck("tiktok → views", primaryMetric("tiktok") === "views");
ck("linkedin → impressions", primaryMetric("linkedin") === "impressions");
ck("facebook → impressions", primaryMetric("facebook") === "impressions");
ck("unknown → views (safe default)", primaryMetric("mastodon") === "views");

console.log("Metric noun (drives the '4.8x usual X' label)");
ck("instagram noun views", metricNoun("instagram") === "views");
ck("linkedin noun impressions", metricNoun("linkedin") === "impressions");

console.log("Capability flags");
ck("tiktok hasFollowers false", platformMetrics("tiktok").hasFollowers === false);
ck("youtube hasImpressions false", platformMetrics("youtube").hasImpressions === false);
ck("linkedin videoOnly false (keeps text posts)", platformMetrics("linkedin").videoOnly === false);
ck("facebook videoOnly false", platformMetrics("facebook").videoOnly === false);
ck("instagram videoOnly true", platformMetrics("instagram").videoOnly === true);

console.log("primaryMetricValue — IG back-compat fallback");
ck("IG legacy snapshot {views} → views (UNCHANGED)", primaryMetricValue({ views: 1000 }, "instagram") === 1000);
ck("IG snapshot with impressions still scores on views", primaryMetricValue({ views: 1000, impressions: 9999 }, "instagram") === 1000);
ck("LinkedIn scores on impressions", primaryMetricValue({ impressions: 5000, views: 0 }, "linkedin") === 5000);
ck("LinkedIn falls back to views when no impressions (video post)", primaryMetricValue({ views: 200 }, "linkedin") === 200);
ck("null snapshot → null (no crash)", primaryMetricValue(null, "linkedin") === null);
ck("empty snapshot → null", primaryMetricValue({}, "linkedin") === null);

console.log("Config completeness");
for (const p of ["instagram", "facebook", "linkedin", "youtube", "tiktok"]) {
  const m = PLATFORM_METRICS[p];
  ck(`${p} config has all flags`, m && "primary" in m && "noun" in m && "hasFollowers" in m && "hasImpressions" in m && "videoOnly" in m);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
