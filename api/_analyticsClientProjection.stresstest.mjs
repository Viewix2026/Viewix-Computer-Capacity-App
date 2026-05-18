// Stress-test for buildClientProjection — the client-safe contract.
//
// No test runner in this repo (vite only). This is a standalone node
// script: `node api/_analyticsClientProjection.stresstest.mjs`.
// Exits non-zero on any failure so it can gate CI later.
//
// It runs the five data scenarios the design brief mandates and
// asserts the projection NEVER bluffs and NEVER leaks internal state:
//   1. great month
//   2. flat month
//   3. brand-new client (almost no data)
//   4. one viral spike (must not distort the read)
//   5. no competitor data
// Plus a universal leak check on every scenario.

import { buildClientProjection } from "./_analyticsClientProjection.js";

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Internal markers that must NEVER appear anywhere in the projection.
const NEVER = [
  "renewalAmmo", "ruleId", "rule.", "whyMightBeWrong", "confidence",
  "repeatab", "overperformanceScore", "scored", " n=", "_sourceTimestamp",
  "founder_talking_head", "client_proof", "behind_the_scenes",
  "objection_handling", "manualFormatOverride", "claudeReason",
];
function leakCheck(scenario, projection) {
  const json = JSON.stringify(projection);
  const hit = NEVER.find(m => json.includes(m));
  check(`[${scenario}] no internal leak`, !hit, hit ? `found "${hit}"` : "");
}

// ─── fixture builders ─────────────────────────────────────────────
function vid(id, fmt, score, views, ageDays = 5) {
  const ts = new Date(Date.now() - ageDays * 864e5).toISOString();
  return {
    videoId: id, platform: "instagram",
    scoring: { overperformanceScore: score },
    classification: { format: fmt },
    _sourceTimestamp: ts,
  };
}
function videosRoot(vids) {
  const ig = {};
  for (const v of vids) {
    ig[v.videoId] = {
      post: { caption: `caption ${v.videoId}`, url: `https://instagram.com/p/${v.videoId}/`,
              thumbnail: null, timestamp: v._sourceTimestamp },
      snapshots: { "2026-05-15": { views: 9000, likes: 200, comments: 12 } },
    };
  }
  return { instagram: ig };
}
function formatCounts(map) {
  const o = {};
  for (const [k, [count, med]] of Object.entries(map)) o[k] = { count, medianOverperf: med };
  return o;
}
const baseRenewal = {
  totalPosts: 42,
  topPosts: [{ caption: "best one", views: 51000, url: "https://instagram.com/p/best/" }],
  trajectoryHighlights: [{ startCount: 1800, latestCount: 2100, label: "followers" }],
};
const baseCompetitors = {
  instagram: { rivalco: { videos: { cvid1: { post: { url: "https://instagram.com/p/cvid1/" } } } } },
};
const baseNiche = { posts: [{ take: "Short explainers are landing in this space.", post: { url: "https://instagram.com/p/cvid1/" } }] };

// ─── 1. great month ───────────────────────────────────────────────
{
  const vids = [
    vid("g1", "founder_talking_head", 4.8, 24000),
    vid("g2", "founder_talking_head", 3.1, 16000),
    vid("g3", "founder_talking_head", 2.2, 12000),
    vid("g4", "client_proof", 1.9, 9000),
  ];
  const p = buildClientProjection({
    config: { companyName: "Acme Co" },
    status: { state: "growing", reason: "Views up 32% vs the prior 30 days." },
    momentum: { signals: { viewsDelta: 0.32 } },
    baselines: { medianEngagementRate: { instagram: 0.05 } },
    competitorCohort: { instagram: { medianEngagementRate: 0.03 } },
    formatCounts: formatCounts({ founder_talking_head: [3, 3.3], client_proof: [1, 1.9] }),
    recs: [{ idea: "Make another founder-led explainer.", rationale: "Your strongest format.", sourceType: "client_post", sourceIds: ["g1"] }],
    videoUpdates: vids, videosRoot: videosRoot(vids),
    competitorsRoot: baseCompetitors, renewalAmmo: baseRenewal,
    thisWeekInNiche: baseNiche, enabledPlatforms: ["instagram"],
    computedAt: new Date().toISOString(),
  });
  console.log("Scenario 1 — great month");
  check("header not gathering", p.meta.dataState.header === "ready");
  check("momentum has metric+%", /up \d+%/.test(p.header.momentumSentence), p.header.momentumSentence);
  check("hero proof present + has ×", !!p.header.heroProof && p.header.heroProof.includes("×"), p.header.heroProof || "null");
  check("winning populated", p.winning && p.winning.length >= 3);
  check("formatPlaybook present (≥3-sample only)", p.formatPlaybook && p.formatPlaybook.length === 1, `len ${p.formatPlaybook?.length}`);
  check("winning labels humanised", p.winning.every(w => /× your usual views/.test(w.winLabel)));
  leakCheck("great", p);
}

// ─── 2. flat month ────────────────────────────────────────────────
{
  const vids = [vid("f1", "client_proof", 1.1, 7000), vid("f2", "client_proof", 0.9, 6000), vid("f3", "client_proof", 1.0, 6500)];
  const p = buildClientProjection({
    config: { companyName: "Flatline Co" },
    status: { state: "flat", reason: "Views within 4% of the prior 30 days." },
    momentum: { signals: { viewsDelta: 0.04 } },
    baselines: { medianEngagementRate: { instagram: 0.03 } },
    competitorCohort: { instagram: { medianEngagementRate: 0.03 } },
    formatCounts: formatCounts({ client_proof: [3, 1.0] }),
    recs: [{ idea: "Test a founder-led explainer this month.", rationale: "Worth a controlled test.", sourceType: "client_post", sourceIds: ["f1"] }],
    videoUpdates: vids, videosRoot: videosRoot(vids),
    competitorsRoot: baseCompetitors, renewalAmmo: baseRenewal,
    thisWeekInNiche: baseNiche, enabledPlatforms: ["instagram"],
    computedAt: new Date().toISOString(),
  });
  console.log("Scenario 2 — flat month");
  check("momentum sentence present", !!p.header.momentumSentence);
  check("not alarmist (no 'down 100%', no 'failing')", !/down 100%|failing|crisis/i.test(JSON.stringify(p)));
  check("flat format below 1.0 excluded / honest", p.formatPlaybook === null || p.formatPlaybook.every(f => /×/.test(f.comparisonSentence)));
  check("no hero proof bluff (no fake ×)", !p.header.heroProof || p.header.heroProof.includes("×"));
  leakCheck("flat", p);
}

// ─── 3. brand-new client (almost no data) ─────────────────────────
{
  const p = buildClientProjection({
    config: { companyName: "Fresh Start" },
    status: { state: "insufficient", reason: "Not enough data yet." },
    momentum: { signals: {} },
    baselines: {},
    competitorCohort: {},
    formatCounts: {},
    recs: [],
    videoUpdates: [], videosRoot: { instagram: {} },
    competitorsRoot: {}, renewalAmmo: {},
    thisWeekInNiche: null, enabledPlatforms: ["instagram"],
    computedAt: new Date().toISOString(),
  });
  console.log("Scenario 3 — brand-new client");
  check("header gathering", p.meta.dataState.header === "gathering");
  check("no fabricated number in header", !/\d+%|\d+×/.test(p.header.momentumSentence), p.header.momentumSentence);
  check("winning null", p.winning === null);
  check("nextVideos null", p.nextVideos === null);
  check("formatPlaybook null", p.formatPlaybook === null);
  check("niche absent (hidden)", p.meta.dataState.niche === "absent" && p.niche === null);
  check("freshness line still present", !!p.meta.freshnessLine);
  leakCheck("new", p);
}

// ─── 4. one viral spike (must not distort) ────────────────────────
{
  // 1 monster post + 2 normal in the SAME format (count=3 ok), and a
  // 1-post format that should NOT become a "winner".
  const vids = [
    vid("v1", "trend_based", 210, 410000),    // viral
    vid("v2", "trend_based", 1.0, 7000),
    vid("v3", "trend_based", 0.8, 5000),
    vid("v4", "event_activation", 9.0, 60000), // single-post format — must be excluded
  ];
  const p = buildClientProjection({
    config: { companyName: "Spike Co" },
    status: { state: "growing", reason: "Views up 80% vs the prior 30 days." },
    momentum: { signals: { viewsDelta: 0.8 } },
    baselines: { medianEngagementRate: { instagram: 0.04 } },
    competitorCohort: { instagram: { medianEngagementRate: 0.03 } },
    formatCounts: formatCounts({ trend_based: [3, 1.0], event_activation: [1, 9.0] }),
    recs: [{ idea: "Lean into your proven formats.", rationale: "Steady performers beat chasing a one-off.", sourceType: "client_post", sourceIds: ["v2"] }],
    videoUpdates: vids, videosRoot: videosRoot(vids),
    competitorsRoot: baseCompetitors, renewalAmmo: baseRenewal,
    thisWeekInNiche: baseNiche, enabledPlatforms: ["instagram"],
    computedAt: new Date().toISOString(),
  });
  console.log("Scenario 4 — one viral spike");
  check("single-post format NOT a playbook winner",
    !p.formatPlaybook || !p.formatPlaybook.some(f => /event/i.test(f.format)),
    JSON.stringify(p.formatPlaybook));
  check("trend_based playbook uses MEDIAN not the spike (≈1×, not 70×)",
    !p.formatPlaybook || p.formatPlaybook.every(f => !/[2-9]\d×|\d{3}×/.test(f.comparisonSentence)),
    JSON.stringify(p.formatPlaybook));
  check("spike still shown in winning", p.winning && p.winning.some(w => /\d{2,}× your usual views/.test(w.winLabel)));
  leakCheck("spike", p);
}

// ─── 5. no competitor data ────────────────────────────────────────
{
  const vids = [vid("n1", "client_proof", 2.0, 11000), vid("n2", "client_proof", 1.7, 9000), vid("n3", "client_proof", 1.6, 8500)];
  const p = buildClientProjection({
    config: { companyName: "Solo Co" },
    status: { state: "growing", reason: "Views up 18% vs the prior 30 days." },
    momentum: { signals: { viewsDelta: 0.18 } },
    baselines: { medianEngagementRate: { instagram: 0.05 } },
    competitorCohort: {},
    formatCounts: formatCounts({ client_proof: [3, 1.8] }),
    recs: [{ idea: "More client proof — it's working.", rationale: "Your strongest format.", sourceType: "client_post", sourceIds: ["n1"] }],
    videoUpdates: vids, videosRoot: videosRoot(vids),
    competitorsRoot: {}, renewalAmmo: baseRenewal,
    thisWeekInNiche: null, enabledPlatforms: ["instagram"],
    computedAt: new Date().toISOString(),
  });
  console.log("Scenario 5 — no competitor data");
  check("niche hidden (absent, not empty frame)", p.meta.dataState.niche === "absent" && p.niche === null);
  check("rest still works (winning present)", p.winning && p.winning.length >= 3);
  check("header still confident", /up 18%/.test(p.header.momentumSentence));
  leakCheck("nocomp", p);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
