// api/whisper.js
// Vercel Serverless Function: OpenAI Whisper proxy.
// Used by the Social Organic ShortlistStep to let producers dictate a format
// description into the mic instead of typing it out.
//
// Accepts a multipart/form-data upload with an "audio" file field, calls
// OpenAI whisper-1, returns { text }.  Also logs a $0.006-per-minute line
// into /preproduction/socialOrganic/_costLog/{date}/{runId} so Whisper
// usage appears alongside scrape/classify costs.
//
// Why proxy instead of hitting OpenAI from the browser:
//   - Keeps OPENAI_API_KEY out of the bundle.
//   - Vercel 4.5MB body limit is a hard cap — we surface a cleaner error here
//     than whatever OpenAI would return for an oversized request.
//   - Lets us accrue cost log entries server-side.
//
// Vercel function timeout bumped to 60s in vercel.json (Whisper usually
// returns in 2-10s; 60s is a comfortable safety margin).

import { adminPatch, getAdmin } from "./_fb-admin.js";
import crypto from "crypto";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const WHISPER_API = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";
const WHISPER_COST_PER_MINUTE = 0.006;  // USD, as of 2026
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;  // 4MB — stay under Vercel's 4.5MB body cap

// Vercel wants the raw body for multipart uploads — disable default parsing.
export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function fbCostLog(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  // REST fallback — matches api/social-organic.js's existing cost-log pattern.
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  try {
    const raw = await readRawBody(req);
    if (raw.length > MAX_AUDIO_BYTES) {
      return res.status(413).json({
        error: "Audio clip too large",
        detail: `Max ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB. Got ${(raw.length / 1024 / 1024).toFixed(1)}MB. Record a shorter clip or lower the bit rate.`,
      });
    }
    if (raw.length === 0) return res.status(400).json({ error: "Empty audio body" });

    // Pass the raw multipart body straight through to OpenAI. We keep the
    // same Content-Type (which carries the multipart boundary) so OpenAI
    // parses it identically to the browser's intent.
    const contentType = req.headers["content-type"];
    if (!contentType || !contentType.startsWith("multipart/form-data")) {
      // Also accept a plain audio upload — browsers that POST a raw Blob
      // won't set multipart.  We synthesise a multipart envelope on the fly.
      // But in practice we control the caller (useAudioRecorder) and it uses
      // FormData, so this branch is rare. Surface a clear error to debug.
      return res.status(400).json({
        error: "Expected multipart/form-data",
        detail: "The browser should POST a FormData with an 'audio' field. Got: " + (contentType || "(none)"),
      });
    }

    const whisperResp = await fetch(WHISPER_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": contentType,  // preserves the multipart boundary
      },
      body: raw,
    });

    const whisperBody = await whisperResp.text();
    if (!whisperResp.ok) {
      console.error("whisper error:", whisperResp.status, whisperBody.slice(0, 500));
      return res.status(whisperResp.status).json({
        error: "Whisper API failed",
        detail: whisperBody.slice(0, 500),
      });
    }

    let parsed;
    try { parsed = JSON.parse(whisperBody); }
    catch { return res.status(502).json({ error: "Whisper returned non-JSON", detail: whisperBody.slice(0, 500) }); }

    const text = parsed?.text || "";
    const durationSeconds = parsed?.duration || null;

    // Cost log — best-effort, never fail the request on a log error.
    // We don't always get a duration back (verbose_json only), so fall back
    // to a byte-based estimate (~12kbps webm = 1MB/~11 min is typical).
    try {
      const today = new Date().toISOString().slice(0, 10);
      const runId = `whisper_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;
      const estMinutes = durationSeconds
        ? durationSeconds / 60
        : (raw.length / (12 * 1024)) / 60;  // rough MediaRecorder webm estimate
      const estCost = +(estMinutes * WHISPER_COST_PER_MINUTE).toFixed(4);
      await fbCostLog(`/preproduction/socialOrganic/_costLog/${today}/${runId}`, {
        type: "whisper",
        bytes: raw.length,
        estMinutes: +estMinutes.toFixed(2),
        cost: estCost,
        textChars: text.length,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("whisper cost log failed:", e.message);
    }

    return res.status(200).json({ text, durationSeconds });
  } catch (e) {
    console.error("whisper handler error:", e);
    return res.status(500).json({ error: e.message || "Unknown error" });
  }
}
