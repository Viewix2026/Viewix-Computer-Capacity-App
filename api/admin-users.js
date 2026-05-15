// api/admin-users.js
//
// Founder-only user management endpoint. Powers the in-app "Users" tab.
//
// Actions:
//   invite     — { email, role, name? }        create pending stub
//   setRole    — { targetUid, role }           change a user's role
//   setActive  — { targetUid, active }         activate / deactivate
//   delete     — { targetUid }                 hard delete record + auth user
//
// All writes use Admin SDK and bypass firebase-rules.json. Rules block
// direct client writes to /users — this endpoint is the only legitimate
// path for /users mutations.
//
// Self-protection:
//   - Reject self-deactivate, self-delete.
//   - Reject demoting / deactivating / deleting the last active founder.
//
// Side effects on deactivate / delete / role-demotion:
//   - revokeRefreshTokens(targetUid) — kills future ID token refresh
//     within seconds.
//   - setCustomUserClaims(targetUid, { role: null }) — strips the role
//     claim so the next forced refresh (which the client does on every
//     load) drops them at the Login screen.

import { getAdmin } from "./_fb-admin.js";
import { handleOptions, setCors, requireRole, sendAuthError, actorFrom } from "./_requireAuth.js";
import { isValidRole, isFounderRole, FOUNDER_ROLES } from "./_roles.js";
import { emailKeyFor } from "./auth-google.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try {
    decoded = await requireRole(req, FOUNDER_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { admin, err: adminErr } = getAdmin();
  if (adminErr) return res.status(500).json({ error: adminErr });
  const db = admin.database();

  const actor = actorFrom(decoded);
  const { action } = req.body || {};

  try {
    switch (action) {
      case "invite":     return await invite(req, res, db, actor);
      case "setRole":    return await setRole(req, res, db, admin, actor);
      case "setActive":  return await setActive(req, res, db, admin, actor);
      case "delete":     return await del(req, res, db, admin, actor);
      default:           return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error("admin-users error:", e);
    return res.status(500).json({ error: e.message });
  }
}

async function invite(req, res, db, actor) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const role  = String(req.body.role || "").trim();
  const name  = (req.body.name || "").trim() || email;

  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
  if (!isValidRole(role))             return res.status(400).json({ error: "Invalid role" });

  const emailKey = emailKeyFor(email);

  // Reject if the email is already known (real or pending)
  const existing = (await db.ref(`/usersByEmail/${emailKey}`).once("value")).val();
  if (existing) return res.status(409).json({ error: "Email already invited or registered" });

  const pendingUid = `pending:${emailKey}`;
  const now        = Date.now();
  const record = {
    email,
    name,
    photoURL:    null,
    role,
    active:      true,
    pending:     true,
    createdAt:   now,
    createdBy:   actor,
    updatedAt:   now,
    updatedBy:   actor,
    lastLoginAt: null,
  };
  await db.ref().update({
    [`/users/${pendingUid}`]:      record,
    [`/usersByEmail/${emailKey}`]: pendingUid,
  });

  return res.status(200).json({ ok: true, uid: pendingUid });
}

async function setRole(req, res, db, admin, actor) {
  const targetUid = String(req.body.targetUid || "");
  const role      = String(req.body.role || "");
  if (!targetUid)        return res.status(400).json({ error: "targetUid required" });
  if (!isValidRole(role)) return res.status(400).json({ error: "Invalid role" });

  const rec = (await db.ref(`/users/${targetUid}`).once("value")).val();
  if (!rec) return res.status(404).json({ error: "User not found" });

  // Self-protection: don't let a founder demote themselves below founder
  // tier (locks themselves out of this endpoint).
  if (targetUid === actor.uid && !isFounderRole(role)) {
    return res.status(400).json({ error: "Cannot demote yourself out of the founder tier." });
  }

  // Last-founder protection
  if (isFounderRole(rec.role) && !isFounderRole(role)) {
    const activeFounderCount = await countActiveFounders(db, targetUid);
    if (activeFounderCount === 0) {
      return res.status(400).json({ error: "Cannot demote the last active founder." });
    }
  }

  await db.ref(`/users/${targetUid}`).update({
    role,
    updatedAt: Date.now(),
    updatedBy: actor,
  });

  // If we demoted a real (non-pending) user, refresh their claim
  // immediately so the rules layer picks up the new role next time
  // their client refreshes the token.
  if (!targetUid.startsWith("pending:")) {
    try {
      await admin.auth().setCustomUserClaims(targetUid, { role });
    } catch (e) {
      // Pending users don't have a Firebase Auth user yet — ignore.
      if (e.code !== "auth/user-not-found") throw e;
    }
  }

  return res.status(200).json({ ok: true });
}

async function setActive(req, res, db, admin, actor) {
  const targetUid = String(req.body.targetUid || "");
  const active    = !!req.body.active;
  if (!targetUid) return res.status(400).json({ error: "targetUid required" });

  const rec = (await db.ref(`/users/${targetUid}`).once("value")).val();
  if (!rec) return res.status(404).json({ error: "User not found" });

  // Self-protection
  if (targetUid === actor.uid && !active) {
    return res.status(400).json({ error: "Cannot deactivate yourself." });
  }

  // Last-founder protection on deactivate
  if (!active && isFounderRole(rec.role)) {
    const activeFounderCount = await countActiveFounders(db, targetUid);
    if (activeFounderCount === 0) {
      return res.status(400).json({ error: "Cannot deactivate the last active founder." });
    }
  }

  await db.ref(`/users/${targetUid}`).update({
    active,
    updatedAt: Date.now(),
    updatedBy: actor,
  });

  if (!targetUid.startsWith("pending:")) {
    try {
      if (!active) {
        // Kill session: future refreshes fail, current token retains
        // its claims until expiry (~1hr) but the rules-layer active
        // gate catches them on every write attempt before that.
        await admin.auth().revokeRefreshTokens(targetUid);
        await admin.auth().setCustomUserClaims(targetUid, { role: null });
      } else {
        // Re-activate: restore the role claim
        await admin.auth().setCustomUserClaims(targetUid, { role: rec.role });
      }
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
    }
  }

  return res.status(200).json({ ok: true });
}

async function del(req, res, db, admin, actor) {
  const targetUid = String(req.body.targetUid || "");
  if (!targetUid) return res.status(400).json({ error: "targetUid required" });

  const rec = (await db.ref(`/users/${targetUid}`).once("value")).val();
  if (!rec) return res.status(404).json({ error: "User not found" });

  if (targetUid === actor.uid) {
    return res.status(400).json({ error: "Cannot delete yourself." });
  }
  if (isFounderRole(rec.role)) {
    const activeFounderCount = await countActiveFounders(db, targetUid);
    if (activeFounderCount === 0) {
      return res.status(400).json({ error: "Cannot delete the last active founder." });
    }
  }

  const emailKey = emailKeyFor(rec.email);
  await db.ref().update({
    [`/users/${targetUid}`]:       null,
    [`/usersByEmail/${emailKey}`]: null,
  });

  if (!targetUid.startsWith("pending:")) {
    try {
      await admin.auth().revokeRefreshTokens(targetUid);
      await admin.auth().setCustomUserClaims(targetUid, { role: null });
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
    }
  }

  return res.status(200).json({ ok: true });
}

// Count active founders OTHER than `excludeUid`. Used by the
// last-founder safety checks to decide whether the target can be
// demoted / deactivated / deleted.
async function countActiveFounders(db, excludeUid) {
  const all = (await db.ref("/users").once("value")).val() || {};
  let count = 0;
  for (const [uid, rec] of Object.entries(all)) {
    if (uid === excludeUid) continue;
    if (rec && rec.active !== false && isFounderRole(rec.role)) count++;
  }
  return count;
}
