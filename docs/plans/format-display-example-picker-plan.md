# Plan — Format display-example picker (DRAFT for Codex review)

Lets a teammate mark, per format, which example (IG/TikTok/YouTube link) the client
sees as the reference in the social-organic pre-production review — replacing the
hard-coded `examples[0]`. Also adds remove + reorder to the format's example list.
Storage is **global per format** (`/formatLibrary/{id}`). See scope packet:
`docs/plans/format-display-example-picker-scope-packet.md`.

## Constraint that drives the architecture
The public client review (`ClientReview.jsx`) runs under `auth != null` **with no role**
and therefore **cannot read `/formatLibrary`** (rules require `auth.token.role != null`).
So the chosen example must be **carried into the per-project `preproductionDoc`**, which
the client can read. We do NOT loosen the `/formatLibrary` read rule (would leak other
clients' examples). All three `ClientReview` render sites (public link, client portal,
producer preview) read the same `preproductionDoc`, so they all benefit from one change.

## Data model
- **New field, global source of truth:** `/formatLibrary/{id}/displayExampleUrl` — the `url`
  of the chosen example, or absent/null = fall back to first. Use `url` (not array index):
  stable under reorder/remove.
- **New field, per-project carry:** `preproductionDoc.formats[i].displayExample = { url, thumbnail, sourceAccount } | null`.
  Self-contained so `ClientReview` needs no lookup and no library read. `null` ⇒ `examples[0]`.

## Self-review corrections (folded in)
- **Producers do NOT preview `<ClientReview>` in-dashboard.** The only mount is
  `PreproductionPublicView.jsx:208`, which signs in **anonymously** (`signInAnonymouslyForPublic`)
  → cannot read `/formatLibrary` even for a producer. The producer's project surface is
  `ClientReviewFeedback` (`SocialOrganicResearch.jsx:4866`), a feedback-management view that IS
  role'd and can read `/formatLibrary`. So any reconcile/pick that needs the library must live in
  `ClientReviewFeedback` (or the Format Library), never in the public view. _(killed the old §3.)_
- Firebase write path confirmed: top-level `socialOrganic/.write` (role'd+active) cascades to
  `preproductionDoc/formats/{i}/displayExample`; clients (anon) can't write it. Generation writes
  via admin SDK. ✔
- Single client render path: fixing `ClientReview.jsx:99` covers public link + portal embed. ✔
- `SocialOrganicSelect` / `FormatCard` use `examples[0]` only for producer-side thumbnails — not the
  client reference. No client leak; reorder stays cosmetic there. ✔

## Changes

### 1. Format Library detail — picker + manage (`src/components/FormatLibrary.jsx:424-477`)
- Add a **"Show to client" radio** per example row. Checked = this example's `url` equals
  `format.displayExampleUrl`; when unset, the **first** example shows as the implicit default.
  Selecting writes `fbSet('/formatLibrary/{id}/displayExampleUrl', ex.url)`.
- Add **Remove (✕)** per example: filters `examples`, `fbSet('/formatLibrary/{id}/examples', next)`.
  If the removed example was the chosen one, also clear `displayExampleUrl` (→ falls back to first).
- Add **Reorder (↑/↓)** per example: swaps adjacent entries, `fbSet(...examples, next)`. Arrows, no
  drag-dep. Helper text: reordering changes the library preview order but NOT the client-facing pick
  (which is by `url`).
- Keep "+ Add example" as-is.

### 2. Generation carries the choice (`api/social-organic.js:1494-1504`)
- In `formatsSection`, resolve and attach the chosen example (server-side, admin SDK):
  ```js
  const chosen = (fmt.examples || []).find(e => e.url === fmt.displayExampleUrl) || null;
  // ...existing fields...
  displayExample: chosen ? { url: chosen.url, thumbnail: chosen.thumbnail || null, sourceAccount: chosen.sourceAccount || null } : null,
  ```
- Independent of the `examples.slice(0,3)` snapshot, so a chosen example outside the first 3 still works.

### 3. Propagation to already-generated docs — RECOMMENDED: idempotent reconcile in `ClientReviewFeedback`
- `ClientReviewFeedback` (`SocialOrganicResearch.jsx:4866`) is role'd, has the project, and can read
  `/formatLibrary`. When the producer opens a project there, for each `doc.formats[i]` with a
  `formatLibraryId`, compare the live library `displayExampleUrl` → resolved example vs the doc's
  `displayExample?.url`. If different, write the resolved object to
  `/preproduction/socialOrganic/{projectId}/preproductionDoc/formats/{i}/displayExample`.
- Idempotent reconciler (matches the house pattern), no "sync" button. Guard: write only on diff to
  avoid a render→write→render loop; batch into one `fbUpdate`.
- **Known limit (accepted at SMB scale):** a project the producer never reopens after a library change
  keeps its old pick until reopened; new generations are always correct. Documented, not engineered around.

### 4. Client review honors the choice (`src/components/preproduction/ClientReview.jsx:97-112`)
- Replace the `examples[0]` reference derivation with:
  `const first = f.displayExample || (Array.isArray(f.examples) && f.examples[0] ? f.examples[0] : null);`
  then derive handle + `refUrl` from `first` exactly as today. No change to `ClientReviewScripts.jsx`.

## Done / verification (manual, per packet)
1. Format Library: mark a non-first example as "Show to client"; reload — selection persists.
2. Producer preview of a project using that format shows the chosen example's handle + watch link.
3. Public/client review of the same project shows the same. Remove the chosen example → falls back to first.
4. Reorder examples → client-facing choice unchanged (still by url).

## Open decisions (for Gate 1)
- **O1 — propagation of a post-generation change (the one real fork):**
  - **A (recommended):** Pick + manage in Format Library; generation captures it; idempotent reconcile in
    `ClientReviewFeedback` syncs an already-generated project's doc when the producer reopens it (§3).
    Fewest surfaces, matches "global + manage in library", uses the house reconciler pattern. Cost: rare
    staleness for never-reopened projects.
  - **B:** Pick from within the producer's project feedback view (`ClientReviewFeedback`), listing all the
    format's library examples; the pick writes the doc directly (instant, zero staleness for that project)
    AND mirrors to the library global field. Manage (add/remove/reorder) still in Format Library. Cost:
    pick UI split across two surfaces; doc write is a projection of the global.
  - **C:** Generation-time only — drop §3 entirely; producers set the display example before generating, or
    regenerate to refresh. Simplest; stale for any change after generation.
- **O2 — field shape:** `displayExample` object (recommended, self-contained, client needs no lookup) vs
  `displayExampleUrl` only (requires the chosen example to be inside the snapshot).
- **O3 — reorder UX:** up/down arrows (recommended, no dep) vs drag-and-drop.

## Accepted tradeoff (logged, not re-litigated)
Global-per-format means a format reused across clients shows the **same** example to every client until
re-picked. User chose this over per-project and over hybrid. Escape hatch if it bites: revisit the hybrid
(library default + per-project override).

## Out of scope (carried from packet)
Per-client/per-project override, auto-best-pick, Shortlist add flow, Meta Ads pre-prod, non-socialOrganic.
