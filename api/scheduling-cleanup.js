// api/scheduling-cleanup.js
//
// Daily prune for the Slack scheduler's transient state:
//   /scheduling/pending/{shortId}    — proposals (used, cancelled, stale,
//                                       expired, or unfinished)
//   /scheduling/events/{event_id}    — Slack event-id dedup records
//
// Triggered by Vercel cron once per day (see vercel.json#crons). Also
// reachable via authenticated POST for manual runs.
//
// Retention:
//   - Pending proposals past their expiresAt → flip status to "expired"
//     so they can never accidentally apply, but keep the record one
//     more retention window for audit trace.
//   - Anything in a terminal state (used, cancelled, stale, expired)
//     older than 7 days → delete.
//   - Awaiting_clarification past expiresAt → mark expired.
//   - Event-id dedup entries older than 24h → delete (Slack's retry
//     window is much shorter; 24h is a comfortable cushion).

import { getAdmin } from "./_fb-admin.js";

export const config = { maxDuration: 60 };

const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EVENT_DEDUP_RETENTION_MS = 24 * 60 * 60 * 1000;  // 24 hours
const TERMINAL_STATUSES = new Set(["used", "cancelled", "stale", "expired"]);

export default async function handler(req, res) {
  // Cron path — Vercel sets x-vercel-cron: 1 on its scheduled invocations.
  // Block manual GET requests; require an authenticated POST otherwise.
  const isCron = req.headers["x-vercel-cron"] === "1";
  if (req.method === "GET" && !isCron) {
    return res.status(401).json({ error: "Cron header required" });
  }
  if (req.method !== "GET" && req.method !== "POST") {
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
    pendingExpired: 0,
    pendingDeleted: 0,
    eventsDeleted: 0,
    scannedPending: 0,
    scannedEvents: 0,
  };

  // ── Proposals ───────────────────────────────────────────────────
  const pendingSnap = await db.ref("/scheduling/pending").once("value");
  const pending = pendingSnap.val() || {};
  result.scannedPending = Object.keys(pending).length;

  for (const [shortId, p] of Object.entries(pending)) {
    if (!p || typeof p !== "object") {
      // Stray garbage — drop.
      await db.ref(`/scheduling/pending/${shortId}`).remove();
      result.pendingDeleted += 1;
      continue;
    }

    const status = p.status || "";
    const expiresAt = Number(p.expiresAt) || 0;
    const createdAt = Number(p.createdAt) || 0;

    // Mark live proposals as expired if past their TTL.
    if ((status === "pending" || status === "awaiting_clarification") && expiresAt > 0 && now > expiresAt) {
      await db.ref(`/scheduling/pending/${shortId}`).update({
        status: "expired",
        expiredAt: now,
      });
      result.pendingExpired += 1;
      continue;
    }

    // Delete terminal records older than the retention window.
    if (TERMINAL_STATUSES.has(status)) {
      const referenceTime = Math.max(
        Number(p.usedAt) || 0,
        Number(p.cancelledAt) || 0,
        Number(p.expiredAt) || 0,
        createdAt,
      );
      if (referenceTime > 0 && now - referenceTime > TERMINAL_RETENTION_MS) {
        await db.ref(`/scheduling/pending/${shortId}`).remove();
        result.pendingDeleted += 1;
      }
    }
  }

  // ── Event dedup ────────────────────────────────────────────────
  // These records exist solely to swallow Slack's event retries
  // within their ~3min retry budget. 24h is overkill but safe.
  const eventsSnap = await db.ref("/scheduling/events").once("value");
  const events = eventsSnap.val() || {};
  result.scannedEvents = Object.keys(events).length;

  for (const [eventId, e] of Object.entries(events)) {
    const receivedAt = Number(e?.receivedAt) || 0;
    const expiresAt = Number(e?.expiresAt) || 0;
    const referenceTime = expiresAt || receivedAt;
    if (referenceTime > 0 && now > referenceTime + EVENT_DEDUP_RETENTION_MS) {
      await db.ref(`/scheduling/events/${eventId}`).remove();
      result.eventsDeleted += 1;
    } else if (!referenceTime) {
      // Missing timestamp — can't reason about age, so drop.
      await db.ref(`/scheduling/events/${eventId}`).remove();
      result.eventsDeleted += 1;
    }
  }

  return result;
}
