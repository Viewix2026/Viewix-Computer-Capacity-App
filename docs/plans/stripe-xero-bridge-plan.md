# Plan — Stripe → Xero Reconciliation Bridge (rev 3, post Codex round 2)

Companion to `stripe-xero-bridge-scope-packet.md`. Rev 3 folds in the adopted
Codex round-1 (**#n**) and round-2 (**R2-#n**) findings.

## Goal restated

For sales that took payment through the dashboard's Stripe checkout: automatically
post each paid slice into Xero so the matched invoice shows paid into a "Stripe
Clearing" account with the fee + surcharge split out, leaving clearing to net to
zero against the real Stripe payout. Feature-flagged OFF; proven on Xero Demo
Company first.

---

## Architecture: idempotent daily reconciler, off the hot path

A once-daily Vercel cron scans the sale ledger and posts any **eligible, paid,
un-bridged** slices into Xero. No changes to `api/stripe-webhook.js` (hot path
untouched). Self-healing: a slice missed one day (invoice not yet created, Xero
down) is picked up next run. ~1 invocation/day ≈ free.

Match key = **Xero invoice `Reference` == dashboard `saleId`** (resolved), backed
by a **secondary validation guard** before any write (#6).

### Eligibility (#1, #10; R2-#6) — never bleed history, no unobservable stamp

The round-1 `xeroBridgeEligible` stamp is **removed** — with a manual Attio
field the dashboard can't observe the link, so the stamp had no honest trigger
(R2-#6). Eligibility is instead **derived from two independent gates that
historical sales fail automatically**:

A slice is eligible only if **all** hold:
- `slice.paidAt >= XERO_BRIDGE_GO_LIVE_AT` (ISO cutoff env var) — hard time gate.
- `slice.status === "paid"` (ignore pending/declined/refunded/cancelled).
- `!slice.xeroBridgedAt`.
- **A validated Xero invoice with `Reference == saleId` exists** (the match +
  secondary-validation step below). Pre-go-live invoices were created before the
  Zap field-map existed, so their Reference is empty/different → they never match.

Two independent gates (time cutoff AND a Reference-matched validated invoice)
mean old paid sales can't bleed even if one gate is misconfigured. Eligibility is
**per-sale, all paid slices** (deposit + balance + installments), not just slice 0.

### Per-slice posting state machine (#4) — survives a crash mid-sequence

Three Xero writes per slice, each id stored the instant it lands so a retry never
re-creates:

```
state on slice (all under the slice object, written via mutateRecord by sliceId):
  xeroClaimAt   — set first, transactionally, to claim the slice for this run
  xeroPaymentId — set immediately after the Payment POST succeeds
  xeroSurchargeId — set after the surcharge Receive-Money POST succeeds
  xeroFeeTxId   — set after the fee Spend-Money POST succeeds
  xeroBridgedAt — set last, only when all three ids present
```

**Resume by LOCAL ids, never by invoice status (R2-#1).** A crash after the
Payment posts flips the invoice to PAID; the next run must NOT treat "PAID" as
done — it resumes the surcharge/fee steps because `xeroSurchargeId`/`xeroFeeTxId`
are still absent. PAID short-circuits only when the slice has a complete local id
set. A PAID invoice with NO local ids at all (someone paid it by hand in Xero) →
**review**, never auto-mark complete.

**Durable idempotency = deterministic `Reference`, not just the header (R2-#2).**
`Idempotency-Key` is a request header Xero only honours for ~24h; it is NOT
queryable. So every Payment and BankTransaction also carries a deterministic
**`Reference` field** (`viewix-{sliceId}-payment` / `-surcharge` / `-fee`), and
the pre-create check queries `where=Reference=="{that key}"`. That is the only
idempotency path that survives past 24h.

Per slice, in order, skipping any step whose local id is already present:
1. **Claim**: `mutateRecord` set `xeroClaimAt = now` iff unset or stale. Staleness
   = older than a bound safely above the cron's own max runtime (use **6h**, not
   1h, so a slow-but-live run can't have its claim stolen and double-post, R2-#1).
   Abort if another run holds a fresh claim.
2. **Payment** (if no `xeroPaymentId`): pre-check `where=Reference=="viewix-{sliceId}-payment"`;
   if found, adopt that id. Else POST with `Reference` set + `Idempotency-Key`
   header. Store `xeroPaymentId`.
3. **Surcharge** (if no `xeroSurchargeId` and `surcharge > 0`): same pre-check +
   POST a Receive-Money `BankTransaction` into Stripe Clearing.
4. **Fee** (if no `xeroFeeTxId`): same pre-check + POST a Spend-Money
   `BankTransaction` from Stripe Clearing.
5. Set `xeroBridgedAt` only once all required ids are present.

### The three postings (#2, #9) — clearing nets to zero

Walk one deposit: `projectAmount=$1000` (GST-inc), `surcharge=$20`, actual Stripe
fee `$30`, payout `$990`.

| Posting | Amount | Account |
|---|---|---|
| Payment applied to invoice | +$1000 | into Stripe Clearing |
| Receive-money (surcharge income) | +$20 | into Stripe Clearing, coded to surcharge income |
| Spend-money (actual Stripe fee) | −$30 | out of Stripe Clearing, coded to Stripe Fees |
| (manual, out of scope) payout transfer | −$990 | out of Stripe Clearing → bank |

Clearing = 1000 + 20 − 30 − 990 = **$0.** ✓ Summed across a batch payout, the
per-charge fees sum to Stripe's batch deduction, so clearing nets for the whole
payout.

**GST flag — `LineAmountTypes: "Inclusive"` is mandatory (R2-#3).** Xero defaults
bank-transaction line amounts to GST-*exclusive*; a $20 GST-inclusive surcharge
line posted without the flag becomes $22 in clearing. Every BankTransaction
(surcharge + fee) MUST set `LineAmountTypes: "Inclusive"`. Tests assert the
Xero-side **total + tax + clearing delta equal the Stripe cash**, not the raw
cent inputs.

**Actual fee source (#9; R2-#4):** the reconciler resolves the real fee via
Stripe, branching on which id the slice actually stored (subscription slices
store `stripeInvoiceId`, not `stripePaymentIntentId` — R2-#4):
- has `stripePaymentIntentId` → `PaymentIntent → latest_charge → balance_transaction.fee`.
- else has `stripeInvoiceId` → `Invoice → payment_intent → latest_charge → balance_transaction.fee`.
If the balance transaction isn't available yet (pending) or unreadable → **do not
post**, mark the slice for review, retry next run. Never use the surcharge as a
fee proxy.

**Rounding vs invoice AmountDue (R2-#5, R3-#1).** `Σ slice.projectAmount` can
drift from the Xero invoice total by a cent or two (existing schedule rounding).
Handle the two directions explicitly by **sign of the residual** on the final slice:
- **Positive** (collected ≥ invoice; e.g. AmountDue $0.67, payment $0.68): cap the
  Payment at remaining `AmountDue`, post the ≤2¢ excess as a rounding line to the
  surcharge income account. Clearing nets, invoice fully paid.
- **Negative** (invoice > collected; e.g. AmountDue $0.68, final projectAmount
  $0.67): **never** auto-resolve — a $0.01 receive-money would overstate clearing
  and the invoice would still be 1¢ unpaid. Route the sale to **review** and do
  **not** set `xeroBridgedAt` while any `AmountDue` remains.
A drift larger than the secondary-validation tolerance (1¢ on the *total*) already
routes the whole sale to review before any posting.

**Posting math (#3):** all of the above lives in a pure
`computeXeroPostings(slice, stripeFeeCents, remainingDueCents)` returning the
three postings with amounts (cents), accounts, tax types, `LineAmountTypes`,
`Reference`, and dates — so the accountant-nominated GST treatment is a config
change in one place, unit-tested.

### Secondary match validation (#6) — typo can't mis-post

After the Reference lookup returns exactly one invoice, assert ALL before any
write, else route to the review queue (never post):
- invoice `Contact` name (normalised) == sale `clientName` (normalised);
- invoice `Total` within 1¢ of the sale's expected project total (Σ projectAmount);
- invoice `CurrencyCode === "AUD"`;
- `AmountDue >=` this posting's payment amount (#11 keeps this true across slices).

### Invoice lookup branches (#8) — no silent skips

`GET /Invoices?where=Reference=="{saleId}"` across statuses, then:
- **0 matches** → not created yet / unlinked → record `xeroMatchStatus="no_invoice"`
  + `xeroFirstMissedAt` (#13); retry next run.
- **1 AUTHORISED ACCREC** → validate (#6) → post.
- **1 DRAFT** → `xeroMatchStatus="draft"`; retry; escalate if aged (#13).
- **1 PAID** → branch on LOCAL ids (R2-#1, R3-#2), never auto-no-op:
  - has `xeroPaymentId` but missing surcharge/fee id → **resume** those steps (our
    own payment flipped it PAID mid-sequence); set `xeroBridgedAt` only when complete.
  - has a complete local id set → genuine no-op, already done.
  - has NO local ids → someone paid it by hand in Xero → **review**, do not post.
- **VOIDED / DELETED** → `xeroMatchStatus="voided"` → review.
- **>1 match** (any status mix) → **never post**; `xeroReviewRequired` + Slack.

### Multi-slice within one run (#11)

Process a sale's eligible slices **sequentially**, decrementing a local
`remainingDueCents` after each Payment (or refetch the invoice). If the next
slice's payment would exceed remaining due → flag review, don't post.

### 0-match / failure escalation (#13) — money never goes silent

Persist `xeroMatchStatus` + `xeroFirstMissedAt` + reason on the sale. The daily
run escalates to the Slack review channel **once** when an eligible paid slice has
gone > 1 business day with no postable invoice. The per-run digest still reports
counts, but unresolved money gets a real ping, not just a number.

### Dates (#14)

All Xero `Date` fields use the **Sydney** calendar day of `slice.paidAt`, via the
existing `sydneyDateKey()` in `_sale-schedules.js`. Boundary test at 23:00 UTC.

---

## Components

### 1. `api/_xero.js` — Custom Connection client (resolved: M2M)

- **No OAuth redirect, no refresh token, no token persistence.** Custom Connection
  (`grant_type=client_credentials`) → `POST https://identity.xero.com/connect/token`
  with `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` and scopes
  `accounting.transactions accounting.settings.read accounting.contacts.read`.
  Returns a 30-min access token; fetch fresh per cron run (a daily run never
  outlives one token).
- `getXeroToken()` → access token (optionally memoised within a single invocation).
- `xeroFetch(path, opts)` → adds `Authorization`, `Xero-tenant-id` (from
  `XERO_TENANT_ID` env), `Idempotency-Key` on writes; on a 401 it fetches a fresh
  token once and retries.
- **Org assertion (#12; R2-#7):** after fetching the token, assert via
  `GET /Organisation` that the connected org **name** matches `XERO_ORG_NAME`
  (don't rely on a tenantId the Custom Connection flow may not surface cleanly).
  Halt with a Slack alert on mismatch. Demo and live are **separate Custom
  Connection apps with separate client id/secret** (R2-#7) — not a tenant swap —
  so a stale demo credential can't silently post to live. No cached per-tenant
  account state; account codes are env-driven and re-validated each run.

### 2. `api/cron/xero-reconcile.js` — the reconciler

- **Flag gate:** `XERO_BRIDGE_ENABLED !== "true"` → exit 200 noop.
- **Cron auth:** mirror `api/cron/sales-daily.js` (Vercel cron header / `CRON_SECRET`).
- **Account-code validation:** once per run, `GET /Accounts`, confirm
  `XERO_CLEARING_ACCOUNT_CODE` and `XERO_FEES_ACCOUNT_CODE` (+ surcharge income
  code) exist and are the expected type; halt with Slack alert if not.
- Scan `/sales`, apply the eligibility rule, run the state machine per slice.
- One Slack digest line per run + per-failure escalation (#13).

### 3. Salesperson link surface (resolved: manual Attio field)

- Jeremy adds a **"Dashboard Sale ID"** field to the Attio deal; the Attio→Xero
  Zap maps it into the invoice `Reference`.
- Dashboard code: on the **Sales tab row**, a small **copy-`saleId` chip** so the
  salesperson copies the exact id (no typing). That's the whole dashboard surface
  for the link. No `webhook-deal-won.js` change, and **no eligibility stamp** —
  eligibility is derived (go-live cutoff + Reference-matched validated invoice),
  so there's no unobservable flag to set (R2-#6). Docs agree (#7).

### 4. Config / `vercel.json`

- New daily cron for `api/cron/xero-reconcile.js` (e.g. 06:30 Sydney).
- Env: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_ORG_NAME` (asserted via
  `GET /Organisation`), `XERO_CLEARING_ACCOUNT_CODE`, `XERO_FEES_ACCOUNT_CODE`,
  `XERO_SURCHARGE_ACCOUNT_CODE`, `XERO_BRIDGE_GO_LIVE_AT` (ISO),
  `XERO_BRIDGE_ENABLED` (default unset/false). Demo and live use **different**
  `XERO_CLIENT_ID`/`SECRET`/`XERO_ORG_NAME` (separate Custom Connection apps).

---

## Tests (`api/__tests__/` — never `api/*.test.mjs`, that deploys live)

- `computeXeroPostings` — the three postings, amounts to the cent, the $1000/$20/
  $30/$990 worked example nets to zero, GST/tax-type constants, **`LineAmountTypes:
  "Inclusive"` so the Xero-side total/tax equal the Stripe cash** (R2-#3),
  surcharge=0 path, final-slice cap to remaining AmountDue + ≤2¢ residual (R2-#5).
- Eligibility filter — excludes historical (paidAt < cutoff, no Reference-matched
  invoice), pending/refunded/cancelled, already-bridged; includes all paid slices.
- State machine — resume after each partial step re-creates nothing; **a PAID
  invoice with `xeroPaymentId` but no surcharge/fee id still completes those
  steps** (R2-#1); PAID with no local ids → review; pre-create `Reference` query
  finds a prior posting after the 24h key window (R2-#2); 6h stale-claim reclaim;
  concurrent-claim abort.
- Match validation — wrong contact / wrong total / non-AUD / AmountDue too low →
  review, not post (#6).
- Invoice-lookup branches — 0 / DRAFT / PAID / VOIDED / 1-AUTHORISED / >1 (#8).
- Multi-slice — two paid slices decrement remainingDue; second over-applies → flag (#11).
- Real-fee resolution — **both** id paths: `stripePaymentIntentId` AND
  `stripeInvoiceId → payment_intent` (R2-#4); missing balance_transaction →
  review, not surcharge-proxy (#9).
- Sydney date — 23:00 UTC paidAt posts the next Sydney day (#14).

## Done / verification

1. Unit tests green.
2. **Xero Demo Company** end-to-end: create a demo ACCREC invoice with
   `Reference = <test saleId>`, run the cron against the demo tenant, confirm:
   invoice → PAID; payment + surcharge in Stripe Clearing; fee in Stripe Fees;
   clearing nets to the deposit; re-run posts nothing (idempotent); a typo'd
   Reference routes to review.
3. Flip `XERO_BRIDGE_ENABLED` on in prod **only after** the demo proof **and**
   accountant sign-off on the GST constants.

## Rollout

Ship flag OFF. Jeremy:
1. In **Xero Demo Company**: create the three accounts (Stripe Clearing bank,
   Stripe Fees expense, Surcharge income); register a **Custom Connection** app
   against the demo org; put its client id/secret + `XERO_ORG_NAME=Demo Company`
   + account codes in env; run the reconciler against demo; add the Zap field map;
   verify the demo end-to-end proof.
2. To go **live**: register a **separate** Custom Connection app against the live
   org (new client id/secret — R2-#7), swap `XERO_CLIENT_ID`/`SECRET`/`XERO_ORG_NAME`,
   recreate the three accounts in the live org, set `XERO_BRIDGE_GO_LIVE_AT` to now,
   get **accountant sign-off** on the GST tax-type constants, then flip
   `XERO_BRIDGE_ENABLED=true`.

## Deferred (unchanged, out of scope)

Refunds/cancellations into Xero, auto bank-payout reconcile, historical backfill,
dashboard auto-match confirm UI (option b).
