// api/auth-google.js
//
// Per-user auth endpoint. Replaces the shared-password api/auth.js.
//
// Flow:
//   1. Client signs in with Google via signInWithPopup (firebase.js).
//   2. Client POSTs the resulting Google ID token to this endpoint.
//   3. We verify the ID token came from Google AND has email_verified.
//   4. We look up `/usersByEmail/{emailKey}` → `/users/{uid}`.
//      - Bootstrap path: if email is in BOOTSTRAP_FOUNDER_EMAILS and no
//        record exists, auto-seed with role:"founders", active:true.
//      - Pending re-key path: if the index points to "pending:..." and
//        the record has pending:true, atomically swap the pending uid
//        for the user's real Google uid.
//   5. If the user is not authorized or inactive, strip any stale role
//      custom claim and reject.
//   6. For authorized users, set the role custom claim and stamp
//      lastLoginAt. Client then force-refreshes the ID token to pick
//      up the new claim.

import { getAdmin } from "./_fb-admin.js";
import { handleOptions, setCors } from "./_requireAuth.js";
import { isValidRole } from "./_roles.js";

const BOOTSTRAP_FOUNDERS = (process.env.BOOTSTRAP_FOUNDER_EMAILS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// RTDB keys can't contain '.', '#', '$', '/', '[', ']'. Lowercase the
// email and replace '.' and '@' with '_' so jeremy@viewix.com.au becomes
// jeremy_viewix_com_au. This is a deterministic 1:1 mapping — we never
// need to reverse it (the email lives inside the user record itself).
export function emailKeyFor(email) {
  return String(email || "").toLowerCase().replace(/\./g, "_").replace(/@/g, "_at_");
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { admin, err: adminErr } = getAdmin();
  if (adminErr) return res.status(500).json({ error: adminErr });

  // 1. Extract + verify Google ID token
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: "Missing bearer token" });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch {
    return res.status(401).json({ error: "Invalid bearer token" });
  }

  // 2. Provider + email_verified gate
  if (decoded.firebase?.sign_in_provider !== "google.com") {
    return res.status(403).json({ error: "Google sign-in required" });
  }
  const email = (decoded.email || "").toLowerCase();
  if (!email || !decoded.email_verified) {
    return res.status(403).json({ error: "Verified Google email required" });
  }

  const realUid  = decoded.uid;
  const emailKey = emailKeyFor(email);
  const db       = admin.database();

  // 3. Look up the user record via email index
  let indexed = (await db.ref(`/usersByEmail/${emailKey}`).once("value")).val();
  let userRec = null;
  if (indexed) {
    userRec = (await db.ref(`/users/${indexed}`).once("value")).val();
  }

  // 4a. Bootstrap path — first sign-in by an allowlisted founder, no record yet
  if (!userRec && BOOTSTRAP_FOUNDERS.includes(email)) {
    const seedRec = {
      email,
      name:        decoded.name || email,
      photoURL:    decoded.picture || null,
      role:        "founders",
      active:      true,
      pending:     null,
      createdAt:   Date.now(),
      createdBy:   null, // null = bootstrap, no actor
      updatedAt:   Date.now(),
      updatedBy:   null,
      lastLoginAt: Date.now(),
    };
    await db.ref().update({
      [`/users/${realUid}`]:         seedRec,
      [`/usersByEmail/${emailKey}`]: realUid,
    });
    indexed = realUid;
    userRec = seedRec;
  }

  // 4b. Pending re-key path — invited user signing in for the first time
  if (indexed && typeof indexed === "string" && indexed.startsWith("pending:") && userRec?.pending) {
    const merged = {
      ...userRec,
      pending:     null,
      photoURL:    decoded.picture || userRec.photoURL || null,
      // If the stub was created with just the email as the name (which
      // /api/admin-users.js does when no name is provided at invite
      // time), upgrade to the real Google profile name on first login.
      name:        userRec.name === userRec.email ? (decoded.name || userRec.email) : userRec.name,
      lastLoginAt: Date.now(),
    };
    await db.ref().update({
      [`/users/${realUid}`]:         merged,
      [`/users/${indexed}`]:         null,
      [`/usersByEmail/${emailKey}`]: realUid,
    });
    indexed = realUid;
    userRec = merged;
  }

  // 5. Defensive re-keying — handles the rare case where indexed is a
  // different real uid than the current Google uid. Should not happen
  // in practice (Google → Firebase uid is stable per email) but cheap
  // insurance against account merges.
  if (indexed && indexed !== realUid && userRec) {
    await db.ref().update({
      [`/users/${realUid}`]:         { ...userRec, lastLoginAt: Date.now() },
      [`/users/${indexed}`]:         null,
      [`/usersByEmail/${emailKey}`]: realUid,
    });
    userRec = { ...userRec, lastLoginAt: Date.now() };
  }

  // 6. Rejection paths — strip any stale role claim so a previously
  // authorized user can't keep using a cached token.
  if (!userRec) {
    await admin.auth().setCustomUserClaims(realUid, { role: null });
    return res.status(403).json({ error: "Email not authorized. Ask a founder to add you in the Users tab." });
  }
  if (userRec.active === false) {
    await admin.auth().setCustomUserClaims(realUid, { role: null });
    await admin.auth().revokeRefreshTokens(realUid);
    return res.status(403).json({ error: "Account deactivated." });
  }
  if (!isValidRole(userRec.role)) {
    await admin.auth().setCustomUserClaims(realUid, { role: null });
    return res.status(500).json({ error: "Invalid role on user record. Contact a founder." });
  }

  // 7. Authorized — persist role claim, stamp lastLoginAt
  await admin.auth().setCustomUserClaims(realUid, { role: userRec.role });
  await db.ref(`/users/${realUid}/lastLoginAt`).set(Date.now());

  return res.status(200).json({
    role:     userRec.role,
    email,
    name:     userRec.name || decoded.name || null,
    photoURL: userRec.photoURL || decoded.picture || null,
  });
}
