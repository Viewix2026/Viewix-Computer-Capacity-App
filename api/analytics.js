// api/analytics.js — client-callable analytics actions.
//
// Action-dispatched (matches the social-organic.js / attio.js
// convention). Every action requires the existing
// requireRole(req, ["founders", "founder", "lead"]) gate — the same
// allowlist used by App.jsx + firebase-rules.json. Three role
// strings (legacy "founders" + current "founder" + "lead") matches
// existing codebase convention; do not "clean it up."
//
// Actions:
//   - refresh: manual scrape trigger. 1/day cap per client +
//     per-account daily budget guard. Returns runIds + estimated
//     completion. Phase 2 makes this real (Phase 1 was a 501 stub).
//
// Not here (deliberate):
//   - generateInsights — cron-only, lives in
//     api/cron/analytics-schedule.js (later phase). Keeps insights
//     generation out of UI reach so a click can't fan out Claude
//     calls and burn budget.
//   - listClients / getClient / upsertClientConfig — Phase 1 reads/
//     writes config directly via Firebase rules + fbSet from the
//     UI hooks. If we ever need server-side validation on config
//     edits, those actions land here.

import { handleOptions, requireRole } from "./_requireAuth.js";
import {
  startAnalyticsApifyRun,
  decideRefreshMode,
  todayClientCostUsd,
  todayGlobalCostUsd,
  APIFY_IG_COST_PER_RESULT_USD,
  DEFAULT_PER_CLIENT_DAILY_BUDGET_USD,
  DEFAULT_GLOBAL_DAILY_BUDGET_USD,
} from "./_analyticsScrape.js";
import { adminGet, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

// Rough cost estimate, mirrors _analyticsScrape.buildIgScrapeInput.
function estimateRunCostUsd(mode) {
  const items = mode === "initial" ? 60 : mode === "weekly" ? 90 : 20;
  return items * APIFY_IG_COST_PER_RESULT_USD;
}

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

  if (action === "refresh") return await handleRefresh(req, res, body);

  res.status(400).json({ error: `Unknown action: ${action || "(none)"}` });
}

// ─── refresh ──────────────────────────────────────────────────────

async function handleRefresh(req, res, body) {
  const { accountId, platform: platformIn } = body;
  if (!accountId) {
    res.status(400).json({ error: "Missing accountId" });
    return;
  }

  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) {
    res.status(500).json({ error: "APIFY_API_TOKEN not configured" });
    return;
  }

  const config = await fbGet(`/analytics/clients/${accountId}/config`);
  if (!config) {
    res.status(404).json({ error: "No analytics config for this account. Set one up first." });
    return;
  }
  if (!config.enabled) {
    res.status(400).json({ error: "Analytics isn't enabled for this account. Toggle it on first." });
    return;
  }

  // v1 only supports Instagram. If the caller specified a different
  // platform, reject explicitly; otherwise default to Instagram.
  const platform = platformIn || "instagram";
  if (platform !== "instagram") {
    res.status(400).json({ error: `Platform "${platform}" isn't supported in v1. Instagram only.` });
    return;
  }
  if (!config.platforms?.[platform]) {
    res.status(400).json({ error: `Platform "${platform}" isn't enabled for this account.` });
    return;
  }
  const handle = config.handles?.[platform];
  if (!handle) {
    res.status(400).json({ error: `No ${platform} handle configured for this account.` });
    return;
  }

  // ─── 1/day manual-refresh cap ───
  // Reject if a client scrape started within the last 24h for this
  // account. body.force=true bypasses the cap; reserved for
  // founder-tier emergency use only — the UI doesn't expose it.
  const runs = (await fbGet("/analytics/runs")) || {};
  const since = Date.now() - 24 * 3600 * 1000;
  const recentClientRun = Object.values(runs).filter(r => r
    && r.clientId === accountId
    && r.platform === platform
    && r.target === "client"
    && r.startedAt
    && new Date(r.startedAt).getTime() >= since
  );
  if (recentClientRun.length > 0 && !body.force) {
    const latest = recentClientRun.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
    const nextAt = new Date(new Date(latest.startedAt).getTime() + 24 * 3600 * 1000);
    const remainingHours = Math.max(1, Math.ceil((nextAt.getTime() - Date.now()) / 3600 / 1000));
    res.status(429).json({
      ok: false,
      error: "rate_limited",
      message: `Refresh is capped to 1/day per client. Next refresh available in ~${remainingHours}h.`,
      nextAvailableAt: nextAt.toISOString(),
    });
    return;
  }

  // ─── Mode + budget ───
  // For manual refresh, force at least daily mode (don't no-op).
  // Initial mode wins automatically if there's no prior data.
  let mode = await decideRefreshMode(accountId, platform);
  if (!mode) mode = "daily";

  const perClientCap = Number(config.dailyBudgetUsd || DEFAULT_PER_CLIENT_DAILY_BUDGET_USD);
  const globalCap = DEFAULT_GLOBAL_DAILY_BUDGET_USD;

  const perClientCost = await todayClientCostUsd(accountId);
  const globalCost = await todayGlobalCostUsd();

  const clientRunCost = estimateRunCostUsd(mode);
  if (perClientCost + clientRunCost > perClientCap) {
    res.status(402).json({
      ok: false,
      error: "budget_exceeded",
      scope: "client",
      message: `This client's daily Apify budget ($${perClientCap.toFixed(2)}) is exhausted.`,
      perClientCostToday: +perClientCost.toFixed(4),
      perClientCap,
    });
    return;
  }
  if (globalCost + clientRunCost > globalCap) {
    res.status(402).json({
      ok: false,
      error: "budget_exceeded",
      scope: "global",
      message: `Global daily Apify budget ($${globalCap.toFixed(2)}) is exhausted across all clients.`,
      globalCostToday: +globalCost.toFixed(4),
      globalCap,
    });
    return;
  }

  // ─── Fire the runs ───
  // Client + (each saved competitor). Competitors are best-effort:
  // if one fails to start we don't abort the whole refresh.
  const runIds = { client: null, competitors: {} };
  const errors = [];

  try {
    runIds.client = await startAnalyticsApifyRun({
      clientId: accountId, platform, mode,
      target: "client", handle, apifyToken,
    });
  } catch (err) {
    errors.push({ scope: "client", error: err.message });
  }

  const competitors = config.competitors?.[platform] || [];
  let runningClientCost = perClientCost + (runIds.client ? clientRunCost : 0);
  let runningGlobalCost = globalCost + (runIds.client ? clientRunCost : 0);
  for (const c of competitors) {
    if (!c?.handle) continue;
    const compRunCost = estimateRunCostUsd(mode) * 0.5; // competitors get ~30 items
    if (runningClientCost + compRunCost > perClientCap) {
      errors.push({ scope: "competitor", handle: c.handle, error: "client_budget_exceeded" });
      continue;
    }
    if (runningGlobalCost + compRunCost > globalCap) {
      errors.push({ scope: "competitor", handle: c.handle, error: "global_budget_exceeded" });
      continue;
    }
    try {
      runIds.competitors[c.handle] = await startAnalyticsApifyRun({
        clientId: accountId, platform, mode,
        target: "competitor", handle: c.handle, apifyToken,
      });
      runningClientCost += compRunCost;
      runningGlobalCost += compRunCost;
    } catch (err) {
      errors.push({ scope: "competitor", handle: c.handle, error: err.message });
    }
  }

  const totalStarted = (runIds.client ? 1 : 0) + Object.keys(runIds.competitors).length;
  if (totalStarted === 0) {
    res.status(500).json({
      ok: false,
      error: "all_runs_failed",
      message: "No Apify runs started. Check Apify token and account config.",
      errors,
    });
    return;
  }

  res.status(202).json({
    ok: true,
    action: "refresh",
    mode,
    runIds,
    errors,
    message: `Started ${totalStarted} Apify run(s). Results land in /analytics/videos/${accountId}/ via webhook.`,
  });
}
