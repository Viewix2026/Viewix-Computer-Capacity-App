# Scope Packet — Motion Graphics: revise a saved library graphic

## Outcome
Clicking a saved graphic in the Shared Library lets an editor keep iterating on it (type follow-up instructions → updated animation), then either **Update original** (overwrite that library item) or **Save as new** (keep the original, add a copy). Today a library click loads a read-only preview with no refine bar.

## Out of scope
- Version history / diff between revisions (Update overwrites; Save-as-new just adds an item).
- Reverting an Update (no undo — surfaced in the button copy / decision).
- Editing name/client during a revise (those stay as-is; assign dropdown already handles client).
- Touching the templates / brand-pull / enhance paths.

## Done looks like
- Click a library item → preview loads → the **refine bar is available** and a revision regenerates the graphic.
- After a revision: top toolbar shows **Update original** AND **Save as new**.
- Update overwrites `/motionGraphicsLibrary/html/{id}` + content meta (dimension, durationSec, costUsd, generationId, updatedBy/At), preserving name/client/createdBy.
- Save-as-new uses the existing `save` flow (new id).
- Codex round on the new write path; preview green; merged; prod live. (No new RTDB nodes → no firebase deploy.)

## Hard constraints
- Reuse the endpoint auth model (requireRole(GENERATE_ROLES) + fresh /users check already run for every action).
- `update` must read authoritative cost/dims from the `/aiUsage` ledger by `generationId` — never trust client cost (same as `save`).
- Re-run `injectGuard` on the revised content (the trust boundary) before writing.
- `validId` on both the library id and the generationId (path-injection guard).

## Resolved decisions
- **Both buttons after a revise** (Jeremy chose "Give me both buttons"). Update original = new `update` action; Save as new = existing `save`. Buttons appear only when the result is a revision of a library item (`result.reviseOf` set); a fresh generation keeps the single Save.
- **Prompt optional on refine.** A refine is driven by previousFragment + instruction, so revising a saved graphic (empty describe box) must not 400 "Missing prompt". Gate the prompt-required check behind `!isRefine`.
- **previousFragment limit 100KB → 200KB** to match `outputHtml`, so any saved graphic (guarded ≤200KB) can actually be revised (a 100KB cap would silently block large items — the exact thing this feature is for).
- **Non-destructive default preserved:** Update is explicit; loading a library item shows no Save button until the user actually revises (no accidental empty save/overwrite).
- **reviseOf threads through chained revisions** so you can refine twice then still Update the same original.

## Open decisions
None.

## Approved plan
1. Backend `api/motion-graphics.js`: `isRefine` gate (prompt optional), bump previousFragment limit, new `handleUpdate` (validId id+generationId, ledger lookup, injectGuard, multi-path overwrite of content leaves only), wire `update` into the switch + docstring.
2. Frontend `MotionGraphicsGenerator.jsx`: refine bar shows for `hasResult` (drop the `!fromLibrary` gate); `loadFromLibrary` stamps `reviseOf`/name/client; `callGenerate` carries `reviseOf` through; toolbar shows Update original + Save as new when `reviseOf`; `updateOriginal()` + `updatingRef`/`updatedGenId` state mirroring the save guards.
3. Codex adversarial loop on the diff → triage → fix → verify.
4. Ship: commit, preview green, PR→main, watch prod.

## Implementation deltas
- **Codex round 1 — all 4 adopted** (2 must-fix, 2 cheap-correct):
  - #1 (High) fresh generation inherited a stale `reviseOf` → "Update original" could overwrite an unrelated item. Fix: carry `reviseOf`/`name`/`client` only when `isRefine` (a fresh generate clears them).
  - #2 (Medium) client `htmlCache` served pre-revision HTML after Update original → a later revise/overwrite would silently operate on stale content. Fix: key the cache by `id:generationId` (Update bumps generationId → cache miss → fresh fetch); remount the thumb on generationId change; seed the cache with the just-updated HTML.
  - #3 (Low) unsent refine text carried onto a newly-loaded item → `setRefine("")` in loadFromLibrary.
  - #4 (Low) Save-as-new dropped the source client when the filter was "All" → fall back to `result.client` for a revision.
  - Self-caught alongside #4: `callGenerate` wasn't carrying `name`/`client` forward at all (only `reviseOf`), so both #4's fix and the Save-as-new name fallback needed those threaded (isRefine-gated).
