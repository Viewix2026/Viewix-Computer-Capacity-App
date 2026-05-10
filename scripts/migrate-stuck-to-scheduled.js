#!/usr/bin/env node
// scripts/migrate-stuck-to-scheduled.js
//
// Companion to audit-stuck-subtasks.js. Takes a JSON file produced
// by the audit script (filter via jq if needed), confirms the
// subtask records are still in `status: "stuck"` server-side (so a
// concurrent producer edit doesn't get clobbered), and flips them to
// `status: "scheduled"`.
//
// Two safe filtering modes baked in:
//   --safe-only   only flip records where audit.safeAutoFlip === true
//                 (no startDate or startDate > today). Recommended.
//   --all         flip every record listed in the input file.
//                 Requires the input to be human-reviewed.
//
// Always re-checks the server-side status before writing — if a
// producer has flipped the subtask to inProgress / done / waitingClient
// since the audit ran, this script leaves it alone.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/audit-stuck-subtasks.js > stuck.json
//   # review stuck.json...
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/migrate-stuck-to-scheduled.js stuck.json --safe-only --apply

import fs from "fs";
import admin from "firebase-admin";

const DB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

function init() {
  if (admin.apps.length) return admin.database();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("FIREBASE_SERVICE_ACCOUNT env var required.");
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
    databaseURL: DB_URL,
  });
  return admin.database();
}

async function main() {
  const args = process.argv.slice(2);
  const inputFile = args.find(a => a.endsWith(".json"));
  const apply = args.includes("--apply");
  const safeOnly = args.includes("--safe-only");
  const all = args.includes("--all");

  if (!inputFile) {
    console.error("Usage: node scripts/migrate-stuck-to-scheduled.js <stuck.json> [--safe-only|--all] [--apply]");
    process.exit(1);
  }
  if (!safeOnly && !all) {
    console.error("Pass --safe-only or --all to confirm the filter mode.");
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const filtered = safeOnly ? records.filter(r => r.safeAutoFlip) : records;
  console.log(`Input records:        ${records.length}`);
  console.log(`After filter:         ${filtered.length}  (${safeOnly ? "safe-only" : "all"})`);

  const db = init();
  const now = new Date().toISOString();
  let flipped = 0;
  let skipped = 0;
  let projectsTouched = new Set();

  for (const r of filtered) {
    const path = `/projects/${r.projectId}/subtasks/${r.subtaskId}`;
    const snap = await db.ref(path).once("value");
    const current = snap.val();
    if (!current) {
      console.log(`SKIP  missing  ${r.projectId}/${r.subtaskId}`);
      skipped++;
      continue;
    }
    if (current.status !== "stuck") {
      console.log(`SKIP  ${current.status}  ${r.projectId}/${r.subtaskId}  (changed since audit)`);
      skipped++;
      continue;
    }
    if (apply) {
      await db.ref(path).update({ status: "scheduled", updatedAt: now });
      await db.ref(`/projects/${r.projectId}/updatedAt`).set(now);
      projectsTouched.add(r.projectId);
    }
    console.log(`${apply ? "FLIP" : "DRY "}  ${r.projectId}/${r.subtaskId}  ·  ${r.clientName} / ${r.projectName}  ·  ${r.subtaskName}`);
    flipped++;
  }

  console.log(`\nFlipped: ${flipped}   Skipped: ${skipped}   Projects touched: ${projectsTouched.size}`);
  if (!apply) console.log("(dry-run; pass --apply to write)");
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
