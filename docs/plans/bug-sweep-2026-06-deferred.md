# Bug sweep 2026-06-10 — deferred findings

> **STATUS UPDATE (same day):** all four findings below were subsequently
> IMPLEMENTED via a second Codex adversarial loop (plan round → build → code
> round, converged). Design + final shape live in
> `bug-sweep-2026-06-deferred-fixes-plan.md`. This doc is kept as the original
> findings record; the "Pushed back" section at the bottom still stands.

The June 2026 full-codebase bug sweep (6 parallel review agents + 2-round Codex
adversarial loop) fixed ~36 sites. These findings were judged REAL but were
deliberately **not** fixed in the sweep because each changes money handling or
product behaviour in ways that deserve a deliberate decision, not a drive-by
patch. Each entry has the trigger that should make it worth doing.

## 1. Subscription payment plans overcharge by surcharge drift
`api/create-checkout-session.js` (~155-196) + `src/utils.js` buildSchedule.
For `subscription_monthly` 3-payment plans, Stripe's recurring price is created
at slice 0's amount (33.34% + slice-0 surcharge) and bills that same amount all
3 cycles — but buildSchedule gives slices 1-2 slightly smaller amounts. Total
collected exceeds grandTotal+surcharges by ~0.02% + surcharge drift (a couple
of dollars on a $10k sale), and `amountPaid` never equals `slice.amount` on
slices 1-2.
**Fix shape:** make the three slice amounts identical (one flat recurring
amount) and rebuild the stored schedule to match.
**Trigger:** next time sale schedules/pricing are touched, or if
reconcile-sale-payments starts flagging amount mismatches.

## 2. Stripe webhook schedule writes are non-transactional
`api/stripe-webhook.js` (checkout.session.completed / invoice.paid /
payment_failed / refund handlers) + `api/charge-sale-balance.js` decline
writer. Each does read-modify-write of the whole `/sales/{id}/schedule` array
via adminGet + adminPatch. Two near-simultaneous events for the same sale can
clobber each other's slice flips (last writer wins).
**Fix shape:** `runRtdbTransaction("/sales/{id}/schedule", ...)` per mutation —
the helper already exists in `_fb-admin.js` and the cold-cache null-pass-through
pattern to copy is in `api/cron/sales-daily.js`.
**Trigger:** any observed paid→pending flip-back, or the next payments work.

## 3. webhook-deal-won has no create idempotency
`api/webhook-deal-won.js`. Accounts and sherpas are deduped, but every
invocation creates a fresh `/projects/proj-…`, `/deliveries/del-…`, preprod
record, and Confirmation email (the email idempotency key embeds the fresh
projectId so it doesn't dedupe either). The handler is slow (full Attio
re-pagination + email leg), so a Zapier timeout-replay or double-fired zap
duplicates everything.
**Fix shape:** before creating, look up an existing non-archived project with
the same normalised clientName+projectName (or a Zapier event id) and
short-circuit.
**Trigger:** first observed duplicate project from a single won deal.

## 4. fathom-webhook duplicates on sender timeout-retry
`api/fathom-webhook.js:159`. `feedbackId = mf-${Date.now()}` with no
payload-derived dedup, and the inline Claude analysis (~45s) exceeds
Zapier/Make webhook timeout budgets — a retry creates a second
`/meetingFeedback` record AND double-counts insights into the weighted KB
(the extract marker is per-feedbackId).
**Fix shape:** derive feedbackId (or an early-exit dedup) from stable payload
fields, e.g. hash of recordingUrl.
**Trigger:** first duplicate meeting-feedback record, or next transcript work.

## Pushed back (reviewed, deliberately not doing)
- **QuoteCalc custom-item margin semantics** — sell-price mode adds custom-item
  markup on top of the entered sell price; surprising but matches the Google
  Sheet it mirrors. Intent ambiguous; leave until the sheet itself changes.
- **`emailKeyFor` collisions** (`a_b@dom` vs `a.b@dom`) in admin-users — needs
  an attacker-controlled account on the same Workspace domain; not a real
  threat at current shape.
- **ScheduleEditsModal strict `role === "editor"` filter** vs Capacity's
  missing-role-counts-as-editor — all current creation paths set role
  explicitly, so there is no live bug.
