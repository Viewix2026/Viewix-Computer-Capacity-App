// shared/profitability.js
//
// Pure, isomorphic margin/contribution compute. Used by BOTH:
//   1. the nightly cron (api/cron/profitability-rollup.js) — reads the
//      full /timeLogs, and is the SOLE writer of /profitability; and
//   2. the Founders -> Profitability UI — recomputes live from the
//      persisted rows + current input nodes, so editing a labour rate,
//      an external cost, or a commission assignment updates the screen
//      instantly (no "wait for tonight" lag).
//
// THE TRUTHFULNESS CONTRACT: a missing input is never silently treated as
// profit. Every row carries `warnings[]` and a `complete` flag. Any
// warning => complete:false => the UI badges the row "Incomplete",
// separates it, and EXCLUDES it from headline totals. Zero is only ever
// "zero" when a human explicitly entered zero; an ABSENT input reads as
// "unknown", not "free".
//
// Figures are EX GST (deal values are stored ex GST — confirmed). The
// headline metric is "Contribution (before overhead)" — overhead is
// intentionally excluded, so it must NEVER be labelled "profit".
//
// Deliberately dependency-free so it runs unchanged under Node (cron) and
// in the browser bundle (UI), and is trivially unit-testable.

// Single documented gate. Deal values are ex GST today, so the math uses
// them directly. If deal values ever become GST-inclusive, flip this and
// divide by 1.1 in ONE place rather than hunting every call site.
export const FIGURES_EX_GST = true;

// Frozen warning vocabulary. Anything in a row's warnings[] makes it
// Incomplete and keeps it out of totals.
export const WARNINGS = {
  MISSING_LABOUR_RATE: "missingLabourRate",
  MISSING_EXTERNAL_COST: "missingExternalCost",
  COMMISSION_UNASSIGNED: "commissionUnassigned",
  COMMISSION_RATE_MISSING: "commissionRateMissing",
  MISSING_OR_ZERO_DEAL_VALUE: "missingOrZeroDealValue",
  DUPLICATE_TASK_ID: "duplicateTaskId",
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isBlank = (v) => v == null || v === "";

// Route a deal's commission to exactly ONE payee.
//   new business  -> the CLOSER: providedLeadPct (company-supplied lead)
//                    or selfSourcedPct (closer found the lead themselves)
//   repeat/managed -> the ACCOUNT MANAGER: repeatPct
// commission is always a real number; when it can't be trusted (no payee
// assigned, or the assigned payee's applicable rate is blank) it returns 0
// AND a warning, so the row is flagged Incomplete rather than silently
// counting as full margin (Codex #6).
export function commissionFor(input, commissionPlans, dealValue) {
  const plans = commissionPlans || {};
  const dv = num(dealValue);

  if (!input || typeof input !== "object" || isBlank(input.dealType)) {
    return { commission: 0, payeeId: null, payeeType: null, leadSource: null, warnings: [WARNINGS.COMMISSION_UNASSIGNED] };
  }

  if (input.dealType === "repeat") {
    const amId = input.accountManagerId;
    const plan = amId ? plans[amId] : null;
    if (!amId || !plan) {
      return { commission: 0, payeeId: amId || null, payeeType: "accountManager", leadSource: null, warnings: [WARNINGS.COMMISSION_UNASSIGNED] };
    }
    const flat = num(plan.flatPerDeal);
    if (isBlank(plan.repeatPct) && !flat) {
      return { commission: 0, payeeId: amId, payeeType: "accountManager", leadSource: null, warnings: [WARNINGS.COMMISSION_RATE_MISSING] };
    }
    const commission = (num(plan.repeatPct) / 100) * dv + flat;
    return { commission, payeeId: amId, payeeType: "accountManager", leadSource: null, warnings: [] };
  }

  // new business -> closer route (any non-"repeat" dealType is treated as new)
  const closerId = input.closerId;
  const plan = closerId ? plans[closerId] : null;
  if (!closerId || !plan) {
    return { commission: 0, payeeId: closerId || null, payeeType: "closer", leadSource: input.leadSource || null, warnings: [WARNINGS.COMMISSION_UNASSIGNED] };
  }
  const leadSource = input.leadSource === "selfSourced" ? "selfSourced" : "provided";
  const pctField = leadSource === "selfSourced" ? plan.selfSourcedPct : plan.providedLeadPct;
  const flat = num(plan.flatPerDeal);
  if (isBlank(pctField) && !flat) {
    return { commission: 0, payeeId: closerId, payeeType: "closer", leadSource, warnings: [WARNINGS.COMMISSION_RATE_MISSING] };
  }
  const commission = (num(pctField) / 100) * dv + flat;
  return { commission, payeeId: closerId, payeeType: "closer", leadSource, warnings: [] };
}

// Light, repeatable per-row compute. `base` carries the EXPENSIVE bits
// already derived from /timeLogs (hoursByPerson, plus the project
// identity and the duplicateTaskId flag); everything else is (re)derived
// from the current input nodes. The client calls this on every edit for
// instant feedback, and the cron calls it too — single source of math.
//
// IMPORTANT: the output is a valid `base` for a future recomputeRow call
// (it round-trips hoursByPerson + duplicateTaskId), which is exactly how
// the client repriced a persisted /profitability row live.
export function recomputeRow(base, { laborCosts = {}, costInputs = {}, commissionInputs = {}, commissionPlans = {} } = {}) {
  const projectId = base.projectId;
  const hoursByPerson = base.hoursByPerson && typeof base.hoursByPerson === "object" ? base.hoursByPerson : {};
  const warnings = [];
  if (base.duplicateTaskId) warnings.push(WARNINGS.DUPLICATE_TASK_ID);

  // --- labour: price each person's logged hours at their cost rate ---
  // A person who logged time but has no rate counts as 0 labour AND
  // raises missingLabourRate (so the row can't masquerade as cheap).
  let labourCost = 0;
  let loggedHours = 0;
  const missingRateFor = [];
  for (const [personId, hrs] of Object.entries(hoursByPerson)) {
    const hours = num(hrs);
    loggedHours += hours;
    const rate = laborCosts?.[personId]?.costPerHour;
    if (isBlank(rate)) {
      if (hours > 0) missingRateFor.push(personId);
      continue;
    }
    labourCost += hours * num(rate);
  }
  if (missingRateFor.length) warnings.push(WARNINGS.MISSING_LABOUR_RATE);

  // --- externals: an ABSENT entry is "unknown", not "free" ---
  // Once a producer has saved the entry (even all zeros + a note), it's a
  // human confirmation and no longer suspect.
  const ci = costInputs?.[projectId];
  let externalCosts = 0;
  if (!ci || typeof ci !== "object") {
    warnings.push(WARNINGS.MISSING_EXTERNAL_COST);
  } else {
    externalCosts = num(ci.crew) + num(ci.travel) + num(ci.location) + num(ci.gear) + num(ci.other);
  }

  // --- deal value (ex GST) ---
  const dealValue = num(base.dealValue);
  if (dealValue <= 0) warnings.push(WARNINGS.MISSING_OR_ZERO_DEAL_VALUE);

  const productionCost = labourCost + externalCosts;
  const productionMargin = dealValue - productionCost;

  // --- commission (routed, single payee) ---
  const c = commissionFor(commissionInputs?.[projectId], commissionPlans, dealValue);
  for (const w of c.warnings) if (!warnings.includes(w)) warnings.push(w);

  const contribution = productionMargin - c.commission;
  const numVideos = num(base.numberOfVideos);

  return {
    projectId,
    clientName: base.clientName || "",
    projectName: base.projectName || "",
    dealValue,
    numberOfVideos: base.numberOfVideos ?? null,
    videoType: base.videoType || "",
    productLine: base.productLine || "",
    // round-trip fields (let the client recompute from a persisted row)
    hoursByPerson,
    duplicateTaskId: !!base.duplicateTaskId,
    missingRateFor,
    // computed
    loggedHours,
    labourCost,
    externalCosts,
    productionCost,
    productionMargin,
    productionMarginPct: dealValue > 0 ? productionMargin / dealValue : null,
    commission: c.commission,
    payeeId: c.payeeId,
    payeeType: c.payeeType,
    dealType: (commissionInputs?.[projectId]?.dealType) || null,
    leadSource: c.leadSource,
    contribution,
    contributionPct: dealValue > 0 ? contribution / dealValue : null,
    perVideoContribution: numVideos > 0 ? contribution / numVideos : null,
    warnings,
    complete: warnings.length === 0,
  };
}

// Build taskId -> projectId index AND flag projects whose subtask ids
// collide with another project's. A duplicate taskId would mis-attribute
// logged labour (Codex #8), so any project touched by a collision is
// marked duplicateTaskId and forced Incomplete.
function indexTasks(projects) {
  const taskToProject = new Map();
  const dupProjectIds = new Set();
  for (const p of Object.values(projects || {})) {
    if (!p || typeof p !== "object" || !p.id) continue;
    for (const stid of Object.keys(p.subtasks || {})) {
      const existing = taskToProject.get(stid);
      if (existing && existing !== p.id) {
        dupProjectIds.add(existing);
        dupProjectIds.add(p.id);
      } else if (!existing) {
        taskToProject.set(stid, p.id);
      }
    }
  }
  return { taskToProject, dupProjectIds };
}

// HEAVY. Reads the full /timeLogs. Cron-only. Accumulates logged hours
// per project split by person, then runs recomputeRow over every project.
// The persisted hoursByPerson is what lets the client reprice labour live
// WITHOUT ever loading /timeLogs.
export function computeProfitability({
  projects = {},
  timeLogs = {},
  laborCosts = {},
  commissionPlans = {},
  costInputs = {},
  commissionInputs = {},
} = {}) {
  const { taskToProject, dupProjectIds } = indexTasks(projects);

  // projectId -> { [personId]: hours }
  const hoursByProject = new Map();
  for (const [personId, byDate] of Object.entries(timeLogs || {})) {
    if (!byDate || typeof byDate !== "object") continue;
    for (const byTask of Object.values(byDate)) {
      if (!byTask || typeof byTask !== "object") continue;
      for (const [taskId, log] of Object.entries(byTask)) {
        if (taskId === "_running") continue; // live timer sentinel, not a real log
        if (!log || typeof log !== "object") continue;
        const projectId = taskToProject.get(taskId);
        if (!projectId) continue; // orphan log — no parent project anywhere
        const hours = num(log.secs) / 3600;
        if (hours <= 0) continue;
        let bucket = hoursByProject.get(projectId);
        if (!bucket) { bucket = {}; hoursByProject.set(projectId, bucket); }
        bucket[personId] = (bucket[personId] || 0) + hours;
      }
    }
  }

  // One row per project. Status is NOT filtered: realized margin on
  // completed work is the most valuable signal, and the cron replaces the
  // whole node nightly so nothing goes stale. Incomplete rows are flagged,
  // not hidden.
  const perProject = {};
  for (const p of Object.values(projects || {})) {
    if (!p || typeof p !== "object" || !p.id) continue;
    const base = {
      projectId: p.id,
      clientName: p.clientName || "",
      projectName: p.projectName || "",
      dealValue: p.dealValue,
      numberOfVideos: p.numberOfVideos ?? null,
      videoType: p.videoType || "",
      productLine: p.productLine || "",
      hoursByPerson: hoursByProject.get(p.id) || {},
      duplicateTaskId: dupProjectIds.has(p.id),
    };
    perProject[p.id] = recomputeRow(base, { laborCosts, costInputs, commissionInputs, commissionPlans });
  }

  const rollups = buildRollups(Object.values(perProject), { commissionPlans });
  return { perProject, rollups };
}

function addNumeric(map, key, fields) {
  if (key == null || key === "") return;
  const cur = map[key] || {};
  for (const [k, v] of Object.entries(fields)) cur[k] = (cur[k] || 0) + num(v);
  map[key] = cur;
}

// Rollups are built from COMPLETE rows ONLY. Incomplete rows are counted
// separately (incompleteCount) and NEVER summed into a headline total —
// the entire point of the truthfulness layer. computedAt is intentionally
// omitted (kept pure); the cron stamps it at persist time.
export function buildRollups(rows, { commissionPlans = {} } = {}) {
  const list = Array.isArray(rows) ? rows : Object.values(rows || {});
  const complete = list.filter((r) => r && r.complete);
  const incomplete = list.filter((r) => r && !r.complete);

  const byProductLine = {};
  const byVideoType = {};
  const byPayee = {};
  const byCloser = {};
  const byAccountManager = {};
  const totals = {
    dealValue: 0, labourCost: 0, externalCosts: 0, productionCost: 0,
    productionMargin: 0, commission: 0, contribution: 0, videos: 0,
  };

  for (const r of complete) {
    const money = {
      dealValue: r.dealValue, labourCost: r.labourCost, externalCosts: r.externalCosts,
      productionCost: r.productionCost, productionMargin: r.productionMargin,
      commission: r.commission, contribution: r.contribution,
      videos: num(r.numberOfVideos), count: 1,
    };
    addNumeric(byProductLine, r.productLine || "(unspecified)", money);
    addNumeric(byVideoType, r.videoType || "(unspecified)", money);
    for (const k of Object.keys(totals)) totals[k] += num(r[k] != null ? r[k] : money[k]);

    if (r.payeeId) {
      const plan = commissionPlans[r.payeeId];
      addNumeric(byPayee, r.payeeId, { commission: r.commission, dealValue: r.dealValue, contribution: r.contribution, count: 1 });
      if (plan?.name) byPayee[r.payeeId].name = plan.name;
      byPayee[r.payeeId].type = r.payeeType || plan?.type || null;
      const target = r.payeeType === "accountManager" ? byAccountManager : byCloser;
      addNumeric(target, r.payeeId, { commission: r.commission, dealValue: r.dealValue, contribution: r.contribution, count: 1 });
      if (plan?.name) target[r.payeeId].name = plan.name;
    }
  }

  totals.contributionPct = totals.dealValue > 0 ? totals.contribution / totals.dealValue : null;
  totals.productionMarginPct = totals.dealValue > 0 ? totals.productionMargin / totals.dealValue : null;
  totals.perVideoContribution = totals.videos > 0 ? totals.contribution / totals.videos : null;

  return {
    byProductLine, byVideoType, byPayee, byCloser, byAccountManager,
    totals,
    completeCount: complete.length,
    incompleteCount: incomplete.length,
  };
}
