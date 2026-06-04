// api/cron/social-schedule-sync.js
//
// 15-minute reconciliation cron. Three jobs:
//
//   0. Resume partial batches. schedule-posting-batch.js pushes Zernio
//      createPost serially; if item N fails, items N+1.. are persisted
//      with status:"pending" but no zernioPostId. Re-push them. Zernio
//      has NO durable client_reference_id, so dedup relies on the two
//      layers createPost() exposes: the 5-min x-request-id window and
//      the 24h content-hash dedup (identical platform/account/content
//      → returns the existing post id instead of forking). The cron
//      runs every 15 min, well inside the 24h window, so a re-push of
//      an item that actually made it to Zernio binds the existing id
//      rather than duplicating.
//
//   1. Reconcile past-due "pending" items that DO hold a zernioPostId
//      (webhook may have missed delivery). GET /posts/{postId} and
//      mirror Zernio's status locally.
//
//   2. Per-profile account drift — poll listAccounts to catch
//      disconnects that didn't fire a webhook.

import { isAuthorizedCron } from "../_cronAuth.js";
import { adminGet, getAdmin } from "../_fb-admin.js";
import { getPost, listAccounts, createPost, mapPlatformsToAccounts } from "../_zernio.js";

// Map a Zernio post status onto our local item status vocabulary.
function localStatusFor(remoteStatus) {
  const s = String(remoteStatus || "").toLowerCase();
  if (s === "published" || s === "posted" || s === "complete" || s === "completed") return "posted";
  if (s === "failed" || s === "error") return "failed";
  if (s === "partial") return "partial";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return null; // scheduled / pending / unknown → leave as-is (maybe stuck)
}

export default async function handler(req, res) {
  const auth = isAuthorizedCron(req);
  if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const now = Date.now();
  let reconciledPosted = 0;
  let reconciledFailed = 0;
  let stuck = 0;
  let resumedCreates = 0;
  let resumedCreateFailures = 0;
  let accountsChecked = 0;
  let accountDriftFlagged = 0;

  const schedules = (await adminGet("/socialSchedule")) || {};

  // Lazy per-profile account cache so we don't re-fetch listAccounts
  // for every item that shares a profile.
  const accountsCache = new Map(); // accountId -> listAccounts response
  async function accountsForAccount(accountId, profileId) {
    if (accountsCache.has(accountId)) return accountsCache.get(accountId);
    let resp = null;
    try { resp = await listAccounts(profileId); } catch (e) {
      console.warn(`sync: listAccounts failed for ${accountId}:`, e.message);
    }
    accountsCache.set(accountId, resp);
    return resp;
  }

  // Resolve an item's platform names → Zernio account refs. Prefer the
  // stored resolvedPlatforms; fall back to a live listAccounts lookup.
  async function resolveItemPlatforms(it, accountId, profileId) {
    if (Array.isArray(it.resolvedPlatforms) && it.resolvedPlatforms.length) {
      return { resolved: it.resolvedPlatforms, missing: [] };
    }
    const accountsResp = await accountsForAccount(accountId, profileId);
    if (!accountsResp) return { resolved: [], missing: it.platforms || [] };
    return mapPlatformsToAccounts(accountsResp, it.platforms || []);
  }

  // ─── Job 0: resume partial batches ────────────────────────────────
  for (const [scheduleId, schedule] of Object.entries(schedules)) {
    if (scheduleId === "byBatchId") continue;
    const items = Array.isArray(schedule?.items) ? schedule.items : [];
    const accountId = schedule?.accountId;
    if (!accountId) continue;
    const profile = await adminGet(`/zernio/profiles/${accountId}`);
    const profileId = profile?.profileId;
    if (!profileId) continue;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (it.status !== "pending") continue;
      if (it.zernioPostId) continue; // already created
      if (!it.zernioMediaUrl || !it.clientReferenceId || !it.postAt) continue;

      // Resolve platforms first — without a connected account we can't
      // create the post.
      const { resolved, missing } = await resolveItemPlatforms(it, accountId, profileId);
      if (!resolved.length || missing.length) {
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          lastResumeError: `unresolved platforms: ${missing.join(", ") || "none connected"}`,
          lastResumeAttemptAt: now,
        });
        resumedCreateFailures++;
        continue;
      }

      // Re-push. createPost dedupes server-side (5-min x-request-id or
      // 24h content-hash) and surfaces the existing post id rather than
      // forking — so an overlapping success from a previous run is
      // harmless: we just bind the id.
      try {
        const { postId } = await createPost({
          content: it.caption,
          scheduledFor: it.postAt,
          timezone: "Australia/Sydney",
          platforms: resolved,
          mediaUrl: it.zernioMediaUrl,
          requestId: it.clientReferenceId,
          trialReel: (it.platforms || []).includes("instagram") ? it.trialReel : false,
          tikTokCompliance: (it.platforms || []).includes("tiktok") ? it.tikTokCompliance : undefined,
        });
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          zernioPostId: postId || null,
          resolvedPlatforms: resolved,
          resumedAt: now,
        });
        resumedCreates++;
      } catch (e) {
        console.warn(`sync resume create failed for ${scheduleId}/${i}:`, e.message);
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          lastResumeError: String(e.message || e).slice(0, 500),
          lastResumeAttemptAt: now,
        });
        resumedCreateFailures++;
      }
    }
  }

  // ─── Job 1: pending-past-due posts (that hold a postId) ───────────
  for (const [scheduleId, schedule] of Object.entries(schedules)) {
    if (scheduleId === "byBatchId") continue;
    const items = Array.isArray(schedule?.items) ? schedule.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.status !== "pending") continue;
      // No postId after Job 0 means create is still failing — Job 0 owns
      // the retry. Without a postId we have nothing to look up (Zernio
      // has no reference query), so skip.
      if (!it.zernioPostId) continue;
      const postAtMs = it.postAt ? Date.parse(it.postAt) : NaN;
      if (!Number.isFinite(postAtMs)) continue;
      if (postAtMs > now) continue; // not due yet

      let remote;
      try {
        remote = await getPost(it.zernioPostId);
      } catch (e) {
        console.warn(`sync: getPost failed for ${scheduleId}/${i} (${it.zernioPostId}):`, e.message);
        continue;
      }
      const post = remote?.post || remote;
      const mapped = localStatusFor(post?.status);

      if (mapped === "posted") {
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          status: "posted",
          publishedAt: Date.parse(post.publishedAt || post.published_at) || now,
          permalink: post.permalink || post.url || null,
        });
        reconciledPosted++;
        continue;
      }
      if (mapped === "failed") {
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          status: "failed",
          failedAt: now,
          failedReason: String(post.error || post.failureReason || "zernio reported failed via sync").slice(0, 500),
        });
        reconciledFailed++;
        continue;
      }
      if (mapped === "cancelled" || mapped === "partial") {
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          status: mapped,
          syncedAt: now,
        });
        continue;
      }
      // Past-due but Zernio still shows scheduled/pending — flag stuck
      // so the producer dashboard can surface it. Don't change status.
      stuck++;
      await db.ref(`/socialSchedule/${scheduleId}/items/${i}/stuckSince`).set(it.stuckSince || now);
    }
  }

  // ─── Job 2: per-profile account drift ─────────────────────────────
  const profiles = (await adminGet("/zernio/profiles")) || {};
  for (const [accountId, p] of Object.entries(profiles)) {
    if (!p?.profileId) continue;
    accountsChecked++;
    const resp = await accountsForAccount(accountId, p.profileId);
    const accounts = resp?.accounts || resp?.data || (Array.isArray(resp) ? resp : []);
    if (!Array.isArray(accounts)) continue;
    for (const a of accounts) {
      const platform = String(a.platform || "").toLowerCase();
      if (!platform) continue;
      const status = String(a.status || "").toLowerCase();
      const local = await adminGet(`/zernio/connections/${accountId}/${platform}`);
      const localStatus = local?.status || null;
      const remoteStatus = status === "connected" || status === "active" ? "connected"
        : status === "expiring" ? "expiring"
        : "disconnected";
      if (localStatus !== remoteStatus) {
        await db.ref(`/zernio/connections/${accountId}/${platform}`).update({
          status: remoteStatus,
          lastSyncedAt: now,
        });
        accountDriftFlagged++;
      }
    }
  }

  return res.status(200).json({
    ok: true,
    ranAt: now,
    resumedCreates,
    resumedCreateFailures,
    reconciledPosted,
    reconciledFailed,
    stuck,
    accountsChecked,
    accountDriftFlagged,
  });
}
