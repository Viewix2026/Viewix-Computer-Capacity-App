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
  if (cache[userId] !== undefined) return cache[userId];
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

// Resolve a bot ID to its name via Slack bots.info (for messages posted by bots/integrations)
async function resolveBotName(botId, token, cache) {
  if (!botId) return "";
  const k = `bot:${botId}`;
  if (cache[k] !== undefined) return cache[k];
  try {
    const r = await fetch(`https://slack.com/api/bots.info?bot=${botId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (data.ok) {
      const name = data.bot?.name || "";
      cache[k] = name;
      return name;
    }
  } catch {}
  cache[k] = "";
  return "";
}

// Pre-fetch all <@USERID> mentions referenced in the messages so we can resolve
// them in cleanText without making one API call per mention inside a sync loop.
async function prewarmMentionedUsers(messages, token, cache) {
  const ids = new Set();
  for (const m of messages) {
    if (!m.text) continue;
    const matches = m.text.match(/<@([UW][A-Z0-9]+)/g) || [];
    matches.forEach(s => ids.add(s.slice(2)));
  }
  await Promise.all([...ids].map(id => resolveUserName(id, token, cache)));
}

// Strip Slack formatting: <@U123|name> → @name (or resolved name from cache),
// <#C123|chan> → #chan, <url|text> → text
function cleanText(text, userCache = {}) {
  if (!text) return "";
  return text
    // Mention with explicit display name: <@U123|alex> → @alex
    .replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, (_, _id, name) => `@${name}`)
    // Mention without display name: <@U123> → @<resolved name> or @user fallback
    .replace(/<@([UW][A-Z0-9]+)>/g, (_, id) => {
      const name = userCache[id];
      return name ? `@${name}` : "@user";
    })
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<#C[A-Z0-9]+>/g, "#channel")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// Pull image URLs from Slack message files. Slack hosts them but they require
// auth — for client display we'll proxy via slack's permalink_public for now,
// or fall back to the original (signed) URL.
function extractImage(msg) {
  const files = Array.isArray(msg.files) ? msg.files : [];
  // Find the first image attachment
  const img = files.find(f => f && (f.mimetype || "").startsWith("image/"));
  if (!img) return null;
  // Public-facing URL for client display. Authenticated bots get signed URLs;
  // for unauth display, prefer the public permalink if Slack made the file public.
  return {
    url: img.url_private || img.thumb_360 || img.thumb_480 || img.thumb_720 || null,
    thumb: img.thumb_360 || img.thumb_480 || null,
    width: img.original_w || img.thumb_360_w || null,
    height: img.original_h || img.thumb_360_h || null,
    name: img.name || "",
    mimetype: img.mimetype || "",
  };
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

    // Pre-resolve every user mentioned in any message body so cleanText can render
    // real names instead of "@user" fallbacks.
    const userCache = {};
    await prewarmMentionedUsers(fireMessages, SLACK_TOKEN, userCache);

    const pool = [];
    for (const msg of fireMessages) {
      // Resolve author: prefer real user, fall back to bot name, fall back to empty.
      let author = await resolveUserName(msg.user, SLACK_TOKEN, userCache);
      if (!author && msg.bot_id) {
        author = await resolveBotName(msg.bot_id, SLACK_TOKEN, userCache);
      }
      if (!author && msg.username) author = msg.username; // raw bot username on legacy posts
      const fireReaction = msg.reactions.find(r => r.name === TARGET_REACTION);
      const image = extractImage(msg);
      pool.push({
        text: cleanText(msg.text, userCache),
        author,
        ts: msg.ts,
        reactionCount: fireReaction?.count || 0,
        postedAt: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        image: image || null,
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
