#!/usr/bin/env node
// scripts/backfill-meeting-salesperson.mjs
//
// One-off backfill for /meetingFeedback records that came in through the
// Fathom webhook before transcript-based salesperson detection existed
// (api/_fathom-detect.js). Those records have salesperson: "" and render
// as "unassigned" in the Meeting Feedback dashboard.
//
// For every record with an empty salesperson, runs the same
// detectSalespersonFromTranscript used by the webhook and writes the
// result back. Records where detection comes up empty are left alone
// (assign them manually via the dashboard detail view).
//
// Re-checks the server-side value before writing — if someone assigned
// the meeting manually since the scan, this script leaves it alone.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/backfill-meeting-salesperson.mjs            # dry run
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/backfill-meeting-salesperson.mjs --apply    # write

import admin from "firebase-admin";
import { detectSalespersonFromTranscript } from "../api/_fathom-detect.js";

const APPLY = process.argv.includes("--apply");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("FIREBASE_SERVICE_ACCOUNT env var is required");
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(raw)),
  databaseURL: "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

const snap = await db.ref("/meetingFeedback").once("value");
const all = snap.val() || {};
const records = Object.entries(all)
  .filter(([, m]) => !m.salesperson)
  .sort(([, a], [, b]) => (b.createdAt || "").localeCompare(a.createdAt || ""));

console.log(`${Object.keys(all).length} meetingFeedback records, ${records.length} unassigned`);
console.log(APPLY ? "MODE: APPLY — writing detections\n" : "MODE: dry run — pass --apply to write\n");

let detected = 0;
let skipped = 0;
let written = 0;
for (const [key, m] of records) {
  const sp = detectSalespersonFromTranscript(m.transcript);
  if (!sp) {
    skipped += 1;
    console.log(`  --      ${m.createdAt?.slice(0, 10)}  ${m.meetingName || m.clientName || key} (no detection — leave unassigned)`);
    continue;
  }
  detected += 1;
  console.log(`  ${sp.padEnd(7)} ${m.createdAt?.slice(0, 10)}  ${m.meetingName || m.clientName || key}`);
  if (!APPLY) continue;

  // Guard against clobbering a manual assignment made after the scan.
  const ref = db.ref(`/meetingFeedback/${key}/salesperson`);
  const current = (await ref.once("value")).val();
  if (current) {
    console.log(`          ^ already assigned to "${current}" server-side — skipped`);
    continue;
  }
  await ref.set(sp);
  written += 1;
}

console.log(`\ndetected: ${detected}, no-detection: ${skipped}${APPLY ? `, written: ${written}` : ""}`);
process.exit(0);
