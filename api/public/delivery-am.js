// api/public/delivery-am.js
//
// PUBLIC (unauthenticated) Account-Manager resolver for the /d/{shortId}
// delivery link. The public delivery page can't resolve its AM client-side
// (the delivery node has no accountId, and /projects + /accounts are not
// anon-readable), so this endpoint does it server-side via the Admin SDK
// and returns ONLY the redacted 5-field AM block.
//
// The browser NEVER reads /accounts, /editors or /projects — this endpoint
// is the only thing that touches them, and it returns nothing but the
// curated accountManager block.
//
// `deliveryId` is already available to the anonymous public delivery view
// (it reads /deliveries and issues leaf writes against
// /deliveries/{id}/videos/{idx}/...), so accepting it here exposes no new
// internal id.
//
// Contract:  GET /api/public/delivery-am?deliveryId=del-1234567890
// Returns:   { accountManager: { name, photo, phone, email, bookingUrl } }
//            or { accountManager: null } when it can't be resolved.

import { getAdmin } from "../_fb-admin.js";
import { accountManagerBlock } from "../_clientRedact.js";

// Delivery ids are minted as `del-${Date.now()}` (api/webhook-deal-won.js);
// allow base36-ish legacy variants but keep it bounded. Exported for tests.
export const DELIVERY_ID_RE = /^del-[A-Za-z0-9]{1,40}$/;

// ── Pure helpers (DB-free, unit-tested by delivery-am.test.mjs) ──

// Find the single project that owns this delivery. RTDB has no
// query-by-child for our layout, so the caller passes the whole
// /projects object and we scan. Returns { project, ambiguous }.
// Fail closed: >1 match → ambiguous (a guessed AM is worse than none).
export function findOwningProject(projects, deliveryId) {
  const matches = Object.values(projects || {}).filter(
    p => p && (p.links || {}).deliveryId === deliveryId
  );
  if (matches.length === 1) return { project: matches[0], ambiguous: false };
  return { project: null, ambiguous: matches.length > 1 };
}

// Build the response envelope from a resolved account + editors. The
// only keys that ever leave the server are `accountManager` (root) and
// the five fields accountManagerBlock returns. No name → null card.
export function buildAmEnvelope(account, editors) {
  if (!account) return { accountManager: null };
  const am = accountManagerBlock(account, editors || {});
  return { accountManager: am && am.name ? am : null };
}

// Light in-memory rate limit (same shape as api/notify-revision.js).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const attempts = new Map();

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRate(ip) {
  const now = Date.now();
  const e = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - e.windowStart > RATE_WINDOW_MS) { e.count = 0; e.windowStart = now; }
  e.count++;
  attempts.set(ip, e);
  return e.count <= RATE_LIMIT;
}

const NO_AM = { accountManager: null };

export default async function handler(req, res) {
  // Never cache: AM details can change and the response is per-delivery.
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!checkRate(clientIp(req))) return res.status(429).json({ error: "Too many requests" });

  const deliveryId = String(req.query.deliveryId || "");
  if (!DELIVERY_ID_RE.test(deliveryId)) {
    return res.status(400).json({ error: "Invalid deliveryId" });
  }

  try {
    const { db, err } = getAdmin();
    if (err) return res.status(500).json({ error: "Server not configured" });

    // Confirm the delivery exists before resolving anything.
    const delSnap = await db.ref(`/deliveries/${deliveryId}`).once("value");
    if (!delSnap.exists()) return res.status(200).json(NO_AM);

    // Reverse-lookup the owning project (RTDB has no query-by-child for our
    // layout). Same scan pattern as api/notify-revision.js. Fail closed on
    // ambiguity — a guessed AM contact is worse than none.
    const projectsObj = (await db.ref("/projects").once("value")).val() || {};
    const { project, ambiguous } = findOwningProject(projectsObj, deliveryId);
    if (ambiguous) {
      console.warn(`[delivery-am] multiple projects share deliveryId=${deliveryId}; refusing to guess AM`);
    }
    const accountId = project?.links?.accountId;
    if (!accountId) return res.status(200).json(NO_AM);

    const [acctSnap, editorsSnap] = await Promise.all([
      db.ref(`/accounts/${accountId}`).once("value"),
      db.ref("/editors").once("value"),
    ]);
    return res.status(200).json(buildAmEnvelope(acctSnap.val(), editorsSnap.val()));
  } catch (e) {
    console.error("[delivery-am] error", e);
    return res.status(500).json({ error: "Could not resolve account manager" });
  }
}
