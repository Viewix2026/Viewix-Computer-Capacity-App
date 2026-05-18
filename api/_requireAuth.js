import { getAdmin } from "./_fb-admin.js";
import { normalizeRole } from "./_roles.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://planner.viewix.com.au",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function allowedOrigins() {
  const configured = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (allowedOrigins().includes(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

export function setCors(req, res, methods = "POST, OPTIONS") {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function handleOptions(req, res, methods = "POST, OPTIONS") {
  setCors(req, res, methods);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

export async function requireRole(req, allowedRoles) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error("Missing bearer token");
    err.status = 401;
    throw err;
  }

  const { admin, err } = getAdmin();
  if (err) {
    const authErr = new Error(err);
    authErr.status = 500;
    throw authErr;
  }

  let decoded;
  try {
    // Second arg `true` enables the revocation check — combined with
    // admin.auth().revokeRefreshTokens(uid) in api/admin-users.js's
    // setActive:false/delete handlers, this kills API access for a
    // deactivated user within seconds, even if their ID token hasn't
    // expired yet.
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch {
    const err = new Error("Invalid or revoked bearer token");
    err.status = 401;
    throw err;
  }

  const roles = (Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).map(normalizeRole);
  const actualRole = normalizeRole(decoded.role);
  if (roles.length && !roles.includes(actualRole)) {
    const actual = decoded.role || "(no role claim)";
    const err = new Error(`Forbidden — your token's role is "${actual}". Allowed: ${roles.join(", ")}. Sign out and back in if you expect access; this refreshes claims on your token.`);
    err.status = 403;
    throw err;
  }
  decoded.role = actualRole;
  return decoded;
}

// Identity-only verifier for the client portal. Does NOT decide access
// (the projects endpoint owns org scoping) — it only answers "who is
// this token". Returns a discriminated union:
//   { kind:"staff",  email, role, decoded }  — token carries a valid role claim
//   { kind:"client", email,       decoded }  — verified email, no role claim
// Throws 401 for missing/invalid/forged/expired tokens or an
// unverified email on a non-staff token. Staff Google tokens DO carry
// an email, so the discriminator is the presence of the role claim.
export async function requireClientOrStaff(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error("Missing bearer token");
    err.status = 401;
    throw err;
  }

  const { admin, err } = getAdmin();
  if (err) {
    const authErr = new Error(err);
    authErr.status = 500;
    throw authErr;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch {
    const e = new Error("Invalid or revoked bearer token");
    e.status = 401;
    throw e;
  }

  const email = (decoded.email || "").toLowerCase();
  const role = normalizeRole(decoded.role);

  // Staff: a valid role claim. (Active-gate + per-rule checks still
  // apply to staff elsewhere; this endpoint family only reads.)
  if (role) {
    return { kind: "staff", email: email || null, role, decoded };
  }

  // Client: must be a verified email (email-link sign-in sets
  // email_verified). No role claim → fenced out of all staff data by
  // the existing rules; here it just identifies the person.
  if (!email || decoded.email_verified !== true) {
    const e = new Error("Verified email required");
    e.status = 401;
    throw e;
  }
  return { kind: "client", email, decoded };
}

// Build a normalised audit "actor" from a verified token.
// Used by audit-stamping endpoints so every handler stops reassembling
// { uid, email, name, ts } differently.
export function actorFrom(decoded) {
  return {
    uid:   decoded.uid,
    email: decoded.email || null,
    name:  decoded.name  || null,
    ts:    Date.now(),
  };
}

export function sendAuthError(res, err) {
  const status = err?.status || 500;
  return res.status(status).json({ error: err?.message || "Auth failed" });
}
