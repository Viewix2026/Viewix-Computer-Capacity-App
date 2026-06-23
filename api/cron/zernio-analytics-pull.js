// api/cron/zernio-analytics-pull.js — Vercel cron: pull first-party
// analytics from Zernio for every enabled analytics client, across all
// connected platforms, and feed the existing scoring engine.
//
// The actual pull logic lives in api/_zernioPull.js (shared with the
// founder-triggered "pullZernio" action in api/analytics.js) so manual
// and scheduled pulls behave identically. This file is just the walker:
// auth, plan-wide add-on preflight, iterate clients, aggregate summary.
//
// ── Schedule ──────────────────────────────────────────────────────────
// UTC `0 18 * * *` (~5am Sydney, 1h after the Apify cron). Each run
// appends one snapshot per post; smart windows in _zernioPull.js keep
// daily runs cheap (30d window) with a weekly full-history (366d)
// refresh per platform.
//
// ── Auth ──────────────────────────────────────────────────────────────
// Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. Fail closed.

import { adminGet, getAdmin } from "../_fb-admin.js";
import { checkAnalyticsAccess, AnalyticsAddonError } from "../_zernioAnalytics.js";
import { pullZernioForClient } from "../_zernioPull.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: "CRON_SECRET not configured; refusing to run." });
    return;
  }
  if ((req.headers.authorization || "") !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!process.env.ZERNIO_API_KEY) {
    res.status(500).json({ error: "ZERNIO_API_KEY not configured" });
    return;
  }

  const now = Date.now();

  // ── Add-on preflight ────────────────────────────────────────────────
  // The Analytics add-on is plan-wide, so check it ONCE before touching
  // any client data. A 402 here aborts cleanly with zero writes — no
  // half-written client left with stale derived state.
  try {
    await checkAnalyticsAccess();
  } catch (err) {
    if (err instanceof AnalyticsAddonError) {
      res.status(200).json({
        ok: false,
        reason: "analytics_addon_required",
        detail: "Zernio Analytics add-on is not active on the plan; aborted before any writes. Enable it, then re-run.",
      });
      return;
    }
    // A non-402 preflight failure (network/auth) — surface, don't half-run.
    res.status(502).json({ ok: false, reason: "preflight_failed", detail: err.message });
    return;
  }

  const clients = (await fbGet("/analytics/clients")) || {};
  const summary = {
    walkedClients: 0, enabledClients: 0, clientsPulled: 0,
    platformsPulled: 0, postsWritten: 0, postsDropped: 0, recomputed: 0,
    windows: {},          // clientId -> { platform: "full" | "recent" }
    skipped: {}, errors: [], addonMissing: false,
  };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };

  for (const [clientId, record] of Object.entries(clients)) {
    summary.walkedClients++;
    if (!record?.config?.enabled) { skip("not_enabled"); continue; }
    summary.enabledClients++;

    let result;
    try {
      result = await pullZernioForClient(clientId, { now });
    } catch (err) {
      summary.errors.push({ clientId, scope: "pull", error: err.message });
      continue;
    }

    if (result.skipped) { skip(result.skipped); }
    if (result.pulled) {
      summary.clientsPulled++;
      summary.platformsPulled += result.platformsPulled;
      summary.postsWritten += result.postsWritten;
      summary.windows[clientId] = result.windows;
    }
    summary.postsDropped += result.postsDropped;
    if (result.recomputed) summary.recomputed++;
    if (result.addonMidloop) summary.addonMissing = true;
    for (const e of result.errors) summary.errors.push({ clientId, ...e });
  }

  res.status(200).json({ ok: true, summary });
}
