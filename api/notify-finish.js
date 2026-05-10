// api/notify-finish.js
// Slack notifications fired by the Editor's Finish modal, plus —
// for client-review finishes — a Ready-For-Review client email.
//
// Auth (added Phase A): requires a Firebase ID token bearer in the
// Authorization header for the user's role to be one of founders /
// founder / lead / editor. The pre-Phase-A endpoint was rate-limited
// by IP but otherwise unauthenticated. That was tolerable when this
// endpoint only sent Slack messages — the worst-case abuse was
// internal channel spam. Now that it also fires client emails, an
// unauthenticated POST could be weaponised to spam clients with
// fake Ready-For-Review notes. Auth + role check closes that.
//
//   reviewType: "internal"  -> SLACK_PROJECT_LEADS_WEBHOOK_URL
//                              "<projectName>: <videoName> ready for
//                               internal review · cc <projectLead>
//                               · <link>"
//   reviewType: "client"    -> SLACK_VIDEO_DELIVERIES_WEBHOOK_URL
//                              "<projectName>: <videoName> is ready
//                               for client review · added to
//                               Deliveries · <link>"
//                            + Ready-For-Review email to the client
//                              via api/_email/send.js
//
// Slack and email are independent: a missing SLACK_*_WEBHOOK_URL
// skips Slack but still sends the email; an email failure never
// blocks the Slack post; both run concurrently via Promise.allSettled.
// The endpoint always returns 200 with per-channel status so the
// editor's Finish flow doesn't fail on a transient hiccup.
//
// Auth: anyone signed in (founder / lead / editor). The endpoint
// only forwards a small composed message + a templated email to a
// known client address — no Firebase writes outside /emailLog — so
// the blast radius if abused is "spam our own Slack channels and
// one client's inbox". Rate limited per-IP for the same reason as
// notify-revision.js.

import { adminGet } from "./_fb-admin.js";
import { requireRole, sendAuthError } from "./_requireAuth.js";
import { send as sendEmail } from "./_email/send.js";
import { buildDeliveryUrl } from "./_email/deliveryUrl.js";

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

// Resolve the delivery record for the Ready-For-Review email.
// Prefer the deliveryId on the request payload (caller knows which
// video maps to which delivery in multi-delivery projects); fall
// back to project.links.deliveryId; bail (return null) if both
// missing. Returns the full delivery record so the email payload
// has shortId + clientName + projectName for URL construction.
async function resolveDelivery({ payloadDeliveryId, project }) {
  const id = payloadDeliveryId || project?.links?.deliveryId || null;
  if (!id) return null;
  try {
    const d = await adminGet(`/deliveries/${id}`);
    return d || null;
  } catch (e) {
    console.warn("notify-finish: delivery lookup failed:", e.message);
    return null;
  }
}

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

    // Run Slack + (for client reviews) email concurrently. Both
    // settle independently. Internal-review finishes have no email
    // step at all, only Slack.
    const slackTask = postSlack(slackWebhook, slackText);

    let emailTask = null;
    if (reviewType === "client") {
      // Build the email task lazily so we only do the Firebase reads
      // when needed. If the project / delivery cannot be resolved,
      // the task resolves to a "skipped" record — Slack still goes
      // out independently.
      emailTask = (async () => {
        if (!projectId) {
          console.warn("notify-finish: client reviewType missing projectId — email skipped");
          return { ok: false, reason: "no_projectId" };
        }
        const project = await adminGet(`/projects/${projectId}`).catch(() => null);
        if (!project) return { ok: false, reason: "project_not_found" };
        const clientEmail = (project.clientContact?.email || "").trim();
        if (!clientEmail) return { ok: false, reason: "no_client_email" };

        const delivery = await resolveDelivery({ payloadDeliveryId, project });
        if (!delivery) {
          return { ok: false, reason: "no_delivery_record" };
        }

        // Use the canonical helper rather than hard-checking
        // delivery.shortId here. `buildDeliveryUrl()` already falls
        // back to the legacy `?d={id}` form when shortId is missing,
        // and returns null only when PUBLIC_BASE_URL is unset or
        // both shortId and id are missing. That keeps older delivery
        // records (pre-shortId era) from silently breaking the
        // Ready-For-Review email.
        const deliveryUrl = buildDeliveryUrl({
          ...delivery,
          // Fill in client/project name so the slug builder produces
          // a friendly URL even if the delivery record itself only
          // stored an id.
          clientName: delivery.clientName || project.clientName || "",
          projectName: delivery.projectName || project.projectName || "",
        });
        if (!deliveryUrl) {
          // Missing PUBLIC_BASE_URL or unrenderable record. Skip the
          // email rather than send a broken link.
          return { ok: false, reason: "no_delivery_url" };
        }

        // Idempotency key: prefer videoId so per-video review emails
        // don't collapse into one project-level send when the same
        // project produces multiple videos. Fall back to subtaskId
        // (the legacy frame in the editor dashboard) and finally to
        // the project itself as a last resort.
        const keySegment = videoId || subtaskId || "project";
        const idempotencyKey = `${projectId}/ReadyForReview/${keySegment}`;

        const result = await sendEmail({
          template: "ReadyForReview",
          idempotencyKey,
          to: clientEmail,
          subject: "Your video is ready to watch",
          props: {
            client: {
              firstName: (project.clientContact?.firstName || "").trim() || "there",
              email: clientEmail,
            },
            project: {
              id: projectId,
              projectName: project.projectName || "your project",
            },
            delivery: {
              shortId: delivery.shortId || null,
              id: delivery.id || null,
              url: deliveryUrl,
            },
            videoName,
          },
          projectId,
        });
        return { ok: result.state === "sent", reason: result.reason || result.state };
      })();
    }

    const [slackResult, emailResult] = await Promise.allSettled([
      slackTask,
      emailTask || Promise.resolve(null),
    ]);

    // Normalise into a single response shape. Always returns 200;
    // a failure in one channel must not poison the editor's Finish
    // flow on the dashboard.
    const slack = slackResult.status === "fulfilled"
      ? slackResult.value
      : { ok: false, reason: slackResult.reason?.message || "rejected" };
    const email = emailResult.status === "fulfilled"
      ? emailResult.value
      : { ok: false, reason: emailResult.reason?.message || "rejected" };

    return res.status(200).json({
      ok: true,
      reviewType,
      slack: slack ? { ok: !!slack.ok, reason: slack.reason || (slack.ok ? "sent" : "unknown") } : null,
      email: email ? { ok: !!email.ok, reason: email.reason || (email.ok ? "sent" : "unknown") } : null,
    });
  } catch (e) {
    console.error("notify-finish error:", e);
    return res.status(200).json({ ok: true, slackPosted: false, reason: e.message });
  }
}
