// api/zernio-webhook.js
//
// Webhook receiver for Zernio events. Five event types we care about:
//
//   post.published   — Zernio successfully published a scheduled item.
//                      Update /socialSchedule/{id}/items/{idx}.status
//                      and auto-flip /deliveries/{id}/videos/{idx}.posted
//                      to true when the delivery is Viewix-owned.
//   post.failed      — Publish failed. Mark status:"failed", surface in
//                      Slack #video-deliveries so a producer can
//                      intervene.
//   account.disconnected — A client's social token died. Flag the row
//                          and fire the appropriate reconnect email:
//                          TikTok → client; everything else → project
//                          lead at Viewix (we reconnect via Leadsie BM
//                          access, no client involvement needed).
//   account.connected — Reverse — a previously dropped account is back.
//                       Update status, clear the warning.
//   account.refresh   — Proactive expiry warning (Ayrshare-style, may
//                       appear in Zernio's event vocabulary too).
//                       Record refreshBy timestamp for future nudges
//                       but don't fire emails yet.
//
// Pattern from api/slack-schedule-listener.js: raw-body read, HMAC
// verify, immediate 200, real work in waitUntil so we don't block
// Zernio's retry policy.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { getAdmin, adminGet, adminPatch } from "./_fb-admin.js";
import { send, newCounters, postCronSummary } from "./_email/send.js";
import { readRawBody } from "./_slack-helpers.js";
import { getConnectUrl } from "./_zernio.js";

export const config = { api: { bodyParser: false } };

// Zernio signs payloads with their `ZERNIO_WEBHOOK_SECRET`. Header
// shape (verify against live docs): `X-Zernio-Signature: t={ts},v1={sig}`
// where sig is HMAC-SHA256 over `${ts}.${rawBody}`. 5-minute replay
// window. If Zernio's actual header shape differs, this is the one
// place to adjust.
function verifyZernioSignature({ rawBody, signatureHeader, secret }) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const parts = String(signatureHeader).split(",").map(s => s.trim());
  let ts = null, sig = null;
  for (const p of parts) {
    if (p.startsWith("t="))  ts  = p.slice(2);
    if (p.startsWith("v1=")) sig = p.slice(3);
  }
  if (!ts || !sig) return false;
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 5 * 60) return false;
  const base = `${ts}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(base).digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const rawBody = await readRawBody(req);
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!secret) {
    console.error("zernio-webhook: ZERNIO_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "webhook secret not configured" });
  }
  const sigHeader = req.headers["x-zernio-signature"] || req.headers["x-signature"];
  if (!verifyZernioSignature({ rawBody, signatureHeader: sigHeader, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: "invalid JSON" }); }

  // Ack immediately so Zernio doesn't retry on slow ack.
  res.status(200).json({ ok: true });

  waitUntil(handleEvent(payload).catch(err => {
    console.error("zernio-webhook handleEvent error:", err);
  }));
}

// Look up the (scheduleId, itemIdx) for a given Zernio reference. The
// clientReferenceId we mint server-side is `${batchId}::${videoIdx}`,
// and the post's persisted scheduleId is the parent ref — we have to
// scan because Zernio carries only the reference, not the schedule id.
// O(scheduleCount × items) on each post event; fine at Viewix's scale.
async function locatePostInSchedule(clientReferenceId, zernioPostId) {
  if (!clientReferenceId && !zernioPostId) return null;
  const schedules = (await adminGet("/socialSchedule")) || {};
  for (const [scheduleId, schedule] of Object.entries(schedules)) {
    if (scheduleId === "byBatchId") continue;
    const items = Array.isArray(schedule?.items) ? schedule.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (clientReferenceId && it.clientReferenceId === clientReferenceId) {
        return { scheduleId, itemIdx: i, item: it, schedule };
      }
      if (zernioPostId && it.zernioPostId === zernioPostId) {
        return { scheduleId, itemIdx: i, item: it, schedule };
      }
    }
  }
  return null;
}

async function handleEvent(payload) {
  const type = String(payload.type || payload.event || "");
  switch (type) {
    case "post.published": return onPostPublished(payload);
    case "post.failed":    return onPostFailed(payload);
    case "account.disconnected": return onAccountDisconnected(payload);
    case "account.connected":    return onAccountConnected(payload);
    case "account.refresh":      return onAccountRefresh(payload);
    default:
      console.log("zernio-webhook: unhandled event type", type);
      return;
  }
}

// ─── post.published ─────────────────────────────────────────────────
async function onPostPublished(payload) {
  const data = payload.data || payload;
  const clientReferenceId = data.client_reference_id || data.clientReferenceId;
  const zernioPostId = data.post_id || data.id;
  const permalink = data.permalink || data.url || null;
  const platform = data.platform || null;

  const found = await locatePostInSchedule(clientReferenceId, zernioPostId);
  if (!found) {
    console.warn("zernio-webhook post.published: no schedule item matched", { clientReferenceId, zernioPostId });
    return;
  }
  const { scheduleId, itemIdx, schedule } = found;

  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
    status: "posted",
    publishedAt: Date.now(),
    permalink,
    publishedPlatform: platform,
    zernioPostId: zernioPostId || found.item?.zernioPostId || null,
  });

  // Auto-flip /deliveries/{id}/videos/{idx}.posted = true on the first
  // successful platform publish — but ONLY when this delivery is
  // Viewix-owned. For client-owned deliveries the existing manual
  // `posted` checkbox is the source of truth and we never touch it.
  const deliveryId = schedule.deliveryId;
  const videoIdx = found.item?.videoIdx;
  if (deliveryId && videoIdx != null) {
    const delivery = await adminGet(`/deliveries/${deliveryId}`);
    if (delivery?.postingOwner === "viewix" || !delivery?.postingOwner) {
      await db.ref(`/deliveries/${deliveryId}/videos/${videoIdx}/posted`).set(true);
    }
  }
}

// ─── post.failed ────────────────────────────────────────────────────
async function onPostFailed(payload) {
  const data = payload.data || payload;
  const clientReferenceId = data.client_reference_id || data.clientReferenceId;
  const zernioPostId = data.post_id || data.id;
  const reason = data.error || data.reason || "unknown";

  const found = await locatePostInSchedule(clientReferenceId, zernioPostId);
  if (!found) {
    console.warn("zernio-webhook post.failed: no schedule item matched", { clientReferenceId, zernioPostId });
    return;
  }
  const { scheduleId, itemIdx } = found;
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
    status: "failed",
    failedAt: Date.now(),
    failedReason: String(reason).slice(0, 500),
  });

  await slackPostMessage(`:rotating_light: Scheduled post FAILED on Zernio — schedule \`${scheduleId}\`, item ${itemIdx}: ${reason}`);
}

// ─── account.disconnected ───────────────────────────────────────────
async function onAccountDisconnected(payload) {
  const data = payload.data || payload;
  const profileKey = data.profile_key || data.profileKey;
  const platform = String(data.platform || "").toLowerCase();
  if (!profileKey || !platform) {
    console.warn("zernio-webhook account.disconnected: missing profile_key or platform");
    return;
  }

  // Resolve which Viewix account this profile maps to.
  const profiles = (await adminGet("/zernio/profiles")) || {};
  const accountEntry = Object.entries(profiles).find(([, v]) => v && v.profileKey === profileKey);
  if (!accountEntry) {
    console.warn("zernio-webhook account.disconnected: no Viewix account for profileKey", profileKey);
    return;
  }
  const [accountId] = accountEntry;
  const account = await adminGet(`/accounts/${accountId}`);
  if (!account) {
    console.warn("zernio-webhook account.disconnected: account missing", accountId);
    return;
  }

  // Skip platforms the account doesn't actually use (don't pester
  // clients about TikTok if their account.platforms.tiktok.enabled
  // is false).
  const platforms = account.platforms || {};
  if (!platforms[platform]?.enabled) {
    console.log(`zernio-webhook account.disconnected: ${accountId}/${platform} not enabled — skipping email`);
    // Still record the status flip so the producer dashboard is
    // truthful, but no notification.
    await adminPatch(`/zernio/connections/${accountId}/${platform}`, {
      status: "disconnected",
      disconnectedAt: Date.now(),
    });
    return;
  }

  await adminPatch(`/zernio/connections/${accountId}/${platform}`, {
    status: "disconnected",
    disconnectedAt: Date.now(),
  });

  // Get a fresh hosted reconnect URL and fire the appropriate email.
  let connectUrl;
  try {
    const resp = await getConnectUrl({ profileKey, platform });
    connectUrl = resp?.connect_url || resp?.connectUrl || resp?.url;
  } catch (e) {
    console.error("zernio-webhook: getConnectUrl failed", e);
    await slackPostMessage(`:warning: Couldn't mint reconnect URL for ${account.companyName}/${platform}: ${e.message}`);
    return;
  }
  if (!connectUrl) {
    console.error("zernio-webhook: Zernio returned no connect_url");
    return;
  }

  const counters = newCounters();
  if (platform === "tiktok") {
    // TikTok client reconnect — direct to client.
    const to = account?.clientContact?.email || account?.contactEmail || null;
    if (!to) {
      await slackPostMessage(`:warning: TikTok disconnected for ${account.companyName} but no client email on file. Add clientContact.email to /accounts/${accountId}.`);
      return;
    }
    await send({
      template: "SocialReconnect",
      idempotencyKey: `socialReconnect/${accountId}/tiktok/${Date.now()}`,
      to,
      subject: `Quick reconnect needed for your TikTok`,
      props: {
        client: {
          firstName: account?.clientContact?.firstName || "",
          companyName: account.companyName || "your accounts",
        },
        reconnectUrl: connectUrl,
      },
      projectId: accountId,
      counters,
    });
  } else {
    // Meta/YT/LinkedIn — internal email to the project lead.
    const leadEmail = account?.projectLead?.email || account?.accountManager?.email || process.env.SOCIAL_RECONNECT_FALLBACK_EMAIL || "hello@viewix.com.au";
    await send({
      template: "SocialReconnectInternal",
      idempotencyKey: `socialReconnectInternal/${accountId}/${platform}/${Date.now()}`,
      to: leadEmail,
      subject: `Reconnect needed: ${account.companyName} ${platform}`,
      props: {
        accountName: account.companyName,
        platform,
        reconnectUrl: connectUrl,
        accountId,
      },
      projectId: accountId,
      counters,
    });
  }
  await postCronSummary(`zernio-disconnect ${platform}`, counters);
}

// ─── account.connected ──────────────────────────────────────────────
async function onAccountConnected(payload) {
  const data = payload.data || payload;
  const profileKey = data.profile_key || data.profileKey;
  const platform = String(data.platform || "").toLowerCase();
  if (!profileKey || !platform) return;
  const profiles = (await adminGet("/zernio/profiles")) || {};
  const accountEntry = Object.entries(profiles).find(([, v]) => v && v.profileKey === profileKey);
  if (!accountEntry) return;
  const [accountId] = accountEntry;
  await adminPatch(`/zernio/connections/${accountId}/${platform}`, {
    status: "connected",
    lastConnected: Date.now(),
    refreshBy: null,
  });
}

// ─── account.refresh (proactive token-expiry warning) ───────────────
async function onAccountRefresh(payload) {
  const data = payload.data || payload;
  const profileKey = data.profile_key || data.profileKey;
  const platform = String(data.platform || "").toLowerCase();
  const refreshBy = data.refresh_by || data.refreshBy || null;
  if (!profileKey || !platform || !refreshBy) return;
  const profiles = (await adminGet("/zernio/profiles")) || {};
  const accountEntry = Object.entries(profiles).find(([, v]) => v && v.profileKey === profileKey);
  if (!accountEntry) return;
  const [accountId] = accountEntry;
  await adminPatch(`/zernio/connections/${accountId}/${platform}`, {
    status: "expiring",
    refreshBy,
  });
}

// ─── Slack helper ───────────────────────────────────────────────────
async function slackPostMessage(text) {
  const url = process.env.SLACK_VIDEO_DELIVERIES_WEBHOOK_URL || process.env.SLACK_PROJECT_LEADS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("zernio-webhook slackPostMessage failed:", e.message);
  }
}
