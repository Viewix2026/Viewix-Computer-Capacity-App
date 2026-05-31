// api/admin-client-access.js
//
// Founder-only client-portal access management. Powers the "Portal
// access" section on the Accounts tab. The ONLY writer of the three
// locked registry nodes (all .read:false/.write:false in
// firebase-rules.json — Admin SDK bypasses rules):
//
//   /accountPortalAccessCandidates/{accountId}/{emailKey}  — backfill
//       seeds awaiting review. Grants ZERO access.
//   /accountPortalAccess/{accountId}/{emailKey}            — approved
//       per-org list.
//   /clientAccess/{emailKey}                               — reverse
//       index for O(1) login lookup. Means LIVE access, period.
//
// Actions:
//   list     { accountId }                       live + candidates
//   add      { accountId, email, displayName }    grant directly
//   approve  { accountId, email, displayName }    candidate -> live
//   remove   { accountId, email }                 revoke
//   dismiss  { accountId, email }                 drop a candidate
//   backfill { }                                  seed candidates from
//                                                  clientContact.email

import { getAdmin } from "./_fb-admin.js";
import { handleOptions, setCors, requireRole, sendAuthError, actorFrom } from "./_requireAuth.js";
import { FOUNDER_ROLES } from "./_roles.js";
import { emailKeyFor } from "./auth-google.js";
import { sendClientPortalInvite } from "./_email/sendClientPortalInvite.js";

const cleanEmail = e => String(e || "").trim().toLowerCase();

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
      case "list":     return await list(req, res, db);
      case "add":      return await grant(req, res, db, actor, false);
      case "approve":  return await grant(req, res, db, actor, true);
      case "remove":   return await remove(req, res, db);
      case "dismiss":  return await dismiss(req, res, db);
      case "resend":   return await resend(req, res, db);
      case "backfill": return await backfill(req, res, db);
      default:         return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error("admin-client-access error:", e);
    return res.status(500).json({ error: e.message });
  }
}

async function list(req, res, db) {
  const accountId = String(req.body.accountId || "");
  if (!accountId) return res.status(400).json({ error: "accountId required" });
  const [liveSnap, candSnap] = await Promise.all([
    db.ref(`/accountPortalAccess/${accountId}`).once("value"),
    db.ref(`/accountPortalAccessCandidates/${accountId}`).once("value"),
  ]);
  return res.status(200).json({
    live: liveSnap.val() || {},
    candidates: candSnap.val() || {},
  });
}

// add (fromCandidate=false) or approve (fromCandidate=true). Both write
// the live per-org list + the reverse index atomically; approve also
// clears the candidate.
async function grant(req, res, db, actor, fromCandidate) {
  const accountId = String(req.body.accountId || "");
  const email = cleanEmail(req.body.email);
  const displayName = String(req.body.displayName || "").trim() || email;
  if (!accountId)              return res.status(400).json({ error: "accountId required" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  const emailKey = emailKeyFor(email);
  const existingIdx = (await db.ref(`/clientAccess/${emailKey}/accountIds`).once("value")).val() || {};
  // Per-org "is this a genuinely new grant?" check, read BEFORE the
  // update overwrites addedAt. A prior entry here means this email was
  // already granted to THIS org, so re-granting must NOT re-send the
  // invite (suppresses spam, including the case where a prior
  // notify:false staging grant already wrote live access — the
  // deliberate "send it now" lever for those is the manual Resend
  // action, not a re-grant). Distinct from existingIdx, which is the
  // cross-org reverse index used only for the alreadyHadAccess flag.
  const priorEntry = (await db.ref(`/accountPortalAccess/${accountId}/${emailKey}`).once("value")).val();
  const wasNew = !priorEntry;
  const update = {
    [`/accountPortalAccess/${accountId}/${emailKey}`]: {
      email, displayName, addedAt: Date.now(), addedBy: actor,
    },
    [`/clientAccess/${emailKey}/accountIds/${accountId}`]: true,
    [`/clientAccess/${emailKey}/displayName`]: displayName,
    [`/clientAccess/${emailKey}/email`]: email,
  };
  if (fromCandidate) {
    update[`/accountPortalAccessCandidates/${accountId}/${emailKey}`] = null;
  }
  await db.ref().update(update);

  // Auto-send the portal invite ONLY on a genuinely new per-org grant,
  // and only when the founder didn't opt out (notify:false → silent
  // pre-staging before a kickoff). send() self-catches and is fully
  // idempotent (stable key), so this is defence-in-depth try/catch.
  // We await it (no sendTimeoutMs) so the returned state is the real
  // outcome the UI toast reflects — not a premature timeout.
  let inviteEmail = "skipped_regrant";
  let inviteEmailReason = "";
  if (wasNew && req.body.notify !== false) {
    try {
      const result = await sendClientPortalInvite({ toEmail: email, displayName, accountId, emailKey });
      inviteEmail = result?.state || "unknown";
      inviteEmailReason = result?.reason || "";
    } catch (e) {
      console.error("admin-client-access grant invite send error:", e);
      inviteEmail = "failed";
      inviteEmailReason = e.message || "";
    }
  } else if (wasNew && req.body.notify === false) {
    inviteEmail = "skipped_notifyOff";
  }

  return res.status(200).json({
    ok: true,
    alreadyHadAccess: Object.keys(existingIdx).length > 0,
    inviteEmail,
    inviteEmailReason,
  });
}

async function remove(req, res, db) {
  const accountId = String(req.body.accountId || "");
  const email = cleanEmail(req.body.email);
  if (!accountId || !email) return res.status(400).json({ error: "accountId and email required" });
  const emailKey = emailKeyFor(email);

  const idx = (await db.ref(`/clientAccess/${emailKey}/accountIds`).once("value")).val() || {};
  delete idx[accountId];
  const remaining = Object.keys(idx).length;

  const update = {
    [`/accountPortalAccess/${accountId}/${emailKey}`]: null,
    [`/clientAccess/${emailKey}/accountIds/${accountId}`]: null,
    // Clear the per-org invite idempotency lock too. Without this, a
    // re-grant after a revoke sees wasNew===true but send() aborts on
    // the stale `sent` log and silently sends nothing — the client
    // never gets a fresh invite on re-onboarding. Revoke is the right
    // reset point (doing it in grant() would race two concurrent first
    // grants into a duplicate send).
    [`/emailLog/portalInvite/${accountId}/${emailKey}`]: null,
  };
  // No orgs left → drop the whole reverse-index node so the next login
  // returns the no-access state.
  if (remaining === 0) update[`/clientAccess/${emailKey}`] = null;
  await db.ref().update(update);
  return res.status(200).json({ ok: true, remainingOrgs: remaining });
}

async function dismiss(req, res, db) {
  const accountId = String(req.body.accountId || "");
  const email = cleanEmail(req.body.email);
  if (!accountId || !email) return res.status(400).json({ error: "accountId and email required" });
  await db.ref(`/accountPortalAccessCandidates/${accountId}/${emailKeyFor(email)}`).remove();
  return res.status(200).json({ ok: true });
}

// Manual "Resend invite" — the deliberate lever for spam-loss /
// re-onboarding, and for a notify:false staging grant that now needs
// the invite sent. Clears the idempotency lock then re-fires.
//
// HARD GUARD: verify the email currently has LIVE access to this org
// before clearing the lock or sending. Never resend to a revoked or
// never-granted email — that would be sending a portal link to someone
// who can't actually sign in.
async function resend(req, res, db) {
  const accountId = String(req.body.accountId || "");
  const email = cleanEmail(req.body.email);
  if (!accountId || !email) return res.status(400).json({ error: "accountId and email required" });
  const emailKey = emailKeyFor(email);

  const liveEntry = (await db.ref(`/accountPortalAccess/${accountId}/${emailKey}`).once("value")).val();
  if (!liveEntry) {
    return res.status(400).json({ error: "No live portal access for this email and org — cannot resend." });
  }

  // Clear the idempotency lock so send() doesn't short-circuit on the
  // prior `sent` state, then re-fire. displayName comes from the stored
  // grant (falls back to req.body, then the email).
  await db.ref(`/emailLog/portalInvite/${accountId}/${emailKey}`).remove();
  const displayName = String(liveEntry.displayName || req.body.displayName || email).trim() || email;

  let inviteEmail;
  let inviteEmailReason = "";
  try {
    const result = await sendClientPortalInvite({ toEmail: email, displayName, accountId, emailKey });
    inviteEmail = result?.state || "unknown";
    inviteEmailReason = result?.reason || "";
  } catch (e) {
    console.error("admin-client-access resend invite send error:", e);
    inviteEmail = "failed";
    inviteEmailReason = e.message || "";
  }
  return res.status(200).json({ ok: true, inviteEmail, inviteEmailReason });
}

// One-shot (idempotent) seed of candidate entries from project
// clientContact.email grouped by links.accountId. Never writes
// /clientAccess — candidates grant nothing until a founder approves.
// Skips emails already live or already a candidate.
async function backfill(req, res, db) {
  const [projSnap, liveSnap, candSnap] = await Promise.all([
    db.ref("/projects").once("value"),
    db.ref("/accountPortalAccess").once("value"),
    db.ref("/accountPortalAccessCandidates").once("value"),
  ]);
  const projects = projSnap.val() || {};
  const live = liveSnap.val() || {};
  const cand = candSnap.val() || {};

  const update = {};
  let seeded = 0, skipped = 0;
  for (const p of Object.values(projects)) {
    const accountId = p?.links?.accountId;
    const email = cleanEmail(p?.clientContact?.email);
    if (!accountId || !email || !email.includes("@")) { skipped++; continue; }
    const emailKey = emailKeyFor(email);
    if (live?.[accountId]?.[emailKey] || cand?.[accountId]?.[emailKey]) { skipped++; continue; }
    update[`/accountPortalAccessCandidates/${accountId}/${emailKey}`] = {
      email,
      source: "backfill:clientContact",
      projectShortId: p?.shortId || null,
      seededAt: Date.now(),
    };
    seeded++;
  }
  if (seeded > 0) await db.ref().update(update);
  return res.status(200).json({ ok: true, seeded, skipped });
}
