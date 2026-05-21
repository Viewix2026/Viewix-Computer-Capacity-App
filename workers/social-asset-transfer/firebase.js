// Firebase admin SDK initialisation — singleton across the worker's
// lifetime. Distinct from the Vercel-side api/_fb-admin.js because the
// worker uses its OWN service account (least-privilege: scoped to read
// /deliveries + /projects + read/write /socialAssets, nothing else
// outside that). The same DB URL though — both surfaces talk to the
// same RTDB instance.

import admin from "firebase-admin";

let _initted = false;

export function initFirebase() {
  if (_initted) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env var not set");
  }
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${e.message}`);
  }
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  if (!databaseURL) {
    throw new Error("FIREBASE_DATABASE_URL env var not set");
  }
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL,
  });
  _initted = true;
  return admin;
}

export function db() {
  if (!_initted) initFirebase();
  return admin.database();
}
