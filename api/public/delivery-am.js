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
// Returns:   { accountManager: { name, photo, phone, email, bookingUrl },
//              clientLogo: { url, bg } | null }
//            or { accountManager: null, clientLogo: null } when it can't be
//            resolved. The client logo lives on /accounts/{id} (logoUrl +
//            logoBg) — the public /d/ page can't read /accounts directly, so
//            we resolve + return it here alongside the AM block. The org's
//            own brand mark is not sensitive to that org.

import { getAdmin } from "../_fb-admin.js";
import { accountManagerBlock } from "../_clientRedact.js";
import { normalizeAvatarUrl } from "../_avatarUrl.js";
import { findOwningProject } from "../_findOwningProject.js";

// Re-exported for back-compat — `delivery-am.test.mjs` imports it from
// here. The implementation lives in `api/_findOwningProject.js` so every
// reverse-lookup endpoint (this, on-video-approved, posting-preferences)
// uses the same fail-closed semantics. Codex audit 2026-05-28.
export { findOwningProject };

// Delivery ids are minted as `del-${Date.now()}` (api/webhook-deal-won.js);
// allow base36-ish legacy variants but keep it bounded. Exported for tests.
export const DELIVERY_ID_RE = /^del-[A-Za-z0-9]{1,40}$/;

// ── Pure helpers (DB-free, unit-tested by delivery-am.test.mjs) ──

// Build the response envelope from a resolved account + editors. The
// only keys that ever leave the server are `accountManager` (root) and
// the five fields accountManagerBlock returns. No name → null card.
export function buildAmEnvelope(account, editors) {
  if (!account) return { accountManager: null };
  const am = accountManagerBlock(account, editors || {});
  return { accountManager: am && am.name ? am : null };
}

// Resolve the client's own brand mark from the account record. `logoUrl`
// may be a Google Drive *share* link (serves HTML, not image bytes) — run
// it through the same normaliser the AM photo uses so <img> gets real
// bytes. `bg` carries the producer's logoBg preference so a white-on-
// transparent mark can be backed on the dark surface it needs. null when
// there's no logo set. (A `del-` delivery node's own logoUrl is almost
// always "" — the real asset lives on /accounts/{id}.)
export function buildClientLogo(account) {
  if (!account) return null;
  const url = normalizeAvatarUrl(account.logoUrl);
  if (!url) return null;
  return { url, bg: account.logoBg || "white" };
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

const NO_AM = { accountManager: null, clientLogo: null };

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

    // Resolve the owning account in two passes.
    // (a) Preferred: reverse-lookup the project via /projects/*.links.deliveryId.
    //     This is the canonical link the deal-won webhook writes.
    // (b) Fallback: match `delivery.clientName` to /accounts/*.companyName
    //     (case-insensitive trim). Necessary for older / manually-created
    //     deliveries whose project never got `links.deliveryId` set.
    // Both passes still fail closed on ambiguity (>1 match) — a guessed
    // AM is worse than none.
    const projectsObj = (await db.ref("/projects").once("value")).val() || {};
    const { project, ambiguous: projectAmbiguous } = findOwningProject(projectsObj, deliveryId);
    if (projectAmbiguous) {
      console.warn(`[delivery-am] multiple projects share deliveryId=${deliveryId}; refusing to guess AM`);
    }

    let accountId = project?.links?.accountId || null;
    if (!accountId) {
      const clientName = String(delSnap.val()?.clientName || "").trim().toLowerCase();
      if (clientName) {
        const accountsObj = (await db.ref("/accounts").once("value")).val() || {};
        const matches = Object.entries(accountsObj).filter(
          ([, a]) => String(a?.companyName || "").trim().toLowerCase() === clientName
        );
        if (matches.length === 1) {
          accountId = matches[0][0];
        } else if (matches.length > 1) {
          console.warn(`[delivery-am] multiple accounts match clientName="${clientName}"; refusing to guess AM`);
        }
      }
    }
    if (!accountId) return res.status(200).json(NO_AM);

    const [acctSnap, editorsSnap] = await Promise.all([
      db.ref(`/accounts/${accountId}`).once("value"),
      db.ref("/editors").once("value"),
    ]);
    const account = acctSnap.val();
    return res.status(200).json({
      ...buildAmEnvelope(account, editorsSnap.val()),
      clientLogo: buildClientLogo(account),
    });
  } catch (e) {
    console.error("[delivery-am] error", e);
    return res.status(500).json({ error: "Could not resolve account manager" });
  }
}
