// api/cron/social-asset-reconcile.js
//
// Daily belt-and-braces cron — covers the case where the side-effect
// POST from the client portal Deliveries UI to /api/on-video-approved
// silently failed (Vercel hiccup, network blip, user closed the tab
// mid-fetch). Without this cron, an approved video with no asset row
// would just sit there until the producer noticed in the Schedule
// Posting modal ("Assets still transferring...") and asked support.
//
// Logic:
//   1. Walk /deliveries.
//   2. For each delivery where postingOwner !== "client":
//      For each video where revision1 === "Approved" || revision2 === "Approved":
//        If /socialAssets/{deliveryId}_{videoId} doesn't exist,
//        back-queue it.
//
// Runs once daily. Volume is tiny (Viewix is at tens of approved
// videos a day, not thousands), so the full scan is fine. If/when
// volume scales, we'd index approved videos at write time instead.
//
// Auth: standard Vercel cron header. Same _cronAuth pattern as
// api/cron/* peers.

import { adminGet, getAdmin } from "../_fb-admin.js";
import { isAuthorizedCron } from "../_cronAuth.js";
import { REVISION_APPROVED, isPostLaunchDelivery } from "../_constants.js";
import { parseFrameioFileId } from "../_frameioUrl.js";

export default async function handler(req, res) {
  // Use the shared cron-auth helper — same path Vercel's bearer
  // injection + the x-vercel-cron presence-check + the test secret
  // are vetted through everywhere else.
  const auth = isAuthorizedCron(req);
  if (!auth.authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const deliveries = (await adminGet("/deliveries")) || {};
  const projectsObj = (await adminGet("/projects")) || {};
  const projectsByDeliveryId = {};
  for (const p of Object.values(projectsObj)) {
    const did = p?.links?.deliveryId;
    if (did) projectsByDeliveryId[did] = p;
  }

  let scanned = 0;
  let backfilled = 0;
  let alreadyQueued = 0;
  let skippedNoVideoId = 0;
  let skippedClientPosts = 0;
  let skippedPreLaunch = 0;
  let purgedPreLaunch = 0;
  let skippedAlreadyInZernio = 0;

  for (const [deliveryId, delivery] of Object.entries(deliveries)) {
    if (!delivery || !Array.isArray(delivery.videos)) continue;

    // Launch-cutoff gate. Deliveries created at/before the social
    // scheduler launch predate this feature (posted via Metricool).
    // They must NEVER queue a transfer. Two responsibilities here:
    //   (a) skip queuing for these deliveries, and
    //   (b) PURGE any /socialAssets row that was written for one
    //       before this gate existed (e.g. the cron ran post-merge
    //       but pre-fix). Idempotent: after the first purge there's
    //       nothing left to delete. This is the self-healing cleanup.
    if (!isPostLaunchDelivery(delivery)) {
      skippedPreLaunch++;
      for (const v of delivery.videos) {
        if (!v) continue;
        const videoId = v.videoId || v.id;
        if (!videoId) continue;
        const assetKey = `${deliveryId}_${videoId}`;
        const existing = await adminGet(`/socialAssets/${assetKey}`);
        if (existing) {
          await db.ref(`/socialAssets/${assetKey}`).remove();
          purgedPreLaunch++;
        }
      }
      continue;
    }

    if (delivery.postingOwner === "client") {
      skippedClientPosts++;
      continue;
    }
    const project = projectsByDeliveryId[deliveryId];
    const accountId = project?.links?.accountId || null;

    for (let idx = 0; idx < delivery.videos.length; idx++) {
      const v = delivery.videos[idx];
      if (!v) continue;
      const APPROVED = REVISION_APPROVED || "Approved";
      const approved = v.revision1 === APPROVED || v.revision2 === APPROVED;
      if (!approved) continue;
      scanned++;

      // Already transferred to Zernio — never re-queue. Matters now that
      // the createdAt backfill can flip previously-excluded deliveries
      // post-launch: a video handled before the gate moved already has
      // its asset in Zernio and must not be queued again. (The
      // /socialAssets row check below also covers the normal case; this
      // guards the path where zernioMediaUrl exists without a row.)
      if (v.zernioMediaUrl) { skippedAlreadyInZernio++; continue; }

      const videoId = v.videoId || v.id;
      if (!videoId) { skippedNoVideoId++; continue; }
      const assetKey = `${deliveryId}_${videoId}`;
      const existing = await adminGet(`/socialAssets/${assetKey}`);
      if (existing) { alreadyQueued++; continue; }

      // Resolve frameioFileId — shared parser, fixed regex (Codex
      // audit P1).
      let frameioFileId = v.frameioFileId || parseFrameioFileId(v.link);

      await db.ref(`/socialAssets/${assetKey}`).set({
        deliveryId,
        videoId,
        videoIdx: idx,
        accountId,
        frameioFileId,
        status: frameioFileId ? "queued" : "failed",
        attempts: 0,
        queuedAt: Date.now(),
        queuedBy: "reconcile-cron",
        error: frameioFileId ? null : "No frameioFileId resolvable from delivery video",
      });
      backfilled++;
    }
  }

  return res.status(200).json({
    ok: true,
    scanned,
    backfilled,
    alreadyQueued,
    skippedNoVideoId,
    skippedClientPosts,
    skippedPreLaunch,
    purgedPreLaunch,
    skippedAlreadyInZernio,
  });
}
