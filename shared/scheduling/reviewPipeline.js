// shared/scheduling/reviewPipeline.js
//
// Phase 4 (#C/#D/#E) — pure helpers for the internal-review pipeline.
// No React / no Firebase, so they're unit-testable and shared by the
// trigger endpoint + the Slack interactivity handler.
//
//   projectEditsAllFinished — "all video edits done" gate for kicking off
//     the internal review (16:9 masters / SO video edits; reformats are a
//     post-review step and don't gate it).
//   earliestCommonWorkingDay — the soonest day every confirmed attendee
//     is working, for auto-booking the 30-min review.

import { isWorkingOnDate, fmtDate } from "./availability.js";

const lc = (s) => (s || "").toString().trim().toLowerCase();
const isDone = (st) => lc(st?.status) === "done";

// A "video edit" = stage edit, linked to a video, and NOT a reformat
// (reformats are created AFTER the review). Mirrors the seeding in
// api/meta-ads.js + api/social-organic.js (videoId-stamped edit subtasks).
export function isVideoEditSubtask(st) {
  if (!st || !st.videoId) return false;
  if (st.reformatOfSubtaskId) return false; // a reformat, not a master/video edit
  const stage = st.stage || "";
  if (stage && stage !== "edit") return false;
  // name-based fallback for legacy rows with no explicit stage
  if (!stage) return lc(st.name).includes("edit");
  return true;
}

// True when the project has ≥1 video edit and EVERY video edit is done.
// (Zero video edits → false: nothing to review yet.)
export function projectEditsAllFinished(project) {
  const subs = project?.subtasks ? Object.values(project.subtasks) : [];
  const videoEdits = subs.filter(isVideoEditSubtask);
  if (videoEdits.length === 0) return false;
  return videoEdits.every(isDone);
}

// Earliest day (from `fromDate`, inclusive, 21-day cap) on which ALL of
// the given attendee editors are working. Returns YYYY-MM-DD or null.
// Used to auto-book the 30-min internal review once attendance is known.
export function earliestCommonWorkingDay(attendeeEditorIds, editors, weekDataByKey, fromDate) {
  const ids = (attendeeEditorIds || []).filter(Boolean);
  if (ids.length === 0) return null;
  const byId = new Map((editors || []).map(e => [e.id, e]));
  const attendees = ids.map(id => byId.get(id)).filter(Boolean);
  if (attendees.length === 0) return null;

  const start = new Date(`${fromDate}T00:00:00`);
  if (isNaN(start)) return null;
  for (let i = 0; i <= 21; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (attendees.every(e => isWorkingOnDate(e, d, weekDataByKey))) {
      return fmtDate(d);
    }
  }
  return null;
}
