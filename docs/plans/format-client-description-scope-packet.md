# Scope Packet — Client-facing format description

**Feature slug:** `format-client-description`
**Source:** Angus (Slack) → Triage card "Replace format library descriptions with client-specific text on pre-production review"
**Status:** Step 4 — Build (Gate 1 PASSED 2026-06-22)

> **Gate 1 decision (Jeremy):** Approved. Added scope: also surface the
> `clientDescription` field in `AddFormatModal` (the "+ Add Format" modal), not
> only in the edit form. So step 1 below covers BOTH FormatDetail and AddFormatModal.

## Outcome
On the **client-side pre-production review** stage, the client sees a short,
plain-language description of each video format — written specifically to explain
the format to the client for the first time — instead of the long internal/AI-
training description.

## Out of scope (this round)
- Per-project / per-client tailoring of the description (decided: one value per format).
- Changing how the full (AI-training) description is produced or consumed.
- Bulk-editing tooling, translation, rich text / media in the short description.

## Done looks like
1. Each format in the format library has a **separate** "client-facing short
   description" field that an admin can write/edit.
2. The full (long) description is **retained** unchanged and still available for
   AI training / internal use.
3. On the client-side pre-production review, the format renders the **short**
   description when present, and **falls back** to the full description when the
   short field is empty (so nothing regresses for formats not yet written).

## Hard constraints
- Reuse the existing format-library data structure and edit surface; do not fork it.
- Must not delete/overwrite or break consumption of the full description.

## Resolved decisions
- **End state:** separate field — short client-facing description stored alongside
  the full description; the short one is what the client sees. (Jeremy, Step 1)
- **Granularity:** one short description per format, global (same for all
  clients), authored in the format library — not per-project. (Jeremy, Step 1)

## Code facts (from exploration)
- Format library lives at RTDB `/formatLibrary/{id}`. Long description = `videoAnalysis`
  (legacy `filmingInstructions` / `structureInstructions` merged into it on save).
- Admin authoring: `src/components/FormatLibrary.jsx` → `FormatDetail` (form at
  L325–481); saves a merge patch via `fbUpdate(/formatLibrary/{id}, {...patch})` (L112).
- **Descriptions are denormalized**: at script-generation time
  `api/social-organic.js` reads each `/formatLibrary/{id}` and copies fields into
  `preproductionDoc.formats[]` (`formatsSection`, L1494–1504). Library edits do NOT
  retro-apply to already-generated docs.
- Client render: `src/components/preproduction/ClientReview.jsx` builds `blurb`
  from `videoAnalysis` (+legacy) at L106; `ClientReviewUI.jsx` `FormatCard` prints
  `{f.blurb}` (4-line clamp, L225).
- Firebase rules: `/formatLibrary` write = active staff; client reads
  `preproductionDoc` and writes only whitelisted feedback paths. Additive field
  needs **no** rule change.

## Open decisions
- _(none — fallback resolved below)_

## Approved plan
**Field:** new optional `clientDescription` (string) on each `/formatLibrary/{id}`.
The full `videoAnalysis` is untouched.

1. **Author it** — `FormatLibrary.jsx` `FormatDetail`: add a `clientDescription`
   state (seeded from `format.clientDescription`), reset on `format.id` change,
   include in the `dirty` check, and include in the `save()` patch. Add a new
   `FieldRow` textarea labelled "Client-facing description" placed **above** the
   Video analysis box (it's the primary/most-valuable field), with a hint that
   it's what the client sees on pre-production review and falls back to the full
   analysis when blank.
2. **Carry it through** — `api/social-organic.js` `formatsSection`: add
   `clientDescription: fmt.clientDescription || ""` to the mapped object so it
   denormalizes into `preproductionDoc.formats[]`.
3. **Show it to the client (with fallback)** — `ClientReview.jsx` L106 blurb:
   `const cd = (f.clientDescription || "").trim();` then `blurb: cd || <existing
   videoAnalysis composite>`. The `.trim()` guards against a whitespace-only
   value falling through as "non-empty". `ClientReviewUI.jsx` unchanged (still
   prints `f.blurb`, 4-line clamp — fine for a short description).

**Fallback (resolved):** when `clientDescription` is empty/whitespace, the client
sees the full composite blurb exactly as today — zero regression for un-written
formats and for already-generated reviews.

**Propagation note:** already-generated `preproductionDoc`s carry the old
denormalized fields; they pick up a newly-written `clientDescription` only on the
next script (re)generation. Live retro-propagation is out of scope (and a live
client-side lookup of `/formatLibrary` is impossible anyway — its read rule
requires a staff `auth.token.role`; the client only has the email-link session).

## Verification of plan (independent review — Codex was unavailable)
Codex plan-review was blocked by repeated 529 API-overload errors. Ran the
adversarial consumer/edge-case pass manually instead:
- **No AI-prompt leakage:** `videoAnalysis` is what feeds Claude
  (`api/social-organic.js` L1138/L1266/L2834, `api/meta-ads.js`). `clientDescription`
  is added ONLY to `formatsSection` (the client doc), so it never enters a prompt. ✓
- **No PDF/proposal consumer:** `workers/proposal-renderer` and
  `skills/viewix-enterprise-proposal` don't read format descriptions. ✓
- **`ClientReview` reuse covered:** rendered by both `PreproductionPublicView.jsx`
  (public client route) and `portal/PreProduction.jsx` (portal) — both client-facing,
  both fixed by the one L106 change. ✓
- **Scope boundary (deliberate):** the producer's INTERNAL Tab-7 format view
  (`SocialOrganicResearch.jsx` L2887) renders `doc.formats` and keeps showing
  `videoAnalysis` — producers retain the full reference; not part of this change.
- **No shape break:** every `doc.formats[]` reader pulls named keys, so an extra
  field is inert.
- **Save edge cases OK:** add `clientDescription` to `FormatDetail` state +
  `dirty` check + `save()` patch; `mergeLegacy` and the filming/structure wipe are
  untouched. `AddFormatModal` leaves it unset (optional) — `|| ""` seeding handles
  undefined.
- **Codex on the CODE will still run in Step 4** (retried when the API recovers).

## Implementation deltas
- **Gate-1 scope add (not a deviation):** `clientDescription` field added to
  `AddFormatModal` as well as `FormatDetail`, per Jeremy's gate decision.
- No material deviations from the approved plan during the build. Files touched:
  - `src/components/FormatLibrary.jsx` — FormatDetail (state/reset/dirty/save +
    textarea) and AddFormatModal (state + create write + textarea).
  - `api/social-organic.js` — `formatsSection` carries `clientDescription`.
  - `src/components/preproduction/ClientReview.jsx` — blurb prefers trimmed
    `clientDescription`, falls back to the videoAnalysis composite.

## Build status
- Code written + self-reviewed. Preview: compiles cleanly (no Vite errors) and
  app mounts; live form test blocked by invite-only SSO wall (no Firebase session).
- **Codex unavailable:** code-review attempt #4 also hit 529 API-overload (0
  tokens). All four Codex runs this session (2 plan, 2 code) were overload-blocked.
  Did the adversarial diff review manually instead.

## Code review (manual — Codex overloaded)
- **Fallback chain (ClientReview.jsx):** `(f.clientDescription||"").trim() ||
  (composite || "—")` — undefined/empty/whitespace all fall through to the full
  description; no blank-card or stray "—" case. ✓
- **Fix applied — dirty-state edge:** `FormatDetail.save()` originally wrote
  `clientDescription.trim()` while `dirty` compared untrimmed state; after saving
  a trailing-space value the Save button would linger (reset effect is keyed on
  `format.id`, unchanged on save). Now stored as-typed like `videoAnalysis`;
  ClientReview trims at render. ✓
- **AddFormatModal:** trims on create (consistent with its name/analysis trims);
  creating with only a clientDescription and no videoAnalysis works, no crash. ✓
- **No AI-prompt leakage:** prompt builders (L1138/L1266/L2834) read videoAnalysis
  only; clientDescription lives solely in formatsSection. ✓
- **No state leak** switching formats (reset effect re-seeds clientDescription). ✓
