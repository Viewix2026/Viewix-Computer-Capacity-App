// api/_cronAuth.js
//
// Single source of truth for authenticating Vercel cron invocations.
//
// ─── Why this exists (incident 2026-05-16) ──────────────────────────
// Every cron handler used `req.headers["x-vercel-cron"] === "1"`.
// Vercel DOES send the `x-vercel-cron` header on cron invocations, but
// it does NOT contractually guarantee the value is the string "1" — it
// has varied across Vercel runtime/region versions. The strict
// `=== "1"` comparison therefore returned false for real Vercel cron
// requests, every scheduled invocation 401'd, and the ENTIRE automation
// layer (email touchpoints, scheduling brain digest + flag flusher,
// Attio cache sync, analytics schedule, founders advisor, sales-daily)
// silently stopped running from ~2026-05-09. Only event-driven paths
// (deal-won webhook → Confirmation, Deliveries modal → ReadyForReview)
// kept working because they don't go through Vercel cron.
//
// Vercel logs showed `GET 401 /api/cron/daily-09` for every fire.
//
// ─── Authorization model ────────────────────────────────────────────
// A request is an authorized cron if ANY of the following hold:
//
//   1. `Authorization: Bearer ${CRON_SECRET}` matches.
//      Vercel automatically injects this header into cron requests
//      when a `CRON_SECRET` env var is set on the project. This is
//      Vercel's documented, stable, secure mechanism — preferred.
//
//   2. The `x-vercel-cron` header is PRESENT (any value).
//      Vercel always adds this header to cron invocations. Presence
//      (not a brittle value match) is the reliable signal that the
//      request originated from Vercel's cron infrastructure. This lets
//      the fix work on the very next deploy with zero env changes,
//      while CRON_SECRET is rolled out as the hardened layer.
//
//   3. `?secret=${CRON_TEST_SECRET}` matches.
//      Manual / scripted runs (curl, the canary, fixture testing).
//      ONLY this path sets `secretValid: true`, which the handlers
//      that support test-only overrides (`&force=1`, `&today=…`,
//      `&dryRunReport=1`, `&skipAutoProgress=…`) gate on — a real
//      Vercel cron must never be able to pass those overrides.
//
// Returns: { ok, via, secretValid }
//   ok          — boolean, request is an authorized cron
//   via         — "cron_secret" | "vercel_cron_header" | "test_secret"
//   secretValid — true ONLY when path (3) matched (test-override gate)

export function isAuthorizedCron(req) {
  const headers = req?.headers || {};

  // (1) Vercel-injected Bearer secret — preferred when CRON_SECRET set.
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = headers.authorization || headers.Authorization || "";
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { ok: true, via: "cron_secret", secretValid: false };
  }

  // (3) Manual / scripted run via ?secret= — checked before the bare
  // header presence so a human-supplied valid test secret correctly
  // sets secretValid (enables &force=1 etc.) even if some proxy also
  // happened to attach an x-vercel-cron header.
  const testSecret = process.env.CRON_TEST_SECRET || "";
  let qSecret = "";
  if (typeof req?.query?.secret === "string") {
    qSecret = req.query.secret;
  } else {
    try {
      qSecret = new URL(req?.url || "", "http://x").searchParams.get("secret") || "";
    } catch {
      qSecret = "";
    }
  }
  if (testSecret && qSecret === testSecret) {
    return { ok: true, via: "test_secret", secretValid: true };
  }

  // (2) Vercel cron header present (any value). Reliable origin signal.
  if (headers["x-vercel-cron"] != null) {
    return { ok: true, via: "vercel_cron_header", secretValid: false };
  }

  return { ok: false, via: null, secretValid: false };
}
