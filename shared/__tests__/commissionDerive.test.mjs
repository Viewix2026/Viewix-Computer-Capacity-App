// Pure unit tests for shared/commissionDerive.js + the new attio-extract owner/
// source extractors. Run via:  node shared/__tests__/commissionDerive.test.mjs
// No test runner — assertions throw on failure, green summary on success.

import assert from "node:assert/strict";
import {
  OWNER_ACTOR_TO_NAME,
  REPEAT_SOURCE,
  SOURCE_LEAD_MAP,
  findPlan,
  deriveCommissionSuggestion,
  suggestionInputs,
} from "../commissionDerive.js";
import { dealOwnerActorId, dealSource } from "../attio-extract.js";
import { WARNINGS } from "../profitability.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

// Live-shaped fixtures (mirror prod /commissionPlans dumped 2026-06-28).
const PLANS = {
  "pl-b":   { type: "closer",         name: "Brandon", active: true, providedLeadPct: 10, selfSourcedPct: 15, repeatPct: "", flatPerDeal: 0 },
  "pl-jam": { type: "accountManager", name: "Jeremy",  active: true, providedLeadPct: 10, selfSourcedPct: 15, repeatPct: 0,  flatPerDeal: 0 },
  "pl-jc":  { type: "closer",         name: "Jeremy",  active: true, providedLeadPct: 0,  selfSourcedPct: 0,  repeatPct: "", flatPerDeal: 0 },
};
const JEREMY = "e90aec93-f56e-4f28-8df8-065c63ab1a2d";
const BRANDON = "bb65f36c-aa47-47a8-aa93-9e2e60f87fc9";
const VISH = "8cf18748-7976-422a-80eb-abf77d89b8d4";

// ── findPlan ──────────────────────────────────────────────────────────
eq(findPlan(PLANS, "Brandon", "closer")?.id, "pl-b", "findPlan exact closer");
eq(findPlan(PLANS, "Jeremy", "accountManager")?.id, "pl-jam", "findPlan AM by name");
eq(findPlan(PLANS, "Jeremy Farrugia", "closer")?.id, "pl-jc", "findPlan first-token fallback");
eq(findPlan(PLANS, "Brandon", "accountManager"), null, "findPlan no AM plan for Brandon");
eq(findPlan({ "x": { type: "closer", name: "Brandon", active: false } }, "Brandon", "closer"), null, "findPlan skips inactive");

// ── deriveCommissionSuggestion ────────────────────────────────────────

// 1. Repeat Business + Jeremy -> repeat, AM plan, high (repeat 0% => commission 0, no warning)
{
  const s = deriveCommissionSuggestion({ source: REPEAT_SOURCE, ownerActorId: JEREMY, dealValue: 7000, commissionPlans: PLANS });
  eq(s.dealType, "repeat", "1 dealType repeat");
  eq(s.accountManagerId, "pl-jam", "1 AM = Jeremy");
  ok(!("closerId" in s), "1 no closerId");
  ok(!("leadSource" in s), "1 repeat needs no leadSource");
  eq(s._meta.confidence, "high", "1 high confidence");
  eq(s._meta.warnings, [], "1 no warnings");
}

// 2. Advertising + Brandon -> new, closer, provided, high (10%)
{
  const s = deriveCommissionSuggestion({ source: "Advertising", ownerActorId: BRANDON, dealValue: 8000, commissionPlans: PLANS });
  eq(s.dealType, "new", "2 dealType new");
  eq(s.closerId, "pl-b", "2 closer = Brandon");
  eq(s.leadSource, "provided", "2 provided lead");
  eq(s._meta.confidence, "high", "2 high");
}

// 3. LinkedIn + Brandon -> self-sourced, high (15%) [Gate-1: LinkedIn = self]
{
  const s = deriveCommissionSuggestion({ source: "Linkedin", ownerActorId: BRANDON, dealValue: 5000, commissionPlans: PLANS });
  eq(s.leadSource, "selfSourced", "3 LinkedIn self-sourced");
  eq(s._meta.confidence, "high", "3 high");
}

// 4. Cold Call + Jeremy -> new, Jeremy closer (0% rate is valid, not blank) -> high
{
  const s = deriveCommissionSuggestion({ source: "Cold Call", ownerActorId: JEREMY, dealValue: 4000, commissionPlans: PLANS });
  eq(s.closerId, "pl-jc", "4 closer = Jeremy");
  eq(s.leadSource, "selfSourced", "4 cold call self-sourced");
  eq(s._meta.confidence, "high", "4 Jeremy 0% still high (0 not blank)");
}

// 5. Repeat Business + Brandon -> Brandon has no AM plan -> review, flagged
{
  const s = deriveCommissionSuggestion({ source: REPEAT_SOURCE, ownerActorId: BRANDON, dealValue: 6000, commissionPlans: PLANS });
  eq(s.dealType, "repeat", "5 dealType repeat");
  ok(!("accountManagerId" in s), "5 no AM assigned");
  eq(s._meta.confidence, "review", "5 review");
  ok(s._meta.warnings.includes(WARNINGS.COMMISSION_UNASSIGNED), "5 flagged unassigned");
}

// 6. blank source -> can't infer deal type -> review, no dealType written
{
  const s = deriveCommissionSuggestion({ source: "", ownerActorId: JEREMY, dealValue: 5000, commissionPlans: PLANS });
  ok(!("dealType" in s), "6 no dealType on blank source");
  eq(s._meta.confidence, "review", "6 review");
  ok(s._meta.warnings.includes(WARNINGS.COMMISSION_UNASSIGNED), "6 flagged");
}

// 7. unmapped owner + Advertising -> dealType + leadSource still derived (payee
// deferred), review. Lead source must NOT depend on owner mapping (Codex F2).
{
  const s = deriveCommissionSuggestion({ source: "Advertising", ownerActorId: "unknown-uuid", dealValue: 5000, commissionPlans: PLANS });
  eq(s.dealType, "new", "7 dealType still inferred");
  ok(!("closerId" in s), "7 no closer for unmapped owner");
  eq(s.leadSource, "provided", "7 leadSource derived even when owner unmapped (F2)");
  ok(s._meta.warnings.includes(WARNINGS.COMMISSION_UNASSIGNED), "7 still flags unassigned payee");
  eq(s._meta.confidence, "review", "7 review");
}

// F2 regression: unmapped owner + UNMAPPED channel -> both deferred, both flagged
{
  const s = deriveCommissionSuggestion({ source: "Webinar", ownerActorId: "unknown-uuid", dealValue: 5000, commissionPlans: PLANS });
  ok(!("leadSource" in s), "F2 no leadSource for unmapped channel");
  ok(s._meta.warnings.includes(WARNINGS.COMMISSION_UNASSIGNED), "F2 unassigned payee flagged");
  ok(s._meta.warnings.includes(WARNINGS.LEAD_SOURCE_UNSET), "F2 lead source flagged");
}

// F1 regression: two active plans sharing a first name -> NO match (never a
// silent wrong attribution); an exact full-name still resolves.
{
  const dup = {
    "pl-a1": { type: "closer", name: "Angus Smith",   active: true, providedLeadPct: 10, selfSourcedPct: 15 },
    "pl-a2": { type: "closer", name: "Angus Brennan", active: true, providedLeadPct: 10, selfSourcedPct: 15 },
  };
  eq(findPlan(dup, "Angus", "closer"), null, "F1 ambiguous first name → no match");
  eq(findPlan(dup, "Angus Smith", "closer")?.id, "pl-a1", "F1 exact full name still resolves");
}

// 8. unmapped channel + Brandon -> closer set, leadSource flagged
{
  const s = deriveCommissionSuggestion({ source: "Webinar", ownerActorId: BRANDON, dealValue: 5000, commissionPlans: PLANS });
  eq(s.dealType, "new", "8 new");
  eq(s.closerId, "pl-b", "8 closer set");
  ok(!("leadSource" in s), "8 no leadSource for unmapped channel");
  ok(s._meta.warnings.includes(WARNINGS.LEAD_SOURCE_UNSET), "8 leadSourceUnset");
  eq(s._meta.confidence, "review", "8 review");
}

// 9. mapped owner (Vish) with NO plan at all -> review, flagged
{
  const s = deriveCommissionSuggestion({ source: "Referral", ownerActorId: VISH, dealValue: 5000, commissionPlans: PLANS });
  ok(!("closerId" in s), "9 no closer (Vish has no plan)");
  eq(s._meta.confidence, "review", "9 review");
}

// suggestionInputs strips _meta
eq(suggestionInputs({ dealType: "new", closerId: "pl-b", _meta: { confidence: "high" } }), { dealType: "new", closerId: "pl-b" }, "suggestionInputs strips _meta");

// SOURCE_LEAD_MAP Gate-1 decisions intact
eq(SOURCE_LEAD_MAP["referral"], "selfSourced", "referral = self (Gate 1)");
eq(SOURCE_LEAD_MAP["linkedin"], "selfSourced", "linkedin = self (Gate 1)");
eq(SOURCE_LEAD_MAP["advertising"], "provided", "advertising = provided");

// ── extractors (live cell shapes) ─────────────────────────────────────
eq(dealOwnerActorId({ values: { owner: [{ referenced_actor_id: JEREMY, referenced_actor_type: "workspace-member" }] } }), JEREMY, "dealOwnerActorId reads UUID");
eq(dealOwnerActorId({ values: {} }), null, "dealOwnerActorId null when absent");
eq(dealSource({ values: { source: [{ option: { title: "Repeat Business" } }] } }), "Repeat Business", "dealSource reads option title");
eq(dealSource({ values: {} }), null, "dealSource null when absent");

console.log(`\n✓ commissionDerive: all ${passed} assertions passed\n`);
