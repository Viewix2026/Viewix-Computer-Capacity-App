// api/_email/sendClientPortalInvite.js
// Orchestration wrapper for the client portal invite.
//
// This is NOT a parallel send path — it resolves the data the
// ClientPortalInvite template needs (account name, account manager,
// sign-in URL), then calls the one centralized send() in ./send.js
// exactly like every other client touchpoint. send() owns the kill
// switch, dry-run, atomic idempotency lock, render, and Resend call.
//
// Trigger: api/admin-client-access.js, on a genuinely NEW per-org
// grant (and the manual "Resend invite" action, which clears the
// idempotency lock first).
//
// Idempotency key: portalInvite/{accountId}/{emailKey} — stable per
// (org, email) so re-granting the same email to the same org is a
// silent no-op. NO timestamp in the key (that would defeat dedup).
//
// Reply-to stays hello@viewix.com.au for v1 (send.js untouched). The
// account manager is a VISUAL signature in the template body only.
//
// No sendTimeoutMs: this is an admin UI action, not the latency-bound
// deal-won webhook. We await the send to completion so the returned
// state is the REAL outcome the founder's toast can trust — a timeout
// would report `failed` even when the email actually sent.

import { adminGet } from "../_fb-admin.js";
import { accountManagerBlock } from "../_clientRedact.js";
import { send } from "./send.js";

const INVITE_SUBJECT = "You're invited to your Viewix client portal";

// First name from a free-form display name. Falls back to "there" when
// the name is empty or is itself an email address (some grants pass the
// raw email as the display name).
function deriveFirstName(displayName) {
  const raw = String(displayName || "").trim();
  if (!raw || raw.includes("@")) return "there";
  const first = raw.split(/\s+/)[0];
  return first || "there";
}

/**
 * Resolve invite context and send the client portal invite.
 *
 * @param {object} args
 * @param {string} args.toEmail     - Recipient (the granted client email). Required.
 * @param {string} [args.displayName] - Free-form name used to derive firstName.
 * @param {string} args.accountId   - Org/account id the grant is scoped to. Required.
 * @param {string} args.emailKey    - Firebase-safe email key (emailKeyFor(email)). Required.
 * @returns {Promise<{state:string, reason?:string, messageId?:string}>}
 *          The raw send() result so the caller can surface it in the UI.
 */
export async function sendClientPortalInvite({ toEmail, displayName, accountId, emailKey }) {
  if (!toEmail) return { state: "skipped", reason: "missing_to" };
  if (!accountId) return { state: "skipped", reason: "missing_account" };
  if (!emailKey) return { state: "skipped", reason: "missing_key" };

  // Sign-in URL guard — mirrors deliveryUrl.js. Without a public base
  // URL there is no client-viewable destination, so skip rather than
  // send a broken/relative link.
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.warn("sendClientPortalInvite: PUBLIC_BASE_URL missing — skipping invite for", toEmail);
    return { state: "skipped", reason: "missing_base_url" };
  }
  const signInUrl = `${base}/clients/`;

  // Resolve account (for org name + AM) and the editors roster (for
  // rich AM details). Both reads can fail independently — a missing
  // account is fatal (we can't name the org), but a missing roster
  // just degrades to the account-level AM override fields.
  let account = null;
  let editors = null;
  try {
    account = await adminGet(`/accounts/${accountId}`);
  } catch (e) {
    console.warn("sendClientPortalInvite: account read failed —", e.message);
  }
  if (!account) return { state: "skipped", reason: "account_not_found" };

  try {
    editors = await adminGet("/editors");
  } catch (e) {
    // Non-fatal: accountManagerBlock falls back to account-level fields.
    console.warn("sendClientPortalInvite: editors read failed —", e.message);
  }

  const companyName = String(account.companyName || "").trim();
  const accountManager = accountManagerBlock(account, editors);
  const firstName = deriveFirstName(displayName);

  return send({
    template: "ClientPortalInvite",
    idempotencyKey: `portalInvite/${accountId}/${emailKey}`,
    to: toEmail,
    subject: INVITE_SUBJECT,
    props: {
      firstName,
      companyName,
      accountManager,
      signInUrl,
      accent: "blue",
    },
    // NO sendTimeoutMs — await the true outcome (see header note).
    // NO replyTo — send.js is untouched; reply-to stays hello@viewix.com.au.
  });
}

export { INVITE_SUBJECT };
