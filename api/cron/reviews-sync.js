// api/cron/reviews-sync.js
//
// Daily cron for the viewixreviews.com.au review wall.
// Plan: docs/plans/viewix-reviews-site-scope-packet.md
//
// Every invocation:
//   1. If a pending Apify run exists → finish it (ingest / fail / wait).
//   2. Else, if the last successful sync is older than 7 days (or a
//      CRON_TEST_SECRET-authorized ?force=1) → start a new scrape,
//      persist pendingRunId BEFORE
//      polling (Codex R2#2), poll to an internal cutoff, ingest if it
//      completes in time. A slow run is picked up tomorrow (R2#1) —
//      single writer, no webhook (Codex F13).
//
// Publishing is gated (Codex F3/R2#3): a scrape that returns fewer
// live reviews than max(REVIEWS_MIN_COUNT, 80% of current) keeps the
// existing wall and alerts Slack instead of publishing.
//
// State at /reviewsSite/state:
//   { pendingRunId, pendingStartedAt, lastSuccessfulSyncAt, lastError }

import { adminGet, adminPatch } from "../_fb-admin.js";
import { slackPostMessage } from "../_slack-helpers.js";
import { isAuthorizedCron } from "../_cronAuth.js";
import {
  DEFAULT_REVIEWS_ACTOR, TERMINAL_FAIL,
  buildActorInput, startReviewsRun, getRun, getDatasetItems,
  normalizeApifyItem, dedupeById, publishGate, parseMinCount,
  mergeReviews, liveReviews, computeMeta,
} from "../_reviewsSync.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_CUTOFF_MS = 240_000; // maxDuration is 300s — leave headroom
const POLL_EVERY_MS = 10_000;
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  // Repo-canonical cron auth (see _cronAuth.js and the 2026-05-16
  // incident writeup there). Accepts the Vercel-injected CRON_SECRET
  // bearer or a manual ?secret=$CRON_TEST_SECRET run; only the test
  // secret unlocks the force override below.
  const cronAuth = isAuthorizedCron(req);
  if (!cronAuth.ok) return res.status(401).json({ error: "Unauthorized" });

  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });
  const actorId = process.env.APIFY_REVIEWS_ACTOR || DEFAULT_REVIEWS_ACTOR;

  const startedAt = Date.now();
  try {
    const state = (await adminGet("/reviewsSite/state")) || {};

    // ── 1. Finish a pending run first ──────────────────────────────
    if (state.pendingRunId) {
      const run = await getRun({ token, runId: state.pendingRunId });
      if (run.status === "SUCCEEDED") {
        const result = await ingest({ token, run });
        return res.status(200).json({ status: "ingested-pending", ...result });
      }
      if (TERMINAL_FAIL.has(run.status)) {
        await adminPatch("/reviewsSite/state", {
          pendingRunId: null, pendingStartedAt: null,
          lastError: `Apify run ${state.pendingRunId} ended ${run.status}`,
        });
        await alert(`Reviews sync: Apify run ended *${run.status}* — wall unchanged. Run: ${state.pendingRunId}`);
        return res.status(200).json({ status: "pending-failed", runStatus: run.status });
      }
      // Still running. A pending run older than a day is wedged — drop
      // the pointer so tomorrow starts fresh, and say so.
      const pendingAge = Date.now() - new Date(state.pendingStartedAt || 0).getTime();
      if (pendingAge > STALE_PENDING_MS) {
        await adminPatch("/reviewsSite/state", { pendingRunId: null, pendingStartedAt: null });
        await alert(`Reviews sync: run ${state.pendingRunId} still ${run.status} after 24h — abandoning pointer.`);
        return res.status(200).json({ status: "pending-abandoned" });
      }
      return res.status(200).json({ status: "pending-still-running", runStatus: run.status });
    }

    // ── 2. Start a new scrape if due ───────────────────────────────
    // force is a test-only override: requires the CRON_TEST_SECRET
    // path (secretValid) per the _cronAuth contract — a real Vercel
    // cron invocation can never pass it.
    const force = cronAuth.secretValid && req.query?.force === "1";
    const last = state.lastSuccessfulSyncAt ? new Date(state.lastSuccessfulSyncAt).getTime() : 0;
    if (!force && Date.now() - last < WEEK_MS) {
      return res.status(200).json({ status: "not-due", lastSuccessfulSyncAt: state.lastSuccessfulSyncAt });
    }

    const { runId } = await startReviewsRun({ token, actorId, input: buildActorInput() });
    // Persist BEFORE polling — if the function dies mid-poll, tomorrow's
    // invocation picks the run up from this pointer.
    await adminPatch("/reviewsSite/state", {
      pendingRunId: runId,
      pendingStartedAt: new Date().toISOString(),
    });

    while (Date.now() - startedAt < POLL_CUTOFF_MS) {
      await sleep(POLL_EVERY_MS);
      const run = await getRun({ token, runId });
      if (run.status === "SUCCEEDED") {
        const result = await ingest({ token, run });
        return res.status(200).json({ status: "ingested", ...result });
      }
      if (TERMINAL_FAIL.has(run.status)) {
        await adminPatch("/reviewsSite/state", {
          pendingRunId: null, pendingStartedAt: null,
          lastError: `Apify run ${runId} ended ${run.status}`,
        });
        await alert(`Reviews sync: Apify run ended *${run.status}* — wall unchanged. Run: ${runId}`);
        return res.status(200).json({ status: "run-failed", runStatus: run.status });
      }
    }
    // Cutoff hit with the run still going — clean exit, pointer persists.
    return res.status(200).json({ status: "poll-cutoff", runId });
  } catch (e) {
    console.error("[reviews-sync]", e);
    try {
      await adminPatch("/reviewsSite/state", { lastError: String(e.message || e) });
    } catch { /* state write is best-effort on the error path */ }
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// Fetch the finished run's dataset, normalize, gate, merge, publish.
async function ingest({ token, run }) {
  const nowIso = new Date().toISOString();
  const items = await getDatasetItems({ token, datasetId: run.defaultDatasetId });
  // Count rejections BEFORE dedupe — duplicate valid items are not
  // "rejected" and must not inflate the alert (Codex round-2 note).
  const normalizedAll = items.map(normalizeApifyItem).filter(Boolean);
  const normalized = dedupeById(normalizedAll);
  const rejected = items.length - normalizedAll.length;

  const existing = (await adminGet("/reviewsSite/reviews")) || {};
  const currentLiveCount = liveReviews(existing).length;
  const minCount = parseMinCount(process.env.REVIEWS_MIN_COUNT);

  const gate = publishGate({ newCount: normalized.length, currentLiveCount, minCount });
  if (!gate.pass) {
    await adminPatch("/reviewsSite/state", {
      pendingRunId: null, pendingStartedAt: null,
      lastError: `publish gate: ${gate.reason}`,
    });
    await alert(
      `Reviews sync *blocked by publish gate* — wall unchanged.\n${gate.reason}\n` +
      `If the lower count is legitimate, lower REVIEWS_MIN_COUNT in Vercel and re-run with ?secret=$CRON_TEST_SECRET&force=1.`
    );
    return { published: false, gate: gate.reason, scraped: items.length, rejected };
  }

  const { reviews, stats } = mergeReviews(existing, normalized, nowIso);
  const meta = computeMeta(reviews, nowIso);
  // One atomic multi-location update — reviews, meta, and state can
  // never be observed half-published (Codex code-review F2). The lease
  // for fully-concurrent writers is deliberately NOT built: the daily
  // cron is the single writer by design; revisit only if a second
  // writer (backfill endpoint, second schedule) ever appears.
  await adminPatch("/reviewsSite", {
    reviews,
    meta,
    "state/pendingRunId": null,
    "state/pendingStartedAt": null,
    "state/lastSuccessfulSyncAt": nowIso,
    "state/lastError": null,
  });

  if (rejected > 0) {
    await alert(`Reviews sync published, but ${rejected} scraped item(s) lacked a stable review id and were skipped.`);
  }
  return { published: true, count: meta.count, rating: meta.rating, ...stats, rejected };
}

// Best-effort Slack alert — never lets a notification failure break the
// sync. Reuses the scheduling bot token; channel overridable per-feature.
async function alert(text) {
  try {
    const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
    const channel =
      process.env.SLACK_REVIEWS_ALERT_CHANNEL_ID ||
      process.env.SLACK_SCHEDULING_CHANNEL_ID ||
      "C0B2JG54GJX";
    if (!botToken || !channel) return;
    await slackPostMessage({ channel, text: `:star: ${text}`, botToken });
  } catch (e) {
    console.error("[reviews-sync] slack alert failed:", e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
