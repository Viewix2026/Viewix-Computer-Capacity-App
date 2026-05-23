// api/zernio-webhook.js
//
// Webhook receiver for Zernio events.
//
// RECONCILED against the real Zernio contract (llms.txt, 2026-05-21):
//   • Signature: header `X-Zernio-Signature` = lowercase-hex
//     HMAC-SHA256 of the RAW request body, keyed by ZERNIO_WEBHOOK_SECRET.
//     (The earlier `t=…,v1=…` parsing was an assumption — Zernio's
//     scheme is the plain hex digest.)
//   • Event id: `payload.id`, also echoed in header `X-Zernio-Event-Id`.
//     We key reconnect-email idempotency on it so a webhook retry never
//     re-sends.
//   • Posts carry no client_reference_id — match purely on the post id.
//   • Zernio must get a 2xx within 5 seconds or it retries (up to 7×),
//     so we ack 200 immediately and do the real work in waitUntil().
//
// Event types handled:
//   post.published   → item status "posted"; auto-flip the delivery's
//                      videos[idx].posted when Viewix-owned.
//   post.partial     → item status "partial" (some platforms succeeded,
//                      some failed); Slack-notify.
//   post.failed      → item status "failed"; Slack-notify.
//   post.cancelled   → item status "cancelled".
//   post.scheduled   → confirmation a scheduled post landed in Zernio's
//                      queue; record scheduledConfirmedAt, status stays
//                      "pending".
//   account.disconnected → flag the connection row + fire reconnect
//                          email (TikTok → client; else → project lead).
//   account.connected    → clear the flag.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { getAdmin, adminGet, adminPatch } from "./_fb-admin.js";
import { send, newCounters, postCronSummary } from "./_email/send.js";
import { readRawBody } from "./_slack-helpers.js";
import { getConnectUrl } from "./_zernio.js";
import { accountManagerBlock } from "./_clientRedact.js";

export const config = { api: { bodyParser: false } };

// Plain lowercase-hex HMAC-SHA256 over the raw body. Constant-time
// compare. No timestamp envelope.
function verifyZernioSignature({ rawBody, signatureHeader, secret }) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const provided = String(signatureHeader).trim().toLowerCase().replace(/^sha256=/, "");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
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

  const eventId = payload.id || req.headers["x-zernio-event-id"] || `evt-${Date.now()}`;

  // Ack immediately so Zernio doesn't retry on slow ack (5s budget).
  res.status(200).json({ ok: true });

  waitUntil(handleEvent(payload, eventId).catch(err => {
    console.error("zernio-webhook handleEvent error:", err);
  }));
}

// Pull the Zernio post id out of an event payload. Zernio nests the
// entity under `data` on most events; be liberal about exact shape.
function postIdFrom(payload) {
  const d = payload.data || payload;
  return d?.post?._id || d?.post?.id || d?.postId || d?.post_id || d?._id || d?.id || null;
}

// Locate (scheduleId, itemIdx) for a Zernio post id. O(schedules×items)
// per event — fine at Viewix's scale.
async function locatePostInSchedule(zernioPostId) {
  if (!zernioPostId) return null;
  const schedules = (await adminGet("/socialSchedule")) || {};
  for (const [scheduleId, schedule] of Object.entries(schedules)) {
    if (scheduleId === "byBatchId") continue;
    const items = Array.isArray(schedule?.items) ? schedule.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.zernioPostId === zernioPostId) {
        return { scheduleId, itemIdx: i, item: it, schedule };
      }
    }
  }
  return null;
}

async function handleEvent(payload, eventId) {
  const type = String(payload.type || payload.event || "");
  switch (type) {
    case "post.published": return onPostPublished(payload);
    case "post.partial":   return onPostPartial(payload);
    case "post.failed":    return onPostFailed(payload);
    case "post.cancelled": return onPostCancelled(payload);
    case "post.scheduled": return onPostScheduled(payload);
    case "account.disconnected": return onAccountDisconnected(payload, eventId);
    case "account.connected":    return onAccountConnected(payload);
    default:
      console.log("zernio-webhook: unhandled event type", type);
      return;
  }
}

// ─── post.published ─────────────────────────────────────────────────
async function onPostPublished(payload) {
  const data = payload.data || payload;
  const zernioPostId = postIdFrom(payload);
  const post = data.post || data;
  const permalink = post.permalink || post.url || data.permalink || null;
  const platform = data.platform || post.platform || null;

  const found = await locatePostInSchedule(zernioPostId);
  if (!found) {
    console.warn("zernio-webhook post.published: no schedule item matched", { zernioPostId });
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
  });

  // Auto-flip /deliveries/{id}/videos/{idx}.posted = true on the first
  // successful platform publish — ONLY when the delivery is Viewix-
  // owned. Client-owned deliveries keep their manual checkbox.
  const deliveryId = schedule.deliveryId;
  const videoIdx = found.item?.videoIdx;
  if (deliveryId && videoIdx != null) {
    const delivery = await adminGet(`/deliveries/${deliveryId}`);
    if (delivery?.postingOwner === "viewix" || !delivery?.postingOwner) {
      await db.ref(`/deliveries/${deliveryId}/videos/${videoIdx}/posted`).set(true);
    }
  }
}

// ─── post.partial (some platforms published, some failed) ───────────
async function onPostPartial(payload) {
  const data = payload.data || payload;
  const zernioPostId = postIdFrom(payload);
  const found = await locatePostInSchedule(zernioPostId);
  if (!found) {
    console.warn("zernio-webhook post.partial: no schedule item matched", { zernioPostId });
    return;
  }
  const { scheduleId, itemIdx } = found;
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  const post = data.post || data;
  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
    status: "partial",
    partialAt: Date.now(),
    partialDetail: String(post.error || data.error || "some platforms failed").slice(0, 500),
  });
  await slackPostMessage(`:warning: Scheduled post PARTIALLY published on Zernio — schedule \`${scheduleId}\`, item ${itemIdx}. Some platforms failed; check Zernio.`);
}

// ─── post.failed ────────────────────────────────────────────────────
async function onPostFailed(payload) {
  const data = payload.data || payload;
  const zernioPostId = postIdFrom(payload);
  const post = data.post || data;
  const reason = post.error || data.error || data.reason || "unknown";

  const found = await locatePostInSchedule(zernioPostId);
  if (!found) {
    console.warn("zernio-webhook post.failed: no schedule item matched", { zernioPostId });
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

// ─── post.cancelled ─────────────────────────────────────────────────
async function onPostCancelled(payload) {
  const zernioPostId = postIdFrom(payload);
  const found = await locatePostInSchedule(zernioPostId);
  if (!found) return;
  const { scheduleId, itemIdx, item } = found;
  // If we already marked it cancelled locally (producer-initiated via
  // schedule-item-cancel), this is just the echo — idempotent update.
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  if (item?.status === "posted") return; // never downgrade a posted item
  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}`).update({
    status: "cancelled",
    cancelledAt: item?.cancelledAt || Date.now(),
  });
}

// ─── post.scheduled (queue confirmation) ────────────────────────────
async function onPostScheduled(payload) {
  const zernioPostId = postIdFrom(payload);
  const found = await locatePostInSchedule(zernioPostId);
  if (!found) return;
  const { scheduleId, itemIdx } = found;
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  // Status stays "pending"; just record that Zernio confirmed the queue.
  await db.ref(`/socialSchedule/${scheduleId}/items/${itemIdx}/scheduledConfirmedAt`).set(Date.now());
}

// Resolve which Viewix account a Zernio profileId maps to.
async function viewixAccountForProfile(profileId) {
  if (!profileId) return null;
  const profiles = (await adminGet("/zernio/profiles")) || {};
  const entry = Object.entries(profiles).find(([, v]) => v && v.profileId === profileId);
  return entry ? entry[0] : null;
}

function profileIdFrom(payload) {
  const d = payload.data || payload;
  return d?.profileId || d?.profile?._id || d?.profile?.id || d?.account?.profileId || null;
}
function platformFrom(payload) {
  const d = payload.data || payload;
  return String(d?.platform || d?.account?.platform || "").toLowerCase();
}

// ─── account.disconnected ───────────────────────────────────────────
async function onAccountDisconnected(payload, eventId) {
  const profileId = profileIdFrom(payload);
  const platform = platformFrom(payload);
  if (!profileId || !platform) {
    console.warn("zernio-webhook account.disconnected: missing profileId or platform");
    return;
  }

  const accountId = await viewixAccountForProfile(profileId);
  if (!accountId) {
    console.warn("zernio-webhook account.disconnected: no Viewix account for profileId", profileId);
    return;
  }
  const account = await adminGet(`/accounts/${accountId}`);
  if (!account) {
    console.warn("zernio-webhook account.disconnected: account missing", accountId);
    return;
  }

  // Record the status flip regardless. Only fire an email if the
  // platform is actually in scope for this account.
  await adminPatch(`/zernio/connections/${accountId}/${platform}`, {
    status: "disconnected",
    disconnectedAt: Date.now(),
  });

  const platforms = account.platforms || {};
  if (!platforms[platform]?.enabled) {
    console.log(`zernio-webhook account.disconnected: ${accountId}/${platform} not enabled — no email`);
    return;
  }

  // Get a fresh hosted reconnect URL.
  let connectUrl;
  try {
    const resp = await getConnectUrl({ profileId, platform });
    connectUrl = resp?.authUrl;
  } catch (e) {
    console.error("zernio-webhook: getConnectUrl failed", e);
    await slackPostMessage(`:warning: Couldn't mint reconnect URL for ${account.companyName}/${platform}: ${e.message}`);
    return;
  }
  if (!connectUrl) {
    console.error("zernio-webhook: Zernio returned no authUrl");
    return;
  }

  const counters = newCounters();
  if (platform === "tiktok") {
    const to = account?.clientContact?.email || account?.contactEmail || null;
    if (!to) {
      await slackPostMessage(`:warning: TikTok disconnected for ${account.companyName} but no client email on file. Add clientContact.email to /accounts/${accountId}.`);
      return;
    }
    await send({
      template: "SocialReconnect",
      // Key on the event id so a webhook retry never re-sends.
      idempotencyKey: `socialReconnect/${accountId}/tiktok/${eventId}`,
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
    // Resolve the account manager's email the same way the client-safe
    // contract does: match account.accountManager (a NAME string) to the
    // /editors roster, falling back to account.accountManagerEmail. The
    // old `account.accountManager.email` / `projectLead.email` shape
    // doesn't exist on real records, so it always fell through to the
    // catch-all address.
    const editors = (await adminGet("/editors")) || null;
    const am = accountManagerBlock(account, editors);
    const leadEmail = am.email || process.env.SOCIAL_RECONNECT_FALLBACK_EMAIL || "hello@viewix.com.au";
    await send({
      template: "SocialReconnectInternal",
      idempotencyKey: `socialReconnectInternal/${accountId}/${platform}/${eventId}`,
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
  const profileId = profileIdFrom(payload);
  const platform = platformFrom(payload);
  if (!profileId || !platform) return;
  const accountId = await viewixAccountForProfile(profileId);
  if (!accountId) return;
  await adminPatch(`/zernio/connections/${accountId}/${platform}`, {
    status: "connected",
    lastConnected: Date.now(),
    refreshBy: null,
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
