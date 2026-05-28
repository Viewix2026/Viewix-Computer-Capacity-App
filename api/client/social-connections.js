// api/client/social-connections.js
//
// Client portal — /clients/accounts view.
//
//   GET  ?accountId={id} (staff) | (none, scopes via registry for clients)
//        → list of platform tiles with status + lastConnected + refreshBy.
//   POST { accountId, platform } (subroute via ?action=reconnect-url)
//        → mints a fresh Zernio hosted connect URL for that platform
//          and returns it. Token is single-use, ~5 min TTL, scoped to
//          this client's profile.
//
// Both modes flow through requireClientOrStaff + clientAccess registry
// scoping, just like api/client/project.js. Output goes through
// redactConnectionStatus — never exposes profileId, raw connect URL
// without action, refresh tokens, etc.

import { handleOptions, setCors, requireClientOrStaff, sendAuthError } from "../_requireAuth.js";
import { getAdmin } from "../_fb-admin.js";
import { emailKeyFor } from "../auth-google.js";
import { redactConnectionStatus } from "../_clientRedact.js";
import { getConnectUrl } from "../_zernio.js";

export default async function handler(req, res) {
  if (handleOptions(req, res, "GET, POST, OPTIONS")) return;
  setCors(req, res, "GET, POST, OPTIONS");

  let who;
  try { who = await requireClientOrStaff(req); }
  catch (e) { return sendAuthError(res, e); }

  const { admin, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });
  const db = admin.database();

  // Reuse the same registry-first scoping pattern as
  // api/client/projects.js. Either we resolve a set of accountIds the
  // caller is allowed to see (registered clients), or the caller is
  // a staff member with explicit ?accountId= (support mode).
  let allowed;
  const emailKey = who.email ? emailKeyFor(who.email) : null;
  const reg = emailKey
    ? (await db.ref(`/clientAccess/${emailKey}`).once("value")).val()
    : null;
  if (reg && reg.accountIds) {
    allowed = new Set(Object.keys(reg.accountIds).filter(k => reg.accountIds[k]));
  } else if (who.kind === "staff") {
    const accountId = String(req.query.accountId || "");
    if (!accountId) return res.status(400).json({ error: "Staff support mode requires ?accountId=" });
    allowed = new Set([accountId]);
  } else {
    return res.status(403).json({ error: "No portal access" });
  }

  // ─── Reconnect-URL subroute ─────────────────────────────────────
  if (req.method === "POST" || req.query.action === "reconnect-url") {
    const platform = String((req.body && req.body.platform) || req.query.platform || "").toLowerCase();
    if (!platform) return res.status(400).json({ error: "platform required" });

    // Resolve the target account by the public `orgName` (clients) or
    // by `?accountId=` (staff support mode). The browser never sees
    // the internal accountId; sending it back would have weakened the
    // redaction contract (Codex audit 2026-05-28). Fail closed if two
    // orgs the caller can see have the same companyName.
    const requestedOrgName = String((req.body && req.body.orgName) || req.query.orgName || "").trim().toLowerCase();
    const staffAccountId = String(req.query.accountId || "");
    let accountId = null;
    if (staffAccountId && allowed.has(staffAccountId)) {
      accountId = staffAccountId;
    } else if (requestedOrgName) {
      const candidates = [];
      for (const id of allowed) {
        const acct = (await db.ref(`/accounts/${id}`).once("value")).val();
        if (String(acct?.companyName || "").trim().toLowerCase() === requestedOrgName) candidates.push(id);
      }
      if (candidates.length === 1) accountId = candidates[0];
      else if (candidates.length > 1) {
        console.warn(`[social-connections] multiple accounts match orgName="${requestedOrgName}" for caller; refusing to guess`);
        return res.status(409).json({ error: "org_name_ambiguous" });
      }
    }
    if (!accountId) return res.status(400).json({ error: "orgName + platform required" });

    // Only TikTok needs a client-facing reconnect link. For Meta /
    // YouTube / LinkedIn, the producer-side admin uses a different
    // endpoint to mint a connect URL they (not the client) opens.
    const profile = (await db.ref(`/zernio/profiles/${accountId}`).once("value")).val();
    if (!profile?.profileId) return res.status(409).json({ error: "no_zernio_profile" });

    try {
      const resp = await getConnectUrl({ profileId: profile.profileId, platform });
      const url = resp?.authUrl;
      if (!url) return res.status(502).json({ error: "zernio_no_url" });
      return res.status(200).json({ ok: true, reconnectUrl: url });
    } catch (e) {
      // Log the real error server-side; return a generic code. Third-
      // party error messages can leak request context, provider IDs,
      // or config hints. Codex audit 2026-05-28.
      console.error("[social-connections] Zernio getConnectUrl failed:", e?.message || e);
      return res.status(502).json({ error: "zernio_connect_url_failed" });
    }
  }

  // ─── GET — list of tiles ─────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "GET or POST only" });

  // Either return for a specific accountId (staff support mode) or
  // all the allowed accountIds (registered client).
  const requestedId = String(req.query.accountId || "");
  const targets = requestedId ? [requestedId] : Array.from(allowed);
  // Always re-check scope; staff support mode still has to pass it.
  const scoped = targets.filter(id => allowed.has(id));

  const out = [];
  for (const accountId of scoped) {
    const account = (await db.ref(`/accounts/${accountId}`).once("value")).val();
    const platforms = account?.platforms || {};
    const connections = (await db.ref(`/zernio/connections/${accountId}`).once("value")).val() || {};

    const tiles = [];
    for (const [plat, scope] of Object.entries(platforms)) {
      if (!scope?.enabled) continue;
      const conn = connections[plat] || {};
      tiles.push(redactConnectionStatus({
        platform: plat,
        status: conn.status || "unknown",
        lastConnected: conn.lastConnected || null,
        refreshBy: conn.refreshBy || null,
      }));
    }
    // Drop accountId from the response — internal IDs stay server-side.
    // The browser identifies its orgs by `orgName`, which is uniquely
    // resolvable within the caller's `allowed` set (an agency with
    // multiple Viewix accounts on the same companyName is implausible;
    // we fail closed if it ever happens). Codex audit 2026-05-28.
    out.push({
      orgName: account?.companyName || "(unnamed)",
      tiles,
    });
  }

  return res.status(200).json({ accounts: out });
}
