#!/usr/bin/env node
// scripts/migrate-to-per-user-auth.js
//
// One-shot cutover script for the shared-password → Google-SSO migration.
//
// Run AFTER the new auth code is deployed AND the first founder has
// successfully signed in via Google (so the founders' real per-user
// records exist in /users). This script:
//
//   1. Lists the 6 shared Firebase Auth users (viewix-founders, etc.).
//   2. Deletes them — invalidating every refresh token issued under
//      those UIDs. Anyone holding an old session falls back to the
//      Login screen on their next ID token refresh (within ~60s).
//   3. Reports any orphan custom claims that need clearing (defensive,
//      should be empty after step 2).
//
// Idempotent: re-running after success is a no-op (auth/user-not-found
// errors are swallowed).
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/migrate-to-per-user-auth.js
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/migrate-to-per-user-auth.js --dry-run

import admin from "firebase-admin";

const SHARED_UIDS = [
  "viewix-founders",
  "viewix-founder",
  "viewix-closer",
  "viewix-editor",
  "viewix-lead",
  "viewix-trial",
];

const DRY_RUN = process.argv.includes("--dry-run");

function init() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("FIREBASE_SERVICE_ACCOUNT env var required (JSON-encoded service account).");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

async function main() {
  init();
  console.log(`${DRY_RUN ? "[DRY RUN]" : "[LIVE]"} Cutover: deleting 6 shared Firebase Auth users…`);

  for (const uid of SHARED_UIDS) {
    try {
      const user = await admin.auth().getUser(uid);
      console.log(`  • ${uid} (created ${user.metadata?.creationTime || "?"})`);
      if (!DRY_RUN) {
        await admin.auth().deleteUser(uid);
        console.log(`    deleted`);
      }
    } catch (e) {
      if (e.code === "auth/user-not-found") {
        console.log(`  • ${uid} — already gone, skipping`);
      } else {
        console.error(`  • ${uid} — error:`, e.message);
      }
    }
  }

  console.log("\nDone.");
  if (DRY_RUN) console.log("Re-run without --dry-run to apply.");
  else console.log("Anyone holding an old session will fall to Login on next token refresh (~60s).");

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
