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
// Deliberately free of EXTERNAL/Node deps so it runs unchanged under Node
// (cron) and in the browser bundle (UI), and is trivially unit-testable.
// The one intra-shared import below (attio-extract) is itself isomorphic
// and dependency-free.
import { buildDealIndex, resolveDealValue } from "./attio-extract.js";

// Single documented gate. Deal values are ex GST today, so the math uses
// them directly. If deal values ever become GST-inclusive, flip this and
// divide by 1.1 in ONE place rather than hunting every call site.
export const FIGURES_EX_GST = true;

// A standard shoot day in hours. Used to ESTIMATE a shoot's labour when the
// booked subtask has no usable start/end time (Jeremy's call: estimate so a
// shoot always contributes some cost, rather than flag the row). One
// documented constant so the assumption is a single edit.
export const EST_SHOOT_DAY_HOURS = 8;

// Bound on a shoot's day span. A stale or mistyped endDate (e.g. years out)
// would otherwise multiply into an enormous estimate that distorts the
// totals. Past this many days the span is treated as suspect: capped AND
// flagged estimated so a single bad date can't quietly torch margin.
export const MAX_SHOOT_DAYS = 14;

// Frozen warning vocabulary. Anything in a row's warnings[] makes it
// Incomplete and keeps it out of totals.
export const WARNINGS = {
  MISSING_LABOUR_RATE: "missingLabourRate",
  MISSING_EXTERNAL_COST: "missingExternalCost",
  COMMISSION_UNASSIGNED: "commissionUnassigned",
  COMMISSION_RATE_MISSING: "commissionRateMissing",
  // New-business deal with a closer but no lead source chosen. The rate
  // (provided 10% vs self-sourced 15%) is a human-only fact, so we refuse to
  // default it — a silent default would pick the LOWER rate and inflate
  // contribution. Row stays Incomplete until a human picks.
  LEAD_SOURCE_UNSET: "leadSourceUnset",
  MISSING_OR_ZERO_DEAL_VALUE: "missingOrZeroDealValue",
  DUPLICATE_TASK_ID: "duplicateTaskId",
  // Attio had >1 Won deal matching this project's name and we couldn't
  // pick one confidently, so no value was sourced. The row is Incomplete
  // until the deal is renamed in Attio or its value set on the project.
  DEAL_MATCH_AMBIGUOUS: "dealMatchAmbiguous",
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isBlank = (v) => v == null || v === "";

// A project earns a profitability row only when someone logged timer time
// against it. That logged labour is the realized cost the margin view
// exists to profile; a project nobody timed would read as full-margin
// revenue against ~zero cost, so it is dropped as noise. STRICT rule by
// design: no logged time => out, EVEN IF the project carries entered
// externals (a deliberate founder call to keep the view to jobs the team
// actually worked). The ONE exception is a duplicateTaskId collision: the
// hours ARE logged but got misattributed to another project sharing a
// subtask id, so dropping it would bury the very warning the producer must
// act on. Applied at the join (computeProfitability) and mirrored in the
// UI live recompute, so cron-persisted truth and on-screen rows agree.
export function keepProjectRow(row) {
  if (!row || typeof row !== "object") return false;
  return num(row.loggedHours) > 0 || !!row.duplicateTaskId;
}

// Viewix's OWN internal projects (BTS, founder content, internal sandboxes,
// admin placeholders like "Leave") carry clientName "Viewix" and have no client
// deal — they are cost-only, never revenue. Excluded from the margin instrument
// entirely (founder call) so the view shows only real client work. There is no
// `internal` flag on project records; clientName is the only signal. Applied in
// computeProfitability so these never reach a row OR consume an Attio deal claim.
const INTERNAL_CLIENT_NAMES = new Set(["viewix"]);
export function isInternalProject(p) {
  return !!p && INTERNAL_CLIENT_NAMES.has(String(p.clientName || "").trim().toLowerCase());
}

// "HH:MM" -> minutes since midnight, or null if malformed.
function hhmmToMin(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Inclusive whole-day span between two YYYY-MM-DD strings (always >= 1). A
// blank endDate, or one not after start, collapses to a single day.
function daySpan(startDate, endDate) {
  if (typeof startDate !== "string" || !startDate) return 1;
  if (typeof endDate !== "string" || !endDate || endDate <= startDate) return 1;
  const a = Date.parse(startDate + "T00:00:00Z");
  const b = Date.parse(endDate + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.round((b - a) / 86400000) + 1;
}

// Labour-hours for ONE shoot subtask from its booked window, plus whether
// the figure was estimated. Real window when start+end times are valid
// (x day span for a multi-day booking); otherwise EST_SHOOT_DAY_HOURS per
// scheduled day.
function shootSubtaskHours(st) {
  const rawDays = daySpan(st.startDate, st.endDate);
  const days = Math.min(rawDays, MAX_SHOOT_DAYS);
  const capped = days < rawDays; // suspect span => treat the result as an estimate
  const a = hhmmToMin(st.startTime);
  const b = hhmmToMin(st.endTime);
  if (a != null && b != null && b > a) {
    return { hours: ((b - a) / 60) * days, estimated: capped };
  }
  return { hours: EST_SHOOT_DAY_HOURS * days, estimated: true };
}

// Scheduled SHOOT labour-hours per crew person for a project, read from its
// shoot subtasks. Each assigned crew member is costed for the FULL shoot
// window (two crew on a 6h shoot = 12 person-hours; both work the whole
// booking). Only subtasks with stage "shoot", a startDate, and >= 1 assignee
// count; freelance crew without an editor id aren't in assigneeIds and stay
// in externals. Returns { byPerson, estimated }.
export function shootHoursByPersonForProject(project, loggedBySubtask = null) {
  const byPerson = {};
  let estimated = false;
  const subs = project && typeof project === "object" ? project.subtasks : null;
  if (!subs || typeof subs !== "object") return { byPerson, estimated };
  for (const [stid, st] of Object.entries(subs)) {
    if (!st || typeof st !== "object" || st.stage !== "shoot") continue;
    if (!st.startDate) continue; // not scheduled yet => no shoot labour yet
    const ids = Array.isArray(st.assigneeIds)
      ? st.assigneeIds
      : (st.assigneeId ? [st.assigneeId] : []);
    if (!ids.length) continue; // no crew attributed => not costable here
    const { hours: windowHours, estimated: est } = shootSubtaskHours(st);
    if (!(windowHours > 0)) continue;
    // Subtract any hours the timer ALREADY captured for THIS person on this
    // shoot, so a partly-logged shoot neither double-counts (logged + full
    // window) NOR under-counts (skipping the whole shoot loses the rest).
    const id = st.id || stid;
    const loggedHere = loggedBySubtask ? (loggedBySubtask.get(id) || loggedBySubtask.get(stid) || null) : null;
    let addedAny = false;
    for (const pid of ids) {
      if (!pid) continue;
      const already = loggedHere ? num(loggedHere[pid]) : 0;
      const add = windowHours - already;
      if (add > 0) {
        byPerson[pid] = (byPerson[pid] || 0) + add;
        addedAny = true;
      }
    }
    if (est && addedAny) estimated = true;
  }
  return { byPerson, estimated };
}

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
  // Lead source must be an explicit human choice. Defaulting a blank to
  // "provided" would silently apply the lower 10% rate and overstate
  // contribution, so a blank is flagged Incomplete instead of guessed.
  if (input.leadSource !== "provided" && input.leadSource !== "selfSourced") {
    return { commission: 0, payeeId: closerId, payeeType: "closer", leadSource: null, warnings: [WARNINGS.LEAD_SOURCE_UNSET] };
  }
  const leadSource = input.leadSource;
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

  // --- scheduled SHOOT labour: crew time on booked shoots the timer never
  // captured (crew rarely run a stopwatch on location). Derived from the
  // shoot subtasks' booked window in computeProfitability and carried in
  // base.shootHoursByPerson so the client reprices it without /projects.
  // Priced exactly like logged labour (missing rate => missingLabourRate),
  // but kept as its OWN line so it never masquerades as timer data.
  const shootHoursByPerson = base.shootHoursByPerson && typeof base.shootHoursByPerson === "object" ? base.shootHoursByPerson : {};
  let shootLabour = 0;
  let shootHours = 0;
  for (const [personId, hrs] of Object.entries(shootHoursByPerson)) {
    const hours = num(hrs);
    shootHours += hours;
    const rate = laborCosts?.[personId]?.costPerHour;
    if (isBlank(rate)) {
      if (hours > 0 && !missingRateFor.includes(personId)) missingRateFor.push(personId);
      continue;
    }
    shootLabour += hours * num(rate);
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
  // base.dealValue has already been resolved upstream (computeProfitability):
  // the project's own value if it had one, else a CONFIDENT Attio match,
  // else 0. We only read it here so the client round-trips the same number.
  const dealValue = num(base.dealValue);
  if (dealValue <= 0) warnings.push(WARNINGS.MISSING_OR_ZERO_DEAL_VALUE);
  // An ambiguous Attio match (>1 same-named Won deal) is flagged so the
  // "missing value" reads as "go disambiguate" rather than "no deal exists".
  if (base.dealMatchAmbiguous) warnings.push(WARNINGS.DEAL_MATCH_AMBIGUOUS);

  const productionCost = labourCost + shootLabour + externalCosts;
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
    // provenance of dealValue: "project" (its own field), "attio" (matched
    // Won deal), or "none". Round-tripped so the client can tag the row and
    // re-derive without re-matching.
    dealValueSource: base.dealValueSource || (dealValue > 0 ? "project" : "none"),
    attioDealId: base.attioDealId || null,
    dealMatchAmbiguous: !!base.dealMatchAmbiguous,
    numberOfVideos: base.numberOfVideos ?? null,
    videoType: base.videoType || "",
    productLine: base.productLine || "",
    // round-trip fields (let the client recompute from a persisted row)
    hoursByPerson,
    shootHoursByPerson,
    shootHoursEstimated: !!base.shootHoursEstimated,
    duplicateTaskId: !!base.duplicateTaskId,
    missingRateFor,
    // computed
    loggedHours,
    labourCost,
    shootHours,
    shootLabour,
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
  attioCache = null,
} = {}) {
  const { taskToProject, dupProjectIds } = indexTasks(projects);
  // Index Won deals by name once, so revenue can be sourced from Attio for
  // projects whose own dealValue is blank (the common case).
  const dealIndex = buildDealIndex(attioCache);

  // Pre-count CONFIDENT claims per deal id. If two different projects both
  // resolve to the SAME Won deal, attaching its value to both would sum one
  // sale into the totals twice. So a deal claimed by >1 project is treated as
  // ambiguous for every BLANK claimant below — no number attached, row flagged.
  //
  // Count EVERY project that resolves to a deal id, INCLUDING those with their
  // own dealValue. An own-value project still consumes its deal: if a blank
  // sibling resolves (by foreign-key id or name) to that same deal, the blank
  // must NOT also borrow it, or the one sale lands twice — once as the own
  // value, once as the borrowed value. (The own-value project keeps its own
  // number regardless; only blank projects consult this count.) This closes the
  // hole the FK matcher widened: a project and its blank duplicate now commonly
  // share one deal id via attioCompanyId.
  const attioClaimCounts = new Map();
  for (const p of Object.values(projects || {})) {
    if (!p || typeof p !== "object" || !p.id) continue;
    if (isInternalProject(p)) continue; // internal work claims no deal
    const m = resolveDealValue(p, dealIndex);
    if (m && m.value > 0 && m.dealId) {
      attioClaimCounts.set(m.dealId, (attioClaimCounts.get(m.dealId) || 0) + 1);
    }
  }

  // projectId -> { [personId]: hours }
  const hoursByProject = new Map();
  // subtask id -> { [personId]: logged hours }, so the shoot derivation can
  // subtract hours the timer already captured on a shoot — avoiding BOTH a
  // double-count and the under-count of skipping a partly-logged shoot.
  const loggedBySubtask = new Map();
  for (const [personId, byDate] of Object.entries(timeLogs || {})) {
    if (!byDate || typeof byDate !== "object") continue;
    for (const byTask of Object.values(byDate)) {
      if (!byTask || typeof byTask !== "object") continue;
      for (const [taskId, log] of Object.entries(byTask)) {
        if (taskId === "_running") continue; // live timer sentinel, not a real log
        if (log == null) continue;
        const projectId = taskToProject.get(taskId);
        if (!projectId) continue; // orphan log — no parent project anywhere
        // logs are normally { secs, stage }, but legacy entries are a plain
        // number of seconds. Every other reader (Capacity, EditorDashboard)
        // handles both; match them, or numeric-format projects undercount to
        // zero hours and get wrongly dropped by the no-logged-time filter.
        const secs = typeof log === "number" ? log : num(log.secs);
        const hours = secs / 3600;
        if (hours <= 0) continue;
        let perPerson = loggedBySubtask.get(taskId);
        if (!perPerson) { perPerson = {}; loggedBySubtask.set(taskId, perPerson); }
        perPerson[personId] = (perPerson[personId] || 0) + hours;
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
    if (isInternalProject(p)) continue; // Viewix's own cost-only work, not revenue

    // Sold-for amount. The project's OWN value wins when present (captured
    // for THIS project, zero matching risk). Attio only fills a blank, and
    // only on a CONFIDENT match; an ambiguous match sets the flag (not a
    // number) so the row reads Incomplete rather than guessed.
    let dealValue = num(p.dealValue);
    let dealValueSource = dealValue > 0 ? "project" : "none";
    let attioDealId = p.attioDealId || null;
    let dealMatchAmbiguous = false;
    if (dealValue <= 0) {
      const m = resolveDealValue(p, dealIndex);
      if (m) {
        if (m.value > 0 && m.dealId && attioClaimCounts.get(m.dealId) > 1) {
          // Contested: >1 project resolves to this one deal. Attach NO
          // number and flag, rather than count the same sale twice.
          dealMatchAmbiguous = true;
        } else if (m.value > 0) {
          dealValue = m.value;
          dealValueSource = "attio";
          attioDealId = m.dealId || null;
        }
        if (m.ambiguous) dealMatchAmbiguous = true;
      }
    }

    const shoot = shootHoursByPersonForProject(p, loggedBySubtask);
    const base = {
      projectId: p.id,
      clientName: p.clientName || "",
      projectName: p.projectName || "",
      dealValue,
      dealValueSource,
      attioDealId,
      dealMatchAmbiguous,
      numberOfVideos: p.numberOfVideos ?? null,
      videoType: p.videoType || "",
      productLine: p.productLine || "",
      hoursByPerson: hoursByProject.get(p.id) || {},
      shootHoursByPerson: shoot.byPerson,
      shootHoursEstimated: shoot.estimated,
      duplicateTaskId: dupProjectIds.has(p.id),
    };
    const row = recomputeRow(base, { laborCosts, costInputs, commissionInputs, commissionPlans });
    // Strict: drop projects nobody logged time on so the calculator shows
    // only jobs the team actually worked. A duplicateTaskId row survives
    // (its hours are misattributed, not absent) so its warning stays
    // visible. See keepProjectRow.
    if (!keepProjectRow(row)) continue;
    perProject[p.id] = row;
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
    dealValue: 0, labourCost: 0, shootLabour: 0, externalCosts: 0, productionCost: 0,
    productionMargin: 0, commission: 0, contribution: 0, videos: 0,
  };

  for (const r of complete) {
    const money = {
      dealValue: r.dealValue, labourCost: r.labourCost, shootLabour: r.shootLabour, externalCosts: r.externalCosts,
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
