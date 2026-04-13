// api/notify-revision.js
// Receives batched revision status changes from client delivery page
// Posts a single message to #revisions Slack channel

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { clientName, deliveryId, changes } = req.body || {};
    const webhookUrl = process.env.SLACK_REVISIONS_WEBHOOK_URL;

    if (!webhookUrl) return res.status(500).json({ error: "SLACK_REVISIONS_WEBHOOK_URL not configured" });
    if (!changes || !Array.isArray(changes) || changes.length === 0) return res.status(400).json({ error: "No changes provided" });

    const lines = changes.map(c => {
      return `• *${c.videoName || "Video"}* — ${c.field === "revision1" ? "Round 1" : "Round 2"}: ${c.oldValue || "Not Started"} → ${c.newValue}`;
    });

    const message = `:pencil2: *Revision update from ${clientName || "a client"}*\n${lines.join("\n")}`;

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
