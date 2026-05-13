// api/_calendar-utils.js
// Pure utilities for the Google Calendar shoot-sync feature.
// No I/O, no Firebase, no googleapis import — keeps this file
// trivially unit-testable from `node --test` without env vars.

import { createHash } from "crypto";

// ─── Deterministic event IDs ───────────────────────────────────────
// Google Calendar event IDs must be 5–1024 chars from base32hex
// (a-v + 0-9). We hash project+subtask, base32hex-encode, truncate
// to 26 chars (130 bits — plenty of collision resistance).
//
// Why deterministic: lets retries reuse the same id, so a partial
// failure on insert can be safely re-attempted. On 409 conflict
// (replay), we GET the existing event and adopt its id.
const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

function base32hexEncode(buf) {
  let bits = "";
  for (const byte of buf) {
    bits += byte.toString(2).padStart(8, "0");
  }
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32HEX_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export function eventIdFor(projectId, subtaskId) {
  const raw = createHash("sha256")
    .update(`viewix:${projectId}:${subtaskId}`)
    .digest();
  return base32hexEncode(raw).slice(0, 26);
}

// ─── Sydney-local datetime strings ─────────────────────────────────
// Returns the canonical "YYYY-MM-DDTHH:MM:00" string with NO Z and
// NO offset. Google Calendar treats this as wall-clock time in the
// supplied timeZone field. Constructing a `new Date()` from these
// inputs on Vercel (UTC server) would silently shift the wall time
// — never do that here.
function pad2(n) {
  return String(n).padStart(2, "0");
}

export function combineDateTimeSydney(date, time) {
  if (!date || !time) return null;
  // Accept "YYYY-MM-DD" and "HH:MM" (or "HH:MM:SS"); reject anything
  // else with null so callers can detect the validation miss.
  const dMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dMatch || !tMatch) return null;
  const yyyy = dMatch[1];
  const mm = pad2(parseInt(dMatch[2], 10));
  const dd = pad2(parseInt(dMatch[3], 10));
  const hh = pad2(parseInt(tMatch[1], 10));
  const mi = pad2(parseInt(tMatch[2], 10));
  // Allow seconds in the input but normalise output to :00 — Google
  // doesn't need second-level precision for shoots.
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00`;
}

// String compare works because the canonical form is fixed-width and
// zero-padded — lexical order matches chronological order in the
// SAME timezone. DST irrelevant for "is B later than A in Sydney
// wall-clock time" because both strings are wall-clock.
export function compareSydneyDateTimes(a, b) {
  if (!a || !b) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ─── Retry backoff ──────────────────────────────────────────────────
// Ladder: 1m → 5m → 15m → 1h → 6h. Cap at 6h so a persistent OAuth
// revocation doesn't hammer the logs every minute forever.
const BACKOFF_LADDER_MS = [
  60_000,
  300_000,
  900_000,
  3_600_000,
  21_600_000,
];

export function computeBackoff(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  const idx = Math.min(n - 1, BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[idx];
}

// ─── Decision function ─────────────────────────────────────────────
// Single source of truth for what the worker should do with a
// subtask. Returns { action: "sync" | "delete" | "hold-error", ... }.
// Splitting into three explicit outcomes is the v6 fix for the
// overloaded "isSynceable" boolean — the implementer can't
// accidentally delete a valid client invite because times got
// temporarily cleared during a producer edit.
export function getCalendarSyncDecision({ subtask, project }) {
  if (!subtask) {
    return { action: "delete", reason: "subtask-missing" };
  }

  // ── DELETE paths (event should not exist) ─────────────────────────
  if (subtask.syncToCalendar === false) {
    // Worker reads _cancellationMode off the queue entry to decide
    // sendUpdates ("all" or "none"). Default "all".
    return { action: "delete", reason: "toggle-off" };
  }
  if (subtask.stage !== "shoot") {
    return { action: "delete", reason: "stage-not-shoot", sendUpdates: "all" };
  }
  if (!subtask.startDate || !subtask.endDate) {
    return { action: "delete", reason: "unscheduled", sendUpdates: "all" };
  }
  if (!Array.isArray(subtask.assigneeIds) || subtask.assigneeIds.length === 0) {
    // Empty assigneeIds reads as "I've pulled the crew off this
    // shoot" — closer to cancel than to incomplete data. Delete with
    // cancellation. Flip to hold-error if this proves wrong in
    // practice.
    return { action: "delete", reason: "no-assignees", sendUpdates: "all" };
  }

  // ── HOLD-ERROR paths (event stays, error pill surfaces) ───────────
  if (!subtask.startTime || !subtask.endTime) {
    return {
      action: "hold-error",
      message: "Shoot times required — set startTime + endTime on the subtask.",
    };
  }
  const start = combineDateTimeSydney(subtask.startDate, subtask.startTime);
  const end = combineDateTimeSydney(subtask.endDate, subtask.endTime);
  if (!start || !end) {
    return {
      action: "hold-error",
      message: "Shoot dates / times malformed — expected YYYY-MM-DD and HH:MM.",
    };
  }
  if (compareSydneyDateTimes(end, start) <= 0) {
    return { action: "hold-error", message: "Shoot end must be after start." };
  }
  if (!project?.clientContact?.email) {
    return {
      action: "hold-error",
      message: "Client email missing on the project. Set it in the project detail panel.",
    };
  }

  return { action: "sync" };
}
