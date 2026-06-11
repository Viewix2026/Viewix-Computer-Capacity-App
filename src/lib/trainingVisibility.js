// Per-role Training category visibility — deny by default.
//
// See-all is an explicit allowlist (founders, manager, lead). Every other
// role gets a filtered view, and any role string the chain doesn't
// recognise — a future role, a missing branch — falls through to the
// most restricted view (trial onboarding), never the full library.
// The old ternary chain in Training.jsx defaulted the other way: an
// unmatched role saw everything, including Sales Training.

import { normalizeRole, isAdminRole } from "./roles.js";

const catName = (c) => (c?.name || "").toLowerCase();

export function visibleTrainingCategories(role, trainingData) {
  const r = normalizeRole(role);
  if (isAdminRole(r) || r === "lead") return trainingData;
  if (r === "closer") return trainingData.filter((c) => catName(c).includes("sales"));
  if (r === "editor") return trainingData.filter((c) => !catName(c).includes("sales"));
  // trial + anything unrecognised
  return trainingData.filter((c) => catName(c).includes("trial editor onboarding"));
}
