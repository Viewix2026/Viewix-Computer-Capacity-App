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
// ── Phase 2: theme sweep ──────────────────────────────────────────
// After the extraction scan, classify any /transcriptInsights item still
// missing a `theme` (the canonical-theme layer shipped after ~464 items
// already existed). Same self-heal philosophy: a PERMANENT hourly sweep,
// not a one-shot migration — it also catches items whose inline
// extraction ran before a deploy added themes, and increments that landed
// on still-unthemed items. Zero missing → one RTDB read, no model calls.
// Reading all items hourly is intentionally accepted at SMB volume
// (~460 items); revisit if the KB approaches five figures.
//
// ── Auth ──────────────────────────────────────────────────────────
// Vercel cron requests carry `Authorization: Bearer <CRON_SECRET>`.
// FAIL CLOSED if CRON_SECRET is unset — this endpoint spends Claude
// tokens, never serve it open.

import { adminGet, adminPatch, getAdmin, mutateRecord } from "../_fb-admin.js";
import { extractAndMergeInsights, classifyInsightThemes } from "../_transcript-insights.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// Per-run cap. 15 sequential Sonnet calls fit comfortably inside the
// 300s maxDuration; the backlog drains across successive hourly runs.
const BATCH = 15;

// Shared time budget across both phases (maxDuration is 300s — see
// vercel.json). Phase 1 stops STARTING an extraction once less than
// PHASE1_MIN_LEFT_MS remains — 60s for the sweep plus ~30s for the
// in-flight extraction to land — so a permanently 15-deep backlog can't
// starve the theme sweep hour after hour. The sweep won't start a
// classifier call without a safety margin left. Both phases resume next
// hour, so pace is irrelevant — only the 300s wall matters.
const MAX_MS = 300_000;
const PHASE1_MIN_LEFT_MS = 90_000;
const SWEEP_MIN_LEFT_MS = 30_000;
const THEME_BATCH = 40;

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

  const t0 = Date.now();
  const msLeft = () => MAX_MS - (Date.now() - t0);

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
      // Time-aware break: never START an extraction without enough
      // headroom left for it AND the theme sweep. Unprocessed records
      // stay marker-less and are picked up next hour.
      if (msLeft() < PHASE1_MIN_LEFT_MS) break;
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
    // Child-path patch, NOT a whole-object set — a set here would wipe
    // sibling meta keys (themeBackfill) every hour.
    await adminPatch("/transcriptInsights/meta", {
      backlogDrained: remaining === 0,
      lastSelfHealRunAt: new Date().toISOString(),
    });

    // ── Phase 2: theme sweep ──────────────────────────────────────
    let themeSweep = null;
    if (msLeft() >= 60_000) {
      const itemsMap = (await fbGet("/transcriptInsights/items")) || {};
      const missing = Object.entries(itemsMap)
        .map(([id, v]) => ({ id, ...(v || {}) }))
        .filter((it) => it.type && it.title && !it.theme);

      let classified = 0, otherCount = 0, failedBatches = 0;
      for (let i = 0; i < missing.length && msLeft() > SWEEP_MIN_LEFT_MS; i += THEME_BATCH) {
        const themeBatch = missing.slice(i, i + THEME_BATCH);
        try {
          const r = await classifyInsightThemes(themeBatch, apiKey);
          for (const [id, theme] of Object.entries(r.assignments)) {
            // Guard on !cur.theme — never clobber a theme set concurrently
            // by the inline extraction path. mutateRecord handles the
            // cold-cache null first run; returning null aborts cleanly.
            const w = await mutateRecord(`/transcriptInsights/items/${id}`, (cur) =>
              cur.theme ? null : { ...cur, theme }
            );
            if (w.committed && w.snapshot) classified++;
          }
          otherCount += r.otherCount;
        } catch (e) {
          // Non-fatal: a failed batch (API error, malformed JSON, quality
          // gate) writes nothing and is naturally retried next hour by
          // the missing-theme scan. No resume bookkeeping needed.
          failedBatches++;
          console.error("theme sweep batch failed (non-fatal):", e.message || e);
        }
      }

      themeSweep = {
        at: new Date().toISOString(),
        totalMissing: missing.length,
        classified,
        otherCount,
        failedBatches,
        missingAfterRun: Math.max(0, missing.length - classified),
      };
      await adminPatch("/transcriptInsights/meta", { themeBackfill: themeSweep });
    }

    return res.status(200).json({
      ok: true, totalPending, processed, added, incremented, failed, remaining, themeSweep,
    });
  } catch (err) {
    console.error("transcript-insights-selfheal error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
