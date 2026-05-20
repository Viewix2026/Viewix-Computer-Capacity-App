// api/_socialSchedule.js
//
// Server-side schedule computation. The Phase 3 modal sends preferences
// (daysOfWeek, videosPerWeek, times, startDate) + N items; this module
// turns that into N concrete ISO postAt timestamps in Sydney time.
//
// Per the plan + the broader Viewix scheduling brain convention: ALL
// times are Sydney-local. We compute postAt as an ISO string with the
// correct Sydney offset (AEST +10:00 or AEDT +11:00 depending on DST).
// Zernio accepts ISO with offset; we don't need to convert to UTC.
//
// Server is final authority: the modal computes a preview client-side
// for display, but the endpoint recomputes here and overwrites
// whatever the client sent. Trust path is the server.

// Day name → 0-6 (Sun=0, Sat=6) so we can match against
// Date.getDay()/getUTCDay() output.
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Get the day-of-week (0-6) of a Date as observed in Sydney. Uses Intl
// so DST is handled correctly automatically.
function sydneyDay(date) {
  const wd = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
  }).format(date).toLowerCase().slice(0, 3); // "mon", "tue", ...
  return DAY_INDEX[wd] ?? 0;
}

// Compute the Sydney UTC offset (in minutes) for a given UTC moment.
// Returns +600 (AEST) or +660 (AEDT) depending on DST.
function sydneyOffsetMinutes(utcDate) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(utcDate);
  const raw = parts.find(p => p.type === "timeZoneName")?.value || "GMT+10:00";
  const m = raw.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 600;
  const sign = m[1] === "+" ? 1 : -1;
  const hh = parseInt(m[2], 10);
  const mm = m[3] ? parseInt(m[3], 10) : 0;
  return sign * (hh * 60 + mm);
}

// Format a Sydney-local (year, month, day, hour, minute) tuple as an
// ISO string with the correct +10:00 / +11:00 offset for that moment.
// E.g. (2026, 5, 21, 9, 0) → "2026-05-21T09:00:00+10:00"
//   (May = AEST = +10)     (December = AEDT = +11)
function sydneyIso(year, month1to12, day, hour, minute) {
  // Build a UTC moment that EQUALS the Sydney-local time we want, by
  // probing the offset at roughly that moment. This is a two-step
  // because the offset can shift across DST boundaries within the
  // same day (rare but possible — e.g. the Sunday morning fall-back).
  const naive = new Date(Date.UTC(year, month1to12 - 1, day, hour, minute, 0));
  const off = sydneyOffsetMinutes(naive);
  const sign = off >= 0 ? "+" : "-";
  const ao = Math.abs(off);
  const oh = String(Math.floor(ao / 60)).padStart(2, "0");
  const om = String(ao % 60).padStart(2, "0");
  return (
    `${year}-${String(month1to12).padStart(2, "0")}-${String(day).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${sign}${oh}:${om}`
  );
}

// Parse a "YYYY-MM-DD" date string and a "HH:MM" time string into the
// (year, month, day, hour, minute) tuple sydneyIso expects.
function parseDateTime(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ""));
  if (!dm) throw new Error(`Invalid date: ${dateStr}`);
  if (!tm) throw new Error(`Invalid time: ${timeStr}`);
  return {
    year:   parseInt(dm[1], 10),
    month:  parseInt(dm[2], 10),
    day:    parseInt(dm[3], 10),
    hour:   parseInt(tm[1], 10),
    minute: parseInt(tm[2], 10),
  };
}

// Advance a (year, month, day) tuple by N calendar days. Uses Date
// internally for the calendar arithmetic but stays in Sydney by
// rebuilding the tuple from the resulting UTC midnight.
function addDays({ year, month, day }, days) {
  // Sydney midnight = UTC 14:00 prior day (AEST) or 13:00 (AEDT).
  // Using Date.UTC at noon avoids the DST edge entirely.
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Day index (0-6) of a (year, month, day) in Sydney TZ.
function dowOf({ year, month, day }, hour = 12, minute = 0) {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  return sydneyDay(probe);
}

// ── computeSchedule ───────────────────────────────────────────────
//
//   prefs:
//     daysOfWeek: ["mon", "wed", "fri"]          // posting days
//     videosPerWeek: 3                            // cadence cap
//     times: { mon: "09:00", wed: "09:00", ... } // per-day time, or
//                                                   a single "default"
//                                                   field as fallback
//     startDate: "YYYY-MM-DD"                     // anchor (Sydney)
//   itemCount: how many posts to schedule
//
// Returns an array of length itemCount: [{ postAt: ISO_STRING }, ...]
//
// Behaviour: walk forward from startDate one day at a time. On each
// day that matches daysOfWeek, schedule one post at the time for that
// day. Repeat until itemCount posts are scheduled. videosPerWeek caps
// the posts per ISO week (Mon-Sun); if exceeded, skip the remaining
// days in that week and continue from next Monday.
export function computeSchedule(prefs, itemCount) {
  const days = (prefs?.daysOfWeek || []).map(String).map(s => s.toLowerCase().slice(0, 3)).filter(d => DAY_INDEX[d] != null);
  if (days.length === 0) throw new Error("computeSchedule: at least one day required");
  const cap = Math.max(1, Math.min(7, Number(prefs?.videosPerWeek) || days.length));
  const startStr = prefs?.startDate;
  if (!startStr) throw new Error("computeSchedule: startDate required");
  // Times: per-day map, else a single fallback. Default 09:00.
  const timesMap = (prefs?.times && typeof prefs.times === "object") ? prefs.times : {};
  const fallbackTime = String(prefs?.defaultTime || timesMap.default || "09:00");
  const timeFor = (d) => String(timesMap[d] || fallbackTime || "09:00");

  // Walk.
  const out = [];
  const targetSet = new Set(days.map(d => DAY_INDEX[d]));
  let cursor = parseDateTime(startStr, "00:00");
  // Track which Sydney-ISO-week we're in (year + weekNumber). When we
  // cross into a new week, reset the per-week counter.
  let weekKey = null;
  let weekCount = 0;
  let safety = 0;

  while (out.length < itemCount && safety++ < 366 * 4) { // 4-year safety bound
    const dow = dowOf(cursor);
    if (targetSet.has(dow)) {
      // Same-week tracking — Mon-based ISO week. Use a coarse key:
      // (year, ordinalMonday) by snapping the cursor back to its
      // Monday. Cheap to compute.
      const isoMonday = (() => {
        let d = { ...cursor };
        let dw = dow;
        // Sunday in JS = 0; we treat Mon as start. Days back to Mon:
        // (dw + 6) % 7.
        const back = (dw + 6) % 7;
        return addDays(d, -back);
      })();
      const wk = `${isoMonday.year}-${String(isoMonday.month).padStart(2, "0")}-${String(isoMonday.day).padStart(2, "0")}`;
      if (wk !== weekKey) {
        weekKey = wk;
        weekCount = 0;
      }
      if (weekCount < cap) {
        const dayName = Object.keys(DAY_INDEX).find(k => DAY_INDEX[k] === dow);
        const { hour, minute } = parseDateTime("2000-01-01", timeFor(dayName));
        out.push({
          postAt: sydneyIso(cursor.year, cursor.month, cursor.day, hour, minute),
        });
        weekCount++;
      }
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}

// Re-export for tests + other callers.
export const _internals = { sydneyDay, sydneyOffsetMinutes, sydneyIso, parseDateTime, addDays, dowOf };
