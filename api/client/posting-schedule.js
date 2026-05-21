// api/client/posting-schedule.js
//
// Client portal — list of upcoming + recent scheduled posts for one
// project's deliveries. Read-only in v1. Surfaced as the Posting
// Schedule tab in ProjectView.
//
//   GET ?projectId={shortId}
//
// Output is REDACTED via redactScheduleItem — never exposes Zernio
// internals (zernioPostId, zernioMediaUrl, clientReferenceId, batchId,
// profileKey).

import { handleOptions, setCors, requireClientOrStaff, sendAuthError } from "../_requireAuth.js";
import { getAdmin } from "../_fb-admin.js";
import { emailKeyFor } from "../auth-google.js";
import { redactScheduleItem } from "../_clientRedact.js";

export default async function handler(req, res) {
  if (handleOptions(req, res, "GET, OPTIONS")) return;
  setCors(req, res, "GET, OPTIONS");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  let who;
  try { who = await requireClientOrStaff(req); }
  catch (e) { return sendAuthError(res, e); }

  const projectShortId = String(req.query.projectId || "");
  if (!projectShortId) return res.status(400).json({ error: "projectId required" });

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });
  const db = admin.database();

  // Same scoping pattern as api/client/project.js — registered
  // clients get their assigned accountIds; staff support mode passes
  // ?accountId= explicitly.
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

  // Resolve the project by shortId, then check scope.
  const projects = (await db.ref("/projects").once("value")).val() || {};
  const project = Object.values(projects).find(p => p && p.shortId === projectShortId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const accountId = project?.links?.accountId;
  if (!accountId || !allowed.has(accountId)) return res.status(403).json({ error: "Not your organisation" });

  const deliveryId = project?.links?.deliveryId;
  if (!deliveryId) return res.status(200).json({ items: [] });

  // Find all schedules tied to this delivery. There can be multiple
  // (re-scheduling within the same delivery creates a new schedule
  // doc on each modal submit) — flatten them and sort by postAt.
  const schedules = (await db.ref("/socialSchedule").once("value")).val() || {};
  const delivery = (await db.ref(`/deliveries/${deliveryId}`).once("value")).val();
  const videos = Array.isArray(delivery?.videos) ? delivery.videos : [];

  const items = [];
  for (const [schedId, sched] of Object.entries(schedules)) {
    if (schedId === "byBatchId") continue;
    if (sched?.deliveryId !== deliveryId) continue;
    const arr = Array.isArray(sched.items) ? sched.items : [];
    for (const it of arr) {
      const video = videos[it?.videoIdx];
      items.push(redactScheduleItem(it, video));
    }
  }
  items.sort((a, b) => {
    const at = a.postAt ? Date.parse(a.postAt) : Infinity;
    const bt = b.postAt ? Date.parse(b.postAt) : Infinity;
    return at - bt;
  });

  return res.status(200).json({ items });
}
