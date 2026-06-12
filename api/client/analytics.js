// api/client/analytics.js
//
// Client portal — Analytics tab. Org-scoped.
//
//   401  invalid / forged / expired token, or unverified non-staff email
//   200  { hasAccess: false, accounts: [] }        valid token, no live registry
//   200  { hasAccess: true,  accounts: [] }        registered, no analytics yet
//   200  { hasAccess: true,  accounts: [{ accountId, name, projection }] }
//
// Returns the SAME client-safe projection the public /r/{shortId} page
// reads — /analytics/public/{portalShortId}, authored server-side in
// api/_analyticsClientProjection.js — never the internal /analytics
// scoring state. This resolver exists because the accountId →
// portalShortId mapping lives under /analytics/clients/{accountId}/config,
// which is staff-only in the RTDB rules.

import { getAdmin } from "../_fb-admin.js";
import { handleOptions, setCors, requireClientOrStaff, sendAuthError } from "../_requireAuth.js";
import { emailKeyFor } from "../auth-google.js";

export default async function handler(req, res) {
  if (handleOptions(req, res, "GET, OPTIONS")) return;
  setCors(req, res, "GET, OPTIONS");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  let who;
  try {
    who = await requireClientOrStaff(req);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });
  const db = admin.database();

  // Registry-FIRST, mirroring api/client/projects.js: /clientAccess is
  // the source of truth for what an email can see as a client. Staff
  // support mode (explicit ?accountId=) is only the fallback for staff
  // who are NOT registered clients.
  let accountIds = [];
  const emailKey = who.email ? emailKeyFor(who.email) : null;
  const reg = emailKey
    ? (await db.ref(`/clientAccess/${emailKey}`).once("value")).val()
    : null;
  if (reg && reg.accountIds) {
    accountIds = Object.keys(reg.accountIds).filter(k => reg.accountIds[k]);
  } else if (who.kind === "staff") {
    const accountId = String(req.query.accountId || "");
    if (!accountId) {
      return res.status(400).json({ error: "Staff support mode requires ?accountId=" });
    }
    // The param goes into ref paths below — reject RTDB-illegal keys
    // up front instead of letting admin .ref() throw an opaque 500.
    if (!/^[A-Za-z0-9_-]+$/.test(accountId)) {
      return res.status(400).json({ error: "Invalid accountId" });
    }
    accountIds = [accountId];
  } else {
    // Valid token, no live access → empty (NOT 401).
    return res.status(200).json({ hasAccess: false, accounts: [] });
  }

  const accounts = [];
  for (const accountId of accountIds) {
    const shortId = (await db.ref(`/analytics/clients/${accountId}/config/portalShortId`).once("value")).val();
    if (!shortId) continue;
    const projection = (await db.ref(`/analytics/public/${shortId}`).once("value")).val();
    // A retired tombstone is truthy but not renderable — same rule as
    // the public /r/ reader.
    if (!projection || projection.retired) continue;
    const name = projection?.header?.companyName
      || (await db.ref(`/accounts/${accountId}/name`).once("value")).val()
      || "Your account";
    accounts.push({ accountId, name, projection });
  }

  return res.status(200).json({ hasAccess: true, accounts });
}
