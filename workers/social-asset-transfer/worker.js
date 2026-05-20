// The claim/process/finish loop. One run per queued /socialAssets row.
//
// Claim is atomic via Firebase transaction — if two workers ever run
// at once (during a restart overlap, say), only one wins the lock per
// row. The loser sees `tx.committed === false` and silently moves on.
//
// On success: writes `status: "ready"` + zernioMediaUrl + fingerprint +
// metadata back to /socialAssets/{key}, AND mirrors zernioMediaUrl onto
// /deliveries/{deliveryId}/videos/{idx}.zernioMediaUrl so the Phase 3
// modal can find it.
//
// On failure: bumps `attempts`, writes `status: "failed"` with the
// error message. After 3 attempts, Slack-pings #video-deliveries with
// a stable summary line (producer goes back to Deliveries and hits
// "Re-queue transfer").
//
// On STALE_SOURCE (from transferOne): writes `status: "stale"` and
// clears `zernioMediaUrl`. The modal blocks scheduling until the
// producer hits Re-queue, which sets back to "queued".

import { hostname } from "os";
import { transferOne } from "./transfer.js";
import { slack } from "./slack.js";

const MAX_ATTEMPTS = 3;

function workerId() {
  return process.env.WORKER_ID || `${hostname()}-${process.pid}`;
}

// Try to atomically take ownership of a row. Returns the claimed row
// or null if we lost the race (or the row was already terminal). The
// transaction predicate accepts:
//   - status === "queued"     → fresh job
//   - status === "claimed"    AND claimedAt > 30 min ago → re-claim a
//                                                          crashed worker
async function claim(db, key, wid) {
  const ref = db.ref(`/socialAssets/${key}`);
  const tx = await ref.transaction(curr => {
    if (!curr) return; // row vanished
    if (curr.status === "queued") {
      return { ...curr, status: "claimed", claimedBy: wid, claimedAt: Date.now() };
    }
    if (curr.status === "claimed" && (Date.now() - (curr.claimedAt || 0)) > 30 * 60 * 1000) {
      // Re-claim — a worker died holding the lock more than 30 minutes
      // ago. Increment attempts so we don't loop forever on a poison row.
      return {
        ...curr,
        status: "claimed",
        claimedBy: wid,
        claimedAt: Date.now(),
        attempts: (curr.attempts || 0) + 1,
      };
    }
    return; // not for us
  });
  if (!tx.committed) return null;
  return tx.snapshot.val();
}

// Once we hold the claim, run the actual transfer.
export async function processRow(db, key) {
  const wid = workerId();
  const row = await claim(db, key, wid);
  if (!row) return { skipped: true };

  // Mark transferring (informational; the claim is the real lock).
  await db.ref(`/socialAssets/${key}`).update({
    status: "transferring",
    transferStartedAt: Date.now(),
  });

  try {
    const frameioFileId = row.frameioFileId;
    if (!frameioFileId) {
      throw new Error("Row has no frameioFileId — on-video-approved hook should have set this");
    }
    const result = await transferOne({
      frameioFileId,
      priorFingerprint: row.sourceFingerprint || null,
    });

    // Write the success state on the queue row.
    await db.ref(`/socialAssets/${key}`).update({
      status: "ready",
      zernioMediaUrl: result.zernioMediaUrl,
      zernioMediaId:  result.zernioMediaId,
      sourceFingerprint: result.sourceFingerprint,
      fileSize:    result.fileSize,
      durationSec: result.durationSec,
      width:       result.width,
      height:      result.height,
      frameioVersionId: result.frameioVersionId,
      finishedAt: Date.now(),
      error: null,
    });

    // Mirror onto the delivery so the Phase 3 modal can find it without
    // joining against /socialAssets at read time.
    if (row.deliveryId != null && row.videoIdx != null) {
      await db.ref(`/deliveries/${row.deliveryId}/videos/${row.videoIdx}/zernioMediaUrl`).set(result.zernioMediaUrl);
    }

    return { ok: true, key, zernioMediaUrl: result.zernioMediaUrl };
  } catch (e) {
    const attempts = (row.attempts || 0) + 1;
    console.error(`transfer ${key} failed (attempt ${attempts}):`, e);

    if (e.code === "STALE_SOURCE") {
      // Producer changed the underlying file. Mark stale, clear the
      // possibly-outdated url, surface in Slack so the producer knows.
      await db.ref(`/socialAssets/${key}`).update({
        status: "stale",
        zernioMediaUrl: null,
        error: e.message,
        attempts,
      });
      await slack(`:warning: Asset transfer marked STALE — source file changed for delivery \`${row.deliveryId}\` video \`${row.videoIdx}\`. Producer must re-queue from the Deliveries UI.`);
      return { stale: true, key };
    }

    const newStatus = attempts >= MAX_ATTEMPTS ? "failed" : "queued"; // back to queue for retry
    await db.ref(`/socialAssets/${key}`).update({
      status: newStatus,
      error: e.message,
      attempts,
    });

    if (newStatus === "failed") {
      await slack(`:rotating_light: Asset transfer FAILED after ${MAX_ATTEMPTS} attempts — delivery \`${row.deliveryId}\` video \`${row.videoIdx}\`: ${e.message}`);
    }
    return { failed: true, key, attempts };
  }
}
