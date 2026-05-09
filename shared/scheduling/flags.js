// shared/scheduling/flags.js
//
// Flag type definitions + stable fingerprinting for dedup.
// Pure JS — no Node `crypto`, no Web Crypto. Hashing for use as an
// RTDB key happens server-side in api/_slack-helpers.js (which already
// imports Node crypto for HMAC). This module only produces the
// fingerprint STRING; the API layer hashes it before persistence.

// Flag kinds — stable identifiers used by detectFlags producers and
// consumers (narration, dedup, digest grouping).
export const FLAG_KINDS = {
  FIXED_TIME_CONFLICT: "fixedTimeConflict",
  MULTIPLE_UNTIMED_SHOOTS: "multipleUntimedShoots",
  OFF_DAY_ASSIGNED: "offDayAssigned",
  IN_OFFICE_IDLE: "inOfficeIdle",
  DAILY_UNDER_CAPACITY: "dailyUnderCapacity",
  DAILY_OVER_CAPACITY: "dailyOverCapacity",
  DAILY_HARD_OVER_CAPACITY: "dailyHardOverCapacity",
  EDIT_OVERRUN: "editOverrun",
  WEEK_DATA_MISMATCH: "weekDataMismatch",
  UNASSIGNED_SCHEDULED: "unassignedScheduled",
};

// Severity bucket per kind. Used by digest grouping (hard > warning > info)
// and to decide which kinds belong on Slack confirm cards vs digest only.
export const FLAG_SEVERITY = {
  fixedTimeConflict: "hard",
  multipleUntimedShoots: "warning",
  offDayAssigned: "hard",
  inOfficeIdle: "info",
  dailyUnderCapacity: "info",
  dailyOverCapacity: "warning",
  dailyHardOverCapacity: "hard",
  editOverrun: "warning",
  weekDataMismatch: "warning",
  unassignedScheduled: "info",
};

// Which kinds belong on Slack confirm cards. Under-capacity / idle /
// overrun are digest-only (noisy at scheduling time, useful in the
// morning briefing).
export const SCHEDULING_CARD_KINDS = new Set([
  "fixedTimeConflict",
  "multipleUntimedShoots",
  "offDayAssigned",
  "dailyOverCapacity",
  "dailyHardOverCapacity",
  "weekDataMismatch",
  "unassignedScheduled",
]);

// Stable string fingerprint per flag — used for:
//  - dedup at flusher time (don't repost the same flag inside 24h)
//  - dedup at detectFlagsForDateRange time (collapse same flag across days)
// The string is human-readable; the API layer hashes it into a short
// hex string when used as an RTDB key.
export function fingerprintFlag(flag) {
  if (!flag || !flag.kind) return "unknown";
  const f = flag;
  switch (f.kind) {
    case "fixedTimeConflict":
      return `ftc|${f.personId}|${f.date}|${(f.subtasks || [])
        .map(s => s.subtaskId).filter(Boolean).sort().join(",")}`;
    case "multipleUntimedShoots":
      return `mus|${f.personId}|${f.date}`;
    case "offDayAssigned":
      return `oda|${f.personId}|${f.date}`;
    case "inOfficeIdle":
      return `ioi|${f.personId}|${f.date}`;
    case "dailyUnderCapacity":
      // Bucket plannedHours so a tiny fluctuation doesn't change the fp.
      // Round to nearest 0.5h.
      return `duc|${f.personId}|${f.date}|${Math.round(f.plannedHours * 2) / 2}`;
    case "dailyOverCapacity":
      return `doc|${f.personId}|${f.date}|${Math.round(f.plannedHours * 2) / 2}`;
    case "dailyHardOverCapacity":
      return `dhoc|${f.personId}|${f.date}|${Math.round(f.plannedHours * 2) / 2}`;
    case "editOverrun":
      // Project + subtask uniquely identifies; ratio buckets to coarse
      // levels so we don't repost as ratio drifts.
      return `eor|${f.projectId}|${f.subtaskId}|${Math.round(f.ratio * 10) / 10}`;
    case "weekDataMismatch":
      return `wdm|${f.personId}|${f.date}|${f.subkind || ""}`;
    case "unassignedScheduled":
      return `uas|${f.projectId}|${f.subtaskId}|${f.startDate}`;
    default:
      // Unknown kind — fall back to stringify (won't dedupe well, but
      // at least produces a stable key).
      return JSON.stringify(f);
  }
}
