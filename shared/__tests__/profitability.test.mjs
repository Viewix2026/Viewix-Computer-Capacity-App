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
  isInternalProject,
  keepProjectRow,
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

test("recomputeRow: no cost-input entry => externals $0, NO warning, does not block completeness", () => {
  // Founder call 2026-06-07: a blank externals entry reads as $0, not "unknown".
  // Shoot labour is auto-costed from the schedule; real externals are rare, so
  // missing externals must NOT hold a row out of the totals.
  const base = { projectId: "p", dealValue: 5000, hoursByPerson: {} };
  const row = recomputeRow(base, {
    laborCosts: {},
    costInputs: {}, // no entry at all
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.equal(row.externalCosts, 0);
  assert.ok(!row.warnings.includes(WARNINGS.MISSING_EXTERNAL_COST));
  // deal value known, no logged labour, commission fully assigned => COMPLETE
  // even though no externals entry exists.
  assert.equal(row.complete, true);
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

test("enrichment: blank project dealValue is filled from the Attio Won deal by deal id (FK)", () => {
  const projects = { "proj-x": { id: "proj-x", clientName: "AusIMM", projectName: "Spanish Translation", dealValue: null, attioCompanyId: "deal-x" } };
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

test("enrichment: a name-only match (no deal id) attaches NO value — row stays Incomplete (id-only safety)", () => {
  // A blank-value project whose NAME matches a Won deal but has no deal-id FK must
  // NOT inherit that deal's value — it could be a different client's same-named
  // deal. Codex round 3 HIGH: never attach a wrong value and mark it Complete.
  const projects = { "nameonly": { id: "nameonly", projectName: "Brand Video", dealValue: null } };
  const attioCache = { data: [rawDeal("deal-bv", "Brand Video", 8000, "co-a")] };
  const timeLogs = withHour(projects);
  const { perProject } = computeProfitability({ projects, attioCache, timeLogs, laborCosts: RATES, costInputs: { "nameonly": { crew: 0 } }, commissionInputs: {}, commissionPlans: PLANS });
  const r = perProject["nameonly"];
  assert.equal(r.dealValue, 0);
  assert.equal(r.dealValueSource, "none");
  assert.ok(r.warnings.includes(WARNINGS.MISSING_OR_ZERO_DEAL_VALUE));
  assert.equal(r.complete, false);
});

test("enrichment: one Won deal claimed by TWO projects => both flagged, sale never double-counted", () => {
  const projects = {
    "proj-1": { id: "proj-1", projectName: "Recurring Social", dealValue: null, attioCompanyId: "deal-dup" },
    "proj-2": { id: "proj-2", projectName: "Recurring Social", dealValue: null, attioCompanyId: "deal-dup" },
  };
  // both projects carry the SAME deal id (FK) -> both resolve to the one deal
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

test("enrichment: own-value project claims its deal by NAME (no FK) + blank FK sibling => blank flagged, sale not doubled", () => {
  // Codex round 4: value sourcing is deal-id-only, but the CLAIM guard must still
  // see an own-value project's confident NAME match (it has NO fk) — else its
  // blank duplicate (which carries the deal id) borrows the same sale and doubles
  // it. This is the case the FK-only own+blank test above does NOT cover.
  const projects = {
    "own":   { id: "own",   projectName: "Masterton Brand", dealValue: 6517 },                              // own value, name claim, no fk
    "blank": { id: "blank", projectName: "Renamed Job",     dealValue: null, attioCompanyId: "deal-mast" }, // fk to the same deal
  };
  const attioCache = { data: [rawDeal("deal-mast", "Masterton Brand", 6517, "co-mast")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "own": { crew: 0 }, "blank": { crew: 0 } },
    commissionInputs: {
      "own": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "blank": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  assert.equal(perProject["own"].dealValue, 6517);
  assert.equal(perProject["own"].complete, true);
  assert.equal(perProject["blank"].dealValue, 0);
  assert.ok(perProject["blank"].warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.equal(perProject["blank"].complete, false);
  assert.equal(rollups.totals.dealValue, 6517); // counted ONCE (via own's name claim), never doubled
});

test("enrichment: own-value project with an AMBIGUOUS name claim + blank FK sibling => blank flagged, sale not doubled", () => {
  // Codex round 5: an own-value project whose name collides across clients (so its
  // name claim is ambiguous) must STILL consume EVERY deal it might be — else a
  // blank FK sibling pointing at one of the colliders double-counts the sale.
  const projects = {
    "own":   { id: "own",   projectName: "Brand Video", dealValue: 8000 },                         // own value, ambiguous name, no fk
    "blank": { id: "blank", projectName: "Renamed",     dealValue: null, attioCompanyId: "bv-a" }, // fk to ONE of the colliders
  };
  const attioCache = { data: [
    rawDeal("bv-a", "Brand Video", 8000, "co-a"),
    rawDeal("bv-b", "Brand Video", 12000, "co-b"),
  ] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "own": { crew: 0 }, "blank": { crew: 0 } },
    commissionInputs: {
      "own": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "blank": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  assert.equal(perProject["own"].dealValue, 8000);
  assert.equal(perProject["own"].complete, true);
  assert.equal(perProject["blank"].dealValue, 0);
  assert.ok(perProject["blank"].warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.equal(rollups.totals.dealValue, 8000); // counted once (own); blank flagged, never doubled
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

// ── own-value duplicate dedup (DUPLICATE_DEAL) ───────────────────────
// Two project records for the SAME Attio sale, EACH with its own dealValue > 0,
// used to both count (a 6517 sale shown as 13034) because the claim guard was
// only consulted for BLANK rows. Now one canonical row counts and the rest are
// flagged DUPLICATE_DEAL: exactly once, never twice, never zero.
test("enrichment: two OWN-VALUE projects sharing a deal id (FK) => sale counts ONCE, duplicate flagged not doubled", () => {
  // THE BUG: both projects carry their OWN dealValue AND the same deal record id
  // in attioCompanyId. Each booked the 6517 sale — totals showed 13034. Now ONE
  // canonical row counts and the other is flagged DUPLICATE_DEAL (Incomplete,
  // excluded). (Viewix copies the FULL deal value onto each project and never
  // splits one deal across rows, so shared-deal own-value rows are always
  // duplicates to collapse, not partial splits to sum.)
  const projects = {
    "proj-a": { id: "proj-a", projectName: "Masterton Brand",    dealValue: 6517, attioCompanyId: "deal-dup" },
    "proj-b": { id: "proj-b", projectName: "Masterton Brand v2", dealValue: 6517, attioCompanyId: "deal-dup" },
  };
  const attioCache = { data: [rawDeal("deal-dup", "Masterton Brand", 6517, "co-mast")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-a": { crew: 0 }, "proj-b": { crew: 0 } },
    commissionInputs: {
      "proj-a": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-b": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  const a = perProject["proj-a"];
  const b = perProject["proj-b"];
  // equal values both match Attio => tie broken on lowest id => proj-a canonical
  assert.equal(a.complete, true);
  assert.equal(a.dealValue, 6517);
  assert.ok(!a.warnings.includes(WARNINGS.DUPLICATE_DEAL));
  // duplicate keeps showing its OWN value (honest) but is flagged + incomplete
  assert.equal(b.dealValue, 6517);
  assert.equal(b.dealValueSource, "project");
  assert.ok(b.warnings.includes(WARNINGS.DUPLICATE_DEAL));
  assert.equal(b.complete, false);
  // the sale lands EXACTLY once in the totals — not 13034
  assert.equal(rollups.totals.dealValue, 6517);
  assert.equal(rollups.completeCount, 1);
  assert.equal(rollups.incompleteCount, 1);
});

test("enrichment: own-value duplicates that DISAGREE => the record matching the Attio value is canonical (not lowest id)", () => {
  // Founder call (Match Attio value): when two duplicate records carry DIFFERENT
  // values, trust the one whose value equals the Attio deal. Here the LOWER id
  // holds a stale 5000 while the higher id holds the true 6517 — the Attio match
  // must win over the id tiebreak, or totals would carry the wrong number.
  const projects = {
    "proj-aaa": { id: "proj-aaa", projectName: "Stale Clone", dealValue: 5000, attioCompanyId: "deal-z" }, // wrong value, lowest id
    "proj-zzz": { id: "proj-zzz", projectName: "True Record", dealValue: 6517, attioCompanyId: "deal-z" }, // matches Attio
  };
  const attioCache = { data: [rawDeal("deal-z", "Whatever", 6517, "co-z")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-aaa": { crew: 0 }, "proj-zzz": { crew: 0 } },
    commissionInputs: {
      "proj-aaa": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-zzz": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  // the Attio-matching record (6517) is canonical even though it has the HIGHER id
  assert.equal(perProject["proj-zzz"].complete, true);
  assert.ok(!perProject["proj-zzz"].warnings.includes(WARNINGS.DUPLICATE_DEAL));
  assert.equal(perProject["proj-aaa"].complete, false);
  assert.ok(perProject["proj-aaa"].warnings.includes(WARNINGS.DUPLICATE_DEAL));
  // totals carry the TRUE 6517 once — not the stale 5000, not 11517
  assert.equal(rollups.totals.dealValue, 6517);
  assert.equal(rollups.completeCount, 1);
});

test("enrichment: two own-value + one blank sibling on one deal => canonical counts once, both others flagged", () => {
  // Mixed claimants: the canonical own-value row counts; the duplicate own-value
  // row gets DUPLICATE_DEAL; the blank sibling keeps its existing ambiguous-match
  // treatment (never borrows). The 8000 sale still lands exactly once.
  const projects = {
    "own-1":   { id: "own-1",   projectName: "Trio Deal", dealValue: 8000, attioCompanyId: "deal-trio" },
    "own-2":   { id: "own-2",   projectName: "Trio Deal", dealValue: 8000, attioCompanyId: "deal-trio" },
    "blank-3": { id: "blank-3", projectName: "Trio Deal", dealValue: null, attioCompanyId: "deal-trio" },
  };
  const attioCache = { data: [rawDeal("deal-trio", "Trio Deal", 8000, "co-trio")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "own-1": { crew: 0 }, "own-2": { crew: 0 }, "blank-3": { crew: 0 } },
    commissionInputs: {
      "own-1": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "own-2": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "blank-3": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  // own-1 (lowest id, value matches Attio) is canonical
  assert.equal(perProject["own-1"].complete, true);
  assert.equal(perProject["own-1"].dealValue, 8000);
  // own-2 is the duplicate
  assert.ok(perProject["own-2"].warnings.includes(WARNINGS.DUPLICATE_DEAL));
  assert.equal(perProject["own-2"].complete, false);
  // blank sibling keeps the existing ambiguous-match treatment (never borrows)
  assert.equal(perProject["blank-3"].dealValue, 0);
  assert.ok(perProject["blank-3"].warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.equal(perProject["blank-3"].complete, false);
  // 8000 counted exactly once
  assert.equal(rollups.totals.dealValue, 8000);
  assert.equal(rollups.completeCount, 1);
  assert.equal(rollups.incompleteCount, 2);
});

test("enrichment: own-value duplicate where only the NON-canonical-by-value has logged time => surviving row carries the sale, never zero", () => {
  // Canonical selection must prefer a claimant that WOULD COUNT (survives the
  // no-logged-time filter and is Complete). proj-empty matches the Attio value but
  // has no logged time (it would be dropped); proj-worked has the team's hours. If
  // the empty clone were canonical it would be dropped and the worked row flagged
  // — zeroing the sale. The worked row must win and count.
  const projects = {
    "proj-empty":  { id: "proj-empty",  projectName: "Clone A", dealValue: 6517, attioCompanyId: "deal-e" }, // matches Attio, NO logged time
    "proj-worked": { id: "proj-worked", projectName: "Clone B", dealValue: 6000, attioCompanyId: "deal-e", subtasks: { "pw-t": { id: "pw-t" } } }, // has logged time
  };
  const attioCache = { data: [rawDeal("deal-e", "Clone", 6517, "co-e")] };
  const timeLogs = { "ed-1": { "2026-05-20": { "pw-t": { secs: 3600 } } } }; // only proj-worked logs an hour
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-worked": { crew: 0 } },
    commissionInputs: { "proj-worked": { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  // empty clone is dropped (no logged time); the worked row survives + counts
  assert.equal(perProject["proj-empty"], undefined);
  assert.ok(perProject["proj-worked"]);
  assert.equal(perProject["proj-worked"].complete, true);
  assert.ok(!perProject["proj-worked"].warnings.includes(WARNINGS.DUPLICATE_DEAL));
  // the sale counts ONCE (6000, the surviving row's own value) — never zero
  assert.equal(rollups.totals.dealValue, 6000);
  assert.equal(rollups.completeCount, 1);
});

test("enrichment: a would-be canonical that is Incomplete loses to a Complete sibling (no zeroing — Codex round 1 #1/#2)", () => {
  // Canonical is chosen from rows that WOULD COUNT, not a pre-guess. proj-x matches
  // the Attio value AND has the lower id (the old tiebreakers) but is Incomplete (a
  // logged person has no labour rate); proj-y has a different value but is fully
  // Complete. proj-y must carry the sale — flagging it would zero the sale outright.
  const projects = {
    "proj-x": { id: "proj-x", projectName: "Clone X", dealValue: 6517, attioCompanyId: "deal-q", subtasks: { "x-t": { id: "x-t" } } }, // matches Attio, lower id, but Incomplete
    "proj-y": { id: "proj-y", projectName: "Clone Y", dealValue: 6000, attioCompanyId: "deal-q", subtasks: { "y-t": { id: "y-t" } } }, // Complete
  };
  const attioCache = { data: [rawDeal("deal-q", "Clone", 6517, "co-q")] };
  const timeLogs = {
    "no-rate-person": { "2026-05-20": { "x-t": { secs: 3600 } } }, // proj-x logged by a person with NO rate => missingLabourRate => Incomplete
    "ed-1":           { "2026-05-20": { "y-t": { secs: 3600 } } }, // proj-y logged by ed-1 (rate 50) => Complete
  };
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-x": { crew: 0 }, "proj-y": { crew: 0 } },
    commissionInputs: {
      "proj-x": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-y": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  // proj-x is Incomplete on its own (missing labour rate) — it can't carry the sale
  assert.equal(perProject["proj-x"].complete, false);
  assert.ok(perProject["proj-x"].warnings.includes(WARNINGS.MISSING_LABOUR_RATE));
  // proj-y is the canonical: Complete, NOT flagged duplicate, counts
  assert.equal(perProject["proj-y"].complete, true);
  assert.ok(!perProject["proj-y"].warnings.includes(WARNINGS.DUPLICATE_DEAL));
  // the sale is counted once (6000, the Complete row) — NOT zero
  assert.equal(rollups.totals.dealValue, 6000);
  assert.equal(rollups.completeCount, 1);
});

test("enrichment: own-value clone PAIR + a blank sibling on one deal => sale once, blank ambiguous, one dup flagged (orthogonal mechanisms)", () => {
  // The blank-claimant guard (DEAL_MATCH_AMBIGUOUS) and the own-value dedup
  // (DUPLICATE_DEAL) are orthogonal — they must coexist without double-counting.
  // Two own-value clones + one blank sibling all share the deal: one own-value
  // canonical counts, the other own-value clone is DUPLICATE_DEAL, the blank is
  // DEAL_MATCH_AMBIGUOUS. The 9000 sale lands exactly once.
  const projects = {
    "own-1":   { id: "own-1",   projectName: "Quad Deal", dealValue: 9000, attioCompanyId: "deal-quad" },
    "own-2":   { id: "own-2",   projectName: "Quad Deal", dealValue: 9000, attioCompanyId: "deal-quad" },
    "blank-3": { id: "blank-3", projectName: "Quad Deal", dealValue: null, attioCompanyId: "deal-quad" },
  };
  const attioCache = { data: [rawDeal("deal-quad", "Quad Deal", 9000, "co-quad")] };
  const timeLogs = withHour(projects);
  const { perProject, rollups } = computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "own-1": { crew: 0 }, "own-2": { crew: 0 }, "blank-3": { crew: 0 } },
    commissionInputs: {
      "own-1": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "own-2": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "blank-3": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  // exactly one own-value row is complete + counted; the other is the flagged dup
  const ownComplete = [perProject["own-1"], perProject["own-2"]].filter((r) => r.complete);
  assert.equal(ownComplete.length, 1, "exactly one own-value clone counts");
  const ownDup = [perProject["own-1"], perProject["own-2"]].find((r) => !r.complete);
  assert.ok(ownDup.warnings.includes(WARNINGS.DUPLICATE_DEAL));
  // blank sibling is ambiguous, NEVER DUPLICATE_DEAL, never counts
  assert.equal(perProject["blank-3"].dealValue, 0);
  assert.ok(perProject["blank-3"].warnings.includes(WARNINGS.DEAL_MATCH_AMBIGUOUS));
  assert.ok(!perProject["blank-3"].warnings.includes(WARNINGS.DUPLICATE_DEAL));
  // 9000 counted exactly once across BOTH mechanisms
  assert.equal(rollups.totals.dealValue, 9000);
  assert.equal(rollups.completeCount, 1);
  assert.equal(rollups.incompleteCount, 2);
});

test("computeProfitability: does NOT mutate the input projects (duplicateDeal stays internal)", () => {
  // The finalize loop's `base.duplicateDeal = true` must not dirty the caller's
  // projects: `base` is a fresh object literal, never the project record. Lock the
  // invariant — the input comes back pristine, with no duplicateDeal leaked onto it.
  const projects = {
    "proj-a": { id: "proj-a", projectName: "Dup", dealValue: 6517, attioCompanyId: "deal-d", subtasks: { "a-t": { id: "a-t" } } },
    "proj-b": { id: "proj-b", projectName: "Dup", dealValue: 6517, attioCompanyId: "deal-d", subtasks: { "b-t": { id: "b-t" } } },
  };
  const attioCache = { data: [rawDeal("deal-d", "Dup", 6517, "co-d")] };
  const timeLogs = { "ed-1": { "2026-05-20": { "a-t": { secs: 3600 }, "b-t": { secs: 3600 } } } };
  const before = JSON.stringify(projects);
  computeProfitability({
    projects, attioCache, timeLogs, laborCosts: RATES,
    costInputs: { "proj-a": { crew: 0 }, "proj-b": { crew: 0 } },
    commissionInputs: {
      "proj-a": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
      "proj-b": { dealType: "new", closerId: "p-closer", leadSource: "provided" },
    },
    commissionPlans: PLANS,
  });
  assert.equal(JSON.stringify(projects), before, "input projects must not be mutated");
  assert.equal(projects["proj-a"].duplicateDeal, undefined);
  assert.equal(projects["proj-b"].duplicateDeal, undefined);
});

test("recomputeRow: duplicateDeal flag round-trips AND the row still survives keepProjectRow (client reprices a persisted duplicate row)", () => {
  // A real persisted duplicate has logged hours (else the cron would have dropped
  // it), so the live UI both keeps it visible AND re-derives DUPLICATE_DEAL from the
  // round-tripped flag without re-running cross-project detection.
  const base = { projectId: "p", dealValue: 6517, hoursByPerson: { "ed-1": 2 }, duplicateDeal: true };
  const first = recomputeRow(base, {
    laborCosts: RATES, costInputs: { p: { crew: 0 } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.ok(first.warnings.includes(WARNINGS.DUPLICATE_DEAL));
  assert.equal(first.complete, false);
  assert.equal(first.duplicateDeal, true);
  assert.ok(keepProjectRow(first), "duplicate row with logged hours stays visible in the UI");
  // feed the OUTPUT back in as base — the flag and Incomplete state must persist
  const second = recomputeRow(first, {
    laborCosts: RATES, costInputs: { p: { crew: 0 } },
    commissionInputs: { p: { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.ok(second.warnings.includes(WARNINGS.DUPLICATE_DEAL));
  assert.equal(second.duplicateDeal, true);
});

// ── internal Viewix projects are excluded entirely ───────────────────
test("isInternalProject: matches clientName 'Viewix' case/space-insensitively, not real clients", () => {
  assert.equal(isInternalProject({ clientName: "Viewix" }), true);
  assert.equal(isInternalProject({ clientName: "  viewix " }), true);
  assert.equal(isInternalProject({ clientName: "Hola Health" }), false);
  assert.equal(isInternalProject({ clientName: "" }), false);
  assert.equal(isInternalProject({}), false);
  assert.equal(isInternalProject(null), false);
});

test("computeProfitability: Viewix's own internal project is excluded from rows AND totals", () => {
  const projects = {
    "client-1": { id: "client-1", clientName: "Acme", projectName: "Client Job", dealValue: 5000 },
    "viewix-1": { id: "viewix-1", clientName: "Viewix", projectName: "Founder Video", dealValue: null },
  };
  const timeLogs = withHour(projects); // both log an hour — internal still dropped
  const { perProject, rollups } = computeProfitability({
    projects, timeLogs, laborCosts: RATES,
    costInputs: { "client-1": { crew: 0 } },
    commissionInputs: { "client-1": { dealType: "new", closerId: "p-closer", leadSource: "provided" } },
    commissionPlans: PLANS,
  });
  assert.ok(perProject["client-1"], "real client project kept");
  assert.equal(perProject["viewix-1"], undefined, "internal Viewix project excluded from rows");
  // internal project never contributes to incompleteCount or any total
  assert.equal(rollups.incompleteCount, 0);
  assert.equal(rollups.completeCount, 1);
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
