// api/apify-webhook.js
// Thin wrapper around processApifyRun (./_apifyProcess.js). Receives
// Apify's ACTOR.RUN.* callbacks, validates the shared secret, and hands
// off to the shared processing helper.
//
// NOTE: in practice the auto-poll in the frontend calls refreshScrapes
// which uses processApifyRun directly (no HTTP loopback, so unaffected
// by Vercel Deployment Protection). This endpoint stays as an
// optimisation — when Apify CAN reach it, data lands faster.
//
// Secret is passed as an Authorization bearer token so it does not land
// in URL logs. Set APIFY_WEBHOOK_SECRET in Vercel.

import { processApifyRun } from "./_apifyProcess.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const SECRET = process.env.APIFY_WEBHOOK_SECRET;
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!SECRET) return res.status(500).json({ error: "APIFY_WEBHOOK_SECRET not configured" });
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const auth = req.headers.authorization || "";
  const providedSecret = auth.match(/^Bearer\s+(.+)$/i)?.[1] || req.headers["x-apify-webhook-secret"];
  if (providedSecret !== SECRET) {
    return res.status(401).json({ error: "Invalid secret" });
  }

  try {
    const payload = req.body || {};
    const runId = payload.runId || payload.resource?.id || req.query.runId;
    const status = payload.status || payload.resource?.status || "SUCCEEDED";
    const datasetId = payload.datasetId || payload.resource?.defaultDatasetId;
    if (!runId) return res.status(400).json({ error: "Missing runId" });

    const result = await processApifyRun({ runId, status, datasetId, apifyToken: APIFY_TOKEN });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("apify-webhook error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
