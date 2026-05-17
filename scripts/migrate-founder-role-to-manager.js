#!/usr/bin/env node
// scripts/migrate-founder-role-to-manager.js
//
// One-shot role rename:
//   old role: founder
//   new role: manager
//
// Run after deploying the code that understands `manager`. The app also
// normalises legacy `founder` records on login, but this updates existing
// /users rows and Firebase Auth custom claims immediately.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/migrate-founder-role-to-manager.js --dry-run
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/migrate-founder-role-to-manager.js

import admin from "firebase-admin";

const DRY_RUN = process.argv.includes("--dry-run");

function init() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("FIREBASE_SERVICE_ACCOUNT env var required (JSON-encoded service account).");
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
    databaseURL: "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app",
  });
}

async function main() {
  init();
  const db = admin.database();
  const users = (await db.ref("/users").once("value")).val() || {};
  const rows = Object.entries(users).filter(([, rec]) => rec?.role === "founder");

  console.log(`${DRY_RUN ? "[DRY RUN]" : "[LIVE]"} founder -> manager role migration`);
  if (!rows.length) {
    console.log("No /users records with role=founder.");
    return;
  }

  for (const [uid, rec] of rows) {
    const label = `${rec.email || uid} (${uid})`;
    console.log(`  - ${label}`);
    if (DRY_RUN) continue;

    await db.ref(`/users/${uid}`).update({
      role: "manager",
      updatedAt: Date.now(),
    });

    if (!uid.startsWith("pending:")) {
      try {
        await admin.auth().setCustomUserClaims(uid, { role: "manager" });
      } catch (e) {
        if (e.code === "auth/user-not-found") {
          console.warn(`    Auth user not found; updated RTDB only.`);
        } else {
          throw e;
        }
      }
    }
  }

  console.log(DRY_RUN ? "Re-run without --dry-run to apply." : "Done.");
}

main().catch(e => { console.error(e); process.exit(1); });
