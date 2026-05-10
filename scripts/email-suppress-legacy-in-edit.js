#!/usr/bin/env node
// scripts/email-suppress-legacy-in-edit.js
//
// One-off baseline for the In-The-Edit-Suite email. Before flipping
// EMAIL_DRY_RUN=false for the first time, the production database
// contains many projects that already have an edit-stage subtask in
// "inProgress" and no /emailLog/{projectId}/InEditSuite entry. The
// first real cron run would blast all of them at once. This script
// pre-writes a `suppressedLegacy` log entry for every such project
// so the cron's idempotency check no-ops on them forever.
//
// Usage (preview only — no writes):
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/email-suppress-legacy-in-edit.js
//
// Usage (apply):
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/email-suppress-legacy-in-edit.js --apply
//
// Idempotent: re-running is safe. Existing entries (any state)
// are left untouched; only projects without an existing entry get
// the suppressedLegacy marker.

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

function listSubtasks(project) {
  const raw = project?.subtasks;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.values(raw).filter(Boolean);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = init();

  const [projectsSnap, emailLogSnap] = await Promise.all([
    db.ref("/projects").once("value"),
    db.ref("/emailLog").once("value"),
  ]);
  const projects = projectsSnap.val() || {};
  const emailLog = emailLogSnap.val() || {};

  const candidates = [];
  for (const [pid, project] of Object.entries(projects)) {
    if (!project) continue;
    const subtasks = listSubtasks(project);
    const hasActiveEdit = subtasks.some(s => s.stage === "edit" && s.status === "inProgress");
    if (!hasActiveEdit) continue;
    const existing = emailLog?.[pid]?.InEditSuite;
    if (existing) continue; // already logged in some state — never overwrite
    candidates.push(pid);
  }

  console.log(`projects with active edit subtask:           ${Object.keys(projects).length ? "—" : "—"}`);
  console.log(`projects needing suppressedLegacy baseline:  ${candidates.length}`);
  if (candidates.length) {
    for (const pid of candidates) {
      const p = projects[pid];
      console.log(`  ${pid}  ·  ${p?.clientName || "(no client)"} / ${p?.projectName || "(no project)"}`);
    }
  }

  if (!apply) {
    console.log("\n(dry-run; pass --apply to write the suppressedLegacy entries)");
    process.exit(0);
  }

  const now = Date.now();
  const updates = {};
  for (const pid of candidates) {
    updates[`${pid}/InEditSuite`] = {
      state: "suppressedLegacy",
      template: "InEditSuite",
      projectId: pid,
      suppressedAt: now,
      reason: "Pre-Phase-A baseline — project already in edit when email automation went live.",
    };
  }
  await db.ref("/emailLog").update(updates);
  console.log(`\nWrote ${candidates.length} suppressedLegacy entries.`);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
