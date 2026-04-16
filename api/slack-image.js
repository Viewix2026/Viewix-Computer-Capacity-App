// api/slack-image.js
// Tiny proxy that streams Slack file images through to the browser using the
// bot token, so the dashboard can render images without exposing the token.
// Usage: <img src="/api/slack-image?url=https://files.slack.com/..." />

export default async function handler(req, res) {
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_TOKEN) {
    return res.status(500).json({ error: "SLACK_BOT_TOKEN not configured" });
  }

  const url = req.query.url;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url query param" });
  }

  // Allow only Slack-hosted file URLs
  if (!/^https:\/\/(files\.slack\.com|\w+\.slack-edge\.com)\//.test(url)) {
    return res.status(400).json({ error: "Only Slack file URLs are allowed" });
  }

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Slack returned ${resp.status}` });
    }
    const contentType = resp.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("slack-image proxy error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
