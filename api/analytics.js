// api/analytics.js — Phase 1 stub.
//
// Action-dispatched endpoint matching the social-organic.js / attio.js
// convention. Phase 1 ships ONE wired action (`refresh`) that returns
// "not implemented yet" so the UI's Refresh button has something
// real to hit while we build out ingestion in Phase 2.
//
// Auth: every client-callable action requires
//   await requireRole(req, ["founders", "founder", "lead"])
// — same gate the App.jsx tab + firebase rules use. Three role strings
// (legacy "founders" + current "founder" + "lead") matches existing
// codebase convention; do not "clean it up."
//
// Important: `generateInsights` is intentionally NOT exposed as an
// action here. Insights generation runs from
// api/cron/analytics-schedule.js only, so a founder click can't fan
// out 30 Claude calls and burn budget. Phase 2/3 add the other client
// actions (listClients, getClient, upsertClientConfig,
// setManualFormatOverride). For now this is just the refresh stub.

import { handleOptions, requireRole } from "./_requireAuth.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await requireRole(req, ["founders", "founder", "lead"]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Auth error" });
    return;
  }

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const action = body.action;

  if (action === "refresh") {
    // Phase 1: not implemented. Returns 501 so the UI can render an
    // honest "feature pending" message without throwing. Phase 2
    // replaces the body of this branch with the real ingestion
    // trigger (start Apify run, write /analytics/runs/{runId},
    // return runId + estimated completion time).
    res.status(501).json({
      ok: false,
      action: "refresh",
      message: "Refresh isn't wired yet — ingestion lands in Phase 2.",
    });
    return;
  }

  res.status(400).json({ error: `Unknown action: ${action || "(none)"}` });
}
