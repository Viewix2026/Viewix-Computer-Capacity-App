// api/zernio-provision-profile.js
//
// Producer-side admin endpoint. POST { accountId } → creates a Zernio
// profile for that Viewix account and writes the mapping at
// /zernio/profiles/{accountId} = { profileId, createdAt, createdBy }.
//
// `profileId` is Zernio's profile `_id` (returned as `profile._id` on
// create). It is the identifier every later call passes.
//
// Idempotent: if /zernio/profiles/{accountId}.profileId already
// exists, returns the existing mapping unchanged. Producers can hit
// the button twice (network glitch, double-click) without forking
// duplicate profiles in Zernio.
//
// Auth: producer-or-better only (founders, manager, lead, producer).
// Editors / closers don't provision client integrations — that's
// account-management work.

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { getAdmin } from "./_fb-admin.js";
import { createProfile } from "./_zernio.js";

const ALLOWED_ROLES = ["founders", "founder", "manager", "lead", "producer"];

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let actor;
  try {
    actor = await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { accountId, accountName } = req.body || {};
  if (!accountId) return res.status(400).json({ error: "accountId required" });

  const { admin, db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  // Idempotency — if we've already provisioned for this account, return
  // the existing record. Producers can mash the button without forking
  // duplicates in Zernio's backend.
  const existing = (await db.ref(`/zernio/profiles/${accountId}`).once("value")).val();
  if (existing && existing.profileId) {
    return res.status(200).json({
      ok: true,
      alreadyProvisioned: true,
      profileId: existing.profileId,
      createdAt: existing.createdAt,
    });
  }

  // Resolve a display name — prefer the request body's accountName
  // (the producer-side UI passes it from the account record they're
  // looking at), fall back to the account record itself, fall back to
  // the accountId so the Zernio dashboard always shows something
  // recognisable.
  let name = String(accountName || "").trim();
  if (!name) {
    const account = (await db.ref(`/accounts/${accountId}`).once("value")).val();
    name = String(account?.companyName || "").trim() || accountId;
  }

  let profileId;
  try {
    // Carry the Viewix accountId across in the description so Zernio's
    // dashboard shows something recognisable and we can cross-reference.
    const created = await createProfile({
      name,
      description: `Viewix account ${accountId}`,
    });
    profileId = created.profileId;
  } catch (e) {
    console.error("zernio-provision-profile createProfile failed:", e);
    return res.status(502).json({
      error: "zernio_create_failed",
      detail: e.message,
      code: e.code || null,
    });
  }

  // Zernio returns the profile under `profile._id`. createProfile()
  // normalises that to profileId; if it's missing, fail loud rather
  // than write a half-broken mapping.
  if (!profileId) {
    console.error("zernio-provision-profile: no profile._id in response");
    return res.status(502).json({
      error: "zernio_response_missing_id",
      detail: "Zernio responded successfully but no profile._id was found in the body.",
    });
  }

  const record = {
    profileId,
    createdAt: Date.now(),
    createdBy: { uid: actor.uid, email: actor.email || null },
    name,
  };
  await db.ref(`/zernio/profiles/${accountId}`).set(record);

  return res.status(200).json({
    ok: true,
    alreadyProvisioned: false,
    profileId,
    createdAt: record.createdAt,
  });
}
