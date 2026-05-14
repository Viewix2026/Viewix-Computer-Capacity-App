// api/_fb-admin.js
// Shared Firebase Admin SDK initialization.
// Used by all server endpoints that need to read/write Firebase.
// Lazily initializes once per cold start.

import admin from "firebase-admin";

const DB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const STORAGE_BUCKET = "viewix-capacity-tracker.firebasestorage.app";

export function getAdmin() {
  if (admin.apps.length) {
    return { admin, db: admin.database(), err: null };
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    return { admin: null, db: null, err: "FIREBASE_SERVICE_ACCOUNT env var is not set" };
  }
  try {
    const sa = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      databaseURL: DB_URL,
      storageBucket: STORAGE_BUCKET,
    });
    return { admin, db: admin.database(), err: null };
  } catch (e) {
    return { admin: null, db: null, err: `Failed to init firebase-admin: ${e.message}` };
  }
}

// Returns the default Storage bucket from the admin SDK (lazy-init).
// Used by api/_analyticsThumbnails.js to upload thumbnail bytes at
// scrape time so they survive past IG CDN expiry.
export function getStorageBucket() {
  const { admin: a, err } = getAdmin();
  if (err) return null;
  return a.storage().bucket();
}

// Convenience wrappers matching the existing fbGet/fbSet/fbPatch pattern
export async function adminGet(path) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  const snap = await db.ref(path).once("value");
  return snap.val();
}

export async function adminSet(path, data) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  await db.ref(path).set(data);
}

export async function adminPatch(path, data) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  await db.ref(path).update(data);
}

// RTDB transaction wrapper.
//
//   path        — Firebase ref path to transact on (string).
//   updaterFn   — (currentValue) => newValue. Return `undefined` to
//                 abort the transaction (e.g. lost the race, value
//                 already changed by another writer).
//
// Returns { committed: boolean, snapshot: any }. The updater can be
// called multiple times by RTDB if there's contention — keep it pure
// (no side effects). Used by the Custom-sale cron to atomically flip
// a pending slice to "processing" before charging Stripe.
export async function runRtdbTransaction(path, updaterFn) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  const result = await db.ref(path).transaction(updaterFn);
  return {
    committed: !!result.committed,
    snapshot: result.snapshot ? result.snapshot.val() : null,
  };
}
