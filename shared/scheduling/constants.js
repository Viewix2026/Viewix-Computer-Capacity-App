// shared/scheduling/constants.js
//
// Tunable thresholds for the scheduling brain. Pure data — no I/O, no
// React, no Node-only imports. Importable by both /api/* and /src/*.

// Daily capacity bands (Jeremy's "looser bands, 8h target" choice).
// Below underMax => underCapacity flag fires.
// Above hardMin => hardOverCapacity flag fires.
// Above warningMin (and below hardMin) => overCapacity flag fires.
// Between underMax and warningMin => healthy, no flag.
export const CAPACITY_BANDS = {
  target: 8,        // hours — full productive day per Jeremy
  underMax: 4,
  warningMin: 8,
  hardMin: 10,
};

// When a shoot subtask has no startTime/endTime, the brain assumes
// this many hours of presumed-load. Half-day-ish — Jeremy explicitly
// rejected the "shoot = full day" assumption (people often work after
// shoots wrap).
export const UNTIMED_SHOOT_HOURS = 4;

// Per-stage hour estimates used when no live videoTypeStats average
// exists (i.e., not enough completed projects of that type+stage to
// trust an average). The deterministic checker uses these for capacity
// math; they're never the basis for "edit overrun" — that requires a
// real average to compare against.
export const FALLBACKS = {
  edit: 3.5,
  revisions: 1.5,
  preProduction: 1.5,
  hold: 0,
};

// Need this many completed (status === "done") subtasks of a given
// videoType+stage before the live average is trusted. Below this, the
// stats output omits the entry and consumers fall through to FALLBACKS.
export const MIN_SAMPLE_SIZE = 3;

// editOverrun fires when actual logged hours > avgHours * OVERRUN_RATIO.
// 1.5x is "noticeably long" — tighter would be noisy, looser would
// miss real overruns.
export const OVERRUN_RATIO = 1.5;

// Slack/RTDB-key safety: hashed fingerprints get truncated to this many
// hex chars when used as a /scheduling/postedFingerprints/{key}.
export const FP_HASH_LEN = 16;

// Look-ahead window for editorFreeCapacity in awareness (Phase 1A).
// "How many hours of free capacity does Luke have over the next 14 days?"
export const FREE_CAPACITY_WINDOW_DAYS = 14;
