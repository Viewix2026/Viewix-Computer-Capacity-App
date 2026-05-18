// api/client/project.js
//
// Client portal — per-project detail for the in-app Deliveries +
// Pre-production tabs. Ownership is RE-CHECKED here (never trust the
// list call): the project's links.accountId must be in the caller's
// authorised set, else 403.
//
//   GET ?id={projectShortId}
//   401  bad token   403  not your org   404  no such project
//   200  redacted detail (deliveries rows + preproduction handle)

import { getAdmin } from "../_fb-admin.js";
import { handleOptions, setCors, requireClientOrStaff, sendAuthError } from "../_requireAuth.js";
import { emailKeyFor } from "../auth-google.js";
import { redactProjectDetail } from "../_clientRedact.js";
import { buildDeliveryUrl, buildPreproductionUrl } from "../_email/deliveryUrl.js";

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

  const id = String(req.query.id || "");
  if (!id) return res.status(400).json({ error: "?id= (project shortId) required" });

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });
  const db = admin.database();

  // Authorised account set for this caller. Registry-FIRST (see
  // api/client/projects.js): a registered client — even one who is
  // also Viewix staff — gets their client scope; staff-support-mode
  // (?accountId=) is only the fallback for non-registered staff.
  let allowed;
  const emailKey = who.email ? emailKeyFor(who.email) : null;
  const reg = emailKey
    ? (await db.ref(`/clientAccess/${emailKey}`).once("value")).val()
    : null;
  if (reg && reg.accountIds) {
    allowed = new Set(Object.keys(reg.accountIds).filter(k => reg.accountIds[k]));
  } else if (who.kind === "staff") {
    const accountId = String(req.query.accountId || "");
    if (!accountId) return res.status(400).json({ error: "Staff support mode requires ?accountId=" });
    allowed = new Set([accountId]);
  } else {
    return res.status(403).json({ error: "No portal access" });
  }

  const projects = (await db.ref("/projects").once("value")).val() || {};
  const project = Object.values(projects).find(p => p && p.shortId === id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const accountId = project?.links?.accountId;
  if (!accountId || !allowed.has(accountId)) {
    return res.status(403).json({ error: "Not your organisation" });   // fail closed
  }

  const account = accountId ? (await db.ref(`/accounts/${accountId}`).once("value")).val() : null;
  const delivery = project?.links?.deliveryId
    ? (await db.ref(`/deliveries/${project.links.deliveryId}`).once("value")).val()
    : null;
  const ppType = project?.links?.preprodType;
  const ppId = project?.links?.preprodId;
  const preprod = ppId && (ppType === "metaAds" || ppType === "socialOrganic")
    ? (await db.ref(`/preproduction/${ppType}/${ppId}`).once("value")).val()
    : null;

  const detail = redactProjectDetail({
    project, account, delivery, preprod,
    deliveryUrl: buildDeliveryUrl(delivery),
    preprodUrl: buildPreproductionUrl(preprod),
  });

  return res.status(200).json(detail);
}
