// api/auth.js
// Serverless auth endpoint: maps passwords to roles and mints Firebase custom tokens.
// The client calls this with a password, gets back a custom token, then signs in with it.
// Firebase security rules read `auth.token.role` to authorize reads/writes.

import { getAdmin } from "./_fb-admin.js";

// Password → role map (mirrors App.jsx login function exactly)
const PW_TO_ROLE = {
  "Sanpel": "founders",
  "Push":   "founder",
  "Close":  "closer",
  "Letsgo": "editor",
  "Lead":   "lead",
  "Trial":  "trial",
};

// Stable UID per role. Shared passwords share a Firebase user — matches the existing model.
const ROLE_TO_UID = {
  founders: "viewix-founders",
  founder:  "viewix-founder",
  closer:   "viewix-closer",
  editor:   "viewix-editor",
  lead:     "viewix-lead",
  trial:    "viewix-trial",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Password required" });

  const role = PW_TO_ROLE[password];
  if (!role) return res.status(401).json({ error: "Invalid password" });

  const uid = ROLE_TO_UID[role];
  try {
    // Ensure the Firebase Auth user exists — setCustomUserClaims below
    // fails if the user doesn't exist yet. Creating ahead of time also
    // stops the auto-created-on-signInWithCustomToken path that was
    // skipping claim persistence entirely.
    try {
      await admin.auth().getUser(uid);
    } catch (lookupErr) {
      if (lookupErr.code === "auth/user-not-found") {
        await admin.auth().createUser({ uid });
      } else {
        throw lookupErr;
      }
    }

    // Persist the role claim on the USER record so it survives token
    // refresh. Custom-token developer claims only land on the initial
    // ID token — when Firebase's SDK auto-refreshes that token ~55
    // minutes later, the claim is gone and writes start failing with
    // PERMISSION_DENIED because our rules check auth.token.role != null.
    // setCustomUserClaims stores the claim server-side; every future
    // refreshed token inherits it.
    await admin.auth().setCustomUserClaims(uid, { role });

    // Still mint a custom token with the claim inline — that's what
    // the client signs in with. Once signed in, the SDK refreshes
    // against the persisted claim and the role sticks.
    const token = await admin.auth().createCustomToken(uid, { role });
    return res.status(200).json({ token, role });
  } catch (e) {
    console.error("Auth mint error:", e);
    return res.status(500).json({ error: e.message });
  }
}
