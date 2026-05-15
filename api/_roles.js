// Shared role definitions — server-side mirror of src/lib/roles.js.
//
// Kept in two files because the client uses CDN-style imports and the
// server runs as ESM Vercel functions — neither cleanly imports across
// the boundary. Keep this in sync with src/lib/roles.js by hand.

export const ROLES = ["founders", "founder", "closer", "editor", "lead", "trial"];

export const FOUNDER_ROLES = ["founders", "founder"];

export function isValidRole(r) {
  return typeof r === "string" && ROLES.includes(r);
}

export function isFounderRole(r) {
  return FOUNDER_ROLES.includes(r);
}
