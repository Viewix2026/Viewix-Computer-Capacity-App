// Shared role definitions for the Viewix dashboard.
//
// The role string is the authoritative permission boundary — it lands on
// the Firebase ID token as a custom claim (set by api/auth-google.js) and
// is checked in firebase-rules.json and api/_requireAuth.js.
//
// `founders` vs `founder`: historical duo, both grant the same access.
// Kept until we explicitly migrate one to the other.

export const ROLES = ["founders", "founder", "closer", "editor", "lead", "trial"];

export const ROLE_LABELS = {
  founders: "Founders",
  founder:  "Founder",
  closer:   "Closer",
  editor:   "Editor",
  lead:     "Lead",
  trial:    "Trial",
};

export const FOUNDER_ROLES = ["founders", "founder"];

export function isValidRole(r) {
  return typeof r === "string" && ROLES.includes(r);
}

export function isFounderRole(r) {
  return FOUNDER_ROLES.includes(r);
}
