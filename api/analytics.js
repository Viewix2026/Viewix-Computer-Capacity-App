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
import { adminGet, adminPatch, getAdmin } from "./_fb-admin.js";
import { recomputeClientAnalytics } from "./_analyticsScoring.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
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

  let decoded;
  try {
    decoded = await requireRole(req, ["founders", "founder", "lead"]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Auth error" });
    return;
  }
  // Stash on the req so action handlers can stamp the override audit
  // trail (manualFormatOverrideBy) without re-decoding.
  req._decodedToken = decoded;

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const action = body.action;

  if (action === "refresh") return await handleRefresh(req, res, body);
  if (action === "recompute") return await handleRecompute(req, res, body);
  if (action === "setManualFormatOverride") return await handleSetManualFormatOverride(req, res, body);
  if (action === "clearManualFormatOverride") return await handleClearManualFormatOverride(req, res, body);

  res.status(400).json({ error: `Unknown action: ${action || "(none)"}` });
}

// ─── recompute ────────────────────────────────────────────────────
//
// Re-derives all analytics state (baselines, scoring, status,
// momentum, insights, decay, renewal ammo) from the data ALREADY
// in /analytics/videos/... — no Apify call, no cost, no rate limit.
//
// Use this when:
//   - You've tuned a threshold and want to see it applied to existing
//     data without paying for a new scrape.
//   - A previous webhook recompute was cut off mid-flight and you want
//     to backfill the derived state.
//   - The Claude classifier was enabled/disabled and you want the
//     formatPlaybook caveat to update.
//
// Same founder/lead gate as the rest of the file.
async function handleRecompute(req, res, body) {
  const clientId = body.clientId;
  if (!clientId) {
    res.status(400).json({ error: "Missing clientId" });
    return;
  }
  try {
    const result = await recomputeClientAnalytics(clientId);
    res.status(200).json({ ok: true, action: "recompute", result });
  } catch (err) {
    console.error(`[analytics] recompute action failed for ${clientId}:`, err);
    res.status(500).json({ error: err.message || "Recompute failed" });
  }
}

// ─── setManualFormatOverride / clearManualFormatOverride ─────────
//
// Founder/lead-gated (same requireRole check as the rest of the file).
// Writes the four manual-override fields onto a video's
// classifications record. Per the plan, manual overrides ALWAYS win
// over the heuristic + Claude classifiers; recomputeClientAnalytics
// preserves them on every subsequent run.
//
// `decoded` is the verified token payload from requireRole — its
// `uid` is what we stamp into manualFormatOverrideBy for the audit
// trail.

const FORMAT_KEYS = [
  "founder_talking_head", "client_proof", "behind_the_scenes",
  "transformation", "educational_explainer", "objection_handling",
  "trend_based", "product_service_demo", "hiring_team_culture",
  "event_activation", "other",
];

async function handleSetManualFormatOverride(req, res, body) {
  const { accountId, platform: platformIn, videoId, format, reason } = body;
  if (!accountId || !videoId || !format) {
    res.status(400).json({ error: "Missing accountId, videoId, or format" });
    return;
  }
  const platform = platformIn || "instagram";
  if (platform !== "instagram") {
    res.status(400).json({ error: `Platform "${platform}" isn't supported in v1.` });
    return;
  }
  if (!FORMAT_KEYS.includes(format)) {
    res.status(400).json({ error: `Unknown format key "${format}". Allowed: ${FORMAT_KEYS.join(", ")}` });
    return;
  }

  // Verify the video exists before writing — silently overriding a
  // non-existent record would create orphan data.
  const existing = await fbGet(`/analytics/videos/${accountId}/${platform}/${videoId}/post`);
  if (!existing) {
    res.status(404).json({ error: "Video not found at that path." });
    return;
  }

  const decoded = req._decodedToken || {};
  const overrideBy = decoded.uid || decoded.user_id || decoded.email || "unknown";
  const overrideAt = new Date().toISOString();

  // Use fbPatch to merge into the classifications subtree so we
  // don't blow away the rest of the record (format, formatConfidence,
  // claudeReason, etc. all stay).
  await fbPatch(`/analytics/videos/${accountId}/${platform}/${videoId}/classifications`, {
    manualFormatOverride: format,
    manualFormatOverrideBy: overrideBy,
    manualFormatOverrideAt: overrideAt,
    manualFormatOverrideReason: reason || null,
    // Also bump the displayed format immediately so the UI doesn't
    // wait for the recompute pass.
    format,
    formatConfidence: "high",
    source: "manual",
  });

  // Trigger a recompute so the Format Playbook + recs reflect the
  // new label without waiting for the next scrape cycle. Done in
  // the background — the override write is already durable.
  try {
    await recomputeClientAnalytics(accountId);
  } catch (err) {
    console.warn(`[analytics.setManualFormatOverride] recompute failed: ${err.message}`);
  }

  res.status(200).json({
    ok: true,
    action: "setManualFormatOverride",
    videoId, format, reason: reason || null,
    overrideBy, overrideAt,
  });
}

async function handleClearManualFormatOverride(req, res, body) {
  const { accountId, platform: platformIn, videoId } = body;
  if (!accountId || !videoId) {
    res.status(400).json({ error: "Missing accountId or videoId" });
    return;
  }
  const platform = platformIn || "instagram";
  if (platform !== "instagram") {
    res.status(400).json({ error: `Platform "${platform}" isn't supported in v1.` });
    return;
  }
  await fbPatch(`/analytics/videos/${accountId}/${platform}/${videoId}/classifications`, {
    manualFormatOverride: null,
    manualFormatOverrideBy: null,
    manualFormatOverrideAt: null,
    manualFormatOverrideReason: null,
  });
  // Recompute will rebuild format + source from the heuristic /
  // Claude classifier on the next pass.
  try {
    await recomputeClientAnalytics(accountId);
  } catch (err) {
    console.warn(`[analytics.clearManualFormatOverride] recompute failed: ${err.message}`);
  }
  res.status(200).json({ ok: true, action: "clearManualFormatOverride", videoId });
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
