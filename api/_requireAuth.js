import { getAdmin } from "./_fb-admin.js";

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

  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (roles.length && !roles.includes(decoded.role)) {
    const actual = decoded.role || "(no role claim)";
    const err = new Error(`Forbidden — your token's role is "${actual}". Allowed: ${roles.join(", ")}. Sign out and back in if you expect access; this refreshes claims on your token.`);
    err.status = 403;
    throw err;
  }
  return decoded;
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
