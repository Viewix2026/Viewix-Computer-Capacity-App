#!/usr/bin/env node
// scripts/render-preview-from-firebase.js
//
// Render all 4 email templates using REAL data pulled from Firebase
// for a specific project. Useful for previewing what a client would
// actually see — real names, real shoot dates, real crew lookups,
// real project URLs.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat ~/.viewix-secrets/sa.json)" \
//     node scripts/render-preview-from-firebase.js <projectId>
//
// Or to pick the first non-archived project automatically:
//   FIREBASE_SERVICE_ACCOUNT="$(cat ~/.viewix-secrets/sa.json)" \
//     node scripts/render-preview-from-firebase.js --auto
//
// Output: writes to /tmp/viewix-email-previews-real/<slug>-{template}.html
// and prints the file paths so they can be opened in a browser.

import admin from "firebase-admin";
import { writeFileSync, mkdirSync } from "fs";
import { renderEmailHtml } from "../api/_email/render.js";
import { buildShootContext } from "../api/_email/getProjectContext.js";
import { buildDeliveryUrl, slugify } from "../api/_email/deliveryUrl.js";

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
function normaliseEditors(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.values(raw).filter(Boolean);
}

async function pickAuto(db) {
  const snap = await db.ref("/projects").once("value");
  const projects = snap.val() || {};
  // Pick the first project with at least: a clientContact.email AND
  // a shoot-stage subtask with a startDate. Maximises realism.
  for (const [id, p] of Object.entries(projects)) {
    if (!p || p.status === "archived") continue;
    if (!p.clientContact?.email) continue;
    const subs = listSubtasks(p);
    const hasShoot = subs.some(s => s.stage === "shoot" && s.startDate);
    if (hasShoot) return id;
  }
  // Fall back: any project with a client email
  for (const [id, p] of Object.entries(projects)) {
    if (p && p.status !== "archived" && p.clientContact?.email) return id;
  }
  // Last resort: anything
  return Object.keys(projects)[0] || null;
}

function pickShootSubtask(project) {
  const subs = listSubtasks(project);
  const today = new Date().toISOString().slice(0, 10);
  // Prefer future shoots, then most recent past shoot, then anything.
  const shoots = subs.filter(s => s.stage === "shoot");
  const future = shoots.filter(s => s.startDate && s.startDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (future.length) return future[0];
  const past = shoots.filter(s => s.startDate && s.startDate < today).sort((a, b) => b.startDate.localeCompare(a.startDate));
  if (past.length) return past[0];
  return shoots[0] || subs.find(s => s.stage === "preProduction") || subs[0] || null;
}

// Per Jeremy's spec 2026-05-12: the project card across ALL emails
// shows a single chip — the account manager. The editor chip is
// dropped entirely; clients don't need to see who's editing their
// video, just who to escalate to.
//
// Multi-source resolution because the account manager can live in
// any of these spots depending on how the project was created:
//   1. project.links.accountId  →  /accounts/{id}.accountManager
//   2. project.accountManager   (direct field, set by some webhook paths)
//   3. project.projectLead      (fallback — often the same person)
//
// Once the name is resolved, look it up in /editors to get the
// avatarUrl (Slack profile photo) so the chip renders with the
// real face instead of just initials.
function pickAccountManager(project, accounts, editors) {
  let name = null;
  const acctId = project?.links?.accountId;
  if (acctId && accounts[acctId]?.accountManager) {
    name = accounts[acctId].accountManager;
  } else if (project?.accountManager) {
    name = project.accountManager;
  } else if (project?.projectLead) {
    name = project.projectLead;
  }
  if (!name) return null;
  // Match the name (case-insensitive) against /editors to grab the
  // avatar URL and phone number. Falls back to no avatar / no phone
  // if there's no roster match — the chip still renders by name.
  const lc = name.trim().toLowerCase();
  const editor = editors.find(e => (e?.name || "").trim().toLowerCase() === lc);
  return {
    name,
    role: "Account Manager",
    avatar: editor?.avatarUrl || editor?.avatar || null,
    phone: (editor?.phone || "").trim() || null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const wantAuto = args.includes("--auto");
  let projectId = args.find(a => !a.startsWith("--"));

  const db = init();

  if (wantAuto || !projectId) {
    projectId = await pickAuto(db);
    if (!projectId) {
      console.error("No suitable project found.");
      process.exit(1);
    }
    console.log(`[auto-pick] projectId: ${projectId}`);
  }

  const [project, editorsRaw, accountsRaw] = await Promise.all([
    db.ref(`/projects/${projectId}`).once("value").then(s => s.val()),
    db.ref("/editors").once("value").then(s => s.val()),
    db.ref("/accounts").once("value").then(s => s.val() || {}),
  ]);
  if (!project) {
    console.error(`Project ${projectId} not found.`);
    process.exit(1);
  }

  const editors = normaliseEditors(editorsRaw);
  const shoot = pickShootSubtask(project);
  // Single chip across all emails — the account manager. The previous
  // producer/editor pair is dropped per Jeremy's redesign.
  const accountManager = pickAccountManager(project, accountsRaw, editors);

  // Build delivery
  let delivery = null;
  const deliveryId = project?.links?.deliveryId;
  if (deliveryId) {
    const d = await db.ref(`/deliveries/${deliveryId}`).once("value").then(s => s.val());
    if (d) {
      delivery = {
        id: d.id || deliveryId,
        shortId: d.shortId || null,
        url: buildDeliveryUrl({
          ...d,
          clientName: d.clientName || project.clientName || "",
          projectName: d.projectName || project.projectName || "",
        }),
      };
    }
  }

  const baseProps = {
    accent: "blue",
    client: {
      firstName: (project.clientContact?.firstName || "").trim() || "there",
      email: (project.clientContact?.email || "").trim(),
    },
    project: {
      id: project.id || projectId,
      shortId: project.shortId || null,
      projectName: project.projectName || "Untitled project",
      clientName: project.clientName || "",
      dueDate: project.dueDate || null,
      productLine: project.productLine || null,
      packageTier: project.packageTier || null,
      numberOfVideos: project.numberOfVideos || null,
      links: project.links || {},
    },
    // Templates take a `producer` slot (the chip render). We feed the
    // account manager there so the project card shows a single
    // "Account Manager" chip. Editor explicitly null — chip is hidden.
    producer: accountManager,
    editor: null,
    delivery,
  };

  const shootCtx = shoot ? buildShootContext({ subtask: shoot, editors }) : null;
  const shootProps = shootCtx ? { ...baseProps, shoot: shootCtx } : baseProps;

  // Use first few subtask names as a stand-in for "videos" if no real videos array.
  const fakeVideos = listSubtasks(project)
    .filter(s => s.stage === "edit" || s.stage === "revisions")
    .slice(0, 3)
    .map(s => ({ name: s.name || "Video", videoId: s.id }));

  // ReadyForReview hard-requires a delivery URL — production refuses
  // to send without one. For preview purposes we synthesise a
  // placeholder URL when the project has no delivery linked, so the
  // CTA button always renders and Jeremy can review it. The
  // production guard lives in api/send-review-batch.js (Phase A.5),
  // not in this template, so injecting a fake URL here doesn't
  // weaken the real safety check.
  const reviewDelivery = delivery && delivery.url
    ? delivery
    : {
        id: "preview-delivery",
        shortId: "preview",
        url: `${(process.env.PUBLIC_BASE_URL || "https://planner.viewix.com.au").replace(/\/+$/, "")}/d/preview/${slugify(project.projectName || projectId)}`,
      };
  const reviewProps = {
    ...baseProps,
    delivery: reviewDelivery,
    videos: fakeVideos.length ? fakeVideos : [{ name: "First cut", videoId: "v1" }],
    producerNote: "",
  };

  // Render all 4
  const outDir = "/tmp/viewix-email-previews-real";
  mkdirSync(outDir, { recursive: true });
  const slug = slugify(project.projectName || projectId).slice(0, 40);

  const renders = [
    ["01-Confirmation", "Confirmation", baseProps],
    ["02-ShootTomorrow", "ShootTomorrow", shootProps],
    ["03-InEditSuite", "InEditSuite", baseProps],
    ["04a-ReadyForReview-single", "ReadyForReview", { ...reviewProps, videos: reviewProps.videos.slice(0, 1) }],
    ["04b-ReadyForReview-batch", "ReadyForReview", { ...reviewProps, videos: reviewProps.videos.length > 1 ? reviewProps.videos : [{ name: "Hero", videoId: "v1" }, { name: "Cutdown", videoId: "v2" }, { name: "Teaser", videoId: "v3" }], producerNote: "Heads up - first three videos ready, second batch mid-week." }],
  ];

  console.log("");
  console.log(`Project: ${project.projectName || projectId}`);
  console.log(`Client:  ${project.clientName || "(no client)"} <${baseProps.client.email || "no email"}>`);
  console.log(`First name: ${baseProps.client.firstName}`);
  console.log(`Account Manager: ${accountManager?.name || "(none on record - chip will be hidden)"}${accountManager?.phone ? ` (${accountManager.phone})` : " (no phone on /editors)"}`);
  console.log(`Shoot:    ${shootCtx ? `${shootCtx.dateLabel} ${shootCtx.timeLabel} at ${shootCtx.location || "(no location)"} — ${shootCtx.crew.length} crew` : "(no shoot subtask)"}`);
  console.log(`Delivery: ${delivery?.url || "(no delivery)"}`);
  console.log("");

  for (const [name, template, props] of renders) {
    const html = await renderEmailHtml(template, props);
    const path = `${outDir}/${slug}-${name}.html`;
    writeFileSync(path, html);
    console.log(`wrote ${path}`);
  }

  console.log(`\nopen ${outDir}/${slug}-*.html`);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
