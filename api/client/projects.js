// api/client/projects.js
//
// Client portal — dashboard project list. Org-scoped, redacted.
//
//   401  invalid / forged / expired token, or unverified non-staff email
//   200  { displayName, projects: [] }   valid token, no live registry
//                                          (portal shows no-access state)
//   200  { displayName, projects: [...] } org-scoped, redacted list items
//
// Reads go through api/_clientRedact.js — never a filtered raw project.
// Staff support mode: a staff token MUST pass ?accountId= to scope to
// one org (still redacted). ?clientEmail= is intentionally NOT honored
// (ambiguous for agency emails across multiple accounts).

import { getAdmin } from "../_fb-admin.js";
import { handleOptions, setCors, requireClientOrStaff, sendAuthError } from "../_requireAuth.js";
import { emailKeyFor } from "../auth-google.js";
import { redactProjectListItem } from "../_clientRedact.js";

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

  let accountIds = [];
  let displayName = null;

  // Registry-FIRST. The /clientAccess registry is the source of truth
  // for "what can this email see as a client". A Viewix staffer who is
  // ALSO a registered client (e.g. testing with their own email) must
  // get their client view — staff-support-mode (explicit ?accountId=)
  // is only the fallback for staff who are NOT registered clients.
  const emailKey = who.email ? emailKeyFor(who.email) : null;
  const reg = emailKey
    ? (await db.ref(`/clientAccess/${emailKey}`).once("value")).val()
    : null;
  if (reg && reg.accountIds) {
    accountIds = Object.keys(reg.accountIds).filter(k => reg.accountIds[k]);
    displayName = reg.displayName || who.email;
  } else if (who.kind === "staff") {
    const accountId = String(req.query.accountId || "");
    if (!accountId) {
      return res.status(400).json({ error: "Staff support mode requires ?accountId=" });
    }
    accountIds = [accountId];
    displayName = who.email || "Staff preview";
  } else {
    // Valid token, no live access → empty (NOT 401).
    return res.status(200).json({ displayName: null, projects: [] });
  }

  const allowed = new Set(accountIds);
  const [projSnap, acctSnap, delSnap, metaSnap, soSnap, editorsSnap] = await Promise.all([
    db.ref("/projects").once("value"),
    db.ref("/accounts").once("value"),
    db.ref("/deliveries").once("value"),
    db.ref("/preproduction/metaAds").once("value"),
    db.ref("/preproduction/socialOrganic").once("value"),
    db.ref("/editors").once("value"),
  ]);
  const projects = projSnap.val() || {};
  const accounts = acctSnap.val() || {};
  const deliveries = delSnap.val() || {};
  const metaAds = metaSnap.val() || {};
  const socialOrganic = soSnap.val() || {};
  const editors = editorsSnap.val() || {};

  const out = [];
  for (const project of Object.values(projects)) {
    const accountId = project?.links?.accountId;
    if (!accountId || !allowed.has(accountId)) continue;     // fail closed
    const account = accounts[accountId] || null;
    const delivery = project?.links?.deliveryId ? deliveries[project.links.deliveryId] : null;
    const ppType = project?.links?.preprodType;
    const ppId = project?.links?.preprodId;
    const preprod = ppId && ppType === "metaAds" ? metaAds[ppId]
      : ppId && ppType === "socialOrganic" ? socialOrganic[ppId]
        : null;
    const item = redactProjectListItem({ project, account, delivery, preprod, editors });
    // A legacy project without a shortId has no openable route — the
    // dashboard would render dead rows and real hrefs to /clients/p/null.
    if (!item.projectId) continue;
    out.push(item);
  }

  // Active first, then by name — stable, no internal sort keys leaked.
  out.sort((a, b) =>
    (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) ||
    a.projectName.localeCompare(b.projectName));

  return res.status(200).json({ displayName, projects: out });
}
