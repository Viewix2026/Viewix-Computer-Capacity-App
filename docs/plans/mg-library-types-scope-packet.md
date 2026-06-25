# Scope Packet — Motion Graphics library: split by animation TYPE, client becomes a tag + search

## Outcome
The Shared Library stops being split per client. It splits by **animation type** (Tier list, Stat, Roadmap, … Other) via filter chips. **Client** becomes a small tag on each card (still assignable) plus a **search box** to narrow to a client. So you browse "all the tier lists" or "all the $value animations", and find a client's work by searching.

## Out of scope
- Renaming/merging types in bulk (you retype per card; template renames flow to future graphics).
- A fixed/locked taxonomy (types are open: preset labels + whatever's been set + Other).
- Touching generate/refine/brand/reference/template-management logic beyond threading `type`.
- Per-client folders or nested grouping.

## Done looks like
- Library filter chips = `All · <types in use> · Other` with counts; selecting one filters the grid.
- A client search input narrows the visible grid by client substring (case-insensitive), within the selected type.
- Each card shows its type (editable dropdown) and its client as a tag (editable dropdown); existing/untyped items show under **Other**.
- Saving a graphic auto-sets its type from the preset/template it was made from (else Other); a revision keeps its type; Update original preserves it.
- Codex round; preview green; merged; prod live. No new RTDB nodes → no firebase deploy.

## Hard constraints
- Reuse the endpoint auth model (requireRole + per-action /users check already run before dispatch).
- Server-only writes; `type` is a field on the existing `/motionGraphicsLibrary/meta/{id}` record (no new node). `setType` mirrors the existing `assign` action (validId, value ≤ 80, leaf write).
- Missing `type` must read as "Other" everywhere (no migration write needed).

## Resolved decisions
- **Type source = auto from preset, editable** (Jeremy). Save sets `type = presetLabel || result.type || "Other"`. Editable per-card via a dropdown whose options = {rail/template labels} ∪ {types already used} ∪ {Other}.
- **Type value = the preset/template label verbatim** (e.g. "S-tier ranking"), no translation layer. Cleaner names come from renaming templates (v4) or per-card edits.
- **Client = tag + search** (Jeremy: "1 but client is search"). Client leaves the primary chips; stays as a card tag + assign dropdown; a search input filters by client substring. No client filter chips.
- **Existing items → Other** by treating missing `type` as "Other"; no backfill write.
- **Save client stamping** drops the old "active client chip" source (no client chip now): client = `result.reviseOf ? result.client||null : null` (revision inherits source client; fresh = unassigned, set later via the card).

## Open decisions
None.

## Approved plan
1. Backend `api/motion-graphics.js`: `handleSave` accepts + stores `type` (string ≤ 80, default "Other"); new `setType` action (mirror `assign`); docstring note. `handleUpdate` leaves type untouched (preserved).
2. Frontend `MotionGraphicsGenerator.jsx`:
   - thread `type` on result (loadFromLibrary stamps `result.type`; callGenerate carries it isRefine-gated like name/client); `saveToLibrary` sends the type + new client logic.
   - library filter: replace per-client chips with per-type chips (`typeOf(i)=item.type||"Other"`, counts, Other last); add a client search input; `visible` filters by type chip AND client substring.
   - card: a type dropdown (setType) + keep the client tag/assign dropdown; show type prominently.
   - `assignType(id, type)` calls the `setType` action.
3. Codex adversarial loop → triage → fix → verify.
4. Ship: commit, preview green, PR→main, watch prod.

## Implementation deltas
- **Codex round 1 — 3 adopted (1 must-fix, 2 cheap), rest confirmed safe:**
  - #5 (Med) saveToLibrary derived `type = presetLabel || result.type || "Other"`, so revising a saved item with a preset still active sent the preset label and corrupted the item's type. Fix: `type = result.reviseOf ? (result.type || "Other") : (presetLabel || "Other")` — a revision keeps the source type.
  - #3 (Low) retyping/archiving every item of the active `typeFilter` stranded the filter on a vanished chip (empty grid). Added an effect that resets `typeFilter` to All when it's no longer in `usedTypes` (dep `usedTypes.join("|")` to avoid per-render churn).
  - #2 (Low) `otherLast` comparator wasn't reflexive (returned 1 for equal). Made it return 0 on equal + String()-guard localeCompare.
  - Confirmed safe by Codex: type bucketing (null/empty → Other), per-card select value always in options, setType path-injection/bounds, clientSearch null-client handling, no dangling clientFilter refs, backwards-compat for untyped items, handleUpdate preserves type.
