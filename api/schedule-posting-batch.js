// api/schedule-posting-batch.js
//
// The Phase 3 Schedule Posting modal submits to this endpoint. Inputs:
//   {
//     batchId,        // minted client-side at modal open, stable across
//                     //   re-submits — idempotency anchor
//     deliveryId,
//     accountId,
//     preferences:    // { daysOfWeek, videosPerWeek, times, startDate }
//                     // — server recomputes the schedule from this,
//                     //   never trusts client-computed postAt
//     items: [        // one per approved video the producer chose
//       {
//         videoIdx,
//         caption,          // editable from the snapshot
//         platforms,        // subset of account.platforms.enabled
//         trialReel,        // IG trial-reel toggle (boolean)
//         tikTokCompliance, // per-delivery section (passed when TikTok
//                           //   is in any item's platforms)
//       },
//     ],
//   }
//
// Server is final authority for `postAt`. Idempotency on batchId
// prevents double-clicks / Vercel retries forking duplicate
// schedules. Per-item clientReferenceId of `${batchId}::${videoIdx}`
// gives Zernio a server-side dedupe anchor too.
//
// On success: writes /socialSchedule/{scheduleId} + a byBatchId index
// for idempotency lookups, plus calls Zernio createPost for each item.

import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { getAdmin, adminGet } from "./_fb-admin.js";
import { computeSchedule } from "./_socialSchedule.js";
import { createPost as zernioCreatePost, listAccounts, mapPlatformsToAccounts } from "./_zernio.js";

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

  const body = req.body || {};
  const batchId    = String(body.batchId || "").trim();
  const deliveryId = String(body.deliveryId || "").trim();
  const accountId  = String(body.accountId  || "").trim();
  const prefs      = body.preferences || {};
  const items      = Array.isArray(body.items) ? body.items : [];

  if (!batchId)    return res.status(400).json({ error: "batchId required" });
  if (!deliveryId) return res.status(400).json({ error: "deliveryId required" });
  if (!accountId)  return res.status(400).json({ error: "accountId required" });
  if (items.length === 0) return res.status(400).json({ error: "no_items" });
  // Cheap shape check on batchId — only alnum + hyphen, 6-40 chars,
  // matching the ShareWithClientModal pattern.
  if (!/^[A-Za-z0-9-]{6,40}$/.test(batchId)) {
    return res.status(400).json({ error: "batchId invalid (6-40 alnum/hyphen)" });
  }

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  // 1. Idempotency — same batchId returns the same schedule.
  const existing = await adminGet(`/socialSchedule/byBatchId/${batchId}`);
  if (existing) {
    const sched = await adminGet(`/socialSchedule/${existing}`);
    return res.status(200).json({
      ok: true,
      scheduleId: existing,
      schedule: sched,
      idempotent: true,
    });
  }

  // 2. Look up Zernio profile.
  const profile = await adminGet(`/zernio/profiles/${accountId}`);
  if (!profile || !profile.profileId) {
    return res.status(409).json({
      error: "no_zernio_profile",
      detail: "Provision a Zernio profile for this account first.",
    });
  }
  const profileId = profile.profileId;

  // 3. Load delivery so we can read zernioMediaUrl per item.
  const delivery = await adminGet(`/deliveries/${deliveryId}`);
  if (!delivery) return res.status(404).json({ error: "delivery_not_found" });
  const videos = Array.isArray(delivery.videos) ? delivery.videos : [];
  if (delivery.postingOwner === "client") {
    return res.status(409).json({ error: "client_posts_themselves" });
  }

  // 3b. Server-authority platform check (Codex pass 4 P2). The modal
  //     fails closed, but the SERVER must independently reject any
  //     platform not enabled on the account — a stale modal, bad
  //     client state, or a crafted request must never schedule an
  //     un-onboarded platform (e.g. posting to a LinkedIn page the
  //     client never connected). Build the enabled-platform set from
  //     /accounts/{accountId}/platforms; reject the whole batch if
  //     none are enabled, and reject any individual item below that
  //     targets a non-enabled platform.
  const accountPlatforms = (await adminGet(`/accounts/${accountId}/platforms`)) || {};
  const enabledPlatformSet = new Set(
    Object.entries(accountPlatforms).filter(([, v]) => v && v.enabled).map(([k]) => k)
  );
  if (enabledPlatformSet.size === 0) {
    return res.status(409).json({
      error: "no_platforms_enabled",
      detail: "This account has no in-scope platforms configured. Set account.platforms[*].enabled before scheduling.",
    });
  }

  // 3c. Fetch Zernio's connected social accounts ONCE for this profile.
  //     `account.platforms[*].enabled` is the Viewix-side "in scope"
  //     flag; it does NOT prove the platform is actually connected in
  //     Zernio. createPost needs the connected account's Zernio `_id`
  //     per platform, so resolve names → ids here. A targeted platform
  //     with no connected Zernio account is a hard fail (reconnect
  //     first) — caught per item below.
  let zernioAccounts;
  try {
    zernioAccounts = await listAccounts(profileId);
  } catch (e) {
    return res.status(502).json({ error: "zernio_list_accounts_failed", detail: e.message });
  }

  // 4. Compute postAt for each item server-side.
  let scheduled;
  try {
    scheduled = computeSchedule(prefs, items.length);
  } catch (e) {
    return res.status(400).json({ error: "schedule_invalid", detail: e.message });
  }

  // 5. Assemble + validate each item before any Zernio call. The
  //    authoritative source for "is this asset ready to schedule?" is
  //    /socialAssets/{deliveryId}_{videoId}.status, NOT the delivery
  //    mirror. The mirror is a cache for the modal's pre-flight
  //    enable/disable logic — but it can lag the queue row when
  //    transitioning to stale or failed. We re-check the queue row
  //    here so a stale/failed asset can NEVER slip through into a
  //    Zernio createPost call. Codex audit P1.
  const assembled = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const idx  = Number(item.videoIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= videos.length) {
      return res.status(400).json({ error: `item ${i}: bad videoIdx ${item.videoIdx}` });
    }
    const v = videos[idx];
    if (!v) return res.status(400).json({ error: `item ${i}: video missing at idx ${idx}` });
    const videoId = v.videoId || v.id || null;
    if (!videoId) {
      return res.status(409).json({
        error: "video_missing_id",
        detail: `Video at idx ${idx} has no videoId — pre-migration record. Set a videoId before scheduling.`,
        videoIdx: idx,
      });
    }

    // Authoritative asset-truth lookup. Reject if the queue row is
    // not in "ready" state, regardless of what the delivery mirror
    // shows. Cover: queued (transfer not started), claimed/transferring
    // (transfer in progress), failed (3 attempts exhausted),
    // stale (source file changed), or row missing (no transfer
    // ever queued).
    const assetKey = `${deliveryId}_${videoId}`;
    const assetRow = await adminGet(`/socialAssets/${assetKey}`);
    if (!assetRow) {
      return res.status(409).json({
        error: "asset_not_queued",
        detail: `Video at idx ${idx} (${v.name || videoId}) has no /socialAssets row. The on-video-approved hook never fired — re-queue from Deliveries.`,
        videoIdx: idx,
      });
    }
    if (assetRow.status !== "ready" || !assetRow.zernioMediaUrl) {
      return res.status(409).json({
        error: "asset_not_ready",
        detail: `Video at idx ${idx} (${v.name || videoId}) has asset status "${assetRow.status}". Only "ready" assets can be scheduled. ${assetRow.error ? "Error: " + assetRow.error : ""}`.trim(),
        videoIdx: idx,
        assetStatus: assetRow.status,
      });
    }

    const platforms = Array.isArray(item.platforms) ? item.platforms.map(String) : [];
    if (platforms.length === 0) {
      return res.status(400).json({ error: `item ${i}: at least one platform required` });
    }
    // Server-authority per-item platform gate (Codex pass 4 P2).
    const badPlatforms = platforms.filter(p => !enabledPlatformSet.has(p));
    if (badPlatforms.length > 0) {
      return res.status(409).json({
        error: "platform_not_enabled",
        detail: `item ${i} (video idx ${idx}): platform(s) ${badPlatforms.join(", ")} are not enabled on this account. Enable them on the account record or remove them from the schedule.`,
        videoIdx: idx,
        badPlatforms,
      });
    }
    // Resolve platform NAMES → Zernio connected-account ids. A targeted
    // platform with no connected Zernio account can't be posted to —
    // fail loudly so the producer reconnects rather than half-scheduling.
    const { resolved, missing } = mapPlatformsToAccounts(zernioAccounts, platforms);
    if (missing.length > 0) {
      return res.status(409).json({
        error: "platform_not_connected",
        detail: `item ${i} (video idx ${idx}): platform(s) ${missing.join(", ")} are enabled on the account but not connected in Zernio. Reconnect them before scheduling.`,
        videoIdx: idx,
        missing,
      });
    }
    assembled.push({
      videoIdx: idx,
      videoId,
      frameioFileId: assetRow.frameioFileId || v.frameioFileId || null,
      // Read mediaUrl from the authoritative queue row, not the cached
      // delivery mirror — protects against a brief window where the
      // mirror lags a stale-flip.
      zernioMediaUrl: assetRow.zernioMediaUrl,
      sourceFingerprint: assetRow.sourceFingerprint || null,
      caption: String(item.caption || v.caption || ""),
      platforms,
      resolvedPlatforms: resolved,
      trialReel: !!item.trialReel,
      tikTokCompliance: item.tikTokCompliance || null,
      postAt: scheduled[i].postAt,
      // OUR internal stable per-item key — used as Zernio's x-request-id
      // header (5-min idempotency) and the local idempotency anchor for
      // the sync cron's resume pass. NOT a Zernio-side durable field;
      // Zernio has no client_reference_id concept.
      clientReferenceId: `${batchId}::${idx}`,
      status: "pending",
    });
  }

  // 6. Push each item to Zernio. We push serially — even though they
  //    could parallelise, serial keeps the failure surface tractable
  //    (if item 4 fails we know items 1-3 are in Zernio + recorded
  //    locally, items 5+ are not yet attempted). Each item passes its
  //    clientReferenceId as Zernio's x-request-id so a Vercel retry
  //    within 5 min dedupes; beyond that the 24h content-hash layer
  //    catches an identical re-POST.
  const scheduleId = `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  for (const item of assembled) {
    try {
      const { postId } = await zernioCreatePost({
        content: item.caption,
        scheduledFor: item.postAt,
        timezone: "Australia/Sydney",
        platforms: item.resolvedPlatforms,
        mediaUrl: item.zernioMediaUrl,
        requestId: item.clientReferenceId,
        trialReel: item.platforms.includes("instagram") ? item.trialReel : false,
        tikTokCompliance: item.platforms.includes("tiktok") ? item.tikTokCompliance : undefined,
      });
      item.zernioPostId = postId || null;
    } catch (e) {
      console.error("zernio createPost failed for item", item, e);
      // Persist what we've done so far so the producer can see partial
      // progress and re-trigger. Mark THIS item as failed and stop —
      // don't push downstream items that the producer might want to
      // adjust after seeing the failure.
      const partial = {
        batchId,
        deliveryId,
        accountId,
        createdAt: Date.now(),
        createdBy: { uid: actor.uid, email: actor.email || null },
        preferencesSnapshot: prefs,
        items: assembled.map(it => it === item
          ? { ...it, status: "failed", error: e.message }
          : it
        ),
        error: e.message,
      };
      await db.ref(`/socialSchedule/${scheduleId}`).set(partial);
      await db.ref(`/socialSchedule/byBatchId/${batchId}`).set(scheduleId);
      return res.status(502).json({
        error: "zernio_create_failed",
        detail: e.message,
        scheduleId,
      });
    }
  }

  // 7. Persist the final schedule.
  const record = {
    batchId,
    deliveryId,
    accountId,
    createdAt: Date.now(),
    createdBy: { uid: actor.uid, email: actor.email || null },
    preferencesSnapshot: prefs,
    items: assembled,
  };
  await db.ref(`/socialSchedule/${scheduleId}`).set(record);
  await db.ref(`/socialSchedule/byBatchId/${batchId}`).set(scheduleId);

  // 8. Mark the schedule banner dismissed on the delivery so the
  //    producer doesn't see "All videos approved — Schedule" pop back
  //    up after they just finished scheduling.
  await db.ref(`/deliveries/${deliveryId}/scheduleBannerDismissed`).set(true);

  return res.status(200).json({
    ok: true,
    scheduleId,
    schedule: record,
    idempotent: false,
  });
}
