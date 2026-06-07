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
  shootHoursByPersonForProject,
  EST_SHOOT_DAY_HOURS,
  MAX_SHOOT_DAYS,
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

test("commission: new + closer + no leadSource => 0 + leadSourceUnset (no flattering default)", () => {
  const r = commissionFor({ dealType: "new", closerId: "p-closer" }, PLANS, 10000);
  assert.equal(r.commission, 0);
  assert.equal(r.leadSource, null);
  assert.deepEqual(r.warnings, [WARNINGS.LEAD_SOURCE_UNSET]);
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

// ── leadSource is an explicit human choice, never defaulted ───────────
// A new-business deal with a closer but no lead source must read Incomplete
// (not silently 10% "provided"), since defaulting the lower rate would
// overstate contribution. Picking provided/self-sourced completes the row.
test("recomputeRow: new + closer + no leadSource => leadSourceUnset + Incomplete", () => {
  const base = { projectId: "p", dealValue: 10000, hoursByPerson: {} };
  const row = recomputeRow(base, {
    laborCosts: {},
    costInputs: { p: { crew: 0 } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.commission, 0);
  assert.ok(row.warnings.includes(WARNINGS.LEAD_SOURCE_UNSET));
  assert.equal(row.complete, false);
});

test("recomputeRow: new + closer + provided => 10%, complete", () => {
  const base = { projectId: "p", dealValue: 10000, hoursByPerson: {} };
  const row = recomputeRow(base, {
    laborCosts: {},
    costInputs: { p: { crew: 0 } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.commission, 1000);
  assert.equal(row.leadSource, "provided");
  assert.ok(!row.warnings.includes(WARNINGS.LEAD_SOURCE_UNSET));
  assert.equal(row.complete, true);
});

test("recomputeRow: new + closer + selfSourced => 15%, complete", () => {
  const base = { projectId: "p", dealValue: 10000, hoursByPerson: {} };
  const row = recomputeRow(base, {
    laborCosts: {},
    costInputs: { p: { crew: 0 } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "selfSourced" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.commission, 1500);
  assert.equal(row.leadSource, "selfSourced");
  assert.ok(!row.warnings.includes(WARNINGS.LEAD_SOURCE_UNSET));
  assert.equal(row.complete, true);
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

test("computeProfitability: strict drops zero-logged-time projects (even with externals); keeps timed", () => {
  const projects = {
    "timed":      { id: "timed", dealValue: 5000, subtasks: { "t-x": { id: "t-x" } } },
    "outsourced": { id: "outsourced", dealValue: 5000 }, // externals but NO logged time
    "ghost":      { id: "ghost", dealValue: 5000 },       // nothing logged, no externals
  };
  const timeLogs = { "ed-1": { "2026-05-20": { "t-x": { secs: 3600 } } } }; // 1h on "timed"
  const { perProject } = computeProfitability({
    projects, timeLogs, laborCosts: RATES,
    costInputs: { "outsourced": { crew: 1200 } }, // real externals, still dropped (strict)
    commissionInputs: {}, commissionPlans: PLANS,
  });
  assert.ok(perProject["timed"], "logged-time project kept");
  assert.equal(perProject["outsourced"], undefined, "externals-only project dropped (no logged time)");
  assert.equal(perProject["ghost"], undefined, "no-time/no-externals project dropped");
  assert.equal(Object.keys(perProject).length, 1);
});

test("computeProfitability: legacy numeric time log (plain seconds) counts as hours, survives the filter", () => {
  // old timer entries stored seconds as a plain number, not { secs }. Every
  // other reader (Capacity, EditorDashboard) handles both; the filter must
  // too, or numeric-format projects undercount to 0 hours and vanish.
  const projects = { "num": { id: "num", dealValue: 5000, subtasks: { "t-n": { id: "t-n" } } } };
  const timeLogs = { "ed-1": { "2026-05-20": { "t-n": 3600 } } }; // plain number, not { secs }
  const { perProject } = computeProfitability({
    projects, timeLogs, laborCosts: RATES,
    costInputs: { "num": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  assert.ok(perProject["num"], "numeric-log project survives");
  assert.equal(perProject["num"].loggedHours, 1);
  assert.equal(perProject["num"].labourCost, 50); // 1h * ed-1 rate 50
});

test("computeProfitability: strict drops a no-logged-time project even with a saved confirmed-zero cost entry", () => {
  // a producer can save all-zero externals + a note as an explicit "no
  // externals" confirmation. Under strict, no logged time still means
  // dropped — the confirmation covers externals, not labour.
  const projects = { "confz": { id: "confz", dealValue: 5000 } };
  const { perProject } = computeProfitability({
    projects, timeLogs: {}, laborCosts: {}, commissionPlans: PLANS,
    costInputs: { "confz": { crew: 0, travel: 0, location: 0, gear: 0, other: 0, note: "confirmed none" } },
    commissionInputs: {},
  });
  assert.equal(perProject["confz"], undefined, "no logged time => dropped, confirmed-zero externals notwithstanding");
});

test("computeProfitability: duplicate taskId flags BOTH projects and keeps the 0-hour one visible", () => {
  const dupProjects = {
    "a": { id: "a", dealValue: 1000, subtasks: { "shared": { id: "shared" } } },
    "b": { id: "b", dealValue: 1000, subtasks: { "shared": { id: "shared" } } },
  };
  // time logged on the shared task maps to ONE project (a); b gets 0 hours.
  // No externals on either. b must STILL survive (the duplicate exception)
  // so its misattribution warning stays visible instead of vanishing.
  const timeLogs = { "ed-1": { "2026-05-20": { "shared": { secs: 3600 } } } };
  const { perProject } = computeProfitability({ projects: dupProjects, timeLogs, laborCosts: RATES, commissionPlans: {}, costInputs: {}, commissionInputs: {} });
  assert.ok(perProject["a"], "project that received the hours is kept");
  assert.ok(perProject["b"], "0-hour duplicate-flagged project is kept (warning stays visible)");
  assert.equal(perProject["b"].loggedHours, 0);
  assert.ok(perProject["a"].warnings.includes(WARNINGS.DUPLICATE_TASK_ID));
  assert.ok(perProject["b"].warnings.includes(WARNINGS.DUPLICATE_TASK_ID));
});

// ── Attio revenue enrichment (computeProfitability + attioCache) ─────
function rawDeal(id, name, value, companyId) {
  return {
    id: { record_id: id },
    values: {
      name: [{ value: name }],
      value: [{ currency_value: value, currency_code: "AUD" }],
      stage: [{ status: { title: "Won" } }],
      close_date: [{ value: "2026-05-01" }],
      ...(companyId ? { associated_company: [{ target_record_id: companyId }] } : {}),
    },
  };
}

// Give every project a subtask + one logged hour so it survives the strict
// no-logged-time filter. These tests exercise deal MATCHING, not the filter
// (which has its own tests), and keep zero externals so the zero-externals
// enrichment path stays covered.
function withHour(projects) {
  const timeLogs = { "ed-1": { "2026-05-20": {} } };
  for (const p of Object.values(projects)) {
    const tid = `${p.id}__t`;
    p.subtasks = { ...(p.subtasks || {}), [tid]: { id: tid } };
    timeLogs["ed-1"]["2026-05-20"][tid] = { secs: 3600 };
  }
  return timeLogs;
}

test("enrichment: blank project dealValue is filled from matched Attio Won deal", () => {
  const projects = { "proj-x": { id: "proj-x", clientName: "AusIMM", projectName: "Spanish Translation", dealValue: null } };
  const attioCache = { data: [rawDeal("deal-x", "Spanish Translation", 672, "co-ausimm")] };
  const timeLogs = withHour(projects);
  const { perProject } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-x": { crew: 0 } },
    commissionInputs: { "proj-x": { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  const r = perProject["proj-x"];
  assert.equal(r.dealValue, 672);
  assert.equal(r.dealValueSource, "attio");
  assert.equal(r.attioDealId, "deal-x");
  assert.ok(!r.warnings.includes(WARNINGS.MISSING_OR_ZERO_DEAL_VALUE));
});

test("enrichment: project's OWN dealValue wins, Attio never overrides", () => {
  const projects = { "proj-y": { id: "proj-y", projectName: "Spanish Translation", dealValue: 999 } };
  const attioCache = { data: [rawDeal("deal-y", "Spanish Translation", 672, "co-ausimm")] };
  const timeLogs = withHour(projects);
  const { perProject } = computeProfitability({ projects, attioCache, timeLogs, laborCosts: RATES, costInputs: { "proj-y": { crew: 0 } } });
  const r = perProject["proj-y"];
  assert.equal(r.dealValue, 999);
  assert.equal(r.dealValueSource, "project");
});

test("enrichment: ambiguous match => no number, DEAL_MATCH_AMBIGUOUS + missing value, Incomplete", () => {
  const projects = { "proj-z": { id: "proj-z", projectName: "Brand Video", dealValue: null } }; // no company => can't disambiguate
  const attioCache = { data: [rawDeal("d-a", "Brand Video", 8000, "co-a"), rawDeal("d-b", "Brand Video", 12000, "co-b")] };
  const timeLogs = withHour(projects);
  const { perProject } = computeProfitability({ projects, attioCache, timeLogs, laborCosts: RATES, costInputs: { "proj-z": { crew: 0 } } });
  const r = perProject["proj-z"];
  assert.equal(r.dealValue, 0);
  assert.equal(r.dealValueSource, "none");
  assert.ok(r.warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.ok(r.warnings.includes(WARNINGS.MISSING_OR_ZERO_DEAL_VALUE));
  assert.equal(r.complete, false);
});

test("enrichment: one Won deal claimed by TWO projects => both flagged, sale never double-counted", () => {
  const projects = {
    "proj-1": { id: "proj-1", projectName: "Recurring Social", dealValue: null },
    "proj-2": { id: "proj-2", projectName: "Recurring Social", dealValue: null },
  };
  // a single deal both same-named projects would otherwise each claim in full
  const attioCache = { data: [rawDeal("deal-dup", "Recurring Social", 5000, "co-x")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-1": { crew: 0 }, "proj-2": { crew: 0 } },
    commissionInputs: {
      "proj-1": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-2": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  const a = perProject["proj-1"];
  const b = perProject["proj-2"];
  // neither gets the number; both flagged ambiguous + Incomplete
  assert.equal(a.dealValue, 0);
  assert.equal(b.dealValue, 0);
  assert.ok(a.warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.ok(b.warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.equal(a.complete, false);
  assert.equal(b.complete, false);
  // the 5000 sale lands in NEITHER total (both excluded) — never doubled
  assert.equal(rollups.totals.dealValue, 0);
  assert.equal(rollups.incompleteCount, 2);
});

test("enrichment: own-value project + blank sibling sharing a deal id (FK) => blank flagged, sale not doubled", () => {
  // Codex Finding 1: the pre-count guard used to skip own-value projects, so a
  // deal claimed by ONE own-value project AND one blank FK project escaped the
  // double-count check — the blank borrowed the same sale the own-value row
  // already booked, summing one deal twice. Both projects carry the deal's
  // record id in attioCompanyId (the FK the matcher now reads).
  const projects = {
    "proj-own":   { id: "proj-own",   projectName: "Masterton Brand", dealValue: 6517, attioCompanyId: "deal-shared" },
    "proj-blank": { id: "proj-blank", projectName: "Masterton Brand B", dealValue: null, attioCompanyId: "deal-shared" },
  };
  const attioCache = { data: [rawDeal("deal-shared", "Masterton Brand", 6517, "co-mast")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-own": { crew: 0 }, "proj-blank": { crew: 0 } },
    commissionInputs: {
      "proj-own": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-blank": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  const own = perProject["proj-own"];
  const blank = perProject["proj-blank"];
  // own-value row keeps its own number and stays complete
  assert.equal(own.dealValue, 6517);
  assert.equal(own.dealValueSource, "project");
  assert.equal(own.complete, true);
  // blank sibling must NOT borrow the same deal — flagged, no value
  assert.equal(blank.dealValue, 0);
  assert.ok(blank.warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.equal(blank.complete, false);
  // the 6517 sale is counted EXACTLY once (the own-value row), never doubled
  assert.equal(rollups.totals.dealValue, 6517);
});

test("enrichment: two blank projects sharing a deal id via attioCompanyId FK => both flagged", () => {
  // Codex Finding 8: the existing duplicate test matches by NAME; this exercises
  // the FK path explicitly — different names, same deal record id in
  // attioCompanyId. Both must be flagged so the sale is never doubled.
  const projects = {
    "p1": { id: "p1", projectName: "Totally Different A", dealValue: null, attioCompanyId: "deal-fk-dup" },
    "p2": { id: "p2", projectName: "Totally Different B", dealValue: null, attioCompanyId: "deal-fk-dup" },
  };
  const attioCache = { data: [rawDeal("deal-fk-dup", "Some Deal Name", 5000, "co-x")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "p1": { crew: 0 }, "p2": { crew: 0 } },
  });
  assert.equal(perProject["p1"].dealValue, 0);
  assert.equal(perProject["p2"].dealValue, 0);
  assert.ok(perProject["p1"].warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.ok(perProject["p2"].warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.equal(rollups.totals.dealValue, 0);
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

// ── scheduled shoot labour (booked shoot subtasks) ───────────────────
const RATES2 = { "ed-1": { costPerHour: 50 }, "crew-jeremy": { costPerHour: 120 }, "crew-steve": { costPerHour: 80 } };
// one logged edit hour so the project clears the no-logged-time filter
const EDIT_HOUR = { "ed-1": { "2026-05-20": { "edit-1": { secs: 3600 } } } };
function shootProject(shootFields) {
  return { "p": { id: "p", dealValue: 10000, subtasks: {
    "edit-1": { id: "edit-1", stage: "edit" },
    "shoot-1": { id: "shoot-1", stage: "shoot", ...shootFields },
  } } };
}

test("shoot labour: booked window priced at crew rate, added as its own line", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", endDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: ["crew-jeremy"] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  const r = perProject["p"];
  assert.equal(r.loggedHours, 1);
  assert.equal(r.labourCost, 50);          // 1h edit * 50, logged labour only
  assert.equal(r.shootHours, 6);           // 6h booked window, 1 crew
  assert.equal(r.shootLabour, 720);        // 6h * 120
  assert.equal(r.shootHoursEstimated, false);
  assert.equal(r.productionCost, 50 + 720 + 0);
  assert.equal(r.productionMargin, 10000 - 770);
});

test("shoot labour: every assigned crew costed for the FULL window (not split)", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: ["crew-jeremy", "crew-steve"] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  const r = perProject["p"];
  assert.equal(r.shootHours, 12);          // 6h * 2 crew
  assert.equal(r.shootLabour, 6 * 120 + 6 * 80); // each works the full 6h
});

test("shoot labour: no booked times => estimated standard shoot day, flagged estimated", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", assigneeIds: ["crew-jeremy"] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  const r = perProject["p"];
  assert.equal(r.shootHours, EST_SHOOT_DAY_HOURS);
  assert.equal(r.shootLabour, EST_SHOOT_DAY_HOURS * 120);
  assert.equal(r.shootHoursEstimated, true);
});

test("shoot labour: multi-day booked window = days x daily window", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", endDate: "2026-05-21", startTime: "09:00", endTime: "13:00", assigneeIds: ["crew-jeremy"] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  assert.equal(perProject["p"].shootHours, 8); // 4h/day * 2 days
  assert.equal(perProject["p"].shootHoursEstimated, false);
});

test("shoot labour: shoot with no assigned crew is skipped (not costable here)", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: [] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  assert.equal(perProject["p"].shootHours, 0);
  assert.equal(perProject["p"].shootLabour, 0);
});

test("shoot labour: crew with no rate => 0 shoot labour + missingLabourRate", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: ["crew-norate"] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  const r = perProject["p"];
  assert.equal(r.shootHours, 6);
  assert.equal(r.shootLabour, 0);
  assert.ok(r.warnings.includes(WARNINGS.MISSING_LABOUR_RATE));
  assert.ok(r.missingRateFor.includes("crew-norate"));
});

test("shoot labour: a SHOOT-only project (no logged time) is still dropped (filter unchanged)", () => {
  const projects = { "shootonly": { id: "shootonly", dealValue: 10000, subtasks: {
    "shoot-1": { id: "shoot-1", stage: "shoot", startDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: ["crew-jeremy"] },
  } } };
  const { perProject } = computeProfitability({ projects, timeLogs: {}, laborCosts: RATES2, costInputs: {}, commissionInputs: {}, commissionPlans: PLANS });
  assert.equal(perProject["shootonly"], undefined, "shoot booked but no logged time => still dropped");
});

test("shootHoursByPersonForProject: pure helper sums crew x window, flags estimate, ignores non-shoots", () => {
  const real = shootHoursByPersonForProject({ subtasks: {
    s1: { stage: "shoot", startDate: "2026-05-20", startTime: "09:00", endTime: "12:00", assigneeIds: ["a", "b"] }, // 3h each
    e1: { stage: "edit", startDate: "2026-05-20", assigneeIds: ["a"] },                                            // ignored
  } });
  assert.deepEqual(real.byPerson, { a: 3, b: 3 });
  assert.equal(real.estimated, false);
  const est = shootHoursByPersonForProject({ subtasks: {
    s1: { stage: "shoot", startDate: "2026-05-20", assigneeIds: ["a"] }, // no times => estimate
  } });
  assert.equal(est.byPerson.a, EST_SHOOT_DAY_HOURS);
  assert.equal(est.estimated, true);
});

test("shoot labour: round-trips through recomputeRow (client reprices a persisted row)", () => {
  const base = { projectId: "p", dealValue: 10000, hoursByPerson: { "ed-1": 1 }, shootHoursByPerson: { "crew-jeremy": 6 }, shootHoursEstimated: false };
  const first = recomputeRow(base, { laborCosts: RATES2, costInputs: { p: { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS });
  assert.equal(first.shootLabour, 720);
  const second = recomputeRow(first, { laborCosts: RATES2, costInputs: { p: { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS });
  assert.equal(second.shootLabour, first.shootLabour);
  assert.equal(second.shootHours, 6);
  assert.equal(second.productionCost, first.productionCost);
});

test("shoot labour: partial-logged shoot adds only the un-timed remainder (no double-count, no under-count)", () => {
  const projects = { "p": { id: "p", dealValue: 10000, subtasks: {
    "shoot-1": { id: "shoot-1", stage: "shoot", startDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: ["crew-jeremy"] }, // 6h booked
  } } };
  // crew-jeremy ran the timer for 4h of the 6h shoot
  const timeLogs = { "crew-jeremy": { "2026-05-20": { "shoot-1": { secs: 4 * 3600 } } } };
  const { perProject } = computeProfitability({ projects, timeLogs, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS });
  const r = perProject["p"];
  assert.equal(r.loggedHours, 4);          // timer truth
  assert.equal(r.labourCost, 4 * 120);     // 480 logged
  assert.equal(r.shootHours, 2);           // 6h booked − 4h logged = 2h remainder
  assert.equal(r.shootLabour, 2 * 120);    // 240 scheduled remainder
  assert.equal(r.productionCost, 6 * 120); // full 6h window, counted exactly once
});

test("shoot labour: a fully-logged shoot adds no scheduled hours (logged covers it)", () => {
  const projects = { "p": { id: "p", dealValue: 10000, subtasks: {
    "shoot-1": { id: "shoot-1", stage: "shoot", startDate: "2026-05-20", startTime: "09:00", endTime: "15:00", assigneeIds: ["crew-jeremy"] }, // 6h
  } } };
  const timeLogs = { "crew-jeremy": { "2026-05-20": { "shoot-1": { secs: 6 * 3600 } } } }; // logged the whole 6h
  const { perProject } = computeProfitability({ projects, timeLogs, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS });
  const r = perProject["p"];
  assert.equal(r.loggedHours, 6);
  assert.equal(r.shootHours, 0);
  assert.equal(r.shootLabour, 0);
});

test("shoot labour: an absurd multi-day span is capped and flagged estimated (one bad endDate can't torch totals)", () => {
  const { perProject } = computeProfitability({
    projects: shootProject({ startDate: "2026-05-20", endDate: "2099-01-01", startTime: "09:00", endTime: "17:00", assigneeIds: ["crew-jeremy"] }),
    timeLogs: EDIT_HOUR, laborCosts: RATES2, costInputs: { "p": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS,
  });
  const r = perProject["p"];
  assert.equal(r.shootHours, MAX_SHOOT_DAYS * 8); // 8h window × capped 14 days
  assert.equal(r.shootHoursEstimated, true);      // capped => estimated
});

console.log(`\n${passed} passed`);
