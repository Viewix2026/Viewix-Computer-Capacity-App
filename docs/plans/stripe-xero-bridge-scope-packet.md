# Scope Packet — Stripe → Xero Reconciliation Bridge

Status: **BUILT — at Gate 2** (Gate 1 passed 2026-06-28; code Codex loop converged)

## Code review trail (2nd Codex loop, on the code)

- **Round 1** — 4 findings, NOT-READY. 2 Critical (stranded-payment resume could
  leave a live ledger entry orphaned; `findExistingId` swallowed Xero errors →
  double-post past the 24h key window), 2 High (the "final payment" guard blocked
  every staged deposit; subscription fee lookup used a removed Stripe field). All
  adopted + fixed with regression tests.
- **Round 2** — Round-1 fixes 1–3 CONFIRMED. 2 small High refinements: a stale-
  plan AmountDue guard (turns a Xero retry-loop into a review item) and the exact
  Stripe `expand` string. Both fixed; the Stripe field path verified directly
  against the installed SDK type defs (`Invoice.payments` → `InvoicePayment.payment.payment_intent/charge`).
- **Converged.** Severity collapsed (4 → 2, Critical → localized); remaining
  surface fails safe to the review queue and gets a demo-org proof before go-live.
- **26 unit tests** green (14 accounting-math + 12 identity/eligibility/gating).
Owner: Jeremy
Created: 2026-06-27
Feature slug: `stripe-xero-bridge`

---

## Outcome

**Hands-off reconciliation for deposit deals.** For any deal that took a deposit
through the dashboard, the Xero invoice automatically shows as paid into a
"Stripe Clearing" account with the Stripe fee split out, so the lump Stripe bank
payout reconciles in one click and neither Jeremy nor his accountant does manual
invoice-to-payment matching. The win is *eliminated manual matching* for the
deposit-deal subset.

## Out of scope (this round)

- **CRM-only / no-deposit deals** — Attio→Xero keeps invoicing them; Jeremy
  reconciles those payouts however he does today. The bridge never touches them.
- **Refunds & cancellations into Xero** — the Stripe webhook already tracks
  `refunded` / `cancelled` slice states, but pushing reversing entries into Xero
  is deferred. Handled manually for now.
- **Auto bank-payout reconcile** — the bridge marks invoices paid into Stripe
  Clearing; clicking the bank-feed payout line as a "transfer out of clearing"
  stays a one-click manual step in Xero (not automated via the bank feed API).
- **Backfilling old payments** — only new deposits from go-live forward are
  bridged. Historical unreconciled payouts are not retro-applied.
- **Salesperson picker UI polish** — the dashboard link surface is just a
  copy-`saleId` chip on the Sales row; any fancier picker/search UX is a later pass.

## Done looks like

Proven **end-to-end against Xero's free Demo Company** before touching the live
org: run a real deposit sale through, confirm the matched invoice flips to PAID
into Stripe Clearing with the Stripe fee split to a Stripe Fees expense account,
and the simulated payout reconciles as a transfer out of clearing leaving the
clearing balance ~0. Then flip the env to the live org.

## Hard constraints

- **Feature-flagged, default OFF.** Bridge ships dark; Jeremy flips it on after
  the demo-org proof. No risk to live accounting on deploy.
- (Engineering defaults, from locked architecture — not user-flagged but applied)
  - Reuse the `mutateRecord()` transaction + cold-cache null-gate and the
    per-slice idempotency pattern from commit `7f52423`. No new concurrency model.
  - Keep the bridge OFF the Stripe webhook hot path — separate module/endpoint,
    never inline synchronous Xero calls into `api/stripe-webhook.js`.
  - Minimise cost — no new always-on infra; reuse existing Vercel cron cadence.

---

## Locked architecture (from pre-skill decisions)

1. **Attio→Xero stays the universal invoice creator** for every deal. Unchanged.
2. **At the "deal Won" moment the salesperson links the won Attio deal to its
   dashboard sale** by pasting the `saleId` (shown as a copy chip on the Sales
   row) into the deal's "Dashboard Sale ID" field. That puts the dashboard
   `saleId` (+ Stripe PaymentIntent ids) onto the deal, which the Attio→Xero Zap
   maps into the **Xero invoice Reference field**.
3. **A new dashboard-side bridge** reads the existing per-payment ledger
   (`/sales/{saleId}.schedule[]`) and applies each paid slice as a payment
   against the matched Xero invoice **into a "Stripe Clearing" bank account**,
   splitting the Stripe fee to a "Stripe Fees" expense account.
4. The lump Stripe bank payout then reconciles (manually, one click) as a
   transfer out of Stripe Clearing.

## Work split

| Part | Owner |
|---|---|
| Dashboard: copy-`saleId` chip on the Sales row (so the paste is exact) | Me (code) |
| Dashboard: `api/_xero.js` Custom Connection client (client_credentials, no token persistence) | Me (code) |
| Dashboard: the daily reconciler that posts payments into Stripe Clearing, idempotent | Me (code) |
| Xero: create "Stripe Clearing" bank, "Stripe Fees" expense, "Surcharge income" accounts | Jeremy (Xero UI) |
| Xero: register a **Custom Connection** app (demo + live are SEPARATE apps/creds), env vars | Jeremy (~10 min) |
| Attio: add a "Dashboard Sale ID" field on the deal object | Jeremy (Attio) |
| Attio→Xero Zap: map "Dashboard Sale ID" into the Xero invoice Reference field | Jeremy (Zapier) |

---

## Resolved decisions

- **Match key = Xero invoice Reference carrying `saleId`** (chosen over API
  lookup by contact/amount). Robust, no fuzzy matching — but now **backed by a
  secondary validation guard** (contact + invoice total + AUD + AmountDue) before
  any write, so a typo'd Reference can't mis-post to the wrong client. (Codex #6)
- **Link captured at the Won moment**, salesperson-driven. v1 = a manual
  "Dashboard Sale ID" field on the Attio deal, mapped by the Zap into the Xero
  invoice Reference. Both docs now agree on this single path. (Codex #7)
- **Xero auth = Custom Connection (client_credentials M2M)**, chosen over standard
  OAuth2. No rotating refresh token, no consent redirect, no token persistence —
  the reconciler fetches a fresh 30-min access token per run. Deletes the
  refresh-rotation bug class (Codex #5) and most of the tenant-state risk (#12).
  Cost: ~US$10/mo Xero add-on (accepted).
- **Three postings per slice** so the clearing account nets to zero: payment for
  the project amount, receive-money for the customer surcharge, spend-money for
  the **actual** Stripe fee (from `balance_transaction.fee`, not the surcharge).
  (Codex #2, #9)
- **Eligibility = per-sale, all paid slices** of any dashboard sale linked after
  go-live (not just slice 0). Deposit + balance + custom installments all bridge.
  **Derived** (no manual stamp): a slice bridges only when `paidAt >= GO_LIVE_AT`
  AND a validated Xero invoice with `Reference == saleId` exists — historical
  invoices have no matching Reference, so they never post. (Codex #1, #10; R2-#6)
- **Outcome = full hands-off** (chosen over accountant-still-clicks).
- **Proof = Xero Demo Company end-to-end** (chosen over unit-only or dry-run).
- **Feature-flagged default OFF.**

## Open decisions

All architecture forks are now resolved (see Resolved decisions). One item
remains **for Jeremy's accountant, gated before flag-flip — not a build blocker:**

1. **⚠️ GST / surcharge tax treatment (accountant sign-off before go-live).**
   The build ships the posting math in one pure `computeXeroPostings(slice)`
   function with config constants for: the surcharge **income account + Xero tax
   type** (is the customer surcharge taxable supply? standard AU default = yes,
   GST-inclusive), and the Stripe-fee **expense account + tax type** (default =
   GST on expenses / "BAS Excluded" pending advice — Stripe AU fees are input-
   taxed/GST-free in many cases). Defaults are encoded + unit-tested; the
   accountant nominates the final values, which change only the constants. The
   flag stays OFF until Jeremy confirms. (Codex #3)

## Approved plan

**Approved at Gate 1 (2026-06-28)** after a 3-round Codex adversarial loop on the
plan (14 → 8 → 2 findings; NOT_BUILDABLE → converged). Full spec:
[stripe-xero-bridge-plan.md](stripe-xero-bridge-plan.md) rev 3.

Build = `api/_xero.js` (Custom Connection M2M client) + `api/cron/xero-reconcile.js`
(daily idempotent reconciler, three postings, per-slice state machine, secondary
validation, review queue) + a copy-`saleId` chip on the Sales row + tests in
`api/__tests__/`. Feature-flagged `XERO_BRIDGE_ENABLED`, default OFF.

**Setup decision:** Jeremy builds nothing; when setup time comes, Claude drives
the ~10-min Xero Custom Connection registration in Jeremy's browser (he
supervises). $0/mo, precise `saleId` matching, full control — chosen over an
A$30–100/mo connector after a build-vs-buy cost comparison.

**Gate before flag-flip:** accountant signs off the GST tax-type constants for the
surcharge income + Stripe fee lines.

## Implementation deltas

- **Slice identity (non-material, logged not gated).** The plan assumed slices
  match by `sliceId`. Preset deposit/subscription sales (`buildSchedule`) — the
  *primary* deposit deals — carry no `sliceId`, only a stable array `idx`. The
  reconciler now uses `sliceId` when present, else `idx`, for the Reference key,
  the state-machine markers, and the Firebase locator. No schema/security/
  dependency/behaviour change; it makes the feature cover the main case, so it
  does not trip the Gate 1.5 material-deviation rule. Covered by tests in
  `api/__tests__/xero-reconcile.test.mjs`.
- Surcharge + rounding fold into ONE Receive-Money posting (same income
  account), keeping it to three Xero writes per slice as designed.
- Reconciler scheduled at 20:30 UTC daily (≈06:30 Sydney AEST). Idempotent, so
  DST drift is harmless.
