// Slack pings — best-effort, never throws. The worker is a background
// service; if Slack is down or misconfigured we still want the
// transfer pipeline to keep moving. Log the failure to stderr and
// carry on.

const WEBHOOK = process.env.SLACK_VIDEO_DELIVERIES_WEBHOOK_URL || "";

export async function slack(text) {
  if (!WEBHOOK) {
    console.warn("slack: SLACK_VIDEO_DELIVERIES_WEBHOOK_URL not set — skipping ping:", text);
    return;
  }
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("slack ping failed:", e.message);
  }
}
