// shared/commissionDerive.js
//
// Pure, dependency-light derivation of a SUGGESTED commission attribution for a
// project, from the two Attio deal fields that already carry the signal:
//   · source  -> dealType ("Repeat Business" => repeat, any channel => new) AND
//                lead source (provided 10% vs self-sourced 15%)
//   · owner   -> the salesperson (closer for new, account manager for repeat)
//
// It NEVER writes anything and NEVER guesses a money fact it isn't sure of: an
// unknown owner, a missing plan, a blank source, or an unmapped channel all
// surface as a `warnings[]` entry that keeps the suggestion at "review" instead
// of "high". Only "high" suggestions (a clean commissionFor() dry-run) are
// eligible for one-click bulk-accept in the UI. This mirrors the instrument's
// "flag, don't fabricate margin" contract (shared/profitability.js).
//
// The output is the EXACT /projectCommissionInputs shape the UI's saveComm()
// writes and recomputeRow()/commissionFor() reads — { dealType, closerId |
// accountManagerId, leadSource } — plus a non-persisted `_meta`.

import { commissionFor, WARNINGS } from "./profitability.js";

// Attio deal `owner` is an actor-reference whose cache cell carries only a
// workspace-member UUID (no name/email). This bridge was resolved ONCE from the
// Attio workspace-members API (GET /v2/workspace_members). A 6th salesperson's
// deals will land as an unmapped owner => `needsOwnerMatch` (review), never a
// wrong attribution — re-run the members API and add the row here to onboard
// them. Suspended ex-staff (Vish, Raoul) are mapped so their deals attribute by
// name; if they have no commission plan the derive flags review anyway.
export const OWNER_ACTOR_TO_NAME = {
  "e90aec93-f56e-4f28-8df8-065c63ab1a2d": "Jeremy",
  "bb65f36c-aa47-47a8-aa93-9e2e60f87fc9": "Brandon",
  "8cf18748-7976-422a-80eb-abf77d89b8d4": "Vish",
  "29a25d36-315e-437a-b0a2-f140eb78e6f8": "Raoul",
  "0617680a-8ba9-4c1e-b909-37fd1a038ae1": "Sophie",
};

// The Attio `source` option that marks a repeat/managed deal (=> account-manager
// route, no lead source). Everything else is treated as new business (Jeremy
// confirmed the team tags repeats consistently). Compared case-insensitively.
export const REPEAT_SOURCE = "Repeat Business";

// Acquisition channel -> commission lead-source bucket (Gate-1 decision, Jeremy
// 2026-06-28). provided = company-generated lead (10%); selfSourced = the
// closer's own effort (15%). An UNLISTED channel is never defaulted — it flags
// `needsLeadSource` so the lower rate can't be applied silently. Keys are
// normalised (trim + lowercase).
export const SOURCE_LEAD_MAP = {
  "advertising": "provided",
  "seo": "provided",
  "conference": "provided",
  "chatgpt": "provided",
  "cold call": "selfSourced",
  "cold email": "selfSourced",
  "referral": "selfSourced",
  "linkedin": "selfSourced",
};

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");

// Find the active commission plan of a given type whose name matches `person`.
// Plan names are founder-entered first names ("Jeremy", "Brandon"); the owner
// bridge yields the same first name. An EXACT normalised full-name match wins;
// otherwise a first-token fallback ("Jeremy Farrugia" -> "jeremy") applies ONLY
// when it's unambiguous — exactly one active plan shares that first token. Two
// payees sharing a first name (Angus Smith / Angus Brennan) therefore yield NO
// match rather than a silent wrong attribution (Codex code-review F1). Returns
// { id, ...plan } or null. Never matches an inactive plan.
export function findPlan(commissionPlans, person, type) {
  if (!person || !commissionPlans) return null;
  const want = norm(person);
  const wantFirst = want.split(/\s+/)[0];
  const active = Object.entries(commissionPlans).filter(([, p]) => p && p.type === type && p.active !== false && norm(p.name));
  for (const [id, p] of active) if (norm(p.name) === want) return { id, ...p };
  const firstTok = active.filter(([, p]) => norm(p.name).split(/\s+/)[0] === wantFirst);
  if (firstTok.length === 1) { const [id, p] = firstTok[0]; return { id, ...p }; }
  return null;
}

// Derive a commission-attribution suggestion for ONE project's matched deal.
//   source        Attio source channel (dealSource(rawDeal))
//   ownerActorId  Attio owner UUID (dealOwnerActorId(rawDeal))
//   dealValue     the row's resolved deal value (for the commissionFor dry-run)
//   commissionPlans the live /commissionPlans map
// Returns { dealType?, closerId?, accountManagerId?, leadSource?, _meta:{
// confidence, basis[], warnings[] } }. `confidence:"high"` ONLY when the
// assembled input dry-runs through the real commissionFor() with zero warnings.
export function deriveCommissionSuggestion({ source, ownerActorId, dealValue, commissionPlans }) {
  const warnings = [];
  const basis = [];
  const out = {};

  // 1. dealType from source (explicit field; blank can't be guessed)
  let dealType = null;
  if (norm(source) === "") {
    warnings.push(WARNINGS.COMMISSION_UNASSIGNED);
    basis.push("no Attio source — deal type can't be inferred");
  } else if (norm(source) === norm(REPEAT_SOURCE)) {
    dealType = "repeat";
    basis.push('source "Repeat Business" → repeat/managed');
  } else {
    dealType = "new";
    basis.push(`source "${source}" → new business`);
  }
  if (dealType) out.dealType = dealType;

  // 2. payee from owner (closer if new, AM if repeat)
  const person = ownerActorId ? OWNER_ACTOR_TO_NAME[ownerActorId] : null;
  if (!person) {
    warnings.push(WARNINGS.COMMISSION_UNASSIGNED);
    basis.push(ownerActorId ? `owner ${ownerActorId} not mapped to a salesperson` : "deal has no owner");
  } else if (dealType === "repeat") {
    const plan = findPlan(commissionPlans, person, "accountManager");
    if (plan) { out.accountManagerId = plan.id; basis.push(`owner ${person} → account-manager plan`); }
    else { warnings.push(WARNINGS.COMMISSION_UNASSIGNED); basis.push(`${person} has no account-manager plan`); }
  } else if (dealType === "new") {
    const plan = findPlan(commissionPlans, person, "closer");
    if (plan) { out.closerId = plan.id; basis.push(`owner ${person} → closer plan`); }
    else { warnings.push(WARNINGS.COMMISSION_UNASSIGNED); basis.push(`${person} has no closer plan`); }
  }

  // 3. lead source — new business only, derived INDEPENDENTLY of whether the
  // payee resolved, so an unmapped/plan-less owner still pre-fills the rate side
  // (otherwise a later manual payee entry would leave the row Incomplete with no
  // lead source ever written — Codex code-review F2). Repeat deals need none.
  if (dealType === "new") {
    const ls = SOURCE_LEAD_MAP[norm(source)];
    if (ls) { out.leadSource = ls; basis.push(`source "${source}" → ${ls === "provided" ? "company-provided (10%)" : "self-sourced (15%)"}`); }
    else { warnings.push(WARNINGS.LEAD_SOURCE_UNSET); basis.push(`source "${source}" has no lead-source mapping`); }
  }

  // 4. confidence: only "high" when the assembled input is fully resolved AND a
  // real commissionFor() dry-run returns zero warnings (catches a matched owner
  // whose plan rate is blank — it would compute commission:0 + a warning).
  let confidence = "review";
  if (warnings.length === 0) {
    const res = commissionFor(out, commissionPlans, dealValue);
    if (res && Array.isArray(res.warnings) && res.warnings.length === 0) {
      confidence = "high";
    } else {
      for (const w of (res?.warnings || [])) if (!warnings.includes(w)) warnings.push(w);
    }
  }

  return { ...out, _meta: { confidence, basis, warnings: [...new Set(warnings)] } };
}

// Strip the non-persisted _meta before writing a suggestion to
// /projectCommissionInputs.
export function suggestionInputs(suggestion) {
  if (!suggestion) return {};
  const { _meta, ...inputs } = suggestion;
  return inputs;
}
