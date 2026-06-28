# Plan — Auto-assign commission attribution (v2, post Codex round 1)

Recommended architecture for the Scope-Packet open decisions: **1a (cron-derived suggestions + UI accept)** + **2 (derive from Attio `source` + `owner`)**.

> **What changed in v2 (Codex round 1 + live data dump):** the new-vs-repeat signal is an explicit Attio field (`source = "Repeat Business"`), so the fragile close-date chronology is **deleted**, not patched. `owner` carries only a workspace-member UUID (no name/email), so payee resolution is a 5-row UUID→person map, not name matching. Suggestion shape is now the exact `/projectCommissionInputs` field set. See "Triage record" at the bottom.

## Principle
Reuse everything. We do NOT touch `commissionFor()` or `computeProfitability()`. We only populate the human input they already read (`/projectCommissionInputs`), via a suggestion layer the founder accepts. Acceptance reuses the existing `saveComm()` leaf write, so the nightly rollup turns the row Complete with zero rollup changes.

## The derivation is driven by just two Attio fields
- **`source`** (`values.source[0].option.title`, a `select`; 748/832 filled) → **dealType** AND **leadSource**:
  - `"Repeat Business"` → `dealType:"repeat"` (→ AM route, no leadSource needed).
  - any acquisition channel → `dealType:"new"` (→ closer route, needs leadSource).
  - blank/absent → `warnings:["needsDealType"]`, suggest nothing for that row.
- **`owner`** (`values.owner[0].referenced_actor_id`, an `actor-reference`; 832/832 filled, **but only a workspace-member UUID — no name/email**) → **payee identity** (closer if new, AM if repeat).

`close_date` / `associated_company` history is **no longer used** — dropped with the chronology heuristic.

## Pieces

### 1. `shared/attio-extract.js` (edit — add small exported extractors + a reusable matcher)
- `export function dealOwnerActorId(d)` → `d?.values?.owner?.[0]?.referenced_actor_id || null`.
- `export function dealSource(d)` → `d?.values?.source?.[0]?.option?.title || null`.
- `export function resolveProfitabilityDeal(project, dealIndex)` → thin wrapper exposing the existing **private `matchDealEntry()`** so the derive cron keys projects→deals **identically to the rollup** (fixes the round-1 hand-wave; the matcher uses `attioDealId || attioCompanyId` then name — must not be reinvented). Add a unit test asserting it returns the same deal `matchDealEntry` picks.

### 2. `shared/commissionDerive.js` (new, pure, unit-tested)
`deriveSuggestions({ visibleIncompleteRows, dealById, ownerMap, sourceMap, roster, commissionPlans, existingInputs })` → `{ [projectId]: Suggestion }`.

`Suggestion` is the **exact `/projectCommissionInputs` shape** plus metadata:
`{ dealType, closerId?|accountManagerId?, leadSource?, _meta:{ confidence:"high"|"review", basis:string[], warnings:string[] } }`

Rules (per visible incomplete row only — see piece 4 for the row set):
- Resolve the row's deal via the matched deal id already on the row (or `resolveProfitabilityDeal`).
- `dealType` from `dealSource(deal)` per the table above; blank → `needsDealType`, skip.
- Resolve `personId = ownerMap[dealOwnerActorId(deal)]`. No mapping (incl. the system/import actor) → `needsOwnerMatch`, skip payee.
- `repeat` → `accountManagerId = personId`. `new` → `closerId = personId` AND `leadSource = sourceMap[source]` (unmapped → `needsLeadSource`).
- Skip any projectId already present in `existingInputs` with a human value (merge-never-clobber).
- **`confidence:"high"` iff** the assembled input, dry-run through the real `commissionFor(input, commissionPlans, dealValue)`, returns **zero warnings** (this catches a matched owner whose plan rate is blank — round-1 F7). Otherwise `"review"`.

### 3. `ownerMap` + `sourceMap` (config, resolved once)
- `ownerMap`: 5 workspace-member UUIDs → roster `personId`. Built at implementation time by calling the Attio **workspace-members** API (reuse `ATTIO_API_KEY` / `api/attio.js`) to resolve each UUID→name, then mapping name→roster id. The dominant UUID (`e90aec93…`, also `created_by` on every cell) is treated as **system/unassigned until Jeremy confirms** it's a real salesperson — if system, it stays unmapped → those rows flag `needsOwnerMatch` rather than mis-attributing 582 deals.
- `sourceMap`: acquisition channel → `provided|selfSourced`. **Recommended (Gate 1 to confirm):** provided = Advertising, Referral, SEO, Conference, ChatGPT; selfSourced = Linkedin, Cold Call, Cold Email. Unmapped → `needsLeadSource`.

### 4. `api/cron/commission-derive.js` (new, mirrors `profitability-rollup.js`)
- `CRON_SECRET` fail-closed (500 unset / 401 mismatch).
- `adminGet` `/projects`, `/timeLogs`, `/attioCache`, `/editors`, `/commissionPlans`, `/projectCommissionInputs`.
- Run the existing `computeProfitability(...)` to get the **canonical visible row set**, then derive suggestions **only for rows that are Incomplete with `commissionUnassigned` or `leadSourceUnset`** (fixes round-1 F10 — no suggestions for internal/duplicate/zero-timelog rows that never render).
- `adminSet("/commissionSuggestions", { ...byProjectId, _meta:{ computedAt } })` — full replace (stale suggestions vanish, like the rollup).
- Schedule after `sync-attio-cache` (05:00): `10 19 * * *` (05:10 Sydney). Suggestions don't feed the rollup, so order vs the 05:30 rollup is irrelevant.
- Add to `vercel.json` `functions` with `maxDuration: 60` (round-1 F12).
- Fail hard on missing creds / Attio-less cache.

### 5. `firebase-rules.json`
`/commissionSuggestions`: founders-read, `.write:false` (admin cron sole writer). Separate `firebase deploy --only database`.

### 6. `FoundersProfitability.jsx` (edit)
- Listen to `/commissionSuggestions`.
- On an Incomplete row with a suggestion, render it inline: `Suggested: New · Angus · self-sourced` + `basis` ("Attio source=Linkedin, owner=Angus") + **Accept** / **Edit**.
- **Accept** calls the existing `saveComm(id, { dealType, closerId|accountManagerId, leadSource, commissionSource:"auto", acceptedAt })` — leaf write, merges onto the per-id value (already clobber-safe for one founder; round-1 F11). Existing `recomputeRow` flips it Complete instantly.
- Toolbar **"Accept all high-confidence (N)"** → `saveComm` per `confidence:"high"` id (leaf writes, not a whole-node set).
- `review`/flagged suggestions are shown but **not** bulk-acceptable — founder confirms the fuzzy bit (lead source, or an owner the map wasn't sure of).
- Manual edits always win; an accepted/auto row is overrideable and badged "auto".

## Blast radius
New: `shared/commissionDerive.js` (+test), `api/cron/commission-derive.js`. Edit: `shared/attio-extract.js` (3 small exports +test), `vercel.json` (1 cron + function config), `firebase-rules.json` (1 node), `FoundersProfitability.jsx` (suggestion UI). Untouched: `commissionFor`, `computeProfitability`, `/profitability` writer, the rollup cron.

## Open decisions for Gate 1 (Jeremy)
1. **sourceMap semantics** — confirm provided vs self-sourced split above (drives the 10% vs 15% rate).
2. **Owner identity** — is the deal owner the right payee (closer for new / AM for repeat)? And is `e90aec93…` (582 deals) a real salesperson or the system/import account? If system, those rows stay flagged, not auto-assigned.
3. Acceptance model 1a (suggest+accept) vs 1c (cron writes directly, flagged auto) — recommend 1a.

---

## Triage record — Codex round 1 (12 findings)
- **F1 (matcher hand-wave) — ADOPT.** Real: `matchDealEntry` is private. Export `resolveProfitabilityDeal`; key off the matched deal id on the computed row.
- **F2/F3 (payee/accept shape) — ADOPT.** Suggestion is now the exact `/projectCommissionInputs` field set; accept reuses `saveComm`.
- **F4/F6 (source/owner field paths & shapes) — ADOPT.** Real shapes confirmed by live dump; added `dealSource`/`dealOwnerActorId` extractors. Owner has no name/email → 5-row UUID map, not name matching.
- **F5 (source taxonomy unknown) — ADOPT/RESOLVED.** Dumped the 9 real values; mapping is now concrete, not fabricated.
- **F7 (high-confidence ignores blank plan rate) — ADOPT.** `confidence:"high"` defined as a clean `commissionFor` dry-run.
- **F8/F9 (chronology dealType unsafe; ties/missing dates) — OBSOLETED.** Dropped chronology entirely; dealType now from explicit `source="Repeat Business"`. Blank source → flagged, not guessed.
- **F10 (suggestions for invisible rows) — ADOPT (elevated to High).** Derive only for `computeProfitability` visible rows with a commission warning.
- **F11 (bulk-accept clobber) — ADOPT (severity softened).** `saveComm` is already a leaf write; bulk = per-id leaf writes, never a whole-node set. No transaction needed for a single founder.
- **F12 (vercel maxDuration) — ADOPT.** Added to `vercel.json` functions.
- **Pushback:** none material. The separate-node + accept design was endorsed; kept.
