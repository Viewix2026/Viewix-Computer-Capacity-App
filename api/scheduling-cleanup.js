// api/scheduling-cleanup.js
//
// Daily housekeeping for the scheduler's transient state.
// Triggered by Vercel cron (see vercel.json#crons). Also reachable
// via authenticated POST for ad-hoc runs.
//
// Prunes:
//   /scheduling/pending           — proposals from the Slack scheduler
//                                    (terminal >7d old → delete)
//   /scheduling/pendingFlags      — drag-flag pending records
//                                    (still active past expiresAt → silence;
//                                     this should be rare since the flusher
//                                     handles them every minute, but it's a
//                                     safety net for stuck records)
//   /scheduling/pendingFlagsDone  — terminal flag records (>7d → delete)
//   /scheduling/postedFingerprints— hashed fp dedup records (>7d → delete)
//   /scheduling/events            — Slack event-id dedup records (>24h → delete)
//
// Counts everything for the response body so the cron's output
// doubles as a sanity-check audit.

import { adminGet, getAdmin } from "./_fb-admin.js";
import { requireRole, sendAuthError } from "./_requireAuth.js";
import { isAuthorizedCron } from "./_cronAuth.js";

export const config = { maxDuration: 60 };

const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_DEDUP_RETENTION_MS = 24 * 60 * 60 * 1000;
const POSTED_FP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROPOSAL_TERMINAL_STATUSES = new Set(["used", "cancelled", "stale", "expired"]);
// Phase 2 plan proposals: terminal once approved/cancelled/expired.
const PLAN_TERMINAL_STATUSES = new Set(["approved", "cancelled", "expired", "stale"]);

export default async function handler(req, res) {
  const isCron = isAuthorizedCron(req).ok;
  if (req.method === "GET") {
    if (!isCron) return res.status(401).json({ error: "Cron header required" });
  } else if (req.method === "POST") {
    // Manual run path — require founders auth so the public can't
    // trigger cleanup writes via an unauthenticated POST.
    try {
      await requireRole(req, ["founders", "founder"]);
    } catch (e) {
      return sendAuthError(res, e);
    }
  } else {
    return res.status(405).json({ error: "POST or cron GET only" });
  }
  try {
    const result = await runCleanup();
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error("scheduling-cleanup error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function runCleanup() {
  const { db, err } = getAdmin();
  if (err) throw new Error(`Firebase admin not configured: ${err}`);

  const now = Date.now();
  const result = {
    proposalsExpired: 0, proposalsDeleted: 0,
    pendingFlagsSilenced: 0, pendingFlagsDoneDeleted: 0,
    postedFingerprintsDeleted: 0,
    eventsDeleted: 0,
    planProposalsExpired: 0, planProposalsDeleted: 0, planHistoryDeleted: 0,
  };

  // ── Phase 2 plan proposals (/scheduling/proposedPlans) ─────────
  // Mirror the Slack-proposal lifecycle: pending past expiresAt →
  // expired; terminal records older than the retention window → delete.
  const plans = (await adminGet("/scheduling/proposedPlans")) || {};
  for (const [shortId, p] of Object.entries(plans)) {
    if (!p || typeof p !== "object") {
      await db.ref(`/scheduling/proposedPlans/${shortId}`).remove();
      result.planProposalsDeleted += 1;
      continue;
    }
    const status = p.status || "";
    const expiresAt = Number(p.expiresAt) || 0;
    const createdAt = Number(p.createdAt) || 0;
    if ((status === "pending" || status === "claimed") && expiresAt > 0 && now > expiresAt) {
      await db.ref(`/scheduling/proposedPlans/${shortId}`).update({
        status: "expired", expiredAt: now,
      });
      result.planProposalsExpired += 1;
      continue;
    }
    if (PLAN_TERMINAL_STATUSES.has(status)) {
      const refTime = Math.max(
        Number(p.approvedAt) || 0,
        Number(p.cancelledAt) || 0,
        Number(p.expiredAt) || 0,
        createdAt,
      );
      if (refTime > 0 && now - refTime > TERMINAL_RETENTION_MS) {
        await db.ref(`/scheduling/proposedPlans/${shortId}`).remove();
        result.planProposalsDeleted += 1;
      }
    }
  }

  // ── Phase 2 plan history (/scheduling/planHistory) ─────────────
  const planHistory = (await adminGet("/scheduling/planHistory")) || {};
  for (const [shortId, p] of Object.entries(planHistory)) {
    const refTime = Math.max(
      Number(p?.approvedAt) || 0,
      Number(p?.cancelledAt) || 0,
      Number(p?.createdAt) || 0,
    );
    if (!p || (refTime > 0 && now - refTime > TERMINAL_RETENTION_MS)) {
      await db.ref(`/scheduling/planHistory/${shortId}`).remove();
      result.planHistoryDeleted += 1;
    }
  }

  // ── Slack-scheduler proposals (existing /scheduling/pending tree) ──
  const proposals = (await adminGet("/scheduling/pending")) || {};
  for (const [shortId, p] of Object.entries(proposals)) {
    if (!p || typeof p !== "object") {
      await db.ref(`/scheduling/pending/${shortId}`).remove();
      result.proposalsDeleted += 1;
      continue;
    }
    const status = p.status || "";
    const expiresAt = Number(p.expiresAt) || 0;
    const createdAt = Number(p.createdAt) || 0;
    if ((status === "pending" || status === "awaiting_clarification") && expiresAt > 0 && now > expiresAt) {
      await db.ref(`/scheduling/pending/${shortId}`).update({
        status: "expired", expiredAt: now,
      });
      result.proposalsExpired += 1;
      continue;
    }
    if (PROPOSAL_TERMINAL_STATUSES.has(status)) {
      const refTime = Math.max(
        Number(p.usedAt) || 0,
        Number(p.cancelledAt) || 0,
        Number(p.expiredAt) || 0,
        createdAt,
      );
      if (refTime > 0 && now - refTime > TERMINAL_RETENTION_MS) {
        await db.ref(`/scheduling/pending/${shortId}`).remove();
        result.proposalsDeleted += 1;
      }
    }
  }

  // ── Drag-flag pending (active records) ─────────────────────────
  // Safety net: if a record's notifyAt + expiresAt has long passed
  // without the flusher silencing/firing it, move it to Done with
  // status "silenced" so it doesn't sit forever.
  const pendingFlags = (await adminGet("/scheduling/pendingFlags")) || {};
  for (const [id, rec] of Object.entries(pendingFlags)) {
    if (!rec) continue;
    const expiresAt = Number(rec.expiresAt) || (Number(rec.notifyAt) || 0) + (60 * 60 * 1000);
    if (now > expiresAt) {
      const moved = { ...rec, status: "silenced", silencedAt: now };
      const updates = {};
      updates[`/scheduling/pendingFlagsDone/${id}`] = moved;
      updates[`/scheduling/pendingFlags/${id}`] = null;
      await db.ref().update(updates);
      result.pendingFlagsSilenced += 1;
    }
  }

  // ── Drag-flag terminal records ─────────────────────────────────
  const pendingDone = (await adminGet("/scheduling/pendingFlagsDone")) || {};
  for (const [id, rec] of Object.entries(pendingDone)) {
    if (!rec) {
      await db.ref(`/scheduling/pendingFlagsDone/${id}`).remove();
      result.pendingFlagsDoneDeleted += 1;
      continue;
    }
    const refTime = Math.max(
      Number(rec.firedAt) || 0,
      Number(rec.silencedAt) || 0,
      Number(rec.createdAt) || 0,
    );
    if (refTime > 0 && now - refTime > TERMINAL_RETENTION_MS) {
      await db.ref(`/scheduling/pendingFlagsDone/${id}`).remove();
      result.pendingFlagsDoneDeleted += 1;
    }
  }

  // ── Posted-fingerprint dedup records ───────────────────────────
  const postedFps = (await adminGet("/scheduling/postedFingerprints")) || {};
  for (const [hash, rec] of Object.entries(postedFps)) {
    const postedAt = Number(rec?.postedAt) || 0;
    if (postedAt > 0 && now - postedAt > POSTED_FP_RETENTION_MS) {
      await db.ref(`/scheduling/postedFingerprints/${hash}`).remove();
      result.postedFingerprintsDeleted += 1;
    } else if (!postedAt) {
      // Missing timestamp — drop.
      await db.ref(`/scheduling/postedFingerprints/${hash}`).remove();
      result.postedFingerprintsDeleted += 1;
    }
  }

  // ── Slack event-id dedup ───────────────────────────────────────
  const events = (await adminGet("/scheduling/events")) || {};
  for (const [eventId, e] of Object.entries(events)) {
    const receivedAt = Number(e?.receivedAt) || 0;
    const expiresAt = Number(e?.expiresAt) || 0;
    const refTime = expiresAt || receivedAt;
    if (refTime > 0 && now > refTime + EVENT_DEDUP_RETENTION_MS) {
      await db.ref(`/scheduling/events/${eventId}`).remove();
      result.eventsDeleted += 1;
    } else if (!refTime) {
      await db.ref(`/scheduling/events/${eventId}`).remove();
      result.eventsDeleted += 1;
    }
  }

  return result;
}
