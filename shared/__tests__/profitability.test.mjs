// Pure unit tests for shared/profitability.js
// Run via:  node shared/__tests__/profitability.test.mjs
// Same convention as the scheduling/capacity suites — no test runner,
// assertions throw on failure, green summary on success.

import assert from "node:assert/strict";
import {
  computeProfitability,
  recomputeRow,
  commissionFor,
  buildRollups,
  WARNINGS,
} from "../profitability.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── commissionFor routing ────────────────────────────────────────────
const PLANS = {
  "p-closer": { name: "Closer Carl", type: "closer", providedLeadPct: 10, selfSourcedPct: 15, repeatPct: "", flatPerDeal: 0 },
  "p-am": { name: "AM Amy", type: "accountManager", providedLeadPct: "", selfSourcedPct: "", repeatPct: 5, flatPerDeal: 0 },
  "p-blankrate": { name: "Blank Bob", type: "accountManager", repeatPct: "", flatPerDeal: 0 },
  "p-flat": { name: "Flat Fred", type: "closer", providedLeadPct: "", selfSourcedPct: "", repeatPct: "", flatPerDeal: 250 },
};

test("commission: new + provided lead = 10%", () => {
  const r = commissionFor({ dealType: "new", closerId: "p-closer", leadSource: "provided" }, PLANS, 10000);
  assert.equal(r.commission, 1000);
  assert.equal(r.payeeType, "closer");
  assert.equal(r.leadSource, "provided");
  assert.deepEqual(r.warnings, []);
});

test("commission: new + self-sourced = 15%", () => {
  const r = commissionFor({ dealType: "new", closerId: "p-closer", leadSource: "selfSourced" }, PLANS, 10000);
  assert.equal(r.commission, 1500);
  assert.equal(r.leadSource, "selfSourced");
});

test("commission: repeat routes to account manager at repeatPct", () => {
  const r = commissionFor({ dealType: "repeat", accountManagerId: "p-am" }, PLANS, 10000);
  assert.equal(r.commission, 500);
  assert.equal(r.payeeType, "accountManager");
  assert.equal(r.payeeId, "p-am");
});

test("commission: no input => 0 + commissionUnassigned", () => {
  const r = commissionFor(undefined, PLANS, 10000);
  assert.equal(r.commission, 0);
  assert.deepEqual(r.warnings, [WARNINGS.COMMISSION_UNASSIGNED]);
});

test("commission: dealType set but no payee => 0 + commissionUnassigned", () => {
  const r = commissionFor({ dealType: "new" }, PLANS, 10000);
  assert.equal(r.commission, 0);
  assert.deepEqual(r.warnings, [WARNINGS.COMMISSION_UNASSIGNED]);
});

test("commission: assigned payee with blank rate => 0 + commissionRateMissing", () => {
  const r = commissionFor({ dealType: "repeat", accountManagerId: "p-blankrate" }, PLANS, 10000);
  assert.equal(r.commission, 0);
  assert.deepEqual(r.warnings, [WARNINGS.COMMISSION_RATE_MISSING]);
});

test("commission: flat-per-deal only (no pct) is honoured, no warning", () => {
  const r = commissionFor({ dealType: "new", closerId: "p-flat", leadSource: "provided" }, PLANS, 10000);
  assert.equal(r.commission, 250);
  assert.deepEqual(r.warnings, []);
});

// ── recomputeRow math ────────────────────────────────────────────────
const RATES = { "ed-1": { costPerHour: 50 }, "ed-jeremy": { costPerHour: 120 } };

test("recomputeRow: margin + contribution end to end", () => {
  const base = {
    projectId: "proj-1", clientName: "Acme", dealValue: 10000,
    numberOfVideos: 2, videoType: "Live Action", productLine: "oneOff",
    hoursByPerson: { "ed-1": 10, "ed-jeremy": 5 }, // 10*50 + 5*120 = 1100
  };
  const row = recomputeRow(base, {
    laborCosts: RATES,
    costInputs: { "proj-1": { crew: 800, travel: 100, location: 0, gear: 0, other: 0 } },
    commissionInputs: { "proj-1": { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.labourCost, 1100);
  assert.equal(row.externalCosts, 900);
  assert.equal(row.productionCost, 2000);
  assert.equal(row.productionMargin, 8000);
  assert.equal(row.commission, 1000); // 10% of 10000
  assert.equal(row.contribution, 7000); // 8000 - 1000
  assert.ok(approx(row.contributionPct, 0.7));
  assert.equal(row.perVideoContribution, 3500);
  assert.equal(row.complete, true);
  assert.deepEqual(row.warnings, []);
});

test("recomputeRow: person logged time but no rate => missingLabourRate + counts 0", () => {
  const base = { projectId: "p", dealValue: 5000, hoursByPerson: { "ed-9": 4 } };
  const row = recomputeRow(base, {
    laborCosts: {}, // no rate for ed-9
    costInputs: { p: { crew: 0 } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.labourCost, 0);
  assert.ok(row.warnings.includes(WARNINGS.MISSING_LABOUR_RATE));
  assert.deepEqual(row.missingRateFor, ["ed-9"]);
  assert.equal(row.complete, false);
});

test("recomputeRow: no cost-input entry => missingExternalCost (unknown != free)", () => {
  const base = { projectId: "p", dealValue: 5000, hoursByPerson: {} };
  const row = recomputeRow(base, { laborCosts: {}, costInputs: {}, commissionInputs: { p: { dealType: "new", closerId: "p-closer" } }, commissionPlans: PLANS });
  assert.ok(row.warnings.includes(WARNINGS.MISSING_EXTERNAL_COST));
  assert.equal(row.complete, false);
});

test("recomputeRow: saved cost entry of all zeros is a confirmation, no warning", () => {
  const base = { projectId: "p", dealValue: 5000, hoursByPerson: {} };
  const row = recomputeRow(base, {
    laborCosts: {},
    costInputs: { p: { crew: 0, travel: 0, location: 0, gear: 0, other: 0, note: "in-house, no externals" } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.externalCosts, 0);
  assert.ok(!row.warnings.includes(WARNINGS.MISSING_EXTERNAL_COST));
});

test("recomputeRow: zero deal value => missingOrZeroDealValue", () => {
  const base = { projectId: "p", dealValue: 0, hoursByPerson: {} };
  const row = recomputeRow(base, { costInputs: { p: { crew: 0 } }, commissionInputs: { p: { dealType: "new", closerId: "p-closer" } }, commissionPlans: PLANS });
  assert.ok(row.warnings.includes(WARNINGS.MISSING_OR_ZERO_DEAL_VALUE));
  assert.equal(row.contributionPct, null);
  assert.equal(row.perVideoContribution, null);
});

test("recomputeRow: round-trips as a valid base (client live recompute)", () => {
  const base = { projectId: "p", dealValue: 5000, numberOfVideos: 1, hoursByPerson: { "ed-1": 2 }, duplicateTaskId: true };
  const first = recomputeRow(base, { laborCosts: RATES, costInputs: { p: { crew: 0 } }, commissionInputs: { p: { dealType: "new", closerId: "p-closer" } }, commissionPlans: PLANS });
  // feed the OUTPUT back in as base — must reproduce identical numbers
  const second = recomputeRow(first, { laborCosts: RATES, costInputs: { p: { crew: 0 } }, commissionInputs: { p: { dealType: "new", closerId: "p-closer" } }, commissionPlans: PLANS });
  assert.equal(second.labourCost, first.labourCost);
  assert.equal(second.contribution, first.contribution);
  assert.ok(second.warnings.includes(WARNINGS.DUPLICATE_TASK_ID));
});

// ── computeProfitability join ────────────────────────────────────────
const PROJECTS = {
  "proj-1": { id: "proj-1", clientName: "Acme", dealValue: 10000, numberOfVideos: 2, videoType: "Live Action", productLine: "oneOff",
    subtasks: { "t-edit": { id: "t-edit", stage: "edit" }, "t-shoot": { id: "t-shoot", stage: "shoot" } } },
  "proj-2": { id: "proj-2", clientName: "Beta", dealValue: 4000, numberOfVideos: 4, videoType: "Brand Builder", productLine: "socialPremium",
    subtasks: { "t-b1": { id: "t-b1", stage: "edit" } } },
};
const TIMELOGS = {
  "ed-1": {
    "2026-05-20": {
      "t-edit": { secs: 36000, stage: "edit" }, // 10h
      "_running": { taskId: "t-edit", startedAt: 1 }, // must be ignored
    },
    "2026-05-21": { "t-b1": { secs: 7200, stage: "edit" } }, // 2h on proj-2
  },
  "ed-jeremy": { "2026-05-20": { "t-shoot": { secs: 18000, stage: "shoot" } } }, // 5h crew on proj-1
};

test("computeProfitability: joins timeLogs->projects, excludes _running", () => {
  const { perProject } = computeProfitability({
    projects: PROJECTS, timeLogs: TIMELOGS, laborCosts: RATES,
    commissionPlans: PLANS,
    costInputs: { "proj-1": { crew: 900 }, "proj-2": { crew: 0 } },
    commissionInputs: {
      "proj-1": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-2": { dealType: "repeat", accountManagerId: "p-am" },
    },
  });
  const p1 = perProject["proj-1"];
  // labour = ed-1 10h*50 + ed-jeremy 5h*120 = 1100; externals 900
  assert.equal(p1.loggedHours, 15);
  assert.equal(p1.labourCost, 1100);
  assert.equal(p1.externalCosts, 900);
  assert.equal(p1.commission, 1000);
  assert.equal(p1.contribution, 10000 - 2000 - 1000);
  assert.equal(p1.complete, true);

  const p2 = perProject["proj-2"];
  // 2h * 50 = 100 labour, externals 0, repeat->AM 5% of 4000 = 200
  assert.equal(p2.labourCost, 100);
  assert.equal(p2.commission, 200);
  assert.equal(p2.contribution, 4000 - 100 - 200);
  assert.equal(p2.complete, true);
});

test("computeProfitability: duplicate taskId across projects flags both", () => {
  const dupProjects = {
    "a": { id: "a", dealValue: 1000, subtasks: { "shared": { id: "shared" } } },
    "b": { id: "b", dealValue: 1000, subtasks: { "shared": { id: "shared" } } },
  };
  const { perProject } = computeProfitability({ projects: dupProjects, timeLogs: {}, laborCosts: {}, commissionPlans: {}, costInputs: {}, commissionInputs: {} });
  assert.ok(perProject["a"].warnings.includes(WARNINGS.DUPLICATE_TASK_ID));
  assert.ok(perProject["b"].warnings.includes(WARNINGS.DUPLICATE_TASK_ID));
});

// ── rollups: totals exclude incomplete rows ──────────────────────────
test("buildRollups: only complete rows enter totals; incomplete counted separately", () => {
  const rows = [
    { complete: true, productLine: "oneOff", videoType: "Live Action", dealValue: 10000, labourCost: 1000, externalCosts: 900, productionCost: 1900, productionMargin: 8100, commission: 1000, contribution: 7100, numberOfVideos: 2, payeeId: "p-closer", payeeType: "closer" },
    { complete: false, productLine: "oneOff", videoType: "Live Action", dealValue: 99999, labourCost: 0, externalCosts: 0, productionCost: 0, productionMargin: 99999, commission: 0, contribution: 99999, numberOfVideos: 1, payeeId: null, payeeType: null },
    { complete: true, productLine: "socialPremium", videoType: "Brand Builder", dealValue: 4000, labourCost: 100, externalCosts: 0, productionCost: 100, productionMargin: 3900, commission: 200, contribution: 3700, numberOfVideos: 4, payeeId: "p-am", payeeType: "accountManager" },
  ];
  const r = buildRollups(rows, { commissionPlans: PLANS });
  assert.equal(r.completeCount, 2);
  assert.equal(r.incompleteCount, 1);
  // totals must NOT include the 99999 incomplete row
  assert.equal(r.totals.dealValue, 14000);
  assert.equal(r.totals.contribution, 10800);
  assert.equal(r.totals.videos, 6);
  assert.ok(approx(r.totals.contributionPct, 10800 / 14000));
  // closer vs AM split
  assert.equal(r.byCloser["p-closer"].commission, 1000);
  assert.equal(r.byAccountManager["p-am"].commission, 200);
  assert.equal(r.byCloser["p-closer"].name, "Closer Carl");
  assert.equal(r.byProductLine["oneOff"].count, 1); // incomplete oneOff excluded
  assert.equal(r.byProductLine["socialPremium"].contribution, 3700);
});

console.log(`\n${passed} passed`);
