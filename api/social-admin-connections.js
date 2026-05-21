// api/social-admin-connections.js
//
// Producer-side counterpart to api/client/social-connections.js. Two
// modes, gated to Founder/Lead/Producer:
//
//   GET                — returns ALL provisioned Zernio profiles +
//                        their per-platform connection states across
//                        every account. Source for the SocialConnections
//                        top-level admin tab.
//
//   POST ?action=reconnect-url
//        { accountId, platform }
//        → Mints a fresh Zernio hosted connect URL the Viewix team
//          member opens (logged into the Viewix Facebook / Google /
//          LinkedIn account that holds Leadsie-granted admin access
//          on the client's assets). For TikTok, instead of returning
//          a URL we fire the SocialReconnect email to the client.
//
// Distinct from api/client/social-connections.js — that one is
// scoped to a single client via the registry; this one shows every
// account a producer manages.

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { getAdmin, adminGet } from "./_fb-admin.js";
import { send, newCounters } from "./_email/send.js";
import { getConnectUrl } from "./_zernio.js";

const ALLOWED_ROLES = ["founders", "founder", "manager", "lead", "producer"];

export default async function handler(req, res) {
  if (handleOptions(req, res, "GET, POST, OPTIONS")) return;
  setCors(req, res, "GET, POST, OPTIONS");

  let actor;
  try { actor = await requireRole(req, ALLOWED_ROLES); }
  catch (e) { return sendAuthError(res, e); }

  // ─── POST — reconnect-url subroute ────────────────────────────────
  if (req.method === "POST" || req.query.action === "reconnect-url") {
    const accountId = String((req.body && req.body.accountId) || req.query.accountId || "");
    const platform = String((req.body && req.body.platform) || req.query.platform || "").toLowerCase();
    if (!accountId || !platform) return res.status(400).json({ error: "accountId + platform required" });

    const profile = await adminGet(`/zernio/profiles/${accountId}`);
    if (!profile?.profileKey) return res.status(409).json({ error: "no_zernio_profile" });
    const account = await adminGet(`/accounts/${accountId}`);

    // For TikTok, the team can't self-link — fire the client email
    // (same template + idempotency pattern as the webhook handler
    // uses). Return ok so the admin UI can confirm "Email sent to
    // client".
    if (platform === "tiktok") {
      let connectUrl;
      try {
        const resp = await getConnectUrl({ profileKey: profile.profileKey, platform });
        connectUrl = resp?.connect_url || resp?.connectUrl || resp?.url;
      } catch (e) {
        return res.status(502).json({ error: "zernio_connect_url_failed", detail: e.message });
      }
      if (!connectUrl) return res.status(502).json({ error: "zernio_no_url" });
      const to = account?.clientContact?.email || account?.contactEmail || null;
      if (!to) return res.status(409).json({ error: "no_client_email", detail: `Add clientContact.email to /accounts/${accountId} first.` });
      const counters = newCounters();
      const result = await send({
        template: "SocialReconnect",
        idempotencyKey: `socialReconnect/${accountId}/tiktok/manual-${Date.now()}`,
        to,
        subject: "Quick reconnect needed for your TikTok",
        props: {
          client: {
            firstName: account?.clientContact?.firstName || "",
            companyName: account?.companyName || "your accounts",
          },
          reconnectUrl: connectUrl,
        },
        projectId: accountId,
        counters,
      });
      return res.status(200).json({ ok: true, sent: result.state, to });
    }

    // For Meta/YT/LinkedIn — return the URL so the team member opens
    // it themselves with their Leadsie-granted FB/Google/LinkedIn
    // access on hand.
    try {
      const resp = await getConnectUrl({ profileKey: profile.profileKey, platform });
      const url = resp?.connect_url || resp?.connectUrl || resp?.url;
      if (!url) return res.status(502).json({ error: "zernio_no_url" });
      return res.status(200).json({ ok: true, reconnectUrl: url });
    } catch (e) {
      return res.status(502).json({ error: "zernio_connect_url_failed", detail: e.message });
    }
  }

  // ─── GET — list every provisioned account's connection state ──────
  if (req.method !== "GET") return res.status(405).json({ error: "GET or POST only" });

  const profiles = (await adminGet("/zernio/profiles")) || {};
  const out = [];
  for (const [accountId, profile] of Object.entries(profiles)) {
    if (!profile?.profileKey) continue;
    const account = await adminGet(`/accounts/${accountId}`);
    const connections = (await adminGet(`/zernio/connections/${accountId}`)) || {};
    const tiles = [];
    const platforms = account?.platforms || {};
    for (const [plat, scope] of Object.entries(platforms)) {
      if (!scope?.enabled) continue;
      const c = connections[plat] || {};
      tiles.push({
        platform: plat,
        status: c.status || "unknown",
        lastConnected: c.lastConnected || null,
        refreshBy: c.refreshBy || null,
        disconnectedAt: c.disconnectedAt || null,
        accountName: scope.accountName || null,
      });
    }
    out.push({
      accountId,
      orgName: account?.companyName || "(unnamed)",
      profileName: profile.name || null,
      providedAt: profile.createdAt || null,
      tiles,
      // Heartbeat for the Mac Mini worker — surfaces here so the
      // admin can spot a stuck transfer pipeline without leaving the
      // tab. Reads /socialAssets/_workerHeartbeat once below.
    });
  }
  const workerHeartbeat = await adminGet("/socialAssets/_workerHeartbeat");

  return res.status(200).json({
    accounts: out,
    workerHeartbeat: workerHeartbeat || null,
  });
}
