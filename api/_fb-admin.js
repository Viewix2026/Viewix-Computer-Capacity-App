// api/_fb-admin.js
// Shared Firebase Admin SDK initialization.
// Used by all server endpoints that need to read/write Firebase.
// Lazily initializes once per cold start.

import admin from "firebase-admin";

const DB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

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
    });
    return { admin, db: admin.database(), err: null };
  } catch (e) {
    return { admin: null, db: null, err: `Failed to init firebase-admin: ${e.message}` };
  }
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
