// ONE-SHOT INSPECT + OPTIONAL DELETE ENDPOINT — DELETE AFTER USE.
//
// Usage:
//   ?token=TOKEN&action=inspect           → dry run, returns what would be removed
//   ?token=TOKEN&action=delete            → actually removes from /mondayEditors + /timeLogs
//
// Reports per-editor: name (if present in /mondayEditors), number of
// time-log days recorded under /timeLogs/{id}, and a rough byte count
// of their time-log payload.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";

const ONE_SHOT_TOKEN = "inspect-editors-9a4c8e17b3d24f16b8e03f4719a5d2e1";
const TARGET_IDS = ["97345986", "101620167", "85363605"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.query?.token || "") !== ONE_SHOT_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const action = req.query?.action || "inspect";
  if (action !== "inspect" && action !== "delete") {
    return res.status(400).json({ error: "action must be 'inspect' or 'delete'" });
  }

  const { err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  try {
    const mondayEditors = (await adminGet("/mondayEditors")) || [];
    const mondayList = Array.isArray(mondayEditors) ? mondayEditors : Object.values(mondayEditors);

    const report = [];
    for (const id of TARGET_IDS) {
      const editor = mondayList.find(e => e && String(e.id) === id);
      const timeLogs = (await adminGet(`/timeLogs/${id}`)) || {};
      const dayKeys = Object.keys(timeLogs);
      const totalEntries = dayKeys.reduce((sum, day) => {
        const entries = timeLogs[day] || {};
        // Exclude the "_running" sentinel key from the count.
        return sum + Object.keys(entries).filter(k => k !== "_running").length;
      }, 0);
      const rawSize = JSON.stringify(timeLogs).length;

      report.push({
        id,
        name: editor?.name || null,
        inMondayEditors: !!editor,
        timeLogDays: dayKeys.length,
        timeLogEntries: totalEntries,
        timeLogSizeBytes: rawSize,
      });
    }

    if (action === "delete") {
      const removed = [];
      // Remove from /mondayEditors (filter out these IDs, write back the reduced list)
      const cleaned = mondayList.filter(e => e && !TARGET_IDS.includes(String(e.id)));
      if (cleaned.length !== mondayList.length) {
        await adminSet("/mondayEditors", cleaned);
        removed.push(`mondayEditors: ${mondayList.length - cleaned.length} entries`);
      }
      // Null out each time-log tree
      for (const id of TARGET_IDS) {
        await adminSet(`/timeLogs/${id}`, null);
      }
      removed.push(`timeLogs: ${TARGET_IDS.length} trees`);
      return res.status(200).json({ action, removed, report });
    }

    return res.status(200).json({ action, report, note: "Dry run. Add &action=delete to actually remove." });
  } catch (e) {
    console.error("inspect-editors failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
