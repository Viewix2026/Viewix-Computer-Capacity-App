// api/notify-finish.js
// Slack notifications fired by the Editor's Finish modal.
//
// Note (Phase A redesign, 2026-05-10): an earlier draft of this
// endpoint also fired a Ready-For-Review client email automatically
// when reviewType === "client". That auto-fire path has been
// removed — client review emails are now producer/AM-driven via a
// batch flow (see api/send-review-batch.js, planned Phase A.5).
// Editors still click "Finish" with reviewType=client to mark a
// video as Ready for Review in the Deliveries tab, but no client
// email leaves until a producer/AM explicitly batches and sends.
//
// Auth (Phase A): requires a Firebase ID token bearer in the
// Authorization header for the user's role to be one of founders /
// founder / lead / editor. Even though this is now Slack-only
// again, the auth gate stays — the endpoint is still callable from
// the dashboard and rate-limited Slack spam isn't a great default.
//
//   reviewType: "internal"  -> SLACK_PROJECT_LEADS_WEBHOOK_URL
//                              "<projectName>: <videoName> ready for
//                               internal review · cc <projectLead>
//                               · <link>"
//   reviewType: "client"    -> SLACK_VIDEO_DELIVERIES_WEBHOOK_URL
//                              "<projectName>: <videoName> is ready
//                               for client review · added to
//                               Deliveries · <link>"
//                              AND the matching delivery video's
//                              viewixStatus is set to "Ready for Review"
//                              so the producer's Deliveries-tab
//                              "Share with client" modal can pre-check it.
//
// **Slack-only. This endpoint does NOT send any client-facing email.**
// (Locked architecture 2026-05-12.) The ReadyForReview email goes out
// only when a producer clicks Send in the Deliveries modal, which
// POSTs to api/send-review-batch.js. Earlier drafts of this file
// triggered a client email from here; that was reverted because
// editors must never be the gatekeeper for client comms — too
// granular, no human review before client sees anything.
//
// Returns 200 with the Slack post status so the editor's Finish flow
// doesn't fail on a transient hiccup.
//
// Auth: anyone signed in (founder / lead / editor). The endpoint
// only forwards a small composed message + a templated email to a
// known client address — no Firebase writes outside /emailLog — so
// the blast radius if abused is "spam our own Slack channels and
// one client's inbox". Rate limited per-IP for the same reason as
// notify-revision.js.

import { adminGet } from "./_fb-admin.js";
import { requireRole, sendAuthError } from "./_requireAuth.js";
// Note: send/buildDeliveryUrl no longer imported — this endpoint
// became Slack-only again after the ReadyForReview redesign. The
// batch-send flow lives in api/send-review-batch.js (planned).

// Roles that may fire a Finish notification. `editor` covers the
// primary caller (editor flagging their own video done). `lead`
// and the two `founder*` roles cover producers / Steve / Jeremy
// triaging in the Editor Dashboard on someone else's behalf.
const ALLOWED_ROLES = ["founders", "founder", "lead", "editor"];

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30; // editors finish many tasks a day; revisions had 10
const attempts = new Map();

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRate(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  attempts.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

// Slack mrkdwn escape — same approach as notify-revision.js. Keeps
// client-supplied strings (project / video / editor names) from
// triggering bold / italic / link parsing in the channel message.
function escapeSlack(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([*_`~|])/g, "​$1");
}

function clamp(s, max) {
  return String(s == null ? "" : s).slice(0, max);
}

// Resolve a roster name to a Slack member ID via /editors. Producers
// paste the Slack ID into the Team Roster's "Slack ID" column once
// per editor; this read is the only place we use it. Any name with
// no roster match — or no slackUserId set on the matched record —
// falls back to plain bold text in the message. Failures
// (firebase-admin not configured, network hiccup) also fall back
// to plain text rather than blocking the notification.
async function lookupSlackId(name) {
  if (!name) return null;
  try {
    const editors = await adminGet("/editors");
    if (!Array.isArray(editors)) return null;
    const lc = name.trim().toLowerCase();
    const match = editors.find(e => e && (e.name || "").trim().toLowerCase() === lc);
    return match?.slackUserId || null;
  } catch (e) {
    console.warn("notify-finish: editor lookup failed:", e.message);
    return null;
  }
}

// Build the Slack message body for the chosen review type. Returns
// the text plus the resolved cc Slack IDs (used for the lead/manager
// mention list). Pure helper — does not post.
async function buildSlackText({ reviewType, projectName, clientName, videoName, editorName, projectLead, accountManager, frameioLink }) {
  const header = clientName
    ? `*${escapeSlack(clientName)}: ${escapeSlack(projectName)}*`
    : `*${escapeSlack(projectName)}*`;
  const safeVideo = escapeSlack(videoName);
  const safeEditor = escapeSlack(editorName);
  const safeLead    = escapeSlack(projectLead);
  const safeManager = escapeSlack(accountManager);
  const safeLink    = escapeSlack(frameioLink);

  const [leadSlackId, managerSlackId] = await Promise.all([
    lookupSlackId(projectLead),
    lookupSlackId(accountManager),
  ]);
  const leadMention    = leadSlackId    ? `<@${leadSlackId}>`    : (safeLead    ? `*${safeLead}*`    : "");
  const managerMention = managerSlackId ? `<@${managerSlackId}>` : (safeManager ? `*${safeManager}*` : "");
  const ccPings = [leadSlackId && leadMention, managerSlackId && managerMention].filter(Boolean).join(" ");
  const ccLine  = ccPings ? ` — cc ${ccPings}` : "";

  const text = reviewType === "internal"
    ? `:eyes: *Ready for internal review*${ccLine}\n${header}\n• Video: *${safeVideo}*\n• Editor: ${safeEditor}\n${projectLead ? `• Project lead: ${leadMention}\n` : ""}${accountManager ? `• Account manager: ${managerMention}\n` : ""}• Frame.io: ${safeLink}`
    : `:white_check_mark: *Ready for client review*${ccLine}\n${header}\n• Video: *${safeVideo}*\n• Editor: ${safeEditor}\n${projectLead ? `• Project lead: ${leadMention}\n` : ""}${accountManager ? `• Account manager: ${managerMention}\n` : ""}• Frame.io: ${safeLink}\n_Link added to the Deliveries tab and pushed to the client's delivery page._`;

  return text;
}

// Post a built message to a Slack webhook. Returns { ok, reason }.
// Treats missing webhook URL as ok=false / reason="not_configured"
// so the caller can record per-channel status without aborting.
async function postSlack(webhookUrl, text) {
  if (!webhookUrl) return { ok: false, reason: "not_configured" };
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("notify-finish Slack error:", r.status, detail);
      return { ok: false, reason: `Slack ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("notify-finish Slack fetch error:", e.message);
    return { ok: false, reason: e.message };
  }
}

// (Removed in Phase A redesign: resolveDelivery() helper. The
// Ready-For-Review email no longer auto-fires from here. The same
// helper has been moved to api/send-review-batch.js where the
// producer-driven batch flow needs it.)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!checkRate(clientIp(req))) return res.status(429).json({ error: "Too many notifications" });

  // Auth gate (Phase A). Verifies a Firebase ID token signed by
  // viewix-* and confirms the role is one we trust to fire client
  // emails. Failures return the standard 401/403 from
  // _requireAuth.js — the editor dashboard catches the fetch
  // rejection and surfaces a console warn (same as before).
  try {
    await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  try {
    const body = req.body || {};
    const reviewType = body.reviewType;
    const projectName = clamp(body.projectName || "Untitled project", 200);
    const clientName  = clamp(body.clientName  || "", 120);
    const videoName   = clamp(body.videoName   || "Video", 200);
    const editorName  = clamp(body.editorName  || "Editor", 100);
    const projectLead    = clamp(body.projectLead    || "", 100);
    const accountManager = clamp(body.accountManager || "", 100);
    const frameioLink    = clamp(body.frameioLink    || "", 500);
    // New (Phase A) — let the email send know which records to use.
    // Optional; the Slack-only branch still works without them.
    const projectId  = clamp(body.projectId  || "", 64);
    const subtaskId  = clamp(body.subtaskId  || "", 64);
    const videoId    = clamp(body.videoId    || "", 64);
    const payloadDeliveryId = clamp(body.deliveryId || "", 64);

    if (reviewType !== "internal" && reviewType !== "client") {
      return res.status(400).json({ error: "reviewType must be 'internal' or 'client'" });
    }
    if (!frameioLink) {
      return res.status(400).json({ error: "frameioLink required" });
    }

    // Build the Slack message ONCE (same payload regardless of post
    // outcome). Resolves the cc Slack IDs along the way.
    const slackText = await buildSlackText({
      reviewType, projectName, clientName, videoName, editorName,
      projectLead, accountManager, frameioLink,
    });
    const slackWebhook = reviewType === "internal"
      ? process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL
      : process.env.SLACK_VIDEO_DELIVERIES_WEBHOOK_URL;

    // Slack-only path (Phase A redesign — see file header). The
    // ReadyForReview email used to fire here for reviewType=client;
    // it now waits for a producer/AM to explicitly batch and send
    // via api/send-review-batch.js. Editor's Finish flow is back to
    // its original Slack-notification-only behaviour.
    const slack = await postSlack(slackWebhook, slackText);

    // Tip: payload fields projectId/subtaskId/videoId/deliveryId are
    // accepted (and validated/clamped above) for forward compatibility
    // — the dashboard already sends them, and a future enhancement may
    // want them on the Slack post. We don't act on them today.
    void projectId; void subtaskId; void videoId; void payloadDeliveryId;

    return res.status(200).json({
      ok: true,
      reviewType,
      slack: { ok: !!slack.ok, reason: slack.reason || (slack.ok ? "sent" : "unknown") },
      email: null, // intentionally inert in this endpoint after the redesign
    });
  } catch (e) {
    console.error("notify-finish error:", e);
    return res.status(200).json({ ok: true, slackPosted: false, reason: e.message });
  }
}
