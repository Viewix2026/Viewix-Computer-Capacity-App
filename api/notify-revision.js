// api/notify-revision.js
// Receives batched revision status changes from client delivery page
// Posts a single message to #revisions Slack channel
// + auto-creates a "Revision Round N" subtask on the linked project
//   for any video whose final settled state (after the 2-min client-
//   side debounce) is "Needs Revisions". Idempotent per videoId+round.

import { adminGet, adminSet } from "./_fb-admin.js";

// Escape Slack mrkdwn special characters in client-supplied strings
// so a video name containing `*hello*` doesn't bold-format the
// surrounding line, and `<script>` doesn't get rendered as a link.
// Reference: https://api.slack.com/reference/surfaces/formatting#escaping
function escapeSlack(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Defang mrkdwn formatting characters by inserting a zero-width
    // space — preserves readability of the original text while
    // breaking the parser's ability to interpret them as syntax.
    .replace(/([*_`~|])/g, "​$1");
}

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
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

function clamp(s, max) {
  return String(s == null ? "" : s).slice(0, max);
}

// Auto-create a "Revision Round N" subtask on the project linked to
// this delivery, for every video whose settled state is "Needs
// Revisions". Idempotent per videoId+round so retries / overlapping
// debounce flushes won't pile up duplicates.
//
// Best-effort: any failure is logged and swallowed by the caller —
// the Slack notification is the primary user-facing signal and must
// not be blocked by a Firebase hiccup.
async function maybeCreateRevisionSubtasks(deliveryId, changes) {
  if (!deliveryId || !Array.isArray(changes) || changes.length === 0) return;
  const delivery = await adminGet(`/deliveries/${deliveryId}`);
  if (!delivery || !Array.isArray(delivery.videos)) return;

  // Reverse-lookup the project that points at this delivery. Realtime
  // Database has no native query-by-child for our path layout, so we
  // pull the projects collection and scan. Fine at Viewix's scale (tens
  // of projects, not thousands).
  const projectsObj = (await adminGet("/projects")) || {};
  const project = Object.values(projectsObj).find(p =>
    p && p.id && (p.links || {}).deliveryId === deliveryId
  );
  if (!project) return;
  const subtasks = Object.values(project.subtasks || {}).filter(Boolean);

  // Reduce the change batch to a unique set of (videoId, round) pairs
  // the client actually touched in this session. The delivery's stored
  // value is the source of truth for "settled" state because every
  // click already wrote-through before this endpoint was called.
  const touched = new Set();
  for (const c of changes) {
    if (c.field !== "revision1" && c.field !== "revision2") continue;
    const v = delivery.videos.find(vv => vv && vv.name === c.videoName);
    if (!v || !v.videoId) continue; // pre-migration record — skip; backfill will catch up
    touched.add(`${v.videoId}|${c.field === "revision1" ? 1 : 2}`);
  }
  if (touched.size === 0) return;

  const baseOrder = subtasks.length > 0
    ? Math.max(...subtasks.map(s => s.order ?? 0)) + 1
    : 0;
  let i = 0;

  for (const key of touched) {
    const [videoId, roundStr] = key.split("|");
    const round = Number(roundStr);
    const video = delivery.videos.find(v => v && v.videoId === videoId);
    if (!video) continue;
    const field = round === 1 ? "revision1" : "revision2";
    // Final-state check: the client may have flickered Needs ->
    // Approved within the 2-min window. Only create the subtask if
    // the settled value really is "Needs Revisions".
    if (video[field] !== "Needs Revisions") continue;
    // Idempotency: one subtask per (videoId, round). New round on the
    // same video is allowed (separate subtask) — this guards against
    // dupes from retried debounce flushes for the same round.
    const existing = subtasks.find(st =>
      st.source === "revision" &&
      st.videoId === videoId &&
      Number(st.revisionRound) === round
    );
    if (existing) continue;

    const stId = `st-rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const subtask = {
      id: stId,
      videoId,
      // "<video name> — Revision Round N" so the producer scanning the
      // subtasks list sees which video and which round at a glance.
      name: `${video.name || "Video"} — Revision Round ${round}`,
      // Stage = revisions; assigneeIds=[] makes it land on the Team
      // Board's Unassigned lane until the producer drags it onto a crew
      // member's track. Status starts "notStarted" so it joins the
      // active pipeline rather than auto-filtering out as Done.
      status: "notStarted",
      stage: "revisions",
      startDate: null, endDate: null, startTime: null, endTime: null,
      assigneeIds: [],
      assigneeId: null,
      source: "revision",
      revisionRound: round,
      order: baseOrder + i,
      createdAt: now, updatedAt: now,
    };
    await adminSet(`/projects/${project.id}/subtasks/${stId}`, subtask);
    subtasks.push(subtask); // local list grows so subsequent idempotency checks see this batch
    i++;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!checkRate(clientIp(req))) return res.status(429).json({ error: "Too many notifications" });

  try {
    const { clientName, deliveryId, changes } = req.body || {};
    const webhookUrl = process.env.SLACK_REVISIONS_WEBHOOK_URL;

    if (!webhookUrl) return res.status(500).json({ error: "SLACK_REVISIONS_WEBHOOK_URL not configured" });
    if (!changes || !Array.isArray(changes) || changes.length === 0) return res.status(400).json({ error: "No changes provided" });
    if (changes.length > 50) return res.status(400).json({ error: "Too many changes in one notification" });

    const lines = changes.map(c => {
      const name = escapeSlack(clamp(c.videoName || "Video", 120));
      const oldV = escapeSlack(clamp(c.oldValue || "Not Started", 120));
      const newV = escapeSlack(clamp(c.newValue, 120));
      return `• *${name}* — ${c.field === "revision1" ? "Round 1" : "Round 2"}: ${oldV} → ${newV}`;
    });

    const message = `:pencil2: *Revision update from ${escapeSlack(clamp(clientName || "a client", 120))}*\n${lines.join("\n")}`;

    const slackResp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });

    if (!slackResp.ok) {
      const errText = await slackResp.text();
      return res.status(500).json({ error: "Slack webhook failed", detail: errText });
    }

    // Best-effort auto-subtask creation on the linked project. Errors
    // are logged but don't surface to the client — Slack already fired,
    // and the producer can manually add a revision subtask if the
    // automation glitches.
    try {
      await maybeCreateRevisionSubtasks(deliveryId, changes);
    } catch (e) {
      console.error("Revision subtask auto-create failed:", e);
    }

    return res.status(200).json({ success: true, notified: changes.length });
  } catch (e) {
    console.error("Revision notification error:", e);
    return res.status(500).json({ error: e.message });
  }
}
