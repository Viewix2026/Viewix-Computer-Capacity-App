// api/sync-shoot-calendar.js
//
// Vercel cron, fires every minute. Drains /calendarSyncQueue entries
// whose dueAt has elapsed, syncs shoot subtasks to the Viewix Google
// Calendar (create / patch / delete) with hello@viewix.com.au as the
// organiser, and emails invitations to the client + assigned crew.
//
// Architecture decisions (see plan doc + Codex review rounds for the
// full rationale; the highlights live here):
//
// • Queue-based, not per-tick scan. Producers push entries on edit;
//   worker only reads /calendarSyncQueue. Survives subtask deletion
//   (delete entries cache the eventId), supports project / editor
//   edit fan-out without scanning everything.
//
// • Atomic lock acquisition + release via RTDB transactions. Two
//   concurrent workers can both think they own a "free" lock under
//   read-then-write — the transaction is the primitive that closes
//   that race AND the "newer-edit clobbered on release" race in one
//   shot. Lock TTL of 5 min covers the function timeout.
//
// • dueAt + backoff re-checked INSIDE the transaction. A producer
//   re-enqueue between scan and lock would push dueAt 5 min into the
//   future; the transaction respects that or it'd claim an entry
//   that should still be debouncing.
//
// • Deterministic event IDs (sha256 → base32hex). Retries reuse the
//   same id, so a partial failure on insert can be safely re-attempted.
//   On 409 conflict (replay), we GET the existing event and adopt
//   its id. On 404 OR 410 from patch (event manually deleted in
//   Google Calendar), we fall through to create with the same id —
//   self-healing.
//
// • Decision function (sync/delete/hold-error) is the v6 fix for the
//   overloaded "isSynceable" boolean — implementer can't accidentally
//   delete a valid client invite because times got temporarily
//   cleared during a producer edit. See api/_calendar-utils.js.
//
// • CRON_SECRET Bearer auth. Vercel forwards the env var as
//   Authorization: Bearer ${CRON_SECRET} on cron requests but does
//   NOT gate the request itself — first line of the handler verifies.
//
// • Slack alert on persistent action: "delete" failures (attempts >= 5)
//   — the subtask is already nulled so there's no UI row to show the
//   error. Without this, orphan client-facing calendar invites would
//   accumulate silently.

import crypto from "crypto";
import { getAdmin, adminGet, adminPatch } from "./_fb-admin.js";
import {
  computeBackoff,
  eventIdFor,
  getCalendarSyncDecision,
} from "./_calendar-utils.js";
import {
  createShootEvent,
  updateShootEvent,
  deleteShootEvent,
  getEventById,
} from "./_google-calendar.js";

export const config = { maxDuration: 60 };

// Each tick processes at most BATCH_CAP entries. Deliberate ceiling
// to keep locks short and prevent one slow Google API call from
// starving everything behind it. Larger queues drain across multiple
// 1-min ticks.
const BATCH_CAP = 30;
const LOCK_TTL_MS = 5 * 60 * 1000;
const SLACK_ALERT_THRESHOLD = 5;

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || "";
  if (!expected) {
    return res.status(500).json({ error: "CRON_SECRET env var is not set" });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET (cron) or POST (manual audit) only" });
  }

  try {
    const result = await runWorker();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error("sync-shoot-calendar error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

async function runWorker() {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);

  const nowMs = Date.now();
  const queueRaw = (await adminGet("/calendarSyncQueue")) || {};
  const queueDepth = Object.keys(queueRaw).length;

  const due = Object.entries(queueRaw)
    .filter(([, e]) => e && e.dueAt && Date.parse(e.dueAt) <= nowMs)
    .filter(([, e]) => !(e.lockedUntil && Date.parse(e.lockedUntil) > nowMs))
    .filter(([, e]) => {
      const attempts = e.attempts || 0;
      if (attempts === 0) return true;
      const last = Date.parse(e.updatedAt || 0);
      return last + computeBackoff(attempts) <= nowMs;
    })
    .sort(([, a], [, b]) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .slice(0, BATCH_CAP);

  let processed = 0;
  let failed = 0;
  const failedDeletes = [];
  const recent = [];

  for (const [key, entry] of due) {
    const lockOwner = crypto.randomUUID();
    const ref = db.ref(`calendarSyncQueue/${key}`);
    const claimed = await acquireLock(ref, lockOwner, nowMs);
    if (!claimed) continue;

    let processError = null;
    let resultStatus = null;
    try {
      resultStatus = await processQueueEntry(claimed);

      // Atomic release — only delete if we still own the lock. If a
      // producer re-enqueued during processing, lockOwner won't match
      // and the entry stays in place for the next tick to pick up
      // with the newer data.
      await ref.transaction((cur) => {
        if (!cur) return;
        if (cur.lockOwner !== lockOwner) return;
        return null;
      });
      processed++;
    } catch (e) {
      processError = e?.message || String(e);
      failed++;
      const errAt = new Date().toISOString();
      // Failure release ALSO uses a transaction. adminPatch would
      // overwrite a newer re-enqueued entry blindly. Stamps
      // lastError + lastErrorAt onto the queue entry — for action:
      // "delete" the subtask is already nulled, so the queue entry
      // is the only place a failure can surface (audit endpoint
      // reads these).
      await ref.transaction((cur) => {
        if (!cur) return;
        if (cur.lockOwner !== lockOwner) return cur;
        return {
          ...cur,
          attempts: (cur.attempts || 0) + 1,
          lockedUntil: null,
          lockOwner: null,
          lastError: processError,
          lastErrorAt: errAt,
          updatedAt: errAt,
        };
      });
      // Mirror to the subtask too (sync actions only — delete
      // actions have no subtask row to write to).
      if (claimed.action === "sync") {
        try {
          const subtaskPath = `/projects/${claimed.projectId}/subtasks/${claimed.subtaskId}`;
          const existing = await adminGet(subtaskPath);
          if (existing) {
            await adminPatch(subtaskPath, {
              calendarSyncError: processError,
              calendarSyncErrorCount: (existing.calendarSyncErrorCount || 0) + 1,
            });
          }
        } catch (innerErr) {
          console.warn("sync-shoot-calendar: subtask error mirror failed:", innerErr?.message);
        }
      }
      // Slack alert on persistent delete failures (orphan-event
      // safety net).
      if (claimed.action === "delete") {
        await maybeAlertSlack(db, key, claimed, processError);
        failedDeletes.push({
          key,
          projectId: claimed.projectId,
          subtaskId: claimed.subtaskId,
          attempts: (claimed.attempts || 0) + 1,
          lastError: processError,
        });
      }
    }

    recent.push({
      key,
      action: claimed.action,
      result: processError ? "failed" : (resultStatus || "ok"),
      reason: claimed.reason || null,
      error: processError,
    });
  }

  return {
    processedCount: processed,
    failedCount: failed,
    queueDepth,
    dueCount: due.length,
    failedDeletes,
    recent,
  };
}

// ─── Lock acquisition ───────────────────────────────────────────────
// ALL checks (exists / locked elsewhere / due / backoff) live inside
// the transaction so the queue entry can drift between scan and lock
// without false-positives. Returns the claimed snapshot (the version
// the transaction wrote) so callers always work from that, not from
// the pre-filtered scan result.
async function acquireLock(ref, lockOwner, scanTimeMs) {
  let claimed = null;
  const tx = await ref.transaction((cur) => {
    if (!cur) return;
    const nowMs = Date.now();
    if (cur.lockedUntil && Date.parse(cur.lockedUntil) > nowMs) return;
    if (Date.parse(cur.dueAt) > nowMs) return;
    const attempts = cur.attempts || 0;
    if (attempts > 0) {
      const last = Date.parse(cur.updatedAt || 0);
      if (last + computeBackoff(attempts) > nowMs) return;
    }
    const next = {
      ...cur,
      lockOwner,
      lockedUntil: new Date(nowMs + LOCK_TTL_MS).toISOString(),
    };
    claimed = next;
    return next;
  });
  // void scanTimeMs is intentional — kept in the signature to make
  // future scan-vs-lock drift debugging easier.
  void scanTimeMs;
  if (!tx.committed || !claimed) return null;
  return claimed;
}

// ─── Per-entry processing ──────────────────────────────────────────
// Pure-ish: reads project/subtask via adminGet, dispatches on the
// decision function's action, calls Google Calendar via the
// _google-calendar.js wrappers, writes results back to the subtask
// row. Returns a short status string for the audit response.
async function processQueueEntry(entry) {
  const { projectId, subtaskId, action, calendarEventId: cachedEventId } = entry;
  if (!projectId || !subtaskId) return "skipped-malformed";

  const project = await adminGet(`/projects/${projectId}`);
  const subtaskPath = `/projects/${projectId}/subtasks/${subtaskId}`;
  const subtask = await adminGet(subtaskPath);

  // ─── Explicit-delete queue entry ─────────────────────────────────
  // Subtask is gone (producer hit the × button). Use the cached
  // calendarEventId stamped onto the queue at delete time. Fall back
  // to the deterministic id if cache is missing — same value.
  if (action === "delete") {
    const eventId = cachedEventId || eventIdFor(projectId, subtaskId);
    if (!eventId) return "no-event-id";
    const sendUpdates = entry._cancellationMode || "all";
    await deleteShootEvent({ eventId, sendUpdates });
    return "deleted";
  }

  // ─── Sync queue entry — run the decision function ───────────────
  const decision = getCalendarSyncDecision({ subtask, project });

  if (decision.action === "delete") {
    // Subtask still exists but the decision says the event should
    // not. Pick the right cancellation mode:
    //   - toggle-off: respect queueEntry._cancellationMode (the
    //                 confirm dialog's "all" / "none" choice)
    //   - everything else: "all" (clean cancellation)
    const sendUpdates =
      decision.reason === "toggle-off"
        ? entry._cancellationMode || "all"
        : decision.sendUpdates || "all";
    const eventId = subtask?.calendarEventId;
    if (!eventId) {
      // Nothing to clean up. Just clear any stale error.
      if (subtask?.calendarSyncError) {
        await adminPatch(subtaskPath, {
          calendarSyncError: null,
          calendarSyncErrorCount: null,
          lastCalendarSyncedAt: new Date().toISOString(),
        });
      }
      return `delete-noop-${decision.reason}`;
    }
    await deleteShootEvent({ eventId, sendUpdates });
    await adminPatch(subtaskPath, {
      calendarEventId: null,
      calendarEventHtmlLink: null,
      calendarSyncError: null,
      calendarSyncErrorCount: null,
      lastCalendarSyncedAt: new Date().toISOString(),
    });
    return `deleted-${decision.reason}`;
  }

  if (decision.action === "hold-error") {
    // Leave existing event as-is (don't orphan a valid client invite
    // on a transient validation blip). Surface the error on the
    // subtask row so the producer can see it.
    if (subtask) {
      await adminPatch(subtaskPath, {
        calendarSyncError: decision.message,
        calendarSyncErrorCount: (subtask.calendarSyncErrorCount || 0) + 1,
        lastCalendarSyncedAt: new Date().toISOString(),
      });
    }
    return `hold-error`;
  }

  // decision.action === "sync"
  const attendees = await buildAttendees({ project, subtask });
  const desiredEventId = eventIdFor(projectId, subtaskId);
  const existingEventId = subtask?.calendarEventId;

  if (existingEventId) {
    try {
      const result = await updateShootEvent({
        eventId: existingEventId,
        project,
        subtask,
        attendees,
      });
      await adminPatch(subtaskPath, {
        calendarEventId: result.id,
        calendarEventHtmlLink: result.htmlLink,
        calendarSyncError: null,
        calendarSyncErrorCount: 0,
        lastCalendarSyncedAt: new Date().toISOString(),
      });
      return "updated";
    } catch (e) {
      const status = e?.code || e?.response?.status;
      if (status === 404 || status === 410) {
        // Event was manually deleted in Google Calendar. Self-heal:
        // fall through to create with the deterministic id.
      } else {
        throw e;
      }
    }
  }

  // Create path — deterministic id, idempotent on 409 replay.
  try {
    const result = await createShootEvent({
      project,
      subtask,
      attendees,
      eventId: desiredEventId,
    });
    await adminPatch(subtaskPath, {
      calendarEventId: result.id,
      calendarEventHtmlLink: result.htmlLink,
      calendarSyncError: null,
      calendarSyncErrorCount: 0,
      lastCalendarSyncedAt: new Date().toISOString(),
    });
    return "created";
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 409) {
      // 409 — id already in use (replay after partial failure). GET
      // the existing event and adopt its id.
      const ev = await getEventById({ eventId: desiredEventId });
      await adminPatch(subtaskPath, {
        calendarEventId: ev.id,
        calendarEventHtmlLink: ev.htmlLink,
        calendarSyncError: null,
        calendarSyncErrorCount: 0,
        lastCalendarSyncedAt: new Date().toISOString(),
      });
      return "created-idempotent";
    }
    throw e;
  }
}

// ─── Attendee builder ──────────────────────────────────────────────
// Pulls the editor email roster, maps assigneeIds → email, dedupes
// with the client email. Editors with no email are silently omitted
// (producer fills the email in Capacity → fan-out enqueues a re-sync).
async function buildAttendees({ project, subtask }) {
  const clientEmail = project?.clientContact?.email;
  const editorsRaw = (await adminGet("/editors")) || [];
  const editorList = Array.isArray(editorsRaw)
    ? editorsRaw
    : Object.values(editorsRaw);
  const byId = new Map();
  for (const e of editorList) {
    if (e?.id) byId.set(e.id, e);
  }
  const assigneeIds = Array.isArray(subtask?.assigneeIds) ? subtask.assigneeIds : [];
  const crewEmails = assigneeIds
    .map((id) => byId.get(id)?.email)
    .filter((email) => !!email && String(email).includes("@"));

  const set = new Set();
  const attendees = [];
  if (clientEmail) {
    const lower = String(clientEmail).toLowerCase();
    if (!set.has(lower)) {
      set.add(lower);
      attendees.push({ email: clientEmail });
    }
  }
  for (const email of crewEmails) {
    const lower = String(email).toLowerCase();
    if (!set.has(lower)) {
      set.add(lower);
      attendees.push({ email });
    }
  }
  return attendees;
}

// ─── Slack alert ───────────────────────────────────────────────────
// Fired ONCE per offending queue entry — deduped via slackAlertedAt.
// Scoped to action: "delete" failures only because the subtask is
// already nulled (no UI row to show calendarSyncError). Sync-action
// failures keep their pill on the subtask row — Slack would be
// double-notification noise.
async function maybeAlertSlack(db, key, entry, errorMessage) {
  const attempts = (entry.attempts || 0) + 1;
  if (attempts < SLACK_ALERT_THRESHOLD) return;
  if (entry.slackAlertedAt) return;
  const webhook = process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL;
  if (!webhook) return;
  const safeErr = String(errorMessage || "(no detail)").slice(0, 500);
  const text = [
    `:warning: *Calendar sync — persistent delete failure*`,
    `Queue key: \`${key}\``,
    `Project: \`${entry.projectId}\``,
    `Subtask: \`${entry.subtaskId}\` (already deleted)`,
    `Attempts: ${attempts}`,
    `Error: ${safeErr}`,
    `Manual cleanup may be needed in Google Calendar for event \`${entry.calendarEventId || "(unknown)"}\`.`,
  ].join("\n");
  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      console.error("sync-shoot-calendar Slack post failed:", r.status);
      return;
    }
    await db
      .ref(`calendarSyncQueue/${key}/slackAlertedAt`)
      .set(new Date().toISOString());
  } catch (e) {
    console.error("sync-shoot-calendar Slack post error:", e?.message);
  }
}
