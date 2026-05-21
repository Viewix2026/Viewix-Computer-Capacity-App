// The actual Frame.io → Zernio transfer for one queued row.
//
// Why temp file by default: pure streaming would be elegant, but
// Zernio's presigned PUT target (S3-style) typically requires a known
// Content-Length, and Frame.io's CloudFront response often returns a
// Transfer-Encoding: chunked stream where we don't know the byte count
// upfront. Plus we WANT to hash the file (sha256 fingerprint) and
// ffprobe it for metadata — both of which need the bytes on disk.
// So: download to /tmp first, then upload from disk. The file size is
// 100-500MB typically, well within /tmp budget.
//
// On startup the worker sweeps /tmp/social-asset-transfer-* paths older
// than 1 hour and unlinks them — covers the case where a previous run
// crashed mid-transfer.

import { createReadStream, createWriteStream, unlinkSync, statSync, mkdtempSync, rmdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { getOriginalMediaUrl } from "./frameio.js";
import { presignUpload, uploadToPresigned } from "./zernio.js";
import { sha256OfFile, probe } from "./fingerprint.js";

// Download the Frame.io original to a tmp file. Returns the local path.
async function downloadToTmp(downloadUrl, suggestedName) {
  const dir = mkdtempSync(join(tmpdir(), "social-asset-transfer-"));
  const ext = suggestedName?.includes(".") ? suggestedName.slice(suggestedName.lastIndexOf(".")) : ".mp4";
  const path = join(dir, `asset${ext}`);
  const resp = await fetch(downloadUrl);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Frame.io download ${resp.status}: ${text.slice(0, 300)}`);
    err.code = `FRAMEIO_DOWNLOAD_${resp.status}`;
    throw err;
  }
  if (!resp.body) {
    throw new Error("Frame.io download: response body is empty");
  }
  await pipeline(resp.body, createWriteStream(path));
  return { path, dir };
}

function cleanup(dir, path) {
  try { unlinkSync(path); } catch { /* ignore */ }
  try { rmdirSync(dir); } catch { /* ignore */ }
}

// Run one transfer end-to-end.
//
//   frameioFileId: from /socialAssets/{key}.frameioFileId (mirrors
//                  /deliveries/{id}/videos/{idx}.frameioFileId once
//                  Phase 2B's snapshot writes it; until then it
//                  defaults to the file id extractable from
//                  /deliveries/{id}/videos/{idx}.link — caller is
//                  expected to have resolved this before queuing).
//
//   priorFingerprint: optional. If provided AND the new fingerprint
//                  differs, we throw STALE_SOURCE so the caller can
//                  mark the row stale instead of replacing the asset.
//
// Returns:
//   { zernioMediaUrl, zernioMediaId, sourceFingerprint, fileSize,
//     durationSec, width, height, frameioVersionId }
export async function transferOne({ frameioFileId, priorFingerprint } = {}) {
  if (!frameioFileId) throw new Error("transferOne: frameioFileId required");

  // 1. Get the fresh Frame.io download URL.
  const fio = await getOriginalMediaUrl(frameioFileId);

  // 2. Download to /tmp.
  let tmp;
  try {
    tmp = await downloadToTmp(fio.downloadUrl, fio.name);
  } catch (e) {
    e.stage = "download";
    throw e;
  }

  try {
    // 3. Probe + hash.
    const stat = statSync(tmp.path);
    const fileSize = stat.size;
    const sourceFingerprint = await sha256OfFile(tmp.path);
    const meta = await probe(tmp.path);

    // 3a. Stale-source check — if the producer swapped the file,
    // bail and let the caller mark this row stale.
    if (priorFingerprint && priorFingerprint !== sourceFingerprint) {
      const err = new Error(`Source fingerprint changed (was ${priorFingerprint.slice(0, 12)}…, now ${sourceFingerprint.slice(0, 12)}…) — marking stale.`);
      err.code = "STALE_SOURCE";
      throw err;
    }

    // 4. Ask Zernio for an upload target.
    const contentType = fio.fileType || "video/mp4";
    const presign = await presignUpload({
      fileType: contentType,
      fileName: fio.name || `asset-${frameioFileId}.mp4`,
    });

    // 5. PUT the bytes.
    const body = createReadStream(tmp.path);
    await uploadToPresigned({
      uploadUrl: presign.uploadUrl,
      body,
      contentType,
      contentLength: fileSize,
    });

    return {
      // publicUrl is the durable handle — the bytes now live in Zernio's
      // own media store, so there's no media id to track for v1.
      zernioMediaUrl: presign.publicUrl,
      zernioMediaId:  null,
      sourceFingerprint,
      fileSize,
      durationSec: meta.durationSec,
      width:       meta.width,
      height:      meta.height,
      frameioVersionId: fio.versionId,
    };
  } finally {
    cleanup(tmp.dir, tmp.path);
  }
}

// Startup sweep — unlink any orphaned tmp dirs from a previous run. We
// recognise our own dirs by the `social-asset-transfer-` prefix.
// Anything older than 1 hour is presumed crashed and is unlinked.
export function cleanupOrphanTmpDirs() {
  let dirs;
  try {
    dirs = readdirSync(tmpdir());
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of dirs) {
    if (!name.startsWith("social-asset-transfer-")) continue;
    const full = join(tmpdir(), name);
    try {
      const stat = statSync(full);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > 60 * 60 * 1000) {
        rmSync(full, { recursive: true, force: true });
        console.log(`cleanupOrphanTmpDirs: removed ${full} (age ${Math.round(ageMs / 60000)}m)`);
      }
    } catch { /* ignore */ }
  }
}
