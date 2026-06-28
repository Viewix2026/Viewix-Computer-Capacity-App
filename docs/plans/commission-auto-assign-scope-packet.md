# Scope Packet — Auto-assign commission attribution

> make-a-feature artifact. Carries intent → plan → build deltas through both gates.
> Status: **PLAN DRAFT (pre-Gate-1)**. Created 2026-06-28.

## Why this, and not Xero (the diagnosis)

The Founders → Profitability instrument is shipped and correct, but **45 of 61 projects fall out of the totals** ($217,533 of deal value excluded). Live `/profitability` read (2026-06-28) shows why:

| Cause | Projects | Notes |
|---|---|---|
| **commissionUnassigned** | **40** | blank `dealType` in `/projectCommissionInputs` → no payee route |
| missingOrZeroDealValue | 10 | deal value missing/zero — out of scope this round |
| missingLabourRate | 4 | only 5 roster people blank; trivial/separate |
| dealMatchAmbiguous | 1 | deal-match — out of scope |

Xero calibration (the parked plan) fixes **4 of 45**. Commission attribution is the real lever. Feasibility confirmed: `/attioCache` deals carry **owner 832/832**, **source 748/832**, **value 744/832**, **stage/close_date/associated_company** — every commission input is derivable from data we already cache.

---

## Required fields

**Outcome.** Founders open Profitability and the totals reflect ~all viable projects, not a 16-project sliver. The ~40 `commissionUnassigned` projects get an auto-derived commission attribution (dealType + payee + lead source) so they become Complete and count toward blended contribution — and new projects keep getting suggestions so it doesn't rot back to 16.

**Out of scope (this round).**
- The 10 `missingOrZeroDealValue` and 1 `dealMatchAmbiguous` (different root cause — deal matching / missing revenue).
- Xero Phase 1 (overhead / real labour rates) — separate feature, comes after.
- Any actual commission *payout* or money movement. This only feeds the internal margin calc.
- The 4 `missingLabourRate` projects (set 5 rates by hand; not a build).

**Done looks like.**
- Run the derivation against real `/attioCache`: `commissionUnassigned` shrinks from 40 to a small flagged residual (only genuinely underivable rows — no owner match, unmapped source, zero value).
- Every auto-assigned row is visibly marked as auto/suggested, auditable (shows what it derived and from which Attio field), and founder-overridable. A manual entry always wins over an auto one.
- Blended contribution recomputes across the newly-Complete projects and the numbers are sane (no absurd/negative commissions).
- Verified on preview against live data (read-only) before merge.

**Hard constraints.**
- Founders-only. Never expose commission/dealValue to any team-facing surface (see `feedback_deal_value_hidden`).
- **Merge, never clobber.** A founder's manually-set `/projectCommissionInputs[id]` always wins over the auto layer (mirrors the Xero plan's `laborCosts` merge posture).
- Reuse what exists: `/attioCache` (no new Attio fetch), the existing owner/person email-match pattern, and `commissionFor()` in `shared/profitability.js` **untouched** — we only populate its inputs.
- **Flag, don't guess** (the instrument's core philosophy). Unmatched owner / unmapped source → flagged "needs review," never a silent default that fabricates margin.
- `/profitability` stays founders-read `.write:false`; if a cron writes suggestions, it writes a *separate* node, not `/profitability`.

---

## Resolved decisions (Gate 1, 2026-06-28)

1. Feature target pivoted from Xero calibration to commission auto-assign — diagnosis showed Xero fixes 4/45, commission fixes 40/45.
2. **Owner = who closed it.** Attio deal `owner` reliably identifies the salesperson (Jeremy's 582 are genuine closes, not admin defaults). → owner is a high-confidence payee signal. Owners with no `/commissionPlans` entry (likely suspended ex-staff Vish/Raoul) → flag for review, don't guess a rate.
3. **Architecture: client-side.** Derive suggestions live inside `FoundersProfitability.jsx` from `/attioCache` (already synced + reachable). NO new cron, NO `/commissionSuggestions` node, NO rules deploy, NO Vercel function. Deletes round-2 findings F2/F5/F12.
4. **dealType from `source`, trusted.** `source == "Repeat Business"` → repeat; any other channel → new (Jeremy confirms tagging is reliable — overrides Codex F1's generic caution); **blank source → flag `needsDealType`**, never guessed.
5. **leadSource map (new business only):** provided (10%) = Advertising, SEO, Conference, ChatGPT; self-sourced (15%) = Cold Call, Cold Email, Referral, LinkedIn. Unmapped/blank channel → flag `needsLeadSource`.
6. **Confidence:** `high` iff the assembled input dry-run through the real `commissionFor()` returns zero warnings (catches blank plan rates). Only `high` is bulk-acceptable; everything else is review-tier (founder confirms before it counts).

## Approved plan

Client-side only. ~3 files, no infra.

**1. `shared/attio-extract.js` (edit + test)** — export three helpers off the existing private internals:
- `dealOwnerActorId(d)` = `d?.values?.owner?.[0]?.referenced_actor_id || null`
- `dealSource(d)` = `d?.values?.source?.[0]?.option?.title || null`
- `resolveProfitabilityDeal(project, dealIndex)` — thin wrapper over the private `matchDealEntry()` returning the matched **raw** deal, so the component keys projects→deals identically to the rollup (round-1 F1). Test asserts parity with `matchDealEntry`.

**2. `shared/commissionDerive.js` (new, pure, unit-tested)** — `deriveSuggestion({ project, deal, ownerMap, roster, commissionPlans })` → `{ dealType, closerId|accountManagerId, leadSource, _meta:{confidence, basis[], warnings[]} }`, the exact `/projectCommissionInputs` shape (round-1 F2/F3). Encodes resolved decisions 4–6. `confidence:"high"` via a real `commissionFor()` dry-run. `ownerMap` = Attio owner UUID → `/commissionPlans` payee id, matched by email/name (the 5 UUID→email pairs resolved via the Attio members API: Jeremy=hello@, Brandon=brandon@, Vish=vish@, Raoul=raoul@, Sophie=sophie@); unmatched owner or owner-without-plan → `needsOwnerMatch`/review.

**3. `src/components/FoundersProfitability.jsx` (edit)** — add `/attioCache` + `/projects` listeners; build the deal index once; for each **visible Incomplete row** (reuse the existing live `rows` set, so no invisible/internal/duplicate rows — round-2 F10) whose warning is `commissionUnassigned`/`leadSourceUnset`, resolve its deal and derive a suggestion. Render inline `Suggested: New · Angus · self-sourced` + basis + **Accept** / **Edit**; toolbar **"Accept all high-confidence (N)"**. Accept reuses the existing `saveComm(id, {…, commissionSource:"auto", acceptedAt})` leaf write (round-1 F11). Manual entries always win; skip any row whose `/projectCommissionInputs` already has a `dealType` set (round-2 F6). Auto rows badged + overrideable.

**Untouched:** `commissionFor`, `computeProfitability`, `/profitability` rollup + writer, all Firebase rules.

**Done / verify:** on preview against live `/attioCache` (read), the ~40 `commissionUnassigned` rows show suggestions; "Accept all high-confidence" clears the reliable subset and blended contribution recomputes sanely; review-tier rows stay flagged with a clear reason; no suggestion ever appears on an already-Complete or manually-set row.

## Implementation deltas

Build deviations from the approved plan (all immaterial — no data-contract /
security / behaviour change), plus the second Codex loop (on code):

- **Reused the existing exported `resolveDeal` instead of a new `resolveProfitabilityDeal`.** It already returns the matched deal's `recordId` + `via`, so no new export was needed; the component joins to the raw deal via a `rawDealById` map. Leaner, identical keying.
- **Codex code-review round 1 (3 findings, all fixed + regression-tested):**
  - F1 (High) `findPlan` first-token fallback could pick a wrong same-first-name payee → now exact-full-name match first, unique-first-token fallback only.
  - F2 (High) lead source was skipped when the owner was unmapped → moved lead-source derivation into its own block so it runs for any new-business deal.
  - F3 (Med) zero-value Attio deals excluded → broadened, then reverted (round 2).
- **Codex code-review round 2 (2 Low, both resolved):**
  - `norm()` now collapses internal whitespace (matches the repo's `normName`).
  - Reverted the F3 `includeZeroValue` broadening: a live sim showed it rescued **0 rows** (a commission-blocked row always carries a positive deal value) while introducing a $0-sibling name-match ambiguity. Positive-only default kept; a $0-Attio-FK deal simply stays manual, as today.

**Verification:** `commissionDerive.test.mjs` 52 assertions pass · `attio-extract.test.mjs` 56 pass · `npm run build` clean · live read-only sim: accepting high-confidence takes Complete **16 → 28** and deal value in totals **$86,236 → $173,449** (contribution $65,577 → $141,102).
