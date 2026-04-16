// api/sync-weekly-wins.js
// Vercel Cron: pulls the latest 3 :fire:-reacted messages from a Slack channel
// and stores them in Firebase under /foundersData/weeklyWinPool.
// Runs once a day. The home page rotates through the pool on each visit.
//
// Env vars required:
//   SLACK_BOT_TOKEN — xoxb-... bot token with channels:history + reactions:read
//                     (must also be invited to the channel)

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const WIN_CHANNEL_ID = "C08HAC28DJL";
const TARGET_REACTION = "fire";
const POOL_SIZE = 3;

// Look back 30 days for fire-reacted messages
const LOOKBACK_DAYS = 30;

async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

// Resolve a user ID to a display name via Slack users.info
async function resolveUserName(userId, token, cache) {
  if (!userId) return "";
  if (cache[userId]) return cache[userId];
  try {
    const r = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (data.ok) {
      const name = data.user?.profile?.display_name || data.user?.profile?.real_name || data.user?.name || "";
      cache[userId] = name;
      return name;
    }
  } catch {}
  cache[userId] = "";
  return "";
}

// Strip Slack formatting: <@U123|name> → @name, <#C123|chan> → #chan, <url|text> → text
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[UW][A-Z0-9]+>/g, "@user")
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<#C[A-Z0-9]+>/g, "#channel")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export default async function handler(req, res) {
  try {
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    if (!SLACK_TOKEN) {
      return res.status(500).json({ error: "SLACK_BOT_TOKEN not configured" });
    }

    // Fetch recent messages from the channel
    const oldest = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 60 * 60;
    const histResp = await fetch(
      `https://slack.com/api/conversations.history?channel=${WIN_CHANNEL_ID}&oldest=${oldest}&limit=200`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const histData = await histResp.json();

    if (!histData.ok) {
      const slackError = histData.error || "unknown";
      const hints = {
        not_in_channel: `The bot isn't a member of channel ${WIN_CHANNEL_ID}. In Slack, open the channel and run /invite @YourBotName.`,
        channel_not_found: `Channel ${WIN_CHANNEL_ID} not found. Check the channel ID, and if it's a private channel the bot needs the groups:history scope (and to be invited).`,
        missing_scope: `Bot token is missing a required scope. Needs: channels:history (public) or groups:history (private), reactions:read, users:read.`,
        invalid_auth: `SLACK_BOT_TOKEN is invalid or expired. Re-copy from Slack OAuth & Permissions and update the Vercel env var.`,
        token_revoked: `SLACK_BOT_TOKEN has been revoked. Reinstall the Slack app and update the env var.`,
        not_authed: `SLACK_BOT_TOKEN env var is empty or malformed.`,
      };
      return res.status(500).json({
        error: "Slack API error",
        detail: slackError + (hints[slackError] ? ` — ${hints[slackError]}` : ""),
      });
    }

    // Filter to messages with the target reaction
    const fireMessages = (histData.messages || [])
      .filter(m => Array.isArray(m.reactions) && m.reactions.some(r => r.name === TARGET_REACTION))
      .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
      .slice(0, POOL_SIZE);

    // Resolve author names
    const userCache = {};
    const pool = [];
    for (const msg of fireMessages) {
      const author = await resolveUserName(msg.user, SLACK_TOKEN, userCache);
      const fireReaction = msg.reactions.find(r => r.name === TARGET_REACTION);
      pool.push({
        text: cleanText(msg.text),
        author,
        ts: msg.ts,
        reactionCount: fireReaction?.count || 0,
        postedAt: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      });
    }

    // Write pool to Firebase. Preserve any existing manual override.
    await fbPatch("/foundersData", {
      weeklyWinPool: pool,
      weeklyWinSyncedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      pooled: pool.length,
      pool,
    });
  } catch (err) {
    console.error("sync-weekly-wins error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
