// api/migrate-account-client-contact.js
//
// One-time data migration. For every /accounts/{id} that has no
// `clientContact` field set, find the matching /projects/{*} that links
// to this account (via project.links.accountId === id) and copy that
// project's clientContact onto the account.
//
// Why: until this migration the canonical home of client contact was
// /projects/{id}/clientContact (one per project). Item 7 of the
// 2026-05-28 backlog moves the canonical home to /accounts/{id}/
// clientContact so the same email survives across many projects with
// the same client and so additionalAccountIds can resolve cc
// recipients without duplicating contact data per project.
//
// Idempotent — running it twice is safe. Once an account has
// clientContact set, subsequent runs skip it. Accounts with multiple
// linked projects pick the first project encountered's contact (rare
// edge case at Viewix scale — there should be one primary per account).
//
// Auth: founders-tier role gate.
//
// Trigger:
//   curl -X POST -H "Authorization: Bearer $YOUR_TOKEN" \
//     https://planner.viewix.com.au/api/migrate-account-client-contact
//
// Delete this file in a follow-up PR once the response confirms the
// touched count you expected.

import { adminGet, getAdmin } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await requireRole(req, ["founders", "founder"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  try {
    const result = await backfill();
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error("migrate-account-client-contact error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function backfill() {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);

  const accounts = (await adminGet("/accounts")) || {};
  const projects = (await adminGet("/projects")) || {};

  // Index projects by their linked accountId so we can look up O(1).
  // Each account ends up with the first matching project's contact;
  // additional matches don't overwrite (deterministic + idempotent).
  const contactByAccountId = {};
  for (const p of Object.values(projects)) {
    if (!p || !p.links?.accountId) continue;
    const accId = p.links.accountId;
    if (contactByAccountId[accId]) continue; // first-wins
    const fn = (p.clientContact?.firstName || "").trim();
    const em = (p.clientContact?.email || "").trim();
    if (!fn && !em) continue;
    contactByAccountId[accId] = { firstName: fn || null, email: em || null };
  }

  let touched = 0;
  const sample = [];

  for (const [accId, acct] of Object.entries(accounts)) {
    if (!acct) continue;
    if (acct.clientContact?.email || acct.clientContact?.firstName) continue;
    const inferred = contactByAccountId[accId];
    if (!inferred) continue;
    await db.ref(`/accounts/${accId}/clientContact`).set(inferred);
    touched++;
    if (sample.length < 10) sample.push({ accountId: accId, companyName: acct.companyName || null, set: inferred });
  }

  return { accountsTouched: touched, sample };
}
