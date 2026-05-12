#!/usr/bin/env node
// scripts/send-review-batch.js
//
// One-shot CLI to fire a single ReadyForReview email against a real
// project. Bridge before Phase A.5 ships the proper Deliveries-tab
// "Share with client" button + the api/send-review-batch.js endpoint.
//
// Why this exists:
//   - notify-finish.js is Slack-only (editor's Finish does NOT fire
//     client emails — Jeremy's design correction).
//   - The cron paths (daily-09) only handle ShootTomorrow + InEditSuite.
//   - ReadyForReview has no auto-trigger in production yet.
//
// This script does exactly what api/send-review-batch.js will do once
// built: resolve project context, build the AM chip + delivery URL,
// generate a batchId, call the shared send() helper. Same code path,
// same idempotency log shape, same dry-run behaviour.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat ~/.viewix-secrets/sa.json)" \
//     RESEND_API_KEY="$(op read 'op://...')" \
//     EMAIL_DRY_RUN=true \
//     PUBLIC_BASE_URL="https://planner.viewix.com.au" \
//     node scripts/send-review-batch.js <projectId> [--videos id1,id2] [--note "..."] [--to override@example.com]
//
// Required env:
//   FIREBASE_SERVICE_ACCOUNT  service account JSON
//   RESEND_API_KEY            unless EMAIL_DRY_RUN=true
//   PUBLIC_BASE_URL           production dashboard origin (used by deliveryUrl helper)
//
// Optional flags:
//   --videos id1,id2,id3      explicit video IDs to include in the batch.
//                             when omitted, the script picks all edit/revisions
//                             subtasks (mirrors the modal's "all editor-flagged"
//                             default).
//   --note "free text"        producer note rendered as a styled block in the email.
//   --to address@example.com  override the recipient (canary testing). when omitted
//                             uses the project's clientContact.email.
//   --subject "..."           override the auto-generated subject line.
//
// Exit codes:
//   0 success (sent / dryRun / skipped)
//   1 failure (missing data, send error, etc.)

import { getAdmin } from "../api/_fb-admin.js";
import { getProjectContext, resolveAccountManagerChip } from "../api/_email/getProjectContext.js";
import { send } from "../api/_email/send.js";

function parseArgs(argv) {
  const args = { videos: null, note: "", to: null, subject: null, projectId: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--videos") { args.videos = (rest[++i] || "").split(",").map(s => s.trim()).filter(Boolean); }
    else if (a === "--note") { args.note = rest[++i] || ""; }
    else if (a === "--to") { args.to = rest[++i] || null; }
    else if (a === "--subject") { args.subject = rest[++i] || null; }
    else if (!a.startsWith("--") && !args.projectId) { args.projectId = a; }
  }
  return args;
}

function listSubtasks(project) {
  const raw = project?.subtasks;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.values(raw).filter(Boolean);
}

// Mirror the eventual modal's default: every "edit" or "revisions" stage
// subtask with viewixStatus === "Ready for Review", OR if none have
// been flagged yet, fall back to all edit/revisions subtasks. The
// production modal will let the producer override this set per send;
// the CLI keeps it simple.
function pickVideosForBatch(project, explicitIds) {
  const subs = listSubtasks(project);
  const edits = subs.filter(s => s?.stage === "edit" || s?.stage === "revisions");
  if (Array.isArray(explicitIds) && explicitIds.length) {
    const byId = new Map(edits.map(s => [s.id, s]));
    return explicitIds
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(s => ({ name: s.name || "Video", videoId: s.id }));
  }
  const flagged = edits.filter(s => s?.viewixStatus === "Ready for Review");
  const pick = flagged.length ? flagged : edits;
  return pick.map(s => ({ name: s.name || "Video", videoId: s.id }));
}

function makeSubject({ count, firstName }) {
  // Jeremy to approve before live. Matches the template's headline
  // shape (singular vs batch). Keeps the first-name out of the
  // subject by default — common spam-filter heuristic flags overly
  // personalised subjects from new senders.
  if (count > 1) return `Your ${count} videos are ready for review`;
  return "Your video is ready for review";
}

function makeBatchId() {
  // 12-char random id. Just unique enough to scope the idempotency
  // key. Doesn't need to be cryptographically secure — it's a log
  // key, not an auth secret.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.projectId) {
    console.error("usage: send-review-batch.js <projectId> [--videos id1,id2] [--note '...'] [--to addr] [--subject '...']");
    process.exit(1);
  }

  // Sanity-check the must-haves up front. send() will refuse without
  // these, but failing fast with a clear message beats decoding a
  // generic 'missing_to' or 'missing_subject' downstream.
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("FIREBASE_SERVICE_ACCOUNT env var required (paste the SA JSON).");
    process.exit(1);
  }
  if (!process.env.PUBLIC_BASE_URL) {
    console.error("PUBLIC_BASE_URL env var required (e.g. https://planner.viewix.com.au).");
    process.exit(1);
  }
  if (process.env.EMAIL_DRY_RUN !== "true" && !process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY required when EMAIL_DRY_RUN is not 'true'. Aborting before a real send is attempted with no key.");
    process.exit(1);
  }

  // Phase A.5 design: the endpoint resolves project context the same
  // way the cron paths do, so the email props are byte-identical to
  // production sends. Loading /accounts separately here because
  // getProjectContext doesn't read accounts (resolveAccountManagerChip
  // takes the map as an argument).
  const { db, err } = getAdmin();
  if (err) {
    console.error(`Firebase init failed: ${err}`);
    process.exit(1);
  }

  const accountsSnap = await db.ref("/accounts").once("value");
  const accounts = accountsSnap.val() || {};

  let ctx;
  try {
    ctx = await getProjectContext(args.projectId);
  } catch (e) {
    console.error(`getProjectContext failed: ${e.message}`);
    process.exit(1);
  }

  // Server-side gate (mirrors api/send-review-batch.js's planned
  // behaviour): refuse to send without a real delivery URL. The
  // ReadyForReview template's CTA is the entire point of the email
  // — sending it without a working button is worse than not sending.
  if (!ctx.delivery?.url) {
    console.error(`Project ${args.projectId} has no delivery URL (link to a delivery record with a shortId in Firebase first). Refusing to send.`);
    process.exit(1);
  }

  const accountManager = resolveAccountManagerChip({
    project: ctx.project,
    accounts,
    editors: ctx.editors,
  });

  const videos = pickVideosForBatch(
    { subtasks: ctx.subtasks },
    args.videos
  );
  if (!videos.length) {
    console.error(`Project ${args.projectId} has no edit/revisions subtasks to include in the batch.`);
    process.exit(1);
  }

  const to = args.to || ctx.client.email;
  if (!to) {
    console.error(`No recipient. Project's clientContact.email is empty and no --to override given.`);
    process.exit(1);
  }

  const subject = args.subject || makeSubject({ count: videos.length, firstName: ctx.client.firstName });

  const batchId = makeBatchId();
  const idempotencyKey = `${args.projectId}/ReadyForReview/${batchId}`;

  // Props match what the ReadyForReview template reads from. The
  // chip relabel inside the template turns `producer` into the
  // Account Manager chip with role/avatar/phone; editor stays null
  // because the template hides that chip entirely for this email.
  const props = {
    accent: "blue",
    client: {
      firstName: ctx.client.firstName,
      email: to,
    },
    project: ctx.project,
    producer: accountManager,
    editor: null,
    delivery: ctx.delivery,
    videos,
    videosCount: videos.length,
    producerNote: args.note,
  };

  console.log(`\nReadyForReview send`);
  console.log(`  projectId:   ${args.projectId}`);
  console.log(`  project:     ${ctx.project.projectName}`);
  console.log(`  to:          ${to}${args.to ? " (override)" : " (from clientContact.email)"}`);
  console.log(`  subject:     ${subject}`);
  console.log(`  videos:      ${videos.length} (${videos.map(v => v.name).join(", ")})`);
  console.log(`  note:        ${args.note ? `"${args.note}"` : "(none)"}`);
  console.log(`  delivery:    ${ctx.delivery.url}`);
  console.log(`  account mgr: ${accountManager?.name || "(none)"}${accountManager?.phone ? ` (${accountManager.phone})` : ""}`);
  console.log(`  batchId:     ${batchId}`);
  console.log(`  idempotency: ${idempotencyKey}`);
  console.log(`  mode:        ${process.env.EMAIL_DRY_RUN === "true" ? "DRY-RUN (Slack preview only, no Resend call)" : "REAL SEND via Resend"}`);
  console.log("");

  const result = await send({
    template: "ReadyForReview",
    idempotencyKey,
    to,
    subject,
    props,
    projectId: args.projectId,
  });

  console.log(`\nresult: ${JSON.stringify(result)}`);

  // Exit code semantics: 0 on any non-failed state. `skipped` (e.g.
  // already_sent) is treated as success because the work was done
  // previously — re-running shouldn't error.
  if (result.state === "failed") {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
