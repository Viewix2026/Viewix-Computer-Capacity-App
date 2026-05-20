// api/zernio-provision-profile.js
//
// Producer-side admin endpoint. POST { accountId } → creates a Zernio
// profile for that Viewix account and writes the mapping at
// /zernio/profiles/{accountId} = { profileKey, createdAt, createdBy }.
//
// Idempotent: if /zernio/profiles/{accountId}.profileKey already
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
  if (existing && existing.profileKey) {
    return res.status(200).json({
      ok: true,
      alreadyProvisioned: true,
      profileKey: existing.profileKey,
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

  let zernioResp;
  try {
    zernioResp = await createProfile({
      name,
      // Carry the Viewix accountId across to Zernio so their dashboard
      // and ours can cross-reference without ambiguity. Safe to expose
      // — accountId is an opaque internal id, not PII.
      externalRef: accountId,
    });
  } catch (e) {
    console.error("zernio-provision-profile createProfile failed:", e);
    return res.status(502).json({
      error: "zernio_create_failed",
      detail: e.message,
      code: e.code || null,
    });
  }

  // Zernio's documented response shape returns the profile under a
  // top-level `profile_key` field (or nested `profile.key` — we accept
  // either to insulate from minor shape drift). If neither key
  // appears, fail loud rather than write a half-broken mapping.
  const profileKey =
    zernioResp?.profile_key ||
    zernioResp?.profile?.key ||
    zernioResp?.key ||
    null;
  if (!profileKey) {
    console.error("zernio-provision-profile: no profileKey in response", zernioResp);
    return res.status(502).json({
      error: "zernio_response_missing_key",
      detail: "Zernio responded successfully but no profile_key was found in the body.",
    });
  }

  const record = {
    profileKey,
    createdAt: Date.now(),
    createdBy: { uid: actor.uid, email: actor.email || null },
    name,
  };
  await db.ref(`/zernio/profiles/${accountId}`).set(record);

  return res.status(200).json({
    ok: true,
    alreadyProvisioned: false,
    profileKey,
    createdAt: record.createdAt,
  });
}
