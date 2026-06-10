// api/_fathom-dedup.js
// Stable feedbackId derivation for the Fathom webhook.
//
// The old `mf-${Date.now()}` id meant every sender timeout-retry
// created a brand-new /meetingFeedback record and paid for a second
// full analysis (the inline pass runs ~45s, longer than some webhook
// senders' retry budgets). A retry carries the same payload, so the id
// must derive from the payload: recordingUrl is unique per Fathom
// recording and identical across retries; when it's absent, fall back
// to the meeting name + transcript shape.
//
// Kept dependency-free (node:crypto only) so tests can import it
// without pulling the webhook's full dependency graph.

import { createHash } from "crypto";

export function deriveFeedbackId({ recordingUrl, meetingName, transcript } = {}) {
  const url = String(recordingUrl || "").trim();
  const t = String(transcript || "");
  // No-URL fallback hashes the FULL transcript — name + length + a
  // 256-char prefix collides for templated recordings (same intro,
  // different content after the opening), silently dropping the second
  // meeting as a duplicate.
  const basis = url
    ? `url:${url}`
    : `meta:${String(meetingName || "").trim()}::${createHash("sha1").update(t.trim()).digest("hex")}`;
  return `mf-${createHash("sha1").update(basis).digest("hex").slice(0, 12)}`;
}
