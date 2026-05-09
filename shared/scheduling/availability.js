// shared/scheduling/availability.js
//
// "Is editor X working on date Y?" + supporting date helpers.
// Pure JS; no React/admin imports. Importable by both /api/* and /src/*.
//
// Extracts the helpers that previously lived privately in
// api/roll-overdue-edits.js. The cron there imports from this module
// so behaviour stays identical.

// JS Date.getDay() is 0=Sun..6=Sat. The dashboard's editor schema uses
// {mon, tue, wed, thu, fri} as keys. Sat / Sun aren't represented and
// always read as "off".
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Format a JS Date as YYYY-MM-DD using en-CA's native format. Avoids
// manual zero-padding and timezone arithmetic.
export function fmtDate(d) {
  return new Intl.DateTimeFormat("en-CA").format(d);
}

// "Today" in Sydney as YYYY-MM-DD. The dashboard stores all subtask
// dates in this Sydney-local format.
export function todaySydney() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

// Time-of-day fields in Sydney (hour, minute, weekday) for cron gating.
// weekday: 0=Sun..6=Sat to match Date.getDay().
export function nowInSydney() {
  // Use formatToParts so we get integer hour/minute/day values directly.
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const weekdayShort = get("weekday"); // "Mon", "Tue", etc.
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute, weekday: weekdayMap[weekdayShort] ?? -1 };
}

// JS-Date in, JS-Date out. Time snapped to 00:00 local. Sunday rolls
// back to the prior week's Monday (matches the rest of the codebase's
// "weeks start Monday" convention). Mirrors src/utils.js getMonday.
export function getMonday(d) {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day + (day === 0 ? -6 : 1));
  x.setHours(0, 0, 0, 0);
  return x;
}

// Collapse a weekData cell value into a normalised string.
// Mirrors src/utils.js dayVal — kept separate here to avoid a frontend
// → shared import cycle when /src/utils.js wants to keep its own copy.
export function dayVal(v) {
  if (v === true || v === "in") return "in";
  if (v === "shoot") return "shoot";
  return "off";
}

// Look up the resolved status for an editor on a date — checks weekData
// first, falls back to defaultDays. Returns "in" / "shoot" / "off".
//
// `date` may be a Date object OR a YYYY-MM-DD string (we normalise).
export function weekDataStatusForEditorOnDate(editor, date, weekDataByKey) {
  if (!editor) return "off";
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : date;
  const dayKey = DAY_KEYS[d.getDay()];
  if (!dayKey || dayKey === "sat" || dayKey === "sun") return "off";

  const wkKey = fmtDate(getMonday(d));
  const weekRec = weekDataByKey?.[wkKey];
  if (weekRec?.editors && Array.isArray(weekRec.editors)) {
    const wkEditor = weekRec.editors.find(e => e?.id === editor.id);
    if (wkEditor && wkEditor.days) {
      return dayVal(wkEditor.days[dayKey]);
    }
  }
  // Fallback: defaultDays only stores `true` for working days.
  return editor.defaultDays?.[dayKey] === true ? "in" : "off";
}

// "Is editor X actually in the edit suite on date Y?" — strict version.
// "shoot" returns false (they're working but not available for edits).
// Used by the roll-overdue-edits cron to decide where to roll a stuck
// edit subtask.
export function isEditorInOnDate(editor, date, weekDataByKey) {
  return weekDataStatusForEditorOnDate(editor, date, weekDataByKey) === "in";
}

// "Is editor X working on date Y?" — broader version. "shoot" returns
// true (they're at work, just not on flexible edit work). Used by the
// brain to decide whether off-day-assigned should fire.
export function isWorkingOnDate(editor, date, weekDataByKey) {
  const status = weekDataStatusForEditorOnDate(editor, date, weekDataByKey);
  return status === "in" || status === "shoot";
}

// Walk forward from `fromDate` (YYYY-MM-DD, inclusive) up to a 21-day
// safety cap. Returns the first date isEditorInOnDate returns true for,
// or null if no match. Used by roll-overdue-edits to find the next
// working day for a rolling subtask.
export function nextWorkingDayFor(editor, fromDate, weekDataByKey) {
  const start = new Date(`${fromDate}T00:00:00`);
  for (let i = 0; i <= 21; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (isEditorInOnDate(editor, d, weekDataByKey)) {
      return fmtDate(d);
    }
  }
  return null;
}

// Iterate dates in [start, end] inclusive, yielding YYYY-MM-DD strings.
// Used by detectFlagsForDateRange in conflicts.js.
export function* datesInRange(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  if (isNaN(start) || isNaN(end) || end < start) return;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    yield fmtDate(d);
  }
}
