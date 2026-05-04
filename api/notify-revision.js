// api/notify-revision.js
// Receives batched revision status changes from client delivery page
// Posts a single message to #revisions Slack channel

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

    return res.status(200).json({ success: true, notified: changes.length });
  } catch (e) {
    console.error("Revision notification error:", e);
    return res.status(500).json({ error: e.message });
  }
}
