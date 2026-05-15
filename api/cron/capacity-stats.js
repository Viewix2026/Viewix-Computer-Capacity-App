// api/cron/capacity-stats.js — Vercel cron handler for the Capacity
// Planner Dashboard's auto-owned inputs.
//
// ── Schedule ──────────────────────────────────────────────────────
// Vercel cron schedules are UTC. We target ~04:30 Sydney (well clear
// of business hours, no collision with existing 17:00/19:00/21:00/
// 21:50/22:00 cron slots). Daily run exceeds the "at least every 2
// days" target.
//   UTC `30 18 * * *`  →  04:30 Sydney during AEST
//                        05:30 Sydney during AEDT
// JSON has no comments — vercel.json carries the schedule string;
// the source of truth + timezone reasoning lives here.
//
// ── What this does ────────────────────────────────────────────────
// 1. Reads /projects, /timeLogs, and the previous /inputs/avgEditHoursPerProject.
// 2. Calls computeCapacityStats() (pure, lives in shared/capacity/).
// 3. adminPatch("/inputs", patch) — patch contains only the three
//    auto keys + _computed metadata. The four manual keys
//    (totalSuites, hoursPerSuitePerDay, avgProjectDuration,
//    targetUtilisation) are never in the patch and therefore
//    untouched in Firebase.
// 4. Returns { ok, computed } for cron-history visibility.
//
// Insufficient time-log data → avgEditHoursPerProject is omitted from
// patch. The previous value stays in Firebase; the UI surfaces
// "Auto · using previous value · insufficient time-log data" via the
// _computed.avgEditHoursPerProject.status flag.
//
// ── Auth ──────────────────────────────────────────────────────────
// Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. Reject
// anything else. FAIL CLOSED if CRON_SECRET is unset — this endpoint
// mutates dashboard state, never let it default-open.

import { adminGet, adminPatch, getAdmin } from "../_fb-admin.js";
import { computeCapacityStats } from "../../shared/capacity/computeCapacityStats.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// REST fallback if admin SDK fails to init. Both helpers fail LOUD on
// non-2xx — the production path is firebase-admin via FIREBASE_SERVICE_ACCOUNT,
// and the fallback only fires when that env var is missing. In that
// case the REST endpoint will almost certainly hit locked rules and
// return 401/permission_denied; we want a thrown error, not a silently
// JSON-parsed `{ "error": "..." }` body being treated as real data.
async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Firebase GET ${path} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  const r = await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Firebase PATCH ${path} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

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
    const [projects, timeLogs, prevAvgEditHours, prevAvgProjectDuration] = await Promise.all([
      fbGet("/projects"),
      fbGet("/timeLogs"),
      fbGet("/inputs/avgEditHoursPerProject"),
      fbGet("/inputs/avgProjectDuration"),
    ]);

    const { patch, computed } = computeCapacityStats({
      projects,
      timeLogs,
      now: Date.now(),
      prevAvgEditHours: Number.isFinite(prevAvgEditHours) ? prevAvgEditHours : null,
      prevAvgProjectDuration: Number.isFinite(prevAvgProjectDuration) ? prevAvgProjectDuration : null,
    });

    await fbPatch("/inputs", patch);

    res.status(200).json({ ok: true, computed });
  } catch (e) {
    console.error("capacity-stats cron failed:", e);
    res.status(500).json({ error: e.message || "internal error" });
  }
}
