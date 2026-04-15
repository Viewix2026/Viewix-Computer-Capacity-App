// api/check-contacts.js
// Vercel Cron: checks client last contact dates and notifies Slack
// Runs daily at 8am AEST (10pm UTC previous day)
// Env vars needed: SLACK_WEBHOOK_URL

import { adminGet, getAdmin } from "./_fb-admin.js";

const FB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

const MANAGER_SLACK_IDS = {
  "Jeremy": "U05KKU93KHB",
  "Steve": "U05KG793EDC",
  "Vish": "U09K3H816UB",
};

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function getLevel(days) {
  if (days <= 7) return "green";
  if (days <= 14) return "amber";
  return "red";
}

export default async function handler(req, res) {
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
    const levelsRes = await fetch(`${FB_URL}/contactNotifications.json`);
    const prevLevels = (await levelsRes.json()) || {};

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

      // Amber to red transition
      if (currentLevel === "red" && previousLevel === "amber") {
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

    // Save updated levels back to Firebase
    await fetch(`${FB_URL}/contactNotifications.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedLevels),
    });

    // Build Slack message if there are alerts
    if (amberAlerts.length === 0 && redAlerts.length === 0) {
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
      return res.status(500).json({ error: "Slack post failed", detail: err });
    }

    return res.status(200).json({
      message: "Notifications sent",
      amber: amberAlerts.length,
      red: redAlerts.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
