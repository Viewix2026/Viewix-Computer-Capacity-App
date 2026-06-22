# Scope Packet — Format display-example picker (client pre-production review)

_Slug: `format-display-example-picker` · created 2026-06-22 · make-a-feature pipeline_

## STATUS — ✅ BUILT + reviewed, at Gate 2 (code), 2026-06-22
The "concurrent clientDescription work" was a **stale-branch illusion**: it had already shipped to
`main` as PRs #327–#330 (clientDescription = #329, FormatCard poster = #330, research-read edit = #328).
There was nothing to commit. Built the feature directly off `origin/main` (4e636f5) in an isolated
worktree (`/tmp/viewix-wt-preprod`, branch `feat/format-display-example-picker`).

**Built — 4 touchpoints (diff: +126/−31, only these 4 files):**
- `api/social-organic.js` ~1589 — resolve `displayExample` from `fmt.displayExampleUrl` in `formatsSection`.
- `FormatLibrary.jsx` FormatDetail — "Show to client" radio (writes `displayExampleUrl`) + Remove + Reorder (↑/↓).
- `SocialOrganicResearch.jsx` ScriptStep ~2783 — idempotent reconciler mirrors the global pick into the doc on diff.
- `ClientReview.jsx` :99 — `f.displayExample || examples[0]`.

**Verify:** `vite build` green; `node --check api/social-organic.js` clean. Interactive portal check needs
auth + real data → Gate 2 / post-deploy (can't self-serve behind SSO here).

**Codex code loop (1 round, converged):** ADOPTED F3 (helper text was misleading re: implicit-default +
reorder) and F5 (null-delete comment). PUSHED BACK on F1 (effect-per-render — provably converges; the
suggested memo fix is more work than the loop) and F2 (duplicate-URL remove — exotic, client still sees the
right URL; uuid migration not worth it). DEFERRED F4/F6/F7 (marginal/non-bugs at SMB volume). Full triage below.

## Outcome
A teammate can choose **which example (Instagram link) is shown to the client** as
the reference for a format in the client-side pre-production review, instead of the
review always defaulting to the format's first example. The teammate also gets to
**manage** a format's examples (add — exists; remove + reorder — new).

When this works: a producer opens a format in the Format Library, marks one example
as "Show to client", and every client pre-prod review that uses that format displays
that example as the reference (handle badge + "Watch reference" link), not `examples[0]`.

## Out of scope (this round)
- **Per-client / per-project override** of the choice — explicitly declined; storage is global per format.
- Auto-suggesting / ranking the "best" example.
- Changing how examples are scraped/added from the Shortlist flow.
- Non-`socialOrganic` project types — the client pre-prod review is socialOrganic-only.
- Meta Ads pre-prod review (`preproduction/metaAds`).

## Done looks like (proof = manual check in the portal)
1. In Format Library → format detail, a teammate marks an example as the client-facing one; it persists.
2. A client pre-prod review for a project using that format shows **that** example as the reference (handle + watch link), verified live in the preview.
3. Remove + reorder examples in the format detail persists and behaves (removing the chosen one falls back to first).

## Hard constraints
- **Public client review cannot read `/formatLibrary`** (rules: review = `auth!=null` no role; formatLibrary = `auth.token.role!=null`). The chosen example MUST be carried into the per-project `preproductionDoc`. Do NOT loosen `/formatLibrary` read rules — leaks other clients' examples.
- Reuse existing components: `FormatLibrary.jsx` detail view, `ClientReview.jsx` / `ClientReviewScripts.jsx`, `ReelPreview` / `VideoEmbed`.
- No new runtime dependencies.
- Prefer an idempotent auto-sync over a manual "sync" button (house rule: automation over needless buttons).

## Resolved decisions
- **Storage = global per format**, on `/formatLibrary/{id}` (not per-project, not per-client, not hybrid). _(user, Step 1)_
- **Scope includes managing examples**: add (exists) + remove + reorder (new). _(user, Step 1)_
- **Proof = manual check in the portal** (no required automated test, though a small one is welcome). _(user, Step 1)_
- **Chosen example identity = `url`** (recommended), not array index — index is fragile under reorder/remove. _(to confirm at Gate 1)_

## Open decisions
_All resolved at Gate 1 — see Resolved decisions above + Approved plan below._

## Approved plan (Gate 1 — 2026-06-22)
Full plan: `docs/plans/format-display-example-picker-plan.md`. Resolved forks:
- **O1 = A (Library pick + auto-reconcile):** pick + manage in Format Library; generation captures the
  chosen example into the doc; idempotent reconcile in `ClientReviewFeedback` (`SocialOrganicResearch.jsx:4866`,
  role'd) syncs an already-generated project's doc when the producer reopens it. Accepted limit: a project
  never reopened after a library change stays stale until reopened.
- **O2 = `displayExample` object** `{url, thumbnail, sourceAccount}` carried on `doc.formats[i]` (self-contained;
  client needs no library lookup; `null` ⇒ fall back to `examples[0]`).
- **O3 = up/down arrows** for reorder (no drag dependency).

Four build touchpoints:
1. `FormatLibrary.jsx:424-477` — "Show to client" radio (writes `/formatLibrary/{id}/displayExampleUrl`) + Remove + Reorder.
2. `api/social-organic.js:1494-1504` — resolve `displayExample` from `fmt.displayExampleUrl` into `formatsSection`.
3. `SocialOrganicResearch.jsx` `ClientReviewFeedback` (~4866) — idempotent reconcile of `doc.formats[i].displayExample` from the live library, write-on-diff only.
4. `ClientReview.jsx:99` — `f.displayExample || f.examples[0]` for the reference.

Verification (manual): pick a non-first example → reload persists; client review (public link) shows it; remove chosen → falls back to first; reorder doesn't change the client pick.

## Implementation deltas
_(only if the build deviates — logged at Gate 1.5)_

---

### Key code references (from exploration)
- `api/social-organic.js:1494-1504` — `handleGenerateScript` builds `formatsSection`, stores `formatLibraryId: fmt.id`, snapshots `examples.slice(0,3)` into `doc.formats[i]`.
- `src/components/preproduction/ClientReview.jsx:97-112` — `formats` useMemo; **line 99** hard-codes `f.examples[0]` as the reference.
- `src/components/preproduction/ClientReviewScripts.jsx:9-54` — `FormatGroupHeader` renders the reference tile + handle + "Watch reference" link.
- `src/components/FormatLibrary.jsx:424-477` — format detail Examples section; renders all examples; "+ Add example" appends + `fbSet('/formatLibrary/{id}/examples', next)`. No remove/reorder today.
- `src/components/Preproduction.jsx` — internal (role'd) producer pre-prod surface (can read `/formatLibrary`).
- `firebase-rules.json:22` (`/formatLibrary` read = role'd), `:78-90` (`/preproduction/socialOrganic/$projectId` read = `auth!=null`).
