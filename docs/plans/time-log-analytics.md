# Time Log Analytics — shipped state

**Lives at: Founders → Time Log Analytics.** This doc is the canonical state of the
feature as shipped; the build history and full decision trail are in the PRs listed at
the bottom. Last synced after PR #282 (2026-06-09).

## What it shows

1. **Weekly trend line graph** (always full history): **median** edit hours per video,
   one line per content category, each video anchored on the week its **edit finished**
   (last edit-stage log). Hand-rolled SVG (`MultiSeriesLineChart.jsx`), gridlines +
   round-number axis increments, clickable legend to toggle lines (Y-axis rescales to
   the visible lines), nearest-week hover tooltip with per-category `n`.
   - **Honesty markers:** points with n<3 render hollow; the in-progress week renders
     hollow with a dashed lead-in and "(partial)" on the axis label + tooltip.
2. **Snapshot** (scoped by the All / 30d / 90d period toggle): KPI strip, edit time by
   category (median bars, mean as secondary), **revision burden by category** (the
   pricing/process headline, worst flagged 🚩, rows **expand to the category's top
   revised videos** — name, client/project, revision h, logged edit h, last log), and a
   five-number spread per category.
3. **Adjusted / Logged toggle** (defaults **Adjusted**) — see the allocation model.

## The data model (src/timeLogStats.js — pure, 24 node:test tests)

- **Cohort:** a log `taskId` that joins a `/projects` subtask AND that subtask is
  `status === "done"`. Legacy numeric-id logs never join → excluded by construction.
  Audited 2026-06-07: join 99.2%, done 89.1% (`scripts/timelog-coverage-audit.mjs`).
- **Category:** `categorizeContent(parentName, project.videoType)`; blank videoType →
  "Uncategorized". The Capacity → Time Logs daily view uses the **same join** (PR #282)
  so all surfaces agree.
- **Paid-hours allocation (the "Adjusted" model):** editors are paid 8h/day but
  underreport. Per (editor, day): `gap = max(0, 8h − total logged that day, all stages)`,
  split evenly across the distinct tasks worked that day. **Stage-split (PR #282):** a
  share only *counts* when that day's log was edit-stage — revision/shoot-day shares are
  dropped, never booked as edit (they used to retroactively move historical chart
  points; 173h of 442h was misattributed before the fix). Adjusted edit = logged edit +
  the task's edit-day shares. Revision metrics stay logged-based throughout.
- **Median over mean** everywhere (line + snapshot): robust to the allocation's
  accepted light-day outliers.
- **Accepted simplification:** any day with logged activity counts as a full 8h paid
  day. A half-day's sole-log task absorbs a big share; medians + hollow-dot markers are
  the mitigation. Revisit only if it visibly misleads.

## Deliberately rejected (don't re-propose without new evidence)

From a 17-agent multi-lens review + adversarial refutation (2026-06-09): lazy-attaching
the `/timeLogs` listener, extracting `niceAxis` into tests, `fmtH` dedupe, changing the
revision-burden numerator (deliberate, self-heals as native history grows), and removing
the five-number spread section. All refuted as marginal for a 2-founder internal tool.

## Deferred — data-bound, with triggers

- **True client turnaround** (first edit → delivery): needs a real delivery / "shared
  with client" timestamp; none exists in the schema today.
- **3-week rolling overlay** on the trend: worth it at ~12+ weeks of native data
  (~Sep 2026). The median switch already absorbed its target outliers.
- **Delta-vs-prior-period KPI**: needs ~10+ weeks so the prior window is fully
  populated (~Aug 2026).
- **Aspect-ratio / creative-format dimensions**: needs format stamped onto logs at save
  time + backfill; aspect ratio is currently never written to Firebase.
- **Per-editor breakdown** inside Analytics (the Capacity section covers the daily
  per-editor view).

## Ship history

#262 snapshot v1 (gate-zero audit forced snapshot-over-trend) → #264 weekly line graph +
move to Founders → #265 clickable legend → #268 legend polish → #271 paid-hours
adjustment + axis increments → #275 median over mean → #282 optimization bundle
(stage-split allocation, honesty markers, category unification, burden drill-down).
Every PR gated on a Codex adversarial loop; #282 additionally on a 17-agent multi-lens
review.
