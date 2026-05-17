// Shared role definitions for the Viewix dashboard.
//
// The role string is the authoritative permission boundary — it lands on
// the Firebase ID token as a custom claim (set by api/auth-google.js) and
// is checked in firebase-rules.json and api/_requireAuth.js.
//
// `founder` was the old singular shared-login role. It was too easy to
// confuse with the real `founders` owner tier, so it now normalises to
// `manager` during the cutover.

export const ROLES = ["founders", "manager", "closer", "editor", "lead", "trial"];

export const ROLE_LABELS = {
  founders: "Founders",
  manager:  "Manager",
  closer:   "Closer",
  editor:   "Editor",
  lead:     "Lead",
  trial:    "Trial",
};

export const LEGACY_ROLE_ALIASES = {
  founder: "manager",
};

export const FOUNDER_ROLES = ["founders"];
export const MANAGER_ROLES = ["manager"];

export function normalizeRole(r) {
  return LEGACY_ROLE_ALIASES[r] || r;
}

export function isValidRole(r) {
  return typeof r === "string" && ROLES.includes(normalizeRole(r));
}

export function isFounderRole(r) {
  return FOUNDER_ROLES.includes(normalizeRole(r));
}

export function isManagerRole(r) {
  return MANAGER_ROLES.includes(normalizeRole(r));
}

export function isAdminRole(r) {
  const role = normalizeRole(r);
  return isFounderRole(role) || isManagerRole(role);
}
