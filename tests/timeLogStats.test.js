// tests/timeLogStats.test.js
// Pure-function unit tests for the Time Log Analytics data layer.
// Run with `npm run test:calendar` (node --test tests/*.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import {
  normStage,
  categoryOf,
  utcDay,
  buildProjectIndex,
  buildVideoFacts,
  summariseByCategory,
  summariseOverall,
  filterFactsByDays,
  weekStartKey,
  buildWeeklySeries,
  computeDailyAllocations,
} from "../src/timeLogStats.js";

// ─── helpers ───
const SECS = (h) => h * 3600;

// Two projects: a done Live Action (Corporate), a done blank-videoType
// (Uncategorized), plus an in-progress one whose logs must be excluded.
const projects = [
  {
    id: "p1", clientName: "Acme", projectName: "Brand Film", videoType: "Live Action",
    subtasks: { a: { id: "st-edit-done", status: "done" }, b: { id: "st-rev-done", status: "done" }, c: { id: "st-shoot-done", status: "done" } },
  },
  {
    id: "p2", clientName: "Beta", projectName: "Mystery", videoType: "",
    subtasks: { a: { id: "st-blank-done", status: "done" } },
  },
  {
    id: "p3", clientName: "Gamma", projectName: "WIP", videoType: "Deluxe - Meta Ads",
    subtasks: { a: { id: "st-inprogress", status: "inProgress" } },
  },
];

test("normStage normalises casing and spaces", () => {
  assert.equal(normStage("Edit"), "edit");
  assert.equal(normStage("Revisions"), "revisions");
  assert.equal(normStage("Pre Production"), "preproduction");
  assert.equal(normStage(""), "");
});

test("categoryOf: populated videoType classifies; blank → Uncategorized", () => {
  assert.equal(categoryOf("Acme: Brand Film", "Live Action"), "Corporate Video");
  assert.equal(categoryOf("X: Y", "Starter Pack - Social Media"), "Social Media");
  assert.equal(categoryOf("X: Y", "Deluxe - Meta Ads"), "Meta Ad");
  assert.equal(categoryOf("Beta: Mystery", ""), "Uncategorized");
  // populated but unmatched stays "Other", not "Uncategorized"
  assert.equal(categoryOf("X: Y", "Storyboard"), "Other");
});

test("utcDay is DST-safe and yields correct day spans", () => {
  // Sydney DST ends ~6 Apr 2025; span across it must be exactly 2 days.
  assert.equal(utcDay("2025-04-07") - utcDay("2025-04-05"), 2);
  // Sydney DST starts ~5 Oct 2025.
  assert.equal(utcDay("2025-10-06") - utcDay("2025-10-04"), 2);
  assert.equal(utcDay("2026-05-10") - utcDay("2026-05-10"), 0);
  assert.ok(Number.isNaN(utcDay("not-a-date")));
  assert.ok(Number.isNaN(utcDay("2026-02-31")), "non-existent date rejected");
  assert.ok(Number.isNaN(utcDay("2026-13-01")), "bad month rejected");
  assert.ok(Number.isNaN(utcDay("2026-9-30")), "non-padded rejected");
});

test("buildProjectIndex maps subtaskId → status/videoType/parentName", () => {
  const idx = buildProjectIndex(projects);
  assert.equal(idx.get("st-edit-done").status, "done");
  assert.equal(idx.get("st-edit-done").videoType, "Live Action");
  assert.equal(idx.get("st-edit-done").parentName, "Acme: Brand Film");
  assert.equal(idx.get("st-inprogress").status, "inProgress");
});

test("buildVideoFacts: cohort gate excludes non-join, non-done, _running, bad stage, zero secs", () => {
  const idx = buildProjectIndex(projects);
  const logs = {
    ed1: {
      "2026-05-01": {
        "st-edit-done": { secs: SECS(4), stage: "Edit", source: "viewix" },      // counts
        "st-inprogress": { secs: SECS(9), stage: "edit", source: "viewix" },      // excluded: not done
        "2620445402": { secs: SECS(3), stage: "Edit" },                            // excluded: legacy, no join
        _running: { taskId: "st-edit-done", startedAt: 1 },                        // excluded: _ key
        "st-shoot-done": { secs: SECS(2), stage: "shoot" },                        // excluded: JOINED+done but stage not edit/rev
        "st-blank-done": { secs: 0, stage: "edit" },                              // excluded: zero secs
      },
    },
  };
  const facts = buildVideoFacts(logs, idx);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].taskId, "st-edit-done");
  assert.equal(facts[0].category, "Corporate Video");
  assert.equal(facts[0].editSecs, SECS(4));
});

test("buildVideoFacts coerces string secs (no concatenation) and skips malformed dates", () => {
  const idx = buildProjectIndex(projects);
  const logs = {
    ed1: {
      "2026-05-01": { "st-edit-done": { secs: "3600", stage: "edit" } },   // string
      "2026-05-02": { "st-edit-done": { secs: "1800", stage: "Edit" } },   // string
      "2026-02-31": { "st-edit-done": { secs: SECS(99), stage: "edit" } }, // bad date → skipped
    },
  };
  const f = buildVideoFacts(logs, idx).find((x) => x.taskId === "st-edit-done");
  assert.equal(f.editSecs, 5400);          // 3600 + 1800, summed not "36001800"
  assert.equal(f.lastLogDate, "2026-05-02"); // bad date never becomes the latest
});

test("five-number summary uses correct nearest-rank quantiles", () => {
  // four Corporate videos with edit hours 1,2,3,4
  const idx = new Map([1, 2, 3, 4].map((h) => [
    `v${h}`, { status: "done", videoType: "Live Action", parentName: `A: ${h}` },
  ]));
  const logs = { ed1: { "2026-05-01": {} } };
  [1, 2, 3, 4].forEach((h) => { logs.ed1["2026-05-01"][`v${h}`] = { secs: SECS(h), stage: "edit" }; });
  const [row] = summariseByCategory(buildVideoFacts(logs, idx));
  assert.equal(row.min, 1);
  assert.equal(row.p25, 1);            // ceil(.25*4)-1 = 0 → 1
  assert.equal(row.medianEditH, 2.5);  // median = avg(2,3)
  assert.equal(row.p75, 3);            // ceil(.75*4)-1 = 2 → 3
  assert.equal(row.p90, 4);            // ceil(.9*4)-1 = 3 → 4
  assert.equal(row.max, 4);
});

test("buildVideoFacts: sums across editors/days, splits edit vs revision, computes span", () => {
  const idx = buildProjectIndex(projects);
  const logs = {
    ed1: {
      "2026-05-01": { "st-edit-done": { secs: SECS(2), stage: "edit" } },
      "2026-05-04": { "st-edit-done": { secs: SECS(3), stage: "Edit" } },        // mixed casing
    },
    ed2: {
      "2026-05-02": { "st-edit-done": { secs: SECS(1), stage: "edit" } },        // 2nd editor
      "2026-05-06": { "st-edit-done": { secs: SECS(5), stage: "Revisions" } },   // revision, doesn't extend edit span
    },
  };
  const f = buildVideoFacts(logs, idx).find((x) => x.taskId === "st-edit-done");
  assert.equal(f.editSecs, SECS(6));       // 2+3+1
  assert.equal(f.revisionSecs, SECS(5));
  assert.equal(f.hasEdit, true);
  assert.equal(f.hasRevision, true);
  assert.equal(f.editSpanDays, 3);          // 2026-05-01 → 2026-05-04
  assert.equal(f.lastLogDate, "2026-05-06"); // revision is the latest log
});

test("summariseByCategory: per-video denominators, apples-to-apples revision metrics, burden guard", () => {
  // Build facts directly via logs for two Corporate videos:
  //   V1: 10h edit, 5h revision
  //   V2: 6h edit, no revision
  // plus a revision-only video V3 (edit predates tracking): 0h edit, 4h revision
  const idx = new Map([
    ["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }],
    ["v2", { status: "done", videoType: "Live Action", parentName: "A: 2" }],
    ["v3", { status: "done", videoType: "Live Action", parentName: "A: 3" }],
  ]);
  const logs = {
    ed1: {
      "2026-05-01": {
        v1: { secs: SECS(10), stage: "edit" },
        v2: { secs: SECS(6), stage: "edit" },
        v3: { secs: SECS(4), stage: "revisions" },
      },
      "2026-05-02": { v1: { secs: SECS(5), stage: "revisions" } },
    },
  };
  const facts = buildVideoFacts(logs, idx);
  const [row] = summariseByCategory(facts);
  assert.equal(row.category, "Corporate Video");
  assert.equal(row.n, 3);                 // all three videos
  assert.equal(row.nEdit, 2);             // only v1,v2 have edit time
  assert.equal(row.medianEditH, 8);       // median of [6,10]
  // revisionHPerVideo over ALL videos: (5+4)/3 = 3
  assert.equal(row.revisionHPerVideo, 3);
  // avg among revised (v1,v3): (5+4)/2 = 4.5
  assert.equal(row.avgRevisionHAmongRevised, 4.5);
  // revisionRate: 2 of 3 had revisions
  assert.ok(Math.abs(row.revisionRate - 2 / 3) < 1e-9);
  // burden = totalRev/totalEdit = 9/16
  assert.ok(Math.abs(row.revisionBurden - 9 / 16) < 1e-9);
});

test("revisionBurden is null (n/a), not Infinity, when a category has revision but no edit time", () => {
  const idx = new Map([["v3", { status: "done", videoType: "", parentName: "A: 3" }]]);
  const logs = { ed1: { "2026-05-01": { v3: { secs: SECS(4), stage: "revisions" } } } };
  const facts = buildVideoFacts(logs, idx);
  const [row] = summariseByCategory(facts);
  assert.equal(row.category, "Uncategorized");
  assert.equal(row.revisionBurden, null);
  assert.equal(row.medianEditH, 0); // no edit videos
});

test("summariseOverall reports date range and overall stats", () => {
  const idx = new Map([
    ["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }],
    ["v2", { status: "done", videoType: "", parentName: "B: 2" }],
  ]);
  const logs = {
    ed1: {
      "2026-05-10": { v1: { secs: SECS(4), stage: "edit" } },
      "2026-06-02": { v2: { secs: SECS(2), stage: "edit" } },
    },
  };
  const o = summariseOverall(buildVideoFacts(logs, idx));
  assert.equal(o.n, 2);
  assert.equal(o.totalEditH, 6);
  assert.equal(o.firstDate, "2026-05-10");
  assert.equal(o.lastDate, "2026-06-02");
});

test("filterFactsByDays scopes by lastLogDate relative to a ref date", () => {
  const facts = [
    { taskId: "a", lastLogDate: "2026-06-06" },
    { taskId: "b", lastLogDate: "2026-05-01" },
  ];
  const recent = filterFactsByDays(facts, 30, "2026-06-07");
  assert.deepEqual(recent.map((f) => f.taskId), ["a"]);
  assert.equal(filterFactsByDays(facts, 0, "2026-06-07").length, 2); // 0 → unfiltered
});

test("weekStartKey returns the UTC Monday of the week and is stable across the week", () => {
  const mon = weekStartKey("2026-05-06"); // a Wednesday
  assert.equal(new Date(mon + "T00:00:00Z").getUTCDay(), 1, "is a Monday");
  // every day Mon..Sun of that week maps to the same Monday
  for (const d of ["2026-05-04", "2026-05-05", "2026-05-06", "2026-05-10"]) {
    assert.equal(weekStartKey(d), mon);
  }
  assert.notEqual(weekStartKey("2026-05-11"), mon); // next week
  assert.equal(weekStartKey("garbage"), null);
});

test("buildWeeklySeries: continuous weeks, per-category medians, null gaps", () => {
  const idx = new Map([
    ["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }],
    ["v2", { status: "done", videoType: "Live Action", parentName: "A: 2" }],
    ["v3", { status: "done", videoType: "Starter Pack - Social Media", parentName: "B: 3" }],
  ]);
  const logs = {
    ed1: {
      "2026-05-05": { v1: { secs: SECS(2), stage: "edit" } },   // wk 05-04 Corporate
      "2026-05-06": { v2: { secs: SECS(4), stage: "edit" } },   // wk 05-04 Corporate
      "2026-05-19": { v3: { secs: SECS(1), stage: "edit" } },   // wk 05-18 Social (skips 05-11)
    },
  };
  const { weeks, series } = buildWeeklySeries(buildVideoFacts(logs, idx));
  assert.deepEqual(weeks, ["2026-05-04", "2026-05-11", "2026-05-18"]); // continuous incl. empty middle week
  const corp = series.find((s) => s.category === "Corporate Video");
  const soc = series.find((s) => s.category === "Social Media");
  assert.deepEqual(corp.points.map((p) => p.y), [3, null, null]); // (2+4)/2 in wk1, gaps after
  assert.deepEqual(soc.points.map((p) => p.y), [null, null, 1]);
  assert.equal(corp.points[0].n, 2);
});

test("editLastDate anchors on the last EDIT day even when a later revision exists", () => {
  const idx = new Map([["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }]]);
  const logs = {
    ed1: {
      "2026-05-05": { v1: { secs: SECS(2), stage: "edit" } },
      "2026-05-07": { v1: { secs: SECS(1), stage: "edit" } },       // last EDIT
      "2026-05-20": { v1: { secs: SECS(3), stage: "revisions" } },  // later revision
    },
  };
  const f = buildVideoFacts(logs, idx).find((x) => x.taskId === "v1");
  assert.equal(f.editLastDate, "2026-05-07");   // edit anchor, NOT the revision
  assert.equal(f.lastLogDate, "2026-05-20");    // overall last log is the revision
  // the weekly line anchors the video to the EDIT week (of 05-07 = Mon 05-04)
  const { weeks } = buildWeeklySeries([f]);
  assert.equal(weeks[0], weekStartKey("2026-05-07"));
});

test("buildWeeklySeries excludes revision-only videos (no edit anchor)", () => {
  const idx = new Map([["v3", { status: "done", videoType: "", parentName: "A: 3" }]]);
  const logs = { ed1: { "2026-05-05": { v3: { secs: SECS(4), stage: "revisions" } } } };
  assert.deepEqual(buildWeeklySeries(buildVideoFacts(logs, idx)), { weeks: [], series: [] });
});

test("computeDailyAllocations splits the day's unlogged paid gap evenly across tasks worked", () => {
  const logs = {
    ed1: {
      "2026-05-04": {
        t1: { secs: SECS(4), stage: "edit" },
        t2: { secs: SECS(3), stage: "edit" },     // total 7h, gap 1h, 2 tasks → 0.5h each
      },
      "2026-05-05": {
        t3: { secs: SECS(8), stage: "edit" },      // exactly 8h → gap 0 → no allocation
      },
      "2026-05-06": {
        t1: { secs: SECS(2), stage: "edit" },
        t4: { secs: SECS(2), stage: "shoot" },     // total 4h ALL stages, gap 4h, 2 tasks → 2h each, but only the EDIT task keeps its share
        _running: { taskId: "t1", startedAt: 1 },  // ignored
      },
      "2026-05-07": {
        t5: { secs: SECS(6), stage: "Revisions" }, // revision-only day: 2h gap is DROPPED, not booked as edit
      },
    },
  };
  const a = computeDailyAllocations(logs);
  assert.equal(a.get("t1"), SECS(0.5) + SECS(2)); // share from day1 + day3
  assert.equal(a.get("t2"), SECS(0.5));
  assert.equal(a.get("t3") || 0, 0);              // no gap on a full 8h day
  assert.equal(a.get("t4") || 0, 0);              // shoot task dilutes the split but keeps no share
  assert.equal(a.get("t5") || 0, 0);              // revision-day gap never becomes edit time
});

test("buildVideoFacts attaches allocatedEditSecs from the allocation map (0 when absent)", () => {
  const idx = new Map([["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }]]);
  const logs = { ed1: { "2026-05-04": { v1: { secs: SECS(2), stage: "edit" } } } };
  assert.equal(buildVideoFacts(logs, idx, new Map([["v1", SECS(1)]]))[0].allocatedEditSecs, SECS(1));
  assert.equal(buildVideoFacts(logs, idx)[0].allocatedEditSecs, 0);
});

test("end-to-end: a later revision day's gap never inflates adjusted edit, and the chart point stays frozen", () => {
  const idx = new Map([["v1", { status: "done", videoType: "Live Action", parentName: "Acme: Film", name: "Hero cut" }]]);
  const logs = {
    ed1: {
      "2026-05-04": { v1: { secs: SECS(6), stage: "edit" } },       // edit day: gap 2h → +2h edit allocation
      "2026-06-01": { v1: { secs: SECS(1), stage: "revisions" } },  // revision day weeks later: 7h gap DROPPED
    },
  };
  const facts = buildVideoFacts(logs, idx, computeDailyAllocations(logs));
  const f = facts[0];
  assert.equal(f.allocatedEditSecs, SECS(2));       // only the edit-day share
  assert.equal(f.editLastDate, "2026-05-04");       // anchor unchanged by the revision
  const adj = summariseOverall(facts, true);
  assert.equal(adj.medianEditH, 8);                 // 6h logged + 2h edit-day share, NOT +7h more
  // drill-down plumbing rides on the same facts
  assert.equal(f.parentName, "Acme: Film");
  assert.equal(f.videoName, "Hero cut");
});

test("adjusted mode adds allocated hours to edit metrics; revision burden stays logged", () => {
  const idx = new Map([
    ["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }],
    ["v2", { status: "done", videoType: "Live Action", parentName: "A: 2" }],
  ]);
  const logs = {
    ed1: {
      "2026-05-04": { v1: { secs: SECS(2), stage: "edit" }, v2: { secs: SECS(4), stage: "edit" } },
      "2026-05-05": { v1: { secs: SECS(2), stage: "revisions" } },
    },
  };
  const facts = buildVideoFacts(logs, idx, new Map([["v1", SECS(1)], ["v2", SECS(1)]]));
  const logged = summariseOverall(facts, false);
  const adjusted = summariseOverall(facts, true);
  assert.equal(logged.medianEditH, 3);            // median of logged edit [2,4]
  assert.equal(adjusted.medianEditH, 4);          // median of adjusted edit [3,5]
  assert.equal(logged.editHPerVideo, 3);
  assert.equal(adjusted.editHPerVideo, 4);
  // revision burden = logged revision / logged edit, identical in both modes
  assert.ok(Math.abs(logged.revisionBurden - 2 / 6) < 1e-9);
  assert.equal(adjusted.revisionBurden, logged.revisionBurden);
});

test("revision-only video's allocation never leaks into adjusted edit totals", () => {
  const idx = new Map([
    ["vEdit", { status: "done", videoType: "Live Action", parentName: "A: edit" }],
    ["vRev", { status: "done", videoType: "Live Action", parentName: "A: rev" }],
  ]);
  const logs = {
    ed1: {
      "2026-05-04": { vEdit: { secs: SECS(2), stage: "edit" } },
      "2026-05-05": { vRev: { secs: SECS(1), stage: "revisions" } }, // no edit logs
    },
  };
  // vRev gets a big allocation (sole log on a light day), but it has no edit.
  const facts = buildVideoFacts(logs, idx, new Map([["vEdit", SECS(1)], ["vRev", SECS(7)]]));
  const adj = summariseOverall(facts, true);
  // adjusted edit/video must reflect ONLY vEdit's 2h+1h=3h, spread over n=2 → 1.5h.
  // It must NOT include vRev's 7h allocation.
  assert.equal(adj.totalEditH, 3);
  assert.equal(adj.editHPerVideo, 1.5);
  assert.equal(adj.medianEditH, 3); // median over the single edit video
});

test("buildWeeklySeries plots the weekly MEDIAN per category (robust to an outlier)", () => {
  const idx = new Map([1, 2, 3, 4].map((i) => [
    `v${i}`, { status: "done", videoType: "Live Action", parentName: `A: ${i}` },
  ]));
  // four Corporate videos in one week: 1h, 1h, 2h, 20h (one big outlier)
  const logs = { ed1: { "2026-05-04": {} } };
  Object.entries({ v1: 1, v2: 1, v3: 2, v4: 20 }).forEach(([id, h]) => {
    logs.ed1["2026-05-04"][id] = { secs: SECS(h), stage: "edit" };
  });
  const { series } = buildWeeklySeries(buildVideoFacts(logs, idx));
  // median of [1,1,2,20] = 1.5 (mean would be a misleading 6.0)
  assert.equal(series[0].points[0].y, 1.5);
  assert.equal(series[0].points[0].n, 4);
});

test("buildWeeklySeries honours the adjusted flag", () => {
  const idx = new Map([["v1", { status: "done", videoType: "Live Action", parentName: "A: 1" }]]);
  const logs = { ed1: { "2026-05-04": { v1: { secs: SECS(2), stage: "edit" } } } };
  const facts = buildVideoFacts(logs, idx, new Map([["v1", SECS(1)]]));
  assert.equal(buildWeeklySeries(facts, false).series[0].points[0].y, 2);
  assert.equal(buildWeeklySeries(facts, true).series[0].points[0].y, 3);
});

test("empty inputs never throw or divide by zero", () => {
  assert.deepEqual(buildVideoFacts({}, new Map()), []);
  assert.deepEqual(summariseByCategory([]), []);
  const o = summariseOverall([]);
  assert.equal(o.n, 0);
  assert.equal(o.medianEditH, 0);
  assert.equal(o.revisionBurden, null);
  assert.equal(o.firstDate, null);
});
