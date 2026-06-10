// api/check-contacts.js
// Vercel Cron: checks client last contact dates and notifies Slack
// Runs daily at 8am AEST (10pm UTC previous day)
// Env vars needed: SLACK_WEBHOOK_URL

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";
import { isAuthorizedCron } from "./_cronAuth.js";

const FB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

const MANAGER_SLACK_IDS = {
  "Jeremy": "U05KKU93KHB",
  "Steve": "U05KG793EDC",
  "Vish": "U09K3H816UB",
};

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr + "T12:00:00Z");
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function getLevel(days) {
  if (days <= 7) return "green";
  if (days <= 14) return "amber";
  return "red";
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!isAuthorizedCron(req).ok) {
    return res.status(401).json({ error: "Cron header required" });
  }

  try {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({ error: "SLACK_WEBHOOK_URL not set" });
    }

    // Read accounts from Firebase (prefer admin SDK, fall back to REST)
    let accounts;
    const { err: adminErr } = getAdmin();
    if (!adminErr) {
      accounts = await adminGet("/accounts");
    } else {
      const accountsRes = await fetch(`${FB_URL}/accounts.json`);
      accounts = await accountsRes.json();
    }
    if (!accounts) {
      return res.status(200).json({ message: "No accounts found" });
    }

    // Read previous notification levels
    let prevLevels;
    if (!adminErr) {
      prevLevels = (await adminGet("/contactNotifications")) || {};
    } else {
      const levelsRes = await fetch(`${FB_URL}/contactNotifications.json`);
      prevLevels = (await levelsRes.json()) || {};
    }

    const amberAlerts = [];
    const redAlerts = [];
    const updatedLevels = { ...prevLevels };

    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct || !acct.id || !acct.companyName) continue;

      const days = daysSince(acct.lastContact);
      const currentLevel = getLevel(days);
      const previousLevel = prevLevels[id]?.level || "green";

      // Green to amber transition
      if (currentLevel === "amber" && previousLevel === "green") {
        amberAlerts.push({
          client: acct.companyName,
          manager: acct.accountManager || "Unassigned",
          days: days,
        });
        updatedLevels[id] = { level: "amber", notifiedAt: new Date().toISOString() };
      }

      // Amber to red transition — also catches a direct green→red jump
      // (cron outage gap, cleared/unparseable lastContact, or an account
      // first tracked when already overdue), which previously matched
      // neither branch and stayed recorded green forever.
      if (currentLevel === "red" && (previousLevel === "amber" || previousLevel === "green")) {
        redAlerts.push({
          client: acct.companyName,
          manager: acct.accountManager || "Unassigned",
          days: days,
        });
        updatedLevels[id] = { level: "red", notifiedAt: new Date().toISOString() };
      }

      // Reset to green if contact was made
      if (currentLevel === "green" && previousLevel !== "green") {
        updatedLevels[id] = { level: "green", notifiedAt: new Date().toISOString() };
      }
    }

    // Persisting updatedLevels marks alerts as "already notified" — so it
    // must only happen AFTER Slack accepts the message, or a failed post
    // permanently swallows the alerts.
    const persistLevels = async () => {
      if (!adminErr) {
        await adminSet("/contactNotifications", updatedLevels);
      } else {
        await fetch(`${FB_URL}/contactNotifications.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatedLevels),
        });
      }
    };

    // No alerts: safe to persist immediately (only green resets recorded)
    if (amberAlerts.length === 0 && redAlerts.length === 0) {
      await persistLevels();
      return res.status(200).json({ message: "No new alerts" });
    }

    const blocks = [];

    if (amberAlerts.length > 0) {
      const lines = amberAlerts.map(a => {
        const slackId = MANAGER_SLACK_IDS[a.manager];
        const mention = slackId ? `<@${slackId}>` : a.manager;
        return `*${a.client}* — ${a.days} days since last contact. ${mention} please follow up.`;
      });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *Clients falling out of contact*\n\n${lines.join("\n")}`,
        },
      });
    }

    if (redAlerts.length > 0) {
      const lines = redAlerts.map(a => {
        const slackId = MANAGER_SLACK_IDS[a.manager];
        const mention = slackId ? `<@${slackId}>` : a.manager;
        return `*${a.client}* — ${a.days} days since last contact. ${mention} this is now overdue.`;
      });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:red_circle: *Clients overdue for contact*\n\n${lines.join("\n")}`,
        },
      });
    }

    // Post to Slack
    const slackRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    });

    if (!slackRes.ok) {
      const err = await slackRes.text();
      // Deliberately NOT persisting updatedLevels — the alerts re-send
      // on the next run instead of being lost.
      return res.status(500).json({ error: "Slack post failed", detail: err });
    }

    await persistLevels();

    return res.status(200).json({
      message: "Notifications sent",
      amber: amberAlerts.length,
      red: redAlerts.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
