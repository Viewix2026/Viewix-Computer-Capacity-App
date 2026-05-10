#!/usr/bin/env node
// scripts/audit-stuck-subtasks.js
//
// Read-only audit of every subtask currently set to status "stuck".
// Phase A changes the meaning of "stuck" to "actively blocked" only;
// the old default was "stuck" for any newly-created task. This
// script lists the stuck pile so Jeremy can review and decide which
// to flip to "scheduled" (auto-progress eligible) and which to leave
// stuck because they're genuinely blocked.
//
// Output format: stable JSON array of { projectId, projectName,
// clientName, subtaskId, subtaskName, stage, startDate, endDate }
// suitable for piping through jq, grep, or saving to a file as the
// input to migrate-stuck-to-scheduled.js.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/audit-stuck-subtasks.js > stuck.json
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/audit-stuck-subtasks.js --pretty

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
  const pretty = process.argv.includes("--pretty");
  const db = init();
  const projectsSnap = await db.ref("/projects").once("value");
  const projects = projectsSnap.val() || {};

  const today = new Date().toISOString().slice(0, 10);
  const stuck = [];
  for (const [pid, project] of Object.entries(projects)) {
    if (!project) continue;
    if (project.status === "archived") continue;
    const subtasks = listSubtasks(project);
    for (const st of subtasks) {
      if (st.status !== "stuck") continue;
      stuck.push({
        projectId: pid,
        projectName: project.projectName || "",
        clientName: project.clientName || "",
        subtaskId: st.id,
        subtaskName: st.name || "",
        stage: st.stage || "",
        startDate: st.startDate || null,
        endDate: st.endDate || null,
        source: st.source || "",
        // Convenience flag for the migration script: anything with a
        // future or null startDate is the safest auto-flip target,
        // matching the plan's "conservative auto-rule" option.
        safeAutoFlip: !st.startDate || st.startDate > today,
      });
    }
  }

  if (pretty) {
    console.log(`Total stuck subtasks: ${stuck.length}`);
    console.log(`Safe to auto-flip (future / undated): ${stuck.filter(s => s.safeAutoFlip).length}`);
    console.log(`Past-dated stuck (review manually):   ${stuck.filter(s => !s.safeAutoFlip).length}\n`);
    for (const s of stuck) {
      const flag = s.safeAutoFlip ? "  " : "⚠️ ";
      console.log(`${flag}${s.projectId}/${s.subtaskId}  ·  ${s.clientName} / ${s.projectName}  ·  [${s.stage}] "${s.subtaskName}"  ·  ${s.startDate || "(no date)"}${s.source === "default" ? "  · (auto-seeded)" : ""}`);
    }
  } else {
    console.log(JSON.stringify(stuck, null, 2));
  }
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
