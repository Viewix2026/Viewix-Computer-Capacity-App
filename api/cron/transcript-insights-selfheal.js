// api/cron/transcript-insights-selfheal.js — Vercel cron, hourly.
//
// ── What this does ────────────────────────────────────────────────
// Scans /meetingFeedback for records that were analysed but never
// contributed to /transcriptInsights (no `insightsExtracted` marker)
// and runs extractAndMergeInsights on them, oldest-first, sequentially.
//
// The SAME scan serves two jobs over the feature's lifetime:
//   1. First runs after deploy: drain the historical backlog of old
//      transcripts that predate the feature.
//   2. Ongoing: retry any live inline extraction that failed (the
//      inline path leaves no marker on failure, so it shows up here).
// Hence "self-heal", not "backfill" — its permanent hourly existence is
// the retry net, not a one-shot migration. Idempotent via the marker.
//
// Serial + oldest-first keeps the canonical list coherent and avoids
// the duplicate-insert race two parallel extractions could cause.
//
// ── Auth ──────────────────────────────────────────────────────────
// Vercel cron requests carry `Authorization: Bearer <CRON_SECRET>`.
// FAIL CLOSED if CRON_SECRET is unset — this endpoint spends Claude
// tokens, never serve it open.

import { adminGet, adminSet, getAdmin } from "../_fb-admin.js";
import { extractAndMergeInsights } from "../_transcript-insights.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// Per-run cap. 15 sequential Sonnet calls fit comfortably inside the
// 300s maxDuration; the backlog drains across successive hourly runs.
const BATCH = 15;

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({
      error: "CRON_SECRET not configured; refusing to run.",
      hint: "Set CRON_SECRET in Vercel env vars; Vercel sends it as the cron Authorization header.",
    });
    return;
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    return;
  }

  try {
    const all = (await fbGet("/meetingFeedback")) || {};

    // Eligible: analysed + has a transcript + no marker yet.
    const pending = Object.entries(all)
      .map(([key, rec]) => ({ key, rec: rec || {} }))
      .filter(({ rec }) =>
        rec.status === "analysed" &&
        typeof rec.transcript === "string" && rec.transcript.trim().length >= 50 &&
        !rec.insightsExtracted
      )
      .sort((a, b) =>
        String(a.rec.createdAt || a.key).localeCompare(String(b.rec.createdAt || b.key))
      );

    const totalPending = pending.length;
    const batch = pending.slice(0, BATCH);

    let processed = 0, added = 0, incremented = 0, failed = 0;
    for (const { key, rec } of batch) {
      try {
        const r = await extractAndMergeInsights({
          feedbackId: rec.id || key,
          transcript: rec.transcript,
          analysisSummary: rec.analysis?.summary,
          salesperson: rec.salesperson,
          clientName: rec.clientName,
          meetingType: rec.meetingType,
          apiKey,
        });
        processed++;
        if (r && !r.skipped) { added += r.added || 0; incremented += r.incremented || 0; }
      } catch (e) {
        failed++;
        console.error(`self-heal: ${rec.id || key} failed (non-fatal):`, e.message || e);
      }
    }

    const remaining = Math.max(0, totalPending - processed);
    await adminSet("/transcriptInsights/meta", {
      backlogDrained: remaining === 0,
      lastSelfHealRunAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true, totalPending, processed, added, incremented, failed, remaining,
    });
  } catch (err) {
    console.error("transcript-insights-selfheal error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
