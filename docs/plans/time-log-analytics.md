# Time Log Analytics sub-tab

A new **Analytics** sub-view inside the existing **Time Logs** tab (Capacity Planner).

> **v1 is a SNAPSHOT, not a trend.** The original ask was "average time to edit a kind of
> video over time" (line charts). A gate-zero coverage audit against real Firebase data
> killed that for now: native time tracking only goes back ~5 weeks (May–Jun 2026, 2
> calendar months). A time-trend over 2 points is theater. So v1 answers the same underlying
> question — *how long does each kind of video take to edit, and where does the time go* —
> as a current-state snapshot. The over-time trend becomes v2 once ~6+ months accrue,
> reusing the exact same aggregation layer.

## Coverage audit results (gate-zero, run 2026-06-07)

Script: `scripts/timelog-coverage-audit.mjs` (reads `/timeLogs` + `/projects`, read-only).

- **Two log populations.** `source: "viewix"` (native app, `st-` ids): 249 edit/revision
  videos, **99.2% join**, **89.1% done**. `source: (none)` (legacy import, numeric ids,
  Title-Case stages): 125 videos, **0% join** — no project link, no category, no status.
  → **v1 scopes to `source === "viewix"`**; legacy is excluded.
- **Completion gate holds.** 89% of joined viewix videos are `status === "done"`; the rest
  are genuinely in-progress. The gate does not gut the data.
- **Category mapping works** on real `videoType` values via `categorizeContent`: "Live
  Action"→Corporate (49), "…Social Media…"→Social (83), "…Meta Ads…"→Meta (26). The only
  "Other" (62) is projects with a **blank `videoType`** — missing data, not misclassification.
  → **No explicit mapping table needed** (push back on the round-2 finding). Label the blank
  bucket "Uncategorized".
- **Stage casing is mixed** (`edit` vs `Edit`, `revisions` vs `Revisions`) across the two
  sources. Normalize `stage.toLowerCase().replace(/\s+/g,"")` before filtering (defensive;
  within the viewix scope it's already lowercase).
- **History is ~5 weeks.** 220 chartable (viewix+done) videos: 177 land in 2026-05, 43 in
  2026-06. Combined with legacy it's still only Mar–Jun 2026, and that's a migration
  cutover, not a continuous series. → **No time-trend in v1.**

## Locked decisions

| Decision | Choice |
|---|---|
| v1 shape | **Snapshot** (bars + summary), not line-chart trends. |
| Data scope (cohort) | A video is in scope iff its `taskId` **joins a subtask** AND that subtask is `status === "done"`. (Legacy numeric-id logs don't join → naturally excluded; `source === "viewix"` is asserted as a sanity check, not the primary gate.) Stage ∈ {edit, revisions}, case-normalized. |
| "Video kind" | **Content category** via `categorizeContent(parentName, project.videoType)`. Blank → "Uncategorized". |
| Headline metric | **Revision burden = revision hours ÷ edit hours per category** (the actionable pricing/process signal), plus revision rate. The worst category is flagged. |
| Centre metric | **Median** edit hours as the primary bar (edit times are right-skewed); mean shown as small secondary text, not a second bar marker. |
| Spread | A **five-number summary** per category (min / p25 / median / p75 / p90, + outlier count) — not a histogram (cleaner at n=26–83). |
| Honesty rails | One **per-video fact table** so every denominator is explicit; `n` on every bar; explicit scope + date-range label on every KPI; "Uncategorized" labelled plainly. |
| Chart tech | Hand-rolled CSS/SVG **horizontal bars** (simpler than the deferred line chart; mirror `UBar` in `UIComponents.jsx`). No chart library. |

## What v1 renders (`TimeLogAnalytics` sub-view)

Every section carries an explicit scope label (e.g. *"Native completed videos · May–7 Jun 2026 · n=220"*).

1. **Summary KPIs** — videos in scope, median edit hours/video (mean as sub-text), median
   revision hours/video, overall revision rate, overall revision-burden ratio. Each with the
   scope/date label so a partial current week never reads as a full operational total.
2. **Edit time by category** — horizontal bars (median primary; mean as secondary text),
   `n` per bar, sorted by `n`.
3. **Revision burden by category (headline)** — for each category: `edit h`, `revision h`,
   `revision:edit ratio`, `revision rate`. Sorted worst-first and the top one flagged. This
   is the decision view (where revisions are eating margin / where to reprice or tighten brief).
4. **Spread by category** — a five-number summary row (min / p25 / median / p75 / p90 +
   outlier count) for edit hours; optional histogram behind a detail toggle only.
5. *(optional)* **Per-editor** — median edit hours/video and total tracked hours by editor.

A lightweight period filter (All / last 30 / last 90 days, by `lastLogDate`) is scaffolded
but defaults to All given the short history.

## The data layer (pure module `src/timeLogStats.js`)

Reusable across v1 (snapshot) and v2 (trend) — only the final shaping differs.

### `buildProjectIndex(projects)`
`st.id -> { status, videoType, parentName: ` + "`${clientName}: ${projectName}`" + ` }`.

### `buildVideoFacts(allTimeLogs, index)`  ← single source of truth
Walk `editorId → dateKey → taskId → log`, skipping `_`-prefixed keys. Keep logs with
`secs > 0` and `stage.toLowerCase().replace(/\s+/g,"") ∈ {edit, revisions}`. **Cohort gate:**
include only when `taskId` joins `index` AND `index[taskId].status === "done"` (assert
`log.source === "viewix"` as a sanity check). Build ONE row per `taskId` (per video):
```
{ taskId, category,                         // categorizeContent(parentName, videoType); blank → "Uncategorized"
  editSecs, revisionSecs, hasEdit, hasRevision,
  editFirstDay, editLastDay, editSpanDays,  // UTC day index, DST-safe
  lastLogDate }
```
This is the single denominator source — no separate edit/revision summaries to drift apart.

### `summariseByCategory(facts)`
Per category, over the video rows:
- `n = totalVideoN` (all in-scope videos in that category)
- `medianEditH`, `meanEditH`, and the five-number summary (`min/p25/median/p75/p90`, outliers)
  computed over `hasEdit` rows
- `editHPerVideo = Σ editSecs / n`, `revisionHPerVideo = Σ revisionSecs / n`  ← apples-to-apples for the stacked bar
- `revisionRate = count(hasRevision) / n`
- `revisionBurden = Σ revisionSecs / Σ editSecs`  ← headline ratio
- `avgRevisionHAmongRevised` (secondary text only)

### `summariseOverall(facts)` and `summariseByEditor(facts, editors)`
KPI strip (same fields, all videos) and optional per-editor table. Each surfaces `n` and the
scope label inputs (min/max `lastLogDate`).

## Components
- `src/components/TimeLogAnalytics.jsx` (new, own file) — `{ allTimeLogs, projects, editors }`,
  `useMemo` over the pure layer, renders the five sections above + period filter.
- `src/components/Capacity.jsx` (edit) — add a **Daily | Analytics** sub-tab toggle inside
  `TimeLogsView`; pass `projects` (already on `Capacity`) and `editors` through.
- Bars: reuse/extend `UBar` (`UIComponents.jsx`) or a small local `HBar` — no new dependency.

## Edge cases (handled + tested)
- `_`-prefixed keys, non-join (legacy numeric ids), non-edit/revision stages, `secs<=0`, non-done — excluded.
- Mixed stage casing normalized. Blank `videoType` → "Uncategorized" (28% of data — real bucket).
- Right-skewed edit times → median primary, mean secondary text.
- Video with revision but **no** edit (`hasEdit=false`) → counted in `n`/revisionRate; excluded
  from edit median/five-number; `revisionBurden` uses category Σ so it stays defined unless
  `Σ editSecs === 0` (then burden = "n/a", not ∞).
- Video with edit but no revision → `revisionSecs=0`, lowers `revisionHPerVideo`/rate honestly.
- Empty category / empty scope → "no data" state, never a divide-by-zero.

## Testing
`tests/timeLogStats.test.js` (existing `node --test` convention). Cover: cohort gate
(join + done; legacy numeric id excluded), stage case-normalization, **one-row-per-video**
fact building, category derivation (incl. blank→Uncategorized), median/mean + five-number
summary, `revisionHPerVideo` vs `avgRevisionHAmongRevised` (the apples-to-apples fix),
`revisionRate` and `revisionBurden` (incl. edit-less and revision-less videos, and the
`Σ editSecs === 0` → "n/a" guard), UTC day math, and empty-scope handling. Assert the cohort
count lands near the audit's **220** as a regression anchor. No new deps.

## Build order
1. `src/timeLogStats.js` (pure) + `tests/timeLogStats.test.js`.
2. `src/components/TimeLogAnalytics.jsx` (KPIs + category bars + edit/revision split + histogram).
3. Wire sub-tab + `projects`/`editors` props in `src/components/Capacity.jsx`.
4. Verify in preview against real data (the audit numbers are the expected ballpark: ~220
   videos, Social/Corporate/Meta/Uncategorized split).

## Deferred to v2
- **Over-time trend lines** (the original ask) — revisit ~Nov 2026 when ≥6 months of native
  data exist. Reuses `buildStageUnits`; adds `buildSeries(units,{metric})` with continuous
  monthly buckets, raw + 3-month rolling overlay (suppress windows <3 months), and the
  `MultiSeriesLineChart` (edit vs revision series, category as filter). All previously
  designed and triaged below; just blocked on data depth.
- Aspect-ratio / creative-format dimensions (need format stamped on logs + backfill).
- True client turnaround (needs a real delivery timestamp; none exists today).

## Optional cleanup (separate task)
62 done projects have a **blank `videoType`** → "Uncategorized". Backfilling `videoType` on
those would shrink the Uncategorized bucket and improve every category cut.

---

## Appendix — Codex adversarial review trail (2 rounds)

The plan was hardened by a Codex adversarial loop before the audit reframed it. Record kept
because the findings still apply to the v1 snapshot and the deferred v2 trend.

**Round 1 (10 findings, 1 Critical / 2 High):** completion gate missing → **adopted** (done
gate); category from project name collapses to "Other" → **adopted** (classify from
`videoType`); revision skew → **adopted** (separate edit/revision units); sparse months,
empty-month axis gaps, dishonest span label, KPI rules, DST math, metadata drift → adopted;
touch tooltip → **pushed back** (overkill for internal desktop tool).

**Round 2 (new surface):** completion-gate could over-correct and drop data → **audit proved
it doesn't** (89% done); `videoType` substring match too weak → **audit pushed back** (works
on real values; only blank ones fall through); `completionMonth` misnamed, suppress early
rolling windows → adopted into the v2 trend spec.

**Convergence:** stopped at round 2 — severity collapsed and the remaining risks were
input-bound (needed real data). The coverage audit was that input, and it surfaced the two
biggest facts no amount of plan review could: the legacy/native source split and the ~5-week
history that forced the snapshot pivot.
