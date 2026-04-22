// api/seed-auth-claims.js
// ONE-SHOT — backfill persistent role claims on every role user so
// existing logged-in sessions pick them up on the next Firebase
// auto-refresh (~55 min max). Without this, currently-logged-in
// users would need to log out + log back in to get a token that
// passes auth.token.role != null in security rules.
//
// Delete this file once all founders/closers/leads/etc have cycled
// through the updated auth.js login (which does setCustomUserClaims
// inline) — roughly after everyone's next login.
//
// Usage: curl -X POST https://planner.viewix.com.au/api/seed-auth-claims

import { getAdmin } from "./_fb-admin.js";

// Mirror the ROLE_TO_UID map from auth.js — keeping them in sync is a
// chore but we want this file self-contained so it's safe to delete.
const ROLE_TO_UID = {
  founders: "viewix-founders",
  founder:  "viewix-founder",
  closer:   "viewix-closer",
  editor:   "viewix-editor",
  lead:     "viewix-lead",
  trial:    "viewix-trial",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const results = [];
  for (const [role, uid] of Object.entries(ROLE_TO_UID)) {
    try {
      // Create if missing so setCustomUserClaims doesn't fail.
      try {
        await admin.auth().getUser(uid);
      } catch (lookupErr) {
        if (lookupErr.code === "auth/user-not-found") {
          await admin.auth().createUser({ uid });
          results.push({ role, uid, created: true });
        } else {
          throw lookupErr;
        }
      }
      await admin.auth().setCustomUserClaims(uid, { role });
      results.push({ role, uid, ok: true });
    } catch (e) {
      results.push({ role, uid, error: e.message });
    }
  }

  res.status(200).json({ ok: true, results });
}
