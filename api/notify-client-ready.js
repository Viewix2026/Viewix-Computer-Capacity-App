// api/notify-client-ready.js
//
// Phase 4 (#D) — single project-level "ready for client review" Slack ping.
// Replaces the per-video deliveries-channel pings (which still fire while
// PER_VIDEO_PINGS_ENABLED is on). Tags only the Account Manager so the
// project-lead channel isn't double-pinged.
//
// Fires from two call sites:
//   1. The "Approve" outcome on an Internal Review subtask (Phase 4c).
//      api/slack-interactivity.js imports fireClientReady() and calls it
//      directly so we don't take an HTTP round-trip from inside the
//      interactivity handler.
//   2. (Future) The Deliveries-tab path where the last video flips to
//      Ready for Review. Use the same fireClientReady() entry point.
//
// Idempotency: stamps /projects/{id}/notifications/clientReady with an
// ISO timestamp. Re-calls bail with skipped:"already_sent".
//
// Client emails: this endpoint NEVER sends a client-facing email. The
// producer-controlled batch (api/send-review-batch.js) is the only path
// that emails clients. This is internal-only Slack.

import { adminGet, adminPatch } from "./_fb-admin.js";
import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";

const ALLOWED_ROLES = ["founders", "manager", "lead", "editor"];

const lc = (s) => (s == null ? "" : String(s)).trim().toLowerCase();

function findAccountForProject(accounts, project) {
  const list = Array.isArray(accounts) ? accounts : Object.values(accounts || {});
  if (!Array.isArray(list) || list.length === 0) return null;
  const linkId = (project?.links || {}).accountId;
  if (linkId) {
    const byId = list.find(a => a && a.id === linkId);
    if (byId) return byId;
  }
  const clientName = lc(project?.clientName);
  if (!clientName) return null;
  return list.find(a => a && lc(a.clientName) === clientName) || null;
}

function findAMEditor(editors, account) {
  const target = lc(account?.accountManager);
  if (!target) return null;
  const list = Array.isArray(editors) ? editors : Object.values(editors || {});
  return list.find(ed => lc(ed?.name) === target) || null;
}

async function postWebhook(text) {
  const url = process.env.SLACK_VIDEO_DELIVERIES_WEBHOOK_URL;
  if (!url) return { ok: false, reason: "not_configured" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("notify-client-ready slack error:", r.status, detail);
      return { ok: false, reason: `Slack ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("notify-client-ready fetch error:", e.message);
    return { ok: false, reason: e.message };
  }
}

// Gate variant — fires the project-level client-ready alert only if
// the linked delivery is fully marked Ready for Review / Completed.
// Used by the editor Finish reviewType=client path so the AM ping
// lands when the LAST video flips, not on every per-video finish.
// `justSetVideoId` is overlaid as "Ready for Review" in the check —
// avoids the brief race window where the editor's delivery write may
// not yet be visible to a fresh admin read.
export async function fireClientReadyIfAllVideosReady({ projectId, justSetVideoId }) {
  if (!projectId) return { ok: false, error: "projectId required" };
  const project = await adminGet(`/projects/${projectId}`);
  if (!project) return { ok: false, error: "project_not_found" };
  if (project.notifications && project.notifications.clientReady) {
    return { ok: true, skipped: "already_sent" };
  }
  const deliveryId = (project.links || {}).deliveryId;
  if (!deliveryId) return { ok: true, skipped: "no_delivery_link" };
  const delivery = await adminGet(`/deliveries/${deliveryId}`);
  const vids = Array.isArray(delivery?.videos) ? delivery.videos : [];
  if (vids.length === 0) return { ok: true, skipped: "no_delivery_videos" };
  const allReady = vids.every(v => {
    if (!v) return false;
    if (justSetVideoId && v.videoId === justSetVideoId) return true;
    const s = (v.viewixStatus || "").trim();
    return s === "Ready for Review" || s === "Completed";
  });
  if (!allReady) return { ok: true, skipped: "not_all_ready" };
  return await fireClientReady({ projectId });
}

// Internal entrypoint used by api/slack-interactivity.js (Approve outcome).
// Re-checks idempotency + resolves the AM each call so it's safe to invoke
// from any path. Returns { ok, skipped|sent, slack:{ok, reason} }.
export async function fireClientReady({ projectId }) {
  if (!projectId) return { ok: false, error: "projectId required" };
  const project = await adminGet(`/projects/${projectId}`);
  if (!project) return { ok: false, error: "project_not_found" };

  if (project.notifications && project.notifications.clientReady) {
    return { ok: true, skipped: "already_sent", at: project.notifications.clientReady };
  }

  const [accountsRaw, editorsRaw] = await Promise.all([
    adminGet("/accounts"),
    adminGet("/editors"),
  ]);
  const account = findAccountForProject(accountsRaw, project);
  const amEditor = account ? findAMEditor(editorsRaw, account) : null;
  const amMention = amEditor?.slackUserId
    ? `<@${amEditor.slackUserId}>`
    : (amEditor?.name ? `*${amEditor.name}*` : (account?.accountManager ? `*${account.accountManager}*` : "*Account Manager*"));

  const header = project.clientName
    ? `*${project.clientName}: ${project.projectName || "Untitled project"}*`
    : `*${project.projectName || "Untitled project"}*`;
  const text = [
    ":white_check_mark: *Ready for client review*",
    header,
    `${amMention} — internal review passed. The videos are linked in the Deliveries tab and ready for the client send-out.`,
  ].join("\n");

  const slack = await postWebhook(text);

  // Stamp idempotency AFTER the post — if the post failed, leave the
  // key unset so a retry (manual or otherwise) can land the message.
  if (slack.ok) {
    try {
      await adminPatch(`/projects/${projectId}/notifications`, { clientReady: new Date().toISOString() });
    } catch (e) {
      console.warn("notify-client-ready: idempotency stamp failed:", e.message);
    }
  }
  return { ok: true, sent: !!slack.ok, slack };
}

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  let body;
  try {
    body = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  const projectId = (body.projectId || "").toString().trim();
  if (!projectId) return res.status(400).json({ ok: false, error: "projectId required" });

  const result = await fireClientReady({ projectId });
  return res.status(200).json(result);
}
