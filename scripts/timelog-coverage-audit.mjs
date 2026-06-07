// THROWAWAY gate-zero audit for the Time Log Analytics plan.
// Measures join rate, done rate, and category rate over the REAL
// /timeLogs + /projects data so we know whether the completion gate
// and category filter will hold before writing any chart code.
//
// Run: node --env-file=.env.local scripts/timelog-coverage-audit.mjs
//
// Reads only. Writes nothing.

import admin from "firebase-admin";
import { readFileSync } from "node:fs";

const DB_URL =
  "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// .env.local stores FIREBASE_SERVICE_ACCOUNT with unescaped inner quotes, so a
// normal dotenv parser truncates it. The private key contains no double-quotes,
// so we can pull the three fields cert() needs by regex and restore newlines.
function loadServiceAccount() {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT not in .env.local");
  const raw = line.slice("FIREBASE_SERVICE_ACCOUNT=".length);
  const field = (k) => (raw.match(new RegExp(`"${k}":\\s*"([^"]*)"`)) || [])[1];
  const project_id = field("project_id");
  const client_email = field("client_email");
  const private_key = (field("private_key") || "").replace(/\\n/g, "\n");
  if (!project_id || !client_email || !private_key) {
    throw new Error("Could not extract service account fields");
  }
  return { project_id, client_email, private_key };
}

function initDb() {
  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
    databaseURL: DB_URL,
  });
  return admin.database();
}

// Mirror of src/utils.js categorizeContent (fallback classifier).
function categorizeContent(parentName, type) {
  const name = (parentName || "").toLowerCase();
  const t = (type || "").toLowerCase();
  if (name.includes("meta ad") || t.includes("meta ad") || t.includes("meta")) return "Meta Ad";
  if (name.includes("social media") || t.includes("social media") || t.includes("retainer")) return "Social Media";
  if (t.includes("live action") || t.includes("corporate")) return "Corporate Video";
  return "Other";
}

const EDIT_STAGES = new Set(["edit", "revisions"]);

function pct(n, d) {
  return d === 0 ? "0% (0/0)" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

async function main() {
  const db = initDb();
  console.log("Reading /projects and /timeLogs ...");
  const [projectsSnap, logsSnap] = await Promise.all([
    db.ref("/projects").once("value"),
    db.ref("/timeLogs").once("value"),
  ]);
  const projects = projectsSnap.val() || {};
  const timeLogs = logsSnap.val() || {};

  // ---- Build subtask index: subtaskId -> {status, videoType, parentName, stage} ----
  const index = new Map();
  let projectCount = 0;
  let subtaskCount = 0;
  const videoTypeCounts = new Map(); // raw videoType -> # subtasks
  for (const p of Object.values(projects)) {
    if (!p || typeof p !== "object") continue;
    projectCount++;
    const parentName = `${p.clientName || "—"}: ${p.projectName || "Untitled project"}`;
    const videoType = p.videoType || "";
    videoTypeCounts.set(videoType, (videoTypeCounts.get(videoType) || 0) + 1);
    const subs = p.subtasks ? Object.values(p.subtasks) : [];
    for (const st of subs) {
      if (!st || !st.id) continue;
      subtaskCount++;
      index.set(st.id, {
        status: st.status || "unknown",
        videoType,
        parentName,
        stage: st.stage || "",
      });
    }
  }

  // ---- Walk timeLogs: collect edit/revision log-units keyed by taskId ----
  // A "unit" here = a taskId that has at least one edit/revision log with secs>0.
  const unitTaskIds = new Set();
  const taskSource = new Map(); // taskId -> source
  let totalLogEntries = 0;
  let editRevisionLogEntries = 0;
  const stageSeen = new Map(); // stage string -> count of log entries
  const sourceSeen = new Map(); // source -> count of edit/rev units
  for (const [edId, dates] of Object.entries(timeLogs)) {
    if (!dates || typeof dates !== "object") continue;
    for (const [dateKey, dayData] of Object.entries(dates)) {
      if (!dayData || typeof dayData !== "object") continue;
      for (const [taskId, val] of Object.entries(dayData)) {
        if (taskId.startsWith("_")) continue; // skip _running etc.
        totalLogEntries++;
        const secs = typeof val === "number" ? val : (val?.secs || 0);
        const rawStage = typeof val === "object" ? (val?.stage || "") : "";
        // Stage is written in mixed casing/spacing by different code paths
        // ("edit" vs "Edit", "revisions" vs "Revisions", "preProduction" vs
        // "Pre Production"). Normalise before filtering.
        const stage = rawStage.toLowerCase().replace(/\s+/g, "");
        stageSeen.set(rawStage || "(none)", (stageSeen.get(rawStage || "(none)") || 0) + 1);
        if (!EDIT_STAGES.has(stage)) continue;
        if (!(secs > 0)) continue;
        editRevisionLogEntries++;
        unitTaskIds.add(taskId);
        const src = (typeof val === "object" && val?.source) || "(none)";
        if (!taskSource.has(taskId)) {
          taskSource.set(taskId, src);
          sourceSeen.set(src, (sourceSeen.get(src) || 0) + 1);
        }
      }
    }
  }

  // ---- Rate 1: join rate ----
  const joined = [];
  const unjoined = [];
  for (const taskId of unitTaskIds) {
    if (index.has(taskId)) joined.push(taskId);
    else unjoined.push(taskId);
  }

  // ---- Rate 2: done rate (among joined) ----
  const statusCounts = new Map();
  let doneCount = 0;
  for (const taskId of joined) {
    const status = index.get(taskId).status;
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (status === "done") doneCount++;
  }

  // ---- Rate 3: category rate (among joined+done — the rows that would actually chart) ----
  // Scope to source==="viewix" (legacy/(none) never joins anyway).
  const catCounts = new Map();
  const otherVideoTypes = new Map(); // videoType that fell to Other -> count
  let chartable = 0;
  for (const taskId of joined) {
    const meta = index.get(taskId);
    if (meta.status !== "done") continue;
    chartable++;
    const cat = categorizeContent(meta.parentName, meta.videoType);
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
    if (cat === "Other") {
      const key = meta.videoType || "(empty videoType)";
      otherVideoTypes.set(key, (otherVideoTypes.get(key) || 0) + 1);
    }
  }

  // ---- Month spread: for each chartable taskId, its last edit/revision log month ----
  const monthCounts = new Map(); // YYYY-MM -> # videos whose last log lands there
  for (const [edId, dates] of Object.entries(timeLogs)) {
    if (!dates || typeof dates !== "object") continue;
    for (const [dateKey] of Object.entries(dates)) {
      // collect per-task last date below instead; placeholder
    }
  }
  // Recompute per-task last edit/revision date (viewix + done only).
  const lastDateByTask = new Map();
  for (const [edId, dates] of Object.entries(timeLogs)) {
    if (!dates || typeof dates !== "object") continue;
    for (const [dateKey, dayData] of Object.entries(dates)) {
      if (!dayData || typeof dayData !== "object") continue;
      for (const [taskId, val] of Object.entries(dayData)) {
        if (taskId.startsWith("_")) continue;
        const meta = index.get(taskId);
        if (!meta || meta.status !== "done") continue;
        const stage = ((typeof val === "object" && val?.stage) || "").toLowerCase().replace(/\s+/g, "");
        if (!EDIT_STAGES.has(stage)) continue;
        const secs = typeof val === "number" ? val : (val?.secs || 0);
        if (!(secs > 0)) continue;
        const prev = lastDateByTask.get(taskId);
        if (!prev || dateKey > prev) lastDateByTask.set(taskId, dateKey);
      }
    }
  }
  for (const d of lastDateByTask.values()) {
    const m = d.slice(0, 7);
    monthCounts.set(m, (monthCounts.get(m) || 0) + 1);
  }

  // ---------- REPORT ----------
  const line = "─".repeat(64);
  console.log("\n" + line);
  console.log("TIME LOG ANALYTICS — COVERAGE AUDIT");
  console.log(line);
  console.log(`Projects: ${projectCount} | Subtasks indexed: ${subtaskCount}`);
  console.log(`Total log entries (non-_): ${totalLogEntries}`);
  console.log(`  edit/revision entries (secs>0): ${editRevisionLogEntries}`);
  console.log(`Distinct edit/revision videos (taskIds): ${unitTaskIds.size}`);

  console.log("\nStage distribution across ALL log entries:");
  for (const [stage, c] of [...stageSeen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage.padEnd(16)} ${c}`);
  }

  console.log("\nSource of edit/revision videos (distinct taskIds):");
  for (const [s, c] of [...sourceSeen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(s).padEnd(16)} ${c}`);
  }
  // Join rate split by source — the key question is whether the unjoined
  // population is entirely a legacy/external source we can scope out.
  const joinBySource = new Map(); // source -> {joined, total}
  for (const taskId of unitTaskIds) {
    const s = taskSource.get(taskId);
    const rec = joinBySource.get(s) || { joined: 0, total: 0 };
    rec.total++;
    if (index.has(taskId)) rec.joined++;
    joinBySource.set(s, rec);
  }
  console.log("Join rate BY SOURCE:");
  for (const [s, r] of [...joinBySource.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${String(s).padEnd(16)} ${pct(r.joined, r.total)}`);
  }

  console.log("\n[RATE 1] JOIN RATE — do edit/revision videos resolve to a subtask?");
  console.log(`  joined:   ${pct(joined.length, unitTaskIds.size)}`);
  console.log(`  UNJOINED: ${unjoined.length}  (would be silently dropped)`);
  if (unjoined.length) {
    console.log(`  sample unjoined taskIds: ${unjoined.slice(0, 8).join(", ")}`);
  }

  console.log("\n[RATE 2] DONE RATE — of joined videos, how many are status==='done'?");
  console.log(`  done:     ${pct(doneCount, joined.length)}`);
  console.log("  status breakdown (joined videos):");
  for (const [s, c] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(s).padEnd(14)} ${c}`);
  }
  console.log("  >>> If 'done' is a small share, the completion gate would gut the");
  console.log("      dataset -> use the fallback heuristic (no logs in >=21 days).");

  console.log("\n[RATE 3] CATEGORY RATE — of chartable (joined+done) videos, category split:");
  console.log(`  chartable videos: ${chartable}`);
  for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(16)} ${pct(n, chartable)}`);
  }
  const otherShare = (catCounts.get("Other") || 0);
  if (otherShare) {
    console.log("  videoType values that fell to 'Other':");
    for (const [vt, c] of [...otherVideoTypes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    "${vt}"  -> ${c}`);
    }
  }

  console.log("\nMONTH SPREAD — chartable videos by last edit/revision-log month:");
  const months = [...monthCounts.keys()].sort();
  if (months.length) {
    console.log(`  range: ${months[0]} → ${months[months.length - 1]}  (${months.length} distinct months)`);
    for (const m of months) {
      const c = monthCounts.get(m);
      console.log(`  ${m}  ${"█".repeat(c)} ${c}`);
    }
  }

  console.log("\nAll distinct project.videoType values (raw, # projects):");
  for (const [vt, c] of [...videoTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  "${vt || "(empty)"}"  -> ${c}`);
  }

  console.log("\n" + line);
  console.log("VERDICT GUIDE:");
  console.log("  join >=90% & done >=60% & Other <=25%  -> build as planned");
  console.log("  done low                               -> fallback completion heuristic");
  console.log("  Other high                             -> explicit videoType->category map");
  console.log(line);

  await admin.app().delete();
}

main().catch((e) => {
  console.error("AUDIT FAILED:", e);
  process.exit(1);
});
