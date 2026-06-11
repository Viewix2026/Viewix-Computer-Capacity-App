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
// • Read-then-write lock (lockOwner + lockedUntil), NOT a transaction.
//   acquireLock reads the live entry, validates (exists / not locked /
//   due / not in backoff), then stamps the lock. Release/error re-read
//   and only mutate if lockOwner still matches. This is the deliberate
//   model: a Vercel cron never overlaps itself (sub-second runs, 60s
//   cap), and deterministic event IDs make a double-process idempotent,
//   so the stricter RTDB transaction (which aborted on a cold-cache
//   null first-call and silently skipped every due entry) isn't needed.
// • Deterministic event IDs → idempotent create (409 → adopt existing)
//   and self-healing patch (404/410 → recreate same id).
// • Decision function (sync/delete/hold-error) is the single source of
//   truth — see api/_calendar-utils.js. Empty crew = hold-error (E1):
//   event stays live, error pill surfaces, no cancellation email.
// • Auth via isAuthorizedCron (api/_cronAuth.js): Vercel-injected
//   Bearer CRON_SECRET, or ?secret=CRON_TEST_SECRET for manual runs.
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
} from "./_google-calendar.js";

export const config = { maxDuration: 60 };

const BATCH_CAP = 30;
const LOCK_TTL_MS = 5 * 60 * 1000;
const SLACK_ALERT_THRESHOLD = 5;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET (cron) or POST (manual audit) only" });
  }
  // Auth via the shared cron helper (api/_cronAuth.js). With
  // CRON_SECRET set (production) it accepts ONLY the Vercel-injected
  // `Authorization: Bearer ${CRON_SECRET}` or a manual
  // `?secret=${CRON_TEST_SECRET}`. A forged `x-vercel-cron` header is
  // rejected (it's only honoured as a fallback when CRON_SECRET is
  // unset). The earlier hand-rolled Bearer-only check here silently
  // 401'd every real cron invocation, so we defer to the shared helper.
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
      // Release — only delete if we still own the lock (a newer edit
      // re-claims by overwriting lockOwner → we leave it for next tick).
      // Read-then-write rather than a transaction: the admin SDK's
      // transaction first-call ran against a cold cache (cur=null) and
      // the `if (!cur) return` aborted it, silently skipping every due
      // entry. The cron never overlaps itself, so a plain guarded
      // write is safe and correct.
      const relSnap = await ref.once("value");
      const relCur = relSnap.val();
      if (relCur && relCur.lockOwner === lockOwner) await ref.set(null);
      processed++;
    } catch (e) {
      processError = e?.message || String(e);
      failed++;
      const errAt = new Date().toISOString();
      const errSnap = await ref.once("value");
      const errCur = errSnap.val();
      if (errCur && errCur.lockOwner === lockOwner) {
        await ref.set({
          ...errCur,
          attempts: (errCur.attempts || 0) + 1,
          lockedUntil: null,
          lockOwner: null,
          lastError: processError,
          lastErrorAt: errAt,
          updatedAt: errAt,
        });
      }
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

// Claim a queue entry by stamping lockOwner + lockedUntil, after
// re-checking (against the live server value) that it still exists,
// isn't locked elsewhere, is due, and isn't in backoff.
//
// Read-then-write, NOT a transaction. The admin SDK's transaction
// invoked the update callback against a cold local cache (cur=null)
// on the first pass; the `if (!cur) return` aborted it before any
// server read, so acquireLock returned null and EVERY due entry was
// silently skipped (processedCount:0, failedCount:0 — the go-live
// bug). A Vercel cron never overlaps itself (sub-second runs, 60s
// cap), and the deterministic event IDs make a double-process
// idempotent anyway, so a plain guarded write is safe and correct.
async function acquireLock(ref, lockOwner) {
  const snap = await ref.once("value");
  const cur = snap.val();
  if (!cur) return null;
  const nowMs = Date.now();
  if (cur.lockedUntil && Date.parse(cur.lockedUntil) > nowMs) return null;
  if (Date.parse(cur.dueAt) > nowMs) return null;
  const attempts = cur.attempts || 0;
  if (attempts > 0 && Date.parse(cur.updatedAt || 0) + computeBackoff(attempts) > nowMs) return null;
  const next = { ...cur, lockOwner, lockedUntil: new Date(nowMs + LOCK_TTL_MS).toISOString() };
  await ref.set(next);
  return next;
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
      // The deterministic id already exists. Two ways to get here: a
      // previous partial run inserted the event (replay), or the event
      // was deleted and Google kept it as a "cancelled" TOMBSTONE —
      // insert with the same id 409s forever after that. Adopting the
      // event as-is (the old behaviour) silently adopted the
      // tombstone: the dashboard stamped success while the calendar
      // showed nothing (gemIQ / Picup Media, 2026-06-10). Patch the
      // full payload instead — it carries status:"confirmed", which
      // revives a tombstone and is a no-op on a live event.
      const result = await updateShootEvent({ eventId: desiredEventId, project, subtask, attendees });
      await adminPatch(subtaskPath, {
        calendarEventId: result.id,
        calendarEventHtmlLink: result.htmlLink,
        calendarSyncError: null,
        calendarSyncErrorCount: 0,
        lastCalendarSyncedAt: new Date().toISOString(),
      });
      return "revived-idempotent";
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
