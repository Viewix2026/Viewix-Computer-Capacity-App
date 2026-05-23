// sha256 source fingerprinting + ffprobe metadata extraction.
//
// `sourceFingerprint` is stored on /socialAssets/{key} and used by the
// worker on subsequent runs (and by api/on-video-approved.js's
// stale-asset detection) to tell whether the producer swapped the
// underlying Frame.io file out from under us between approval and
// scheduling. Mismatch = mark the asset stale, block scheduling,
// surface a re-queue prompt in the Deliveries UI.
//
// ffprobe gives us duration + width + height for the modal's per-
// platform validation (TikTok max 60s for many account states, IG
// Reels prefers 9:16, etc.). Best-effort: if ffprobe isn't installed
// or fails on a particular file, we record fileSize + null on the
// rest. The Mac Mini SHOULD have ffmpeg/ffprobe available since
// Viewix already runs video tooling there.

import { createHash } from "crypto";
import { spawn } from "child_process";
import { createReadStream, statSync } from "fs";

export function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end",  () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Wraps `ffprobe -v error -print_format json -show_streams -show_format`
// and pulls out duration / width / height / codec. Returns nulls on any
// failure so the asset row at least gets file size + fingerprint.
export async function probe(path) {
  let stat = null;
  try { stat = statSync(path); } catch { /* ignore */ }
  const fileSize = stat ? stat.size : null;

  let parsed = null;
  try {
    parsed = await new Promise((resolve, reject) => {
      const args = [
        "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        path,
      ];
      const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", c => { out += c; });
      child.stderr.on("data", c => { err += c; });
      child.on("error", reject); // ENOENT etc.
      child.on("close", code => {
        if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.slice(0, 300)}`));
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
    });
  } catch (e) {
    console.warn("ffprobe failed (continuing with size only):", e.message);
  }

  const video = parsed?.streams?.find(s => s.codec_type === "video");
  const durationSec = parsed?.format?.duration ? Number(parsed.format.duration) : null;
  const width  = video?.width  ?? null;
  const height = video?.height ?? null;

  return {
    fileSize,
    durationSec: durationSec && isFinite(durationSec) ? Math.round(durationSec * 100) / 100 : null,
    width,
    height,
  };
}
