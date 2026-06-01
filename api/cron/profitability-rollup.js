// api/cron/profitability-rollup.js — nightly margin/contribution rollup.
//
// Reads the six input nodes, computes per-project contribution + rollups
// via shared/profitability.js, and ATOMICALLY REPLACES the whole
// /profitability node (adminSet, not patch) so excluded/deleted projects
// leave no stale rows behind.
//
// SOLE WRITER of /profitability. That node is founders-READ, `.write:false`
// in firebase-rules.json — only this admin-credentialed cron writes it, so
// the cost/commission figures can never be tampered with from a client.
//
// FAILS HARD — no REST fallback (unlike capacity-stats.js). /profitability
// is sensitive cost/commission data behind admin-only write rules; a REST
// write would hit locked rules anyway. adminGet/adminSet throw if
// firebase-admin can't init, so a missing FIREBASE_SERVICE_ACCOUNT 500s
// loudly rather than silently degrading.
//
// ── Schedule ──────────────────────────────────────────────────────
// vercel.json carries the cron string. Vercel crons are UTC:
//   `30 19 * * *`  →  05:30 Sydney (AEST) / 06:30 (AEDT)
// Runs after the 19:00 sync-attio-cache + roll-behind-schedule slots so
// project/timelog state is settled. The math is pure + idempotent, so a
// double-fire just rewrites the same snapshot.
//
// ── Auth ──────────────────────────────────────────────────────────
// Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. FAIL CLOSED if
// CRON_SECRET is unset — this endpoint writes sensitive state.

import { adminGet, adminSet } from "../_fb-admin.js";
import { computeProfitability } from "../../shared/profitability.js";

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({
      error: "CRON_SECRET not configured; refusing to run.",
      hint: "Set CRON_SECRET in Vercel env vars.",
    });
    return;
  }
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (auth !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const [projects, timeLogs, laborCosts, commissionPlans, costInputs, commissionInputs, attioCache] =
      await Promise.all([
        adminGet("/projects"),
        adminGet("/timeLogs"),
        adminGet("/laborCosts"),
        adminGet("/commissionPlans"),
        adminGet("/projectCostInputs"),
        adminGet("/projectCommissionInputs"),
        // Revenue source of truth: projects rarely carry their own dealValue,
        // so the compute fills blanks from the matched Won deal in this cache
        // (refreshed by sync-attio-cache at 19:00 UTC, just before this run).
        adminGet("/attioCache"),
      ]);

    const { perProject, rollups } = computeProfitability({
      projects: projects || {},
      timeLogs: timeLogs || {},
      laborCosts: laborCosts || {},
      commissionPlans: commissionPlans || {},
      costInputs: costInputs || {},
      commissionInputs: commissionInputs || {},
      attioCache: attioCache || null,
    });

    // The pure module stays timeless; the cron stamps computedAt at
    // persist time onto every row and the rollup blob.
    const computedAt = Date.now();
    const rows = {};
    for (const [id, row] of Object.entries(perProject)) {
      rows[id] = { ...row, computedAt };
    }

    // ATOMIC FULL REPLACE. _rollups rides under the same node, so one
    // set() swaps the entire snapshot — a project deleted since the last
    // run simply isn't in `rows`, and therefore vanishes. No stale data.
    await adminSet("/profitability", {
      ...rows,
      _rollups: { ...rollups, computedAt },
    });

    res.status(200).json({
      ok: true,
      projects: Object.keys(rows).length,
      completeCount: rollups.completeCount,
      incompleteCount: rollups.incompleteCount,
      computedAt,
    });
  } catch (e) {
    console.error("profitability-rollup cron failed:", e);
    res.status(500).json({ error: e.message || "internal error" });
  }
}
