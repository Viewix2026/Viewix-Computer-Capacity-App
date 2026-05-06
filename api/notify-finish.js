// api/notify-finish.js
// Slack notifications fired by the Editor's Finish modal.
//
//   reviewType: "internal"  -> SLACK_PROJECT_LEADS_WEBHOOK_URL
//                              "<projectName>: <videoName> ready for
//                               internal review · cc <projectLead>
//                               · <link>"
//   reviewType: "client"    -> SLACK_VIDEO_DELIVERIES_WEBHOOK_URL
//                              "<projectName>: <videoName> is ready
//                               for client review · added to
//                               Deliveries · <link>"
//
// Best-effort: any failure logs and returns 200 with `slackPosted:
// false` so the editor's Finish flow doesn't fail when Slack hiccups.
// The Frame.io link save + delivery propagation already happened
// client-side before this endpoint is called.
//
// Auth: anyone signed in (founder / lead / editor). The endpoint
// only forwards a small composed message — no Firebase writes — so
// the blast radius if abused is "spam our own Slack channels". Rate
// limited per-IP for the same reason as notify-revision.js.

import { adminGet } from "./_fb-admin.js";

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!checkRate(clientIp(req))) return res.status(429).json({ error: "Too many notifications" });

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

    if (reviewType !== "internal" && reviewType !== "client") {
      return res.status(400).json({ error: "reviewType must be 'internal' or 'client'" });
    }
    if (!frameioLink) {
      return res.status(400).json({ error: "frameioLink required" });
    }

    // Pick the right webhook for the review type. Each channel is
    // scoped to its own audience — internal reviews go to the
    // project leads, client reviews go to the broader deliveries
    // channel where the producer team coordinates external sends.
    const webhookUrl = reviewType === "internal"
      ? process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL
      : process.env.SLACK_VIDEO_DELIVERIES_WEBHOOK_URL;
    if (!webhookUrl) {
      const which = reviewType === "internal"
        ? "SLACK_PROJECT_LEADS_WEBHOOK_URL"
        : "SLACK_VIDEO_DELIVERIES_WEBHOOK_URL";
      console.warn(`notify-finish: ${which} not configured — skipping`);
      return res.status(200).json({ ok: true, slackPosted: false, reason: `${which} not set` });
    }

    // Header line includes "Client: Project" so the producer scanning
    // Slack sees the parent record at a glance. Falls back to just
    // projectName when there's no client (Viewix-internal projects).
    const header = clientName
      ? `*${escapeSlack(clientName)}: ${escapeSlack(projectName)}*`
      : `*${escapeSlack(projectName)}*`;
    const safeVideo = escapeSlack(videoName);
    const safeEditor = escapeSlack(editorName);
    const safeLead    = escapeSlack(projectLead);
    const safeManager = escapeSlack(accountManager);
    const safeLink    = escapeSlack(frameioLink);

    // Resolve project lead AND account manager to Slack <@USERID>
    // mentions via the /editors roster. Both fall back to bold
    // plaintext when no Slack ID is on file (or lookup fails) so
    // a missing entry never blocks the message. Internal-review
    // pings cc the lead in the headline; client-review pings cc
    // BOTH the account manager and the lead so the producer-side
    // owner gets the same client-eyes signal as the lead.
    const [leadSlackId, managerSlackId] = await Promise.all([
      lookupSlackId(projectLead),
      lookupSlackId(accountManager),
    ]);
    const leadMention    = leadSlackId    ? `<@${leadSlackId}>`    : (safeLead    ? `*${safeLead}*`    : "");
    const managerMention = managerSlackId ? `<@${managerSlackId}>` : (safeManager ? `*${safeManager}*` : "");

    // "cc" line: just whichever of the two have proper Slack IDs.
    // Plaintext fallbacks aren't useful in cc (no notification), so
    // we omit them from the headline but still list them in the body.
    const ccPings = [leadSlackId && leadMention, managerSlackId && managerMention].filter(Boolean).join(" ");
    const ccLine  = ccPings ? ` — cc ${ccPings}` : "";

    const text = reviewType === "internal"
      ? `:eyes: *Ready for internal review*${ccLine}\n${header}\n• Video: *${safeVideo}*\n• Editor: ${safeEditor}\n${projectLead ? `• Project lead: ${leadMention}\n` : ""}${accountManager ? `• Account manager: ${managerMention}\n` : ""}• Frame.io: ${safeLink}`
      : `:white_check_mark: *Ready for client review*${ccLine}\n${header}\n• Video: *${safeVideo}*\n• Editor: ${safeEditor}\n${projectLead ? `• Project lead: ${leadMention}\n` : ""}${accountManager ? `• Account manager: ${managerMention}\n` : ""}• Frame.io: ${safeLink}\n_Link added to the Deliveries tab and pushed to the client's delivery page._`;

    const slackResp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!slackResp.ok) {
      const detail = await slackResp.text();
      console.error("notify-finish Slack error:", slackResp.status, detail);
      // 200 to caller — don't fail the editor's Finish flow on a Slack hiccup.
      return res.status(200).json({ ok: true, slackPosted: false, reason: `Slack ${slackResp.status}` });
    }

    return res.status(200).json({ ok: true, slackPosted: true, reviewType });
  } catch (e) {
    console.error("notify-finish error:", e);
    return res.status(200).json({ ok: true, slackPosted: false, reason: e.message });
  }
}
