# Fix plan — bug-sweep deferred findings (2026-06-10)

Implements the 4 deferred findings in `bug-sweep-2026-06-deferred.md`.
Constraints: behaviour-preserving except where the bug IS the behaviour; no new
env vars; no schema migrations (additive fields only); SMB volume (tens of
sales, single Stripe account, a handful of concurrent webhook events at worst).

---

## Fix 1 — Subscription plans: flat equal instalments

**Bug.** `buildSchedule` (src/utils.js) gives 3-payment plans uneven slices
(33.34/33.33/33.33 + per-slice surcharge), but `create-checkout-session`
creates ONE flat recurring Stripe price at slice 0's amount — so invoices 2-3
charge slice 0's amount. Customer pays ~0.02% + surcharge drift more than the
schedule says; `amountPaid` never matches slices 1-2.

**Design.**
- New pure helper `subscriptionSliceAmount(grandTotal, sliceCount)` in
  `api/_tiers.js`: `round2(grandTotal / sliceCount)`. Used by `buildSchedule`
  when `cfg.kind === "subscription_monthly"`: every slice gets
  `projectAmount = subscriptionSliceAmount(...)`, identical surcharge, identical
  `amount`. The last-slice rounding absorber NO LONGER applies to subscription
  kind (a flat recurring price cannot absorb anything) — Σ projectAmount may
  drift from grandTotal by ≤ 2c; documented in the _tiers comment block.
- `pct` on subscription slices stays as configured (display metadata only);
  comment updated to say amounts derive from the flat helper, not pct, for
  subscription kind.
- **Legacy guard** in `create-checkout-session`, placed BEFORE the
  open-session-reuse branch (Codex R1-F1: reuse returned the old uneven
  session before any guard could run): for subscription kind, if the stored
  schedule's slice amounts are not all equal, best-effort
  `stripe.checkout.sessions.expire()` any stored open session and return 400
  "Schedule predates the flat-instalment fix — regenerate the payment link."
- **Mid-plan legacy self-heal** (Codex R1-F2, adapted): no manual audit.
  The invoice.paid path passes `invoice.amount_paid` into the slice-paid core
  with a `healAmountToPaid` flag — when the actual charge differs from the
  stored row, the row is marked paid at the ACTUAL amount with
  `amountDriftFrom` + a sale-level `scheduleDriftNote`, instead of the one-off
  mismatch-review path. Legacy mid-plan sales reconcile themselves as Stripe
  bills them; books always reflect reality.
- **Display totals** (Codex R1-F3): Sale.jsx + SalePricingEditor "customer
  pays" figures derive from Σ schedule row amounts when a schedule exists,
  never the pre-rounding computed total.

**Tests.** Extend `api/_sale-schedules.test.mjs` (or a small `_tiers` block in
it): flat helper rounding; buildSchedule-for-subscription returns equal
amounts summing within 2c of grandTotal; deposit_plus_manual path unchanged
(absorber still exact).

## Fix 2 — Transactional /sales schedule mutations

**Bug.** Every slice-state mutation (markSlicePaid, refund, payment_failed,
subscription.deleted in stripe-webhook.js; the decline writer in
charge-sale-balance.js) is adminGet → mutate copy → adminPatch of the whole
schedule array. Two near-simultaneous events for the same sale clobber each
other (last writer reverts the other's flip).

**Design.**
- New helper in `api/_sale-schedules.js`:
  ```js
  export async function mutateSale(saleId, mutator) {
    // runRtdbTransaction on /sales/{saleId} with the cold-cache rule:
    //   cur === null            -> return cur (commit-unchanged; SDK refetches)
    //   mutator(cur) == null    -> return undefined (true abort, no write)
    //   else                    -> return mutator(cur)  (full next sale object)
    // returns { committed, sale: snapshotVal }
  }
  ```
  Transaction scope is the WHOLE sale node so derived fields (paid/paidAt/
  depositPaidAt) commit atomically with the schedule — a schedule-only
  transaction plus follow-up scalar patch can interleave wrong under two
  concurrent events.
- `markSlicePaid` refactor: extract the pure decision core
  `applySlicePaid(sale, { sliceId, sliceIdx, paidAmountCents, now, patch })`
  → `{ action: "paid"|"already_paid"|"no_match"|"mismatch"|"missing", nextSale?, info }`
  into `api/_sale-schedules.js` (includes target resolution, idempotency,
  amount sanity-check, custom deposit re-anchor with its try/catch fallback,
  allPaid computation). `markSlicePaid` becomes: compute `now` once; run
  `mutateSale` whose mutator calls the core and returns `nextSale` for
  action="paid", null otherwise (capturing action/info via closure — captures
  are only read AFTER the transaction resolves, and `committed` disambiguates);
  the `mismatch` branch writes its paymentReviewRequired patch OUTSIDE the
  transaction (different fields, no schedule race).
- Same `mutateSale` conversion for the three inline writers in
  stripe-webhook.js (refund, payment_failed, subscription.deleted), the
  decline writer in charge-sale-balance.js, AND
  `api/reconcile-sale-payments.js` (Codex R1-F4: the founder Reconcile button
  does the same whole-schedule RMW and would otherwise revert committed
  webhook flips).
- Closure-capture rules (Codex R1-F5): capture variables are RESET at the top
  of every updater invocation, and every post-transaction side effect gates on
  `committed && snapshot != null` — a sale deleted mid-transaction (dashboard
  writes null) must abort all follow-ups regardless of earlier captures.
- `api/cron/sales-daily.js` stays on its existing (already transactional,
  already cold-cache-safe) /sales/{id}/schedule claim — overlapping
  parent/child transaction scopes from different lambdas serialize correctly
  server-side. Not worth churning shipped code.
- Timestamps: computed once per event outside the mutator so transaction
  retries are stable.

**Tests.** `api/_sale-schedules.test.mjs`: applySlicePaid — happy path,
already-paid idempotency, sliceId-vs-idx resolution, amount mismatch, custom
deposit re-anchor preserved + empty-rebuild fallback, allPaid only when every
slice paid. (The transaction wrapper itself is I/O; its null/abort contract
mirrors the already-tested pattern from the sweep.)

## Fix 3 — webhook-deal-won create idempotency

**Bug.** Accounts/sherpas are deduped but every invocation creates a fresh
project + delivery + preprod + Confirmation email. The handler is slow (full
Attio re-pagination + email leg), so Zapier timeout-replays and double-fired
zaps duplicate everything.

**Design.**
- New pure helper `findRecentDuplicateProject(projects, { companyName,
  dealName, nowMs, windowMs = 48h })` in `shared/attio-extract.js` (reuses its
  `normName`): match = same normalised clientName + projectName, not archived,
  and created within the window (createdAt field, falling back to the
  timestamp embedded in the `proj-<ms>-<rand>` id). 48h window: replay storms
  are minutes apart; a genuine same-name re-purchase months later still goes
  through.
- In the handler, right after secret + payload validation: adminGet("/projects")
  (fine at SMB volume), run the helper, and on a hit return 200
  `{ ok: true, deduped: true, projectId }` BEFORE any writes or the email leg.
  200, not 4xx, so Zapier stops retrying.
- **Claim lock** (Codex R1-F6 — and the window is worse than reviewed: the
  project write lands 10-40s AFTER the dedup check, behind Attio re-pagination
  and the email leg, so even sequential retries slip through): a
  `runRtdbTransaction` claim on `/dealLocks/{normKey}` right after the dedup
  check — winner stamps `{ status: "processing", ts }` and proceeds; loser
  returns 200 deduped. Locks older than 10 min are stale and may be re-claimed
  (crashed winner). On success the lock is overwritten with
  `{ status: "done", projectId, ts }`; on a thrown error it is deleted so a
  legitimate retry can proceed. Admin SDK bypasses RTDB rules, so no rules
  deploy is needed for the new path.
- **Minimal correction heal** (Codex R1-F7, scoped down — no general field
  merge): on a dedup hit, if the existing project's `dealValue` is null/0 or
  its `clientContact.email` is empty and the replay carries values, patch just
  those and log it. Anything richer is founder-edit territory.

**Tests.** `shared/__tests__/attio-extract.test.mjs`: hit within window, miss
outside window, archived ignored, normalisation (case/whitespace), id-embedded
timestamp fallback, missing dealName → "Untitled project" key.

## Fix 4 — fathom-webhook retry dedup

**Bug.** `feedbackId = mf-${Date.now()}` and the inline ~45s analysis exceeds
some senders' timeout budgets — a timeout-retry creates a second
/meetingFeedback record and double-pays for analysis. (Insight weights are
safe per-feedbackId, but a second record = a second feedbackId = double count.)

**Design.**
- New tiny module `api/_fathom-dedup.js`: `deriveFeedbackId({ recordingUrl,
  meetingName, transcript })` → `mf-<sha1 hex slice 12>` of `recordingUrl`
  when present, else of `meetingName + "::" + transcript.length + "::" +
  transcript.slice(0, 256)`. Deterministic across retries; node:crypto only.
- Handler: compute the stable id, then CLAIM the record via
  `runRtdbTransaction` on `/meetingFeedback/{feedbackId}` (Codex R1-F8 —
  get-then-set leaves a window where two near-simultaneous retries both miss):
  cur === null → write the new entry (claim won, proceed to analysis);
  cur exists with `status !== "error"` → abort, return 200
  `{ success: true, deduped: true, feedbackId }`; cur exists with
  `status === "error"` → take over (reset to analysing) and re-analyse under
  the SAME id.
- **Source-level increment idempotency** (Codex R1-F9): partial first runs
  can apply some weight bumps and die before the run-level marker is written —
  so `bump()` in api/_transcript-insights.js also skips (aborts) when the
  item's `sources` already contain this `feedbackId`. Creates are covered by
  the existing normalized-title backstop converting re-runs into increments,
  which the source guard then blocks.
- Manual/UI-created meetingFeedback records are untouched (different creation
  path).

**Tests.** New `api/_fathom-dedup.test.mjs`: same payload → same id; different
recordingUrl → different id; fallback path stable; slice/length changes alter
the id.

---

## Verification
`npm run build`; `node --test tests/*.test.js`; every standalone `*.test.mjs`
under api/, shared/__tests__, shared/scheduling/__tests__,
shared/capacity/__tests__, api/cron/__tests__ — all green before and after.

## Known trade-offs (deliberate)
- Fix 1 legacy guard hard-blocks stale subscription links (loud 400 +
  regenerate) instead of silently honouring old uneven schedules.
- Fix 1 gives up exact Σ slices === grandTotal for subscription plans (≤2c
  drift) because one flat recurring price cannot absorb rounding.
- Fix 3 dedup is name+window based (no Zapier event id is available in the
  payload today); a same-name deal won twice within 48h would be suppressed —
  accepted at current volume.
- Fix 2 leaves sales-daily's child-path transaction as-is.
