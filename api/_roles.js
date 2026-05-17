// Shared role definitions — server-side mirror of src/lib/roles.js.
//
// Kept in two files because the client uses CDN-style imports and the
// server runs as ESM Vercel functions — neither cleanly imports across
// the boundary. Keep this in sync with src/lib/roles.js by hand.

export const ROLES = ["founders", "manager", "closer", "editor", "lead", "trial"];

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

export function isAssignableRole(r) {
  return typeof r === "string" && ROLES.includes(r);
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
