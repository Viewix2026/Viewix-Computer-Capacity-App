// api/_fathom-detect.js
// Salesperson detection for Fathom webhook meetings. Extracted from
// fathom-webhook.js so the backfill script and tests can use the same
// logic without importing the whole handler.

// Salespeople to detect (order matters — longest first to avoid partial matches)
export const SALESPEOPLE = ["Brandon", "Jeremy"];

// Try to detect the Viewix salesperson from whatever the webhook sender gave
// us. Fathom's native payload has `invitees` as objects; Zapier/Make may send
// `attendees`, `participants`, or individual `hostName`/`organizer` fields;
// Fathom's own webhooks use `recorded_by` and `calendar_invitees`.
// We throw everything into one haystack and look for SALESPEOPLE substrings.
export function detectSalesperson(invitees, meetingName, extras = {}) {
  const inviteeNames = (invitees || []).map(i => {
    if (typeof i === "string") return i;
    return (i?.name || i?.displayName || i?.fullName || i?.email || "").toString();
  });
  const rb = extras.recordedBy;
  const extraFields = [
    extras.hostName, extras.host, extras.organizer, extras.owner,
    extras.meetingHost, extras.scheduledBy, extras.assignedTo,
    typeof rb === "string" ? rb : (rb?.name || rb?.email || ""),
    ...(Array.isArray(extras.attendees) ? extras.attendees.map(a => typeof a === "string" ? a : (a?.name || a?.email || "")) : []),
    ...(Array.isArray(extras.participants) ? extras.participants.map(a => typeof a === "string" ? a : (a?.name || a?.email || "")) : []),
    ...(Array.isArray(extras.calendarInvitees) ? extras.calendarInvitees.map(a => typeof a === "string" ? a : (a?.name || a?.email || "")) : []),
  ].filter(Boolean);
  const combined = [...inviteeNames, ...extraFields, meetingName || ""].join(" ").toLowerCase();
  for (const sp of SALESPEOPLE) {
    if (combined.includes(sp.toLowerCase())) return sp;
  }
  return "";
}

// Fallback detection from the transcript itself. Fathom transcripts label
// every line with a timestamped speaker, and Viewix staff carry a "(Viewix)"
// suffix:
//   00:00:12 - Jeremy Farrugia (Viewix)
//         No, no, you're better than you think...
// Count speaker lines per salesperson and return the dominant one — when two
// salespeople are on the same call, whoever speaks most ran it. When any
// "(Viewix)" tags exist, only tagged lines count, so a CLIENT who happens to
// share a salesperson's first name can't win the assignment.
export function detectSalespersonFromTranscript(transcript) {
  const text = transcript || "";
  if (!text) return "";
  const counts = new Map(); // sp -> { total, tagged }
  const speakerLine = /^\s*\d{1,2}:\d{2}:\d{2}\s*[-–—]\s*(.+?)\s*$/gm;
  let m;
  let sawViewixTag = false;
  while ((m = speakerLine.exec(text))) {
    const speaker = m[1].toLowerCase();
    const tagged = speaker.includes("(viewix)");
    if (tagged) sawViewixTag = true;
    for (const sp of SALESPEOPLE) {
      if (!speaker.includes(sp.toLowerCase())) continue;
      const c = counts.get(sp) || { total: 0, tagged: 0 };
      c.total += 1;
      if (tagged) c.tagged += 1;
      counts.set(sp, c);
    }
  }
  let best = "";
  let bestN = 0;
  for (const [sp, c] of counts) {
    const n = sawViewixTag ? c.tagged : c.total;
    if (n > bestN) { best = sp; bestN = n; }
  }
  return best;
}
