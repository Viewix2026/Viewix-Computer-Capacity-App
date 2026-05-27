// api/sync-shoot-calendar.js
//
// Vercel cron, fires every minute. Drains /calendarSyncQueue entries
// whose dueAt has elapsed, syncs shoot subtasks to the Viewix Google
// Calendar (create / patch / delete) with hello@viewix.com.au as the
// organiser, and emails invitations to the client + assigned crew.
//
// Architecture (see plan doc sections A–F + the historical v7 doc for
// the full rationale; highlights here):
//
// • Queue-based, not per-tick scan. Producers push entries on edit;
//   worker only reads /calendarSyncQueue. Survives subtask deletion
//   (delete entries cache the eventId).
// • Atomic lock acquire + release via RTDB transactions. Closes the
//   duplicate-worker race AND the "newer-edit clobbered on release"
//   race in one primitive. dueAt + backoff re-checked INSIDE the
//   transaction so a producer re-enqueue between scan and lock can't
//   be claimed early.
// • Deterministic event IDs → idempotent create (409 → adopt existing)
//   and self-healing patch (404/410 → recreate same id).
// • Decision function (sync/delete/hold-error) is the single source of
//   truth — see api/_calendar-utils.js. Empty crew = hold-error (E1):
//   event stays live, error pill surfaces, no cancellation email.
// • CRON_SECRET Bearer auth (Vercel forwards it; handler verifies).
// • Slack alert on persistent action:"delete" failures (subtask gone,
//   no UI row to show the error).

import crypto from "crypto";
import { getAdmin, adminGet, adminPatch } from "./_fb-admin.js";
import { isAuthorizedCron } from "./_cronAuth.js";
import { computeBackoff, eventIdFor, getCalendarSyncDecision } from "./_calendar-utils.js";
import {
  createShootEvent,
  updateShootEvent,
  deleteShootEvent,
  getEventById,
} from "./_google-calendar.js";

export const config = { maxDuration: 60 };

const BATCH_CAP = 30;
const LOCK_TTL_MS = 5 * 60 * 1000;
const SLACK_ALERT_THRESHOLD = 5;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET (cron) or POST (manual audit) only" });
  }
  // Auth via the shared cron helper (api/_cronAuth.js). Accepts the
  // Vercel-injected `Authorization: Bearer ${CRON_SECRET}` OR the
  // presence of the `x-vercel-cron` header OR `?secret=CRON_TEST_SECRET`.
  // The earlier hand-rolled Bearer-only check silently 401'd every real
  // cron invocation (same incident class documented in _cronAuth.js,
  // 2026-05-16) — the queue entry sat unprocessed with attempts:0.
  const auth = isAuthorizedCron(req);
  if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });
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
      return Date.parse(e.updatedAt || 0) + computeBackoff(attempts) <= nowMs;
    })
    .sort(([, a], [, b]) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .slice(0, BATCH_CAP);

  // TEMP diagnostic (calendar-sync go-live): log exactly what the worker
  // sees so we can tell whether a stuck entry is being seen as due.
  // Remove once sync is confirmed working in production.
  console.log("[cal-sync diag]", JSON.stringify({
    now: new Date(nowMs).toISOString(),
    queueDepth,
    dueCount: due.length,
    keys: Object.keys(queueRaw),
    sample: Object.entries(queueRaw).slice(0, 5).map(([k, e]) => ({
      k,
      action: e?.action,
      dueAt: e?.dueAt,
      dueDelta: e?.dueAt ? Date.parse(e.dueAt) - nowMs : null,
      attempts: e?.attempts || 0,
      locked: !!e?.lockedUntil,
    })),
  }));

  let processed = 0;
  let failed = 0;
  const failedDeletes = [];
  const recent = [];

  for (const [key, entry] of due) {
    const lockOwner = crypto.randomUUID();
    const ref = db.ref(`calendarSyncQueue/${key}`);
    const claimed = await acquireLock(ref, lockOwner);
    if (!claimed) continue;

    let processError = null;
    let resultStatus = null;
    try {
      resultStatus = await processQueueEntry(claimed);
      // Release — only delete if we still own the lock (newer edit
      // re-claims → lockOwner mismatch → leave for next tick).
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

  return { processedCount: processed, failedCount: failed, queueDepth, dueCount: due.length, failedDeletes, recent };
}

// ALL checks (exists / locked elsewhere / due / backoff) live inside
// the transaction so the queue entry can drift between scan and lock
// without false-positives. Returns the claimed snapshot.
async function acquireLock(ref, lockOwner) {
  let claimed = null;
  const tx = await ref.transaction((cur) => {
    if (!cur) return;
    const nowMs = Date.now();
    if (cur.lockedUntil && Date.parse(cur.lockedUntil) > nowMs) return;
    if (Date.parse(cur.dueAt) > nowMs) return;
    const attempts = cur.attempts || 0;
    if (attempts > 0 && Date.parse(cur.updatedAt || 0) + computeBackoff(attempts) > nowMs) return;
    const next = { ...cur, lockOwner, lockedUntil: new Date(nowMs + LOCK_TTL_MS).toISOString() };
    claimed = next;
    return next;
  });
  if (!tx.committed || !claimed) return null;
  return claimed;
}

async function processQueueEntry(entry) {
  const { projectId, subtaskId, action, calendarEventId: cachedEventId } = entry;
  if (!projectId || !subtaskId) return "skipped-malformed";

  const project = await adminGet(`/projects/${projectId}`);
  const subtaskPath = `/projects/${projectId}/subtasks/${subtaskId}`;
  const subtask = await adminGet(subtaskPath);

  // Explicit-delete queue entry — subtask is gone, use cached eventId.
  if (action === "delete") {
    const eventId = cachedEventId || eventIdFor(projectId, subtaskId);
    if (!eventId) return "no-event-id";
    const sendUpdates = entry._cancellationMode || "all";
    await deleteShootEvent({ eventId, sendUpdates });
    return "deleted";
  }

  const decision = getCalendarSyncDecision({ subtask, project });

  if (decision.action === "delete") {
    const sendUpdates =
      decision.reason === "toggle-off"
        ? entry._cancellationMode || "all"
        : decision.sendUpdates || "all";
    const eventId = subtask?.calendarEventId;
    if (!eventId) {
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
    // on a transient state). Surface the warning on the subtask row.
    if (subtask) {
      await adminPatch(subtaskPath, {
        calendarSyncError: decision.message,
        calendarSyncErrorCount: (subtask.calendarSyncErrorCount || 0) + 1,
        lastCalendarSyncedAt: new Date().toISOString(),
      });
    }
    return "hold-error";
  }

  // decision.action === "sync"
  const attendees = await buildAttendees({ project, subtask });
  const desiredEventId = eventIdFor(projectId, subtaskId);
  const existingEventId = subtask?.calendarEventId;

  if (existingEventId) {
    try {
      const result = await updateShootEvent({ eventId: existingEventId, project, subtask, attendees });
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
      if (status !== 404 && status !== 410) throw e;
      // Event manually deleted in Google → self-heal via create below.
    }
  }

  try {
    const result = await createShootEvent({ project, subtask, attendees, eventId: desiredEventId });
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

// Pull the editor email roster, map assigneeIds → email, dedupe with
// the client email. Editors with no email are silently omitted
// (producer fills the email in Capacity → fan-out enqueues a re-sync).
async function buildAttendees({ project, subtask }) {
  const clientEmail = project?.clientContact?.email;
  const editorsRaw = (await adminGet("/editors")) || [];
  const editorList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw);
  const byId = new Map();
  for (const e of editorList) if (e?.id) byId.set(e.id, e);
  const assigneeIds = Array.isArray(subtask?.assigneeIds) ? subtask.assigneeIds : [];
  const crewEmails = assigneeIds
    .map((id) => byId.get(id)?.email)
    .filter((email) => !!email && String(email).includes("@"));

  const set = new Set();
  const attendees = [];
  if (clientEmail) {
    const lower = String(clientEmail).toLowerCase();
    if (!set.has(lower)) { set.add(lower); attendees.push({ email: clientEmail }); }
  }
  for (const email of crewEmails) {
    const lower = String(email).toLowerCase();
    if (!set.has(lower)) { set.add(lower); attendees.push({ email }); }
  }
  return attendees;
}

// Fired ONCE per offending queue entry — deduped via slackAlertedAt.
// Scoped to action:"delete" failures (subtask already nulled, no UI
// row to show the error). Reuses the existing project-leads webhook.
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
    if (!r.ok) { console.error("sync-shoot-calendar Slack post failed:", r.status); return; }
    await db.ref(`calendarSyncQueue/${key}/slackAlertedAt`).set(new Date().toISOString());
  } catch (e) {
    console.error("sync-shoot-calendar Slack post error:", e?.message);
  }
}
