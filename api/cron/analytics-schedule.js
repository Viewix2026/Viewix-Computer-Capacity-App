// api/cron/analytics-schedule.js — Vercel cron handler for the
// Analytics tab.
//
// ── Schedule ──────────────────────────────────────────────────────
// Vercel cron schedules are UTC, NOT Sydney time. We target ~4am
// Sydney (lowest-traffic local hour) and accept ~1hr seasonal drift
// across daylight saving:
//   UTC `0 17 * * *`  →  4am Sydney during AEDT (~Oct–Apr)
//                       5am Sydney during AEST (~Apr–Oct)
// One UTC schedule, one cron entry. Drift is harmless for a daily
// aggregation job; don't add seasonal toggles unless that 1hr ever
// matters for a customer.
// JSON has no comments — vercel.json carries the schedule string;
// the source of truth + timezone reasoning lives here.
//
// ── What this does ────────────────────────────────────────────────
// 1. Walks /analytics/clients/{id}/config looking for enabled === true.
// 2. For each enabled client + each platform toggled on:
//    a. Decides mode (initial / daily / weekly / null) via the
//       run-history heuristic in _analyticsScrape.js.
//    b. Checks the per-account daily budget.
//    c. Checks the global daily budget.
//    d. If budgets clear, kicks off Apify runs for the client
//       handle and each saved competitor handle.
//    e. Logs what it did (and didn't) for observability.
//
// All scoring lives in api/_analyticsScoring.js. This file dispatches
// scrapes; it never computes derived state itself.
//
// ── Auth ──────────────────────────────────────────────────────────
// Vercel cron requests carry `Authorization: Bearer <CRON_SECRET>`.
// Reject anything else. This endpoint is not directly callable from
// the UI; a founder click should go through api/analytics.js (which
// has its own founder/lead role gate and a 1/day rate limit).

import { adminGet, getAdmin } from "../_fb-admin.js";
import {
  decideRefreshMode,
  startAnalyticsApifyRun,
  todayClientCostUsd,
  todayGlobalCostUsd,
  DEFAULT_PER_CLIENT_DAILY_BUDGET_USD,
  DEFAULT_GLOBAL_DAILY_BUDGET_USD,
  APIFY_IG_COST_PER_RESULT_USD,
} from "../_analyticsScrape.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

// Rough cost estimate for a planned run. Mirrors the limits in
// buildIgScrapeInput; keep in sync.
function estimateRunCostUsd(mode) {
  const items = mode === "initial" ? 60 : mode === "weekly" ? 90 : 20;
  return items * APIFY_IG_COST_PER_RESULT_USD;
}

export default async function handler(req, res) {
  // Vercel cron auth. CRON_SECRET is auto-set by Vercel; if absent
  // (e.g. local dev), accept the call but warn.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) {
    res.status(500).json({ error: "APIFY_API_TOKEN not configured" });
    return;
  }

  const clients = (await fbGet("/analytics/clients")) || {};
  const summary = {
    walkedClients: 0,
    enabledClients: 0,
    runsStarted: 0,
    runsSkipped: 0,
    skipReasons: {},
    errors: [],
  };

  const globalCostBefore = await todayGlobalCostUsd();
  const globalCap = DEFAULT_GLOBAL_DAILY_BUDGET_USD;
  let runningGlobalCost = globalCostBefore;

  for (const [clientId, record] of Object.entries(clients)) {
    summary.walkedClients++;
    const config = record?.config;
    if (!config || !config.enabled) continue;
    summary.enabledClients++;

    const perClientCap = Number(config.dailyBudgetUsd || DEFAULT_PER_CLIENT_DAILY_BUDGET_USD);
    let perClientCost = await todayClientCostUsd(clientId);

    const platforms = config.platforms || {};
    for (const platform of Object.keys(platforms)) {
      if (!platforms[platform]) continue;

      // v1 only supports Instagram. Other platforms can be toggled
      // on in the config UI (so v2/v3 wiring is ready), but the
      // cron won't dispatch them yet.
      if (platform !== "instagram") {
        skip(summary, "platform_v1_only");
        continue;
      }

      const clientHandle = config.handles?.[platform];
      if (!clientHandle) {
        skip(summary, "missing_client_handle");
        continue;
      }

      const mode = await decideRefreshMode(clientId, platform);
      if (!mode) {
        skip(summary, "already_fresh");
        continue;
      }

      // ─── Client handle scrape ───
      const clientRunCost = estimateRunCostUsd(mode);

      if (runningGlobalCost + clientRunCost > globalCap) {
        skip(summary, "global_budget_exceeded");
        continue;
      }
      if (perClientCost + clientRunCost > perClientCap) {
        skip(summary, "client_budget_exceeded");
        continue;
      }

      try {
        await startAnalyticsApifyRun({
          clientId, platform, mode,
          target: "client",
          handle: clientHandle,
          apifyToken,
        });
        summary.runsStarted++;
        perClientCost += clientRunCost;
        runningGlobalCost += clientRunCost;
      } catch (err) {
        summary.errors.push({ clientId, platform, scope: "client", error: err.message });
      }

      // ─── Competitor scrapes ───
      // Competitors get a slightly leaner refresh than the client's
      // own handle (you care most about your own posts). Initial
      // is 30 per competitor (vs 60 for client), but we keep the
      // same mode semantics so the run-history heuristic in
      // decideRefreshMode still gates retreads.
      const competitors = config.competitors?.[platform] || [];
      for (const c of competitors) {
        if (!c?.handle) continue;
        const compRunCost = estimateRunCostUsd(mode) * 0.5; // ~30 items not 60
        if (runningGlobalCost + compRunCost > globalCap) {
          skip(summary, "global_budget_exceeded");
          continue;
        }
        if (perClientCost + compRunCost > perClientCap) {
          skip(summary, "client_budget_exceeded");
          continue;
        }
        try {
          await startAnalyticsApifyRun({
            clientId, platform, mode,
            target: "competitor",
            handle: c.handle,
            apifyToken,
          });
          summary.runsStarted++;
          perClientCost += compRunCost;
          runningGlobalCost += compRunCost;
        } catch (err) {
          summary.errors.push({ clientId, platform, scope: "competitor", handle: c.handle, error: err.message });
        }
      }
    }
  }

  summary.globalCostBefore = +globalCostBefore.toFixed(4);
  summary.globalCostAfterEstimate = +runningGlobalCost.toFixed(4);
  res.status(200).json({ ok: true, summary });
}

function skip(summary, reason) {
  summary.runsSkipped++;
  summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
}
