// api/on-video-approved.js
//
// Side-effect POST fired by the client portal's Deliveries.jsx (and
// the tokenless /d/ public view's DeliveryPublicView.jsx) immediately
// after a revision1/revision2 leaf write resolves with value
// "Approved". The leaf write itself goes direct to Firebase — this
// endpoint exists to do the *follow-on* work that Vercel can't see
// from a passive listener:
//
//   1. Snapshot the caption from /preproduction/socialOrganic onto
//      the delivery video (Phase 2B caption flow).
//   2. Enqueue an asset-transfer job at /socialAssets/{key} so the
//      Mac Mini worker (Phase 2A) starts moving the Frame.io
//      original into Zernio's media store.
//
// Idempotency: a row at /socialAssets/{deliveryId}_{videoId} means
// we've already kicked off (or are mid-transfer of) this approval.
// Skip silently. Producer/client can spam the approval dropdown
// (Approved → Need Revisions → Approved) without forking new jobs.
//
// Auth: NONE — same pattern as api/notify-revision.js. The endpoint
// re-reads /deliveries/{deliveryId} server-side and verifies the
// video at the given idx is actually approved (revision1 OR
// revision2 === "Approved"). Without that check, a hostile actor
// could spam the queue with junk; with it, we only act on state
// that's already been written to Firebase by a separately-authed
// path.
//
// Rate-limited by IP, 30/minute. Same defensive surface as
// notify-revision.js — sized to be invisible to legitimate use but
// hard to weaponise.

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { REVISION_APPROVED, isPostLaunchDelivery } from "./_constants.js";
import { parseFrameioFileId } from "./_frameioUrl.js";
import { captionForVideoId } from "./_preprodCaptions.js";
import { findOwningProject } from "./_findOwningProject.js";

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const attempts = new Map();

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRate(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  attempts.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

// Look up the caption for `videoId` on the linked pre-production doc.
// Uses the shared helper in _preprodCaptions.js so the snapshot here
// matches the read-through fallback the client portal renders pre-
// approval (Codex P1 pass 2). videoIdx is the ordinal lookup path
// scriptTable rows actually support today (Codex pass 3 P1: rows
// have videoNumber, not videoId). If neither path matches, returns
// "" — the producer fills it in manually on the delivery side. The
// asset transfer still queues regardless; an empty caption is an
// acceptable v1 fallback.
async function lookupPreprodCaption({ project, videoId, videoIdx }) {
  if (!project) return "";
  const preprodType = project?.links?.preprodType;
  const preprodId = project?.links?.preprodId;
  if (preprodType !== "socialOrganic" || !preprodId) return "";
  const preprod = await adminGet(`/preproduction/socialOrganic/${preprodId}`);
  return captionForVideoId(preprod, videoId, videoIdx);
}

// Locate the project that links to this delivery via the shared
// fail-closed helper (api/_findOwningProject.js). Returns null on no
// match OR ambiguous (>1) match — we refuse to write to /socialAssets,
// snapshot a caption, or otherwise act on a duplicate-link delivery,
// because attributing the asset to the wrong account is worse than
// the no-op. Codex audit 2026-05-28.
async function findProjectForDelivery(deliveryId) {
  const projectsObj = (await adminGet("/projects")) || {};
  const { project, ambiguous } = findOwningProject(projectsObj, deliveryId);
  if (ambiguous) {
    console.warn(`[on-video-approved] multiple projects share deliveryId=${deliveryId}; refusing to act`);
  }
  return project;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!checkRate(clientIp(req))) return res.status(429).json({ error: "Too many notifications" });

  const { deliveryId, videoIdx } = req.body || {};
  if (!deliveryId) return res.status(400).json({ error: "deliveryId required" });
  if (typeof videoIdx !== "number" || videoIdx < 0) {
    return res.status(400).json({ error: "videoIdx (number >= 0) required" });
  }

  try {
    // 1. Load delivery + verify the video is actually approved.
    //    The UI tells us about an approval transition, but we don't
    //    trust the UI — we verify in Firebase. Without this check,
    //    a hostile actor could spam the queue.
    const delivery = await adminGet(`/deliveries/${deliveryId}`);
    if (!delivery) return res.status(404).json({ error: "delivery_not_found" });

    // Verify approval BEFORE any side-effect (incl. the viewixStatus
    // flip below). The UI tells us about an approval transition but we
    // don't trust it — we re-read Firebase. Without this gate, a
    // hostile actor could flip status on arbitrary delivery videos.
    const videos = Array.isArray(delivery.videos) ? delivery.videos : [];
    const video = videos[videoIdx];
    if (!video) return res.status(404).json({ error: "video_idx_out_of_range" });

    const APPROVED = REVISION_APPROVED || "Approved";
    const isApproved = video.revision1 === APPROVED || video.revision2 === APPROVED;
    if (!isApproved) {
      return res.status(409).json({
        error: "video_not_approved",
        revision1: video.revision1 || null,
        revision2: video.revision2 || null,
      });
    }

    // Universal side-effect: a verified-approved video flips its
    // viewixStatus to "Completed" so the client portal and the staff
    // Deliveries view stay aligned ("you approved it → status reflects
    // that"). Idempotent — skip the write if already "Completed".
    // Applies to ALL delivery types (incl. pre-launch) since this
    // semantic is independent of the asset-transfer pipeline.
    // One-way only: un-approving does NOT auto-revert the status; staff
    // can correct it from the producer Deliveries tab if needed.
    let viewixStatusUpdated = false;
    if (video.viewixStatus !== "Completed") {
      await adminPatch(`/deliveries/${deliveryId}/videos/${videoIdx}`, { viewixStatus: "Completed" });
      viewixStatusUpdated = true;
    }

    // 0. Launch-cutoff gate (asset-transfer-specific). Deliveries
    //    created at/before the social scheduler launch predate Phase 2A
    //    — they were posted via Metricool and must NEVER queue an
    //    asset transfer. Skip silently (200, not an error) so a re-
    //    approval of an old delivery is a clean no-op. The viewixStatus
    //    flip above DID apply — it's an independent concern.
    if (!isPostLaunchDelivery(delivery)) {
      return res.status(200).json({ ok: true, skipped: "pre_launch_delivery", viewixStatusUpdated });
    }

    const videoId = video.videoId || video.id;
    if (!videoId) {
      // Pre-migration delivery row (no videoId). Don't fail loudly —
      // legitimate older deliveries hit this. Return ok so the UI
      // can move on; the daily reconcile cron won't pick this up
      // either (it requires videoId).
      return res.status(200).json({ ok: true, skipped: "no_videoId" });
    }

    // 2. Skip posting-owner=client deliveries — those don't go through
    //    Zernio at all, so no transfer queue needed.
    const postingOwner = delivery.postingOwner || "viewix";
    if (postingOwner === "client") {
      return res.status(200).json({ ok: true, skipped: "client_posts_themselves" });
    }

    // 3. Idempotency — if the row already exists for any prior
    //    approval transition of this video, skip silently.
    const assetKey = `${deliveryId}_${videoId}`;
    const existingAsset = await adminGet(`/socialAssets/${assetKey}`);
    if (existingAsset) {
      return res.status(200).json({
        ok: true,
        alreadyQueued: true,
        assetKey,
        status: existingAsset.status,
      });
    }

    // 4. Reverse-lookup the project so we can find the linked pre-
    //    production doc + accountId for the asset row.
    const project = await findProjectForDelivery(deliveryId);
    const accountId = project?.links?.accountId || null;

    // 5. Snapshot the caption from pre-prod onto the delivery video.
    //    Best-effort — leaves "" if pre-prod has no caption.
    let snapshottedCaption = "";
    try {
      snapshottedCaption = await lookupPreprodCaption({ project, videoId, videoIdx });
    } catch (e) {
      console.warn(`on-video-approved: caption lookup failed for ${assetKey}:`, e.message);
    }
    // Only write if we found something OR the field is currently empty.
    // If the producer manually filled the caption on the delivery (e.g.
    // a delivery with no preprod link), don't clobber it.
    if (snapshottedCaption) {
      await adminPatch(`/deliveries/${deliveryId}/videos/${videoIdx}`, {
        caption: snapshottedCaption,
      });
    }

    // 6. Resolve frameioFileId. Preferred: an explicit
    //    `frameioFileId` field on the delivery video. Fallback:
    //    parse it out of `video.link` via the shared shape walker
    //    in api/_frameioUrl.js (Codex audit caught a regex bug
    //    that captured reviewIds instead of fileIds — see that
    //    file for the comment chain). If neither works, the row
    //    is queued with status "failed" and a clear error so the
    //    producer fixes the link.
    let frameioFileId = video.frameioFileId || parseFrameioFileId(video.link);

    // 7. Write the asset transfer queue row. The Mac Mini worker
    //    (workers/social-asset-transfer/) picks it up within 15s.
    const { db, err } = getAdmin();
    if (err) return res.status(500).json({ error: err });
    await db.ref(`/socialAssets/${assetKey}`).set({
      deliveryId,
      videoId,
      videoIdx,
      accountId,
      frameioFileId,
      status: frameioFileId ? "queued" : "failed",
      attempts: 0,
      queuedAt: Date.now(),
      error: frameioFileId ? null : "No frameioFileId on video and link did not match Frame.io URL pattern",
    });

    return res.status(200).json({
      ok: true,
      assetKey,
      capturedCaption: !!snapshottedCaption,
      frameioFileId: frameioFileId || null,
      viewixStatusUpdated,
    });
  } catch (e) {
    console.error("on-video-approved handler error:", e);
    return res.status(500).json({ error: e.message });
  }
}
