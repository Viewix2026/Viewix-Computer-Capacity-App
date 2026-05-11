// api/_analyticsScrape.js — Apify run starter for the Analytics tab.
//
// Forks the social-organic IG scrape pattern but writes to a separate
// domain (/analytics/...) and uses a separate webhook secret so the
// two systems can evolve independently. Per the plan, the analytics
// build reuses Apify infrastructure but never modifies the
// preproduction code paths.
//
// HTTP-free module. Called by:
//   - api/analytics.js  (manual refresh action)
//   - api/cron/analytics-schedule.js  (scheduled fan-out)
//
// Cost model: every Apify call returns N items × ~$0.0026/item for
// the apify~instagram-scraper actor. A 60-post initial scrape costs
// ~$0.16; a 10-post daily refresh ~$0.03. Per-account + global daily
// caps are enforced in api/analytics.js and the cron handler, NOT
// here — this file just starts runs and records the metadata.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";

const APIFY_BASE = "https://api.apify.com/v2";
const APIFY_IG_ACTOR = "apify~instagram-scraper";
const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// Apify per-result cost for the IG scraper. Used for budget
// accounting before runs start and post-completion cost logging.
// Keep in sync with whatever Apify charges; conservative estimate.
export const APIFY_IG_COST_PER_RESULT_USD = 0.0026;

// Canonical webhook base URL. Mirrors the helper in social-organic.js
// so this module stays self-contained.
function webhookBase() {
  const fromEnv = process.env.APIFY_WEBHOOK_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return "https://planner.viewix.com.au";
}

// Firebase-safe handle key: IG handles can contain `.` which is a
// Firebase path separator. Replace the small set of unsafe chars
// with `_`. Mirrors the same helper in _apifyProcess.js.
export function safeHandleKey(handle) {
  return String(handle || "").replace(/[.#$/\[\]]/g, "_");
}

// fbGet / fbSet wrappers that fall back to REST if admin SDK isn't
// configured. Same shape as _apifyProcess.js.
async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Decide what mode to run for a (clientId, platform) pair based on
 * the run history. Returns one of:
 *   "initial"  — no prior runs; pull 60 posts per handle
 *   "daily"    — recent post refresh; pull ~last 7d, ~10–20 posts
 *   "weekly"   — long-tail refresh; re-scrape posts 7–90d old
 *   null       — nothing to do (already refreshed recently enough)
 *
 * Reads /analytics/runs to find the latest successful run per mode.
 * This is a read-only decision; the caller still has to call
 * startAnalyticsApifyRun if it wants to actually fire the scrape.
 */
export async function decideRefreshMode(clientId, platform) {
  const runs = (await fbGet("/analytics/runs")) || {};
  const recent = Object.values(runs).filter(r =>
    r && r.clientId === clientId && r.platform === platform && r.status === "completed"
  );
  if (recent.length === 0) return "initial";

  const lastDaily = latestOf(recent, "daily");
  const lastWeekly = latestOf(recent, "weekly");
  const now = Date.now();

  // Daily mode if the last daily was ≥24h ago. Anything more recent
  // means we already grabbed fresh posts today.
  const dailyFreshMs = lastDaily ? now - new Date(lastDaily.completedAt).getTime() : Infinity;
  const weeklyFreshMs = lastWeekly ? now - new Date(lastWeekly.completedAt).getTime() : Infinity;

  if (weeklyFreshMs > 7 * 24 * 3600 * 1000) return "weekly";
  if (dailyFreshMs > 24 * 3600 * 1000) return "daily";
  return null;
}

function latestOf(runs, mode) {
  const filtered = runs.filter(r => r.mode === mode);
  if (!filtered.length) return null;
  filtered.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  return filtered[0];
}

/**
 * Build the Apify input object for an Instagram scrape.
 *
 * Date-filtering fallback note: the apify~instagram-scraper actor's
 * input schema accepts `onlyPostsNewerThan` (ISO date or relative like
 * "7 days") in recent versions. If a future actor version drops or
 * changes that field, we fall back to over-scraping by raising
 * `resultsLimit` and filtering by timestamp in the webhook.
 * Phase 2 ships the optimistic path; the webhook validates the
 * timestamp anyway so a missing filter just means more cost, not
 * stale data.
 */
export function buildIgScrapeInput({ handle, mode }) {
  const cleanHandle = String(handle || "").replace(/^@+/, "").trim().toLowerCase();
  if (!cleanHandle) throw new Error("Missing handle");
  const baseUrl = `https://www.instagram.com/${cleanHandle}/`;
  const limits = {
    initial: 60,    // first-time pull: enough to find top-5 + a few months of context
    daily:   20,    // refresh of last 7d; over-fetch slightly in case the date filter is off
    weekly:  90,    // long-tail re-scrape for view-count updates
  };
  const resultsLimit = limits[mode] || limits.daily;
  const input = {
    directUrls: [baseUrl],
    resultsType: "posts",
    resultsLimit,
    searchType: "user",
    addParentData: false,
  };
  if (mode === "daily") {
    input.onlyPostsNewerThan = "7 days";
  } else if (mode === "weekly") {
    input.onlyPostsNewerThan = "90 days";
  }
  return input;
}

/**
 * Start an Apify run for the analytics tab. Returns the runId.
 *
 * Writes a sidecar at /analytics/runs/{runId} containing the routing
 * metadata (clientId, platform, mode, handle, target) so the
 * analytics-webhook can fan the result into the right Firebase paths
 * when the run completes.
 *
 * `target` is "client" for the user's own posts (writes to
 * /analytics/videos/{clientId}/...) or "competitor" for a competitor
 * handle (writes to /analytics/competitors/{clientId}/...).
 *
 * Caller is responsible for cost-budget gating before invoking this.
 */
export async function startAnalyticsApifyRun({
  clientId,
  platform,
  mode,
  target,           // "client" | "competitor"
  handle,
  apifyToken,
  expectedItems,    // for cost estimation
}) {
  if (!clientId || !platform || !mode || !target || !handle) {
    throw new Error("startAnalyticsApifyRun: missing required field");
  }
  if (target !== "client" && target !== "competitor") {
    throw new Error(`startAnalyticsApifyRun: invalid target ${target}`);
  }
  if (platform !== "instagram") {
    throw new Error(`startAnalyticsApifyRun: only platform=instagram is supported in v1`);
  }
  if (!apifyToken) throw new Error("startAnalyticsApifyRun: missing apifyToken");

  const SECRET = process.env.APIFY_ANALYTICS_WEBHOOK_SECRET;
  if (!SECRET) throw new Error("APIFY_ANALYTICS_WEBHOOK_SECRET not configured");

  const webhookUrl = `${webhookBase()}/api/analytics-webhook?secret=${encodeURIComponent(SECRET)}`;
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
    requestUrl: webhookUrl,
    payloadTemplate: `{"runId":"{{resource.id}}","status":"{{resource.status}}","datasetId":"{{resource.defaultDatasetId}}"}`,
  }];
  const webhooksB64 = Buffer.from(JSON.stringify(webhooks)).toString("base64");

  const input = buildIgScrapeInput({ handle, mode });
  const url = `${APIFY_BASE}/acts/${APIFY_IG_ACTOR}/runs?token=${encodeURIComponent(apifyToken)}&webhooks=${encodeURIComponent(webhooksB64)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Apify run start ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const runId = data.data?.id;
  if (!runId) throw new Error("Apify didn't return a run id");

  // Sidecar tells the webhook where to route the result. Flat path
  // per the plan's schema — /analytics/runs/{runId} not nested under
  // a client. Lets the cron/webhook walk all runs in one read.
  const cleanHandle = String(handle).replace(/^@+/, "").trim().toLowerCase();
  await fbSet(`/analytics/runs/${runId}`, {
    runId,
    clientId,
    platform,
    mode,
    target,
    handle: cleanHandle,
    actorId: APIFY_IG_ACTOR,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    expectedItems: expectedItems ?? input.resultsLimit ?? null,
    expectedCostUsd: ((expectedItems ?? input.resultsLimit ?? 0) * APIFY_IG_COST_PER_RESULT_USD).toFixed(4),
    actualItems: null,
    actualCostUsd: null,
    source: "viewix-analytics",
  });

  return runId;
}

/**
 * Sum the actual cost (USD) of completed runs for this client today.
 * Used by the budget guard before kicking off new runs.
 */
export async function todayClientCostUsd(clientId) {
  const runs = (await fbGet("/analytics/runs")) || {};
  const todayUtc = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const r of Object.values(runs)) {
    if (!r || r.clientId !== clientId) continue;
    if (r.status !== "completed") continue;
    if (!r.completedAt || !r.completedAt.startsWith(todayUtc)) continue;
    total += Number(r.actualCostUsd || r.expectedCostUsd || 0);
  }
  return total;
}

/**
 * Sum the actual cost (USD) of all completed runs today across all
 * clients. Used by the global budget guard.
 */
export async function todayGlobalCostUsd() {
  const runs = (await fbGet("/analytics/runs")) || {};
  const todayUtc = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const r of Object.values(runs)) {
    if (!r) continue;
    if (r.status !== "completed") continue;
    if (!r.completedAt || !r.completedAt.startsWith(todayUtc)) continue;
    total += Number(r.actualCostUsd || r.expectedCostUsd || 0);
  }
  return total;
}

// Default budgets in USD. Override per-account via
// /analytics/clients/{id}/config/dailyBudgetUsd or globally via env.
export const DEFAULT_PER_CLIENT_DAILY_BUDGET_USD = Number(
  process.env.ANALYTICS_PER_CLIENT_DAILY_BUDGET_USD || 1.00
);
export const DEFAULT_GLOBAL_DAILY_BUDGET_USD = Number(
  process.env.ANALYTICS_GLOBAL_DAILY_BUDGET_USD || 20.00
);
