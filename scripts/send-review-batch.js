#!/usr/bin/env node
// scripts/send-review-batch.js
//
// LOCAL-DEV one-shot CLI for firing a ReadyForReview batch email
// against a real project. The script is for canary / debugging only.
//
// **NOT a production trigger.** Production ReadyForReview emails fire
// from the Deliveries tab "Share with client" modal, which POSTs to
// api/send-review-batch.js. Both paths share core logic via
// api/_email/dispatchReviewBatch.js — so a CLI dry-run here proves the
// same code path the modal will run in production.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat ~/.viewix-secrets/sa.json)" \
//     RESEND_API_KEY="..."                                   \
//     EMAIL_DRY_RUN=true                                      \
//     PUBLIC_BASE_URL="https://planner.viewix.com.au"         \
//     node scripts/send-review-batch.js <projectId>           \
//       [--videos videoId1,videoId2]                          \
//       [--note "Producer note here"]                         \
//       [--to override@example.com]                           \
//       [--subject "Custom subject"]
//
// Exit codes:
//   0  success (sent / dryRun / skipped)
//   1  failure (missing env, no project, send error, etc.)

import { dispatchReviewBatch } from "../api/_email/dispatchReviewBatch.js";

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

async function main() {
  const args = parseArgs(process.argv);
  if (!args.projectId) {
    console.error("usage: send-review-batch.js <projectId> [--videos id1,id2] [--note '...'] [--to addr] [--subject '...']");
    process.exit(1);
  }

  // Fast-fail on missing env so we surface a clear message instead of
  // a generic downstream error from dispatchReviewBatch / send().
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

  let result;
  try {
    result = await dispatchReviewBatch({
      projectId: args.projectId,
      videoIds: args.videos || [],
      producerNote: args.note,
      recipientOverride: args.to,
      subjectOverride: args.subject,
    });
  } catch (e) {
    console.error(`\n${e.code || "error"}: ${e.message}`);
    process.exit(1);
  }

  console.log("\nReadyForReview send (via Deliveries-modal-equivalent code path):");
  console.log(`  projectId:    ${args.projectId}`);
  console.log(`  to:           ${result.to}${args.to ? " (override)" : " (from clientContact.email)"}`);
  console.log(`  subject:      ${result.subject}`);
  console.log(`  videos:       ${result.videoCount} (${result.videoNames.join(", ")})`);
  console.log(`  note:         ${args.note ? `"${args.note}"` : "(none)"}`);
  console.log(`  account mgr:  ${result.accountManager?.name || "(none)"}${result.accountManager?.phone ? ` (${result.accountManager.phone})` : ""}`);
  console.log(`  batchId:      ${result.batchId}`);
  console.log(`  idempotency:  ${result.idempotencyKey}`);
  console.log(`  mode:         ${process.env.EMAIL_DRY_RUN === "true" ? "DRY-RUN (Slack preview only, no Resend call)" : "REAL SEND via Resend"}`);
  console.log(`\nresult: ${JSON.stringify({ state: result.state, reason: result.reason, messageId: result.messageId })}`);

  if (result.state === "failed") {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
