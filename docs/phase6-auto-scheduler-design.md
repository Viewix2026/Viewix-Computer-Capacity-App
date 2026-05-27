# Phase 6 — Format-aware auto-scheduler (DESIGN ONLY — do not build blind)

The shoot-scheduling modal that distributes a project's edits across
editors. **Not built overnight by deliberate decision** (Codex + Claude
agreed): the solver has subtle correctness traps that are easy to get
wrong and hard to catch without real data. This doc resolves them so it
can be built with confidence + audited first.

## Locked product behaviour (from earlier Q&A)
- On **shoot scheduled** → modal. Q1 "Is this the only shoot?" Yes →
  schedule all edits; No → tick the specific videos to schedule now.
- Show **all editors, default-ticked**; untick those unfit.
- **Propose-then-approve:** show a preview table (each video → editor +
  creativeFormat + landing day + warnings); producer tweaks; **nothing
  writes until Confirm**.
- If a project's **formats aren't assigned**, prompt to assign first.

## Build on the existing planner (don't rebuild)
`shared/scheduling/planner.js` `buildPlan(...)` already does: video units
(`buildVideoUnits`), candidate-editor selection (honours
`requestedEditorIds`), a per-editor/day free-edit-hours capacity grid
(`capacity.js`), greedy earliest-feasible allocation, conflict detection
(`conflicts.js`), and a `{ proposedSubtasks, hardViolations, warnings }`
result. Reconcile leaf-paths live in `plan-apply-core.js`. Invoked today
only from Slack (`api/_scheduling-planner.js`).

## The four problems to resolve (in priority order)

### 1. ⚠️ Planner identity — `_videoIndex`, not `videoId` (the blocker)
Confirmed: reconciliation identity is `(projectId, stage, _videoIndex)`;
`buildVideoUnits` assigns a synthetic `index`. Format grouping needs the
**per-video `creativeFormat`**, which now lives on the canonical
`videoId` (Phase 5). So before any grouping:
- **Thread `videoId` + `creativeFormat` onto the video units** in
  `buildVideoUnits` (read them off the project's video-edit subtasks),
  and carry both onto `proposedSubtasks`. Keep `_videoIndex` for
  reconciliation, but the unit must *also* know its `videoId`/format.
- Verify `plan-apply-core.js` still reconciles on `_videoIndex` (don't
  break the Slack plan flow). Add a test that a unit's `videoId`/
  `creativeFormat` survives `buildVideoUnits` → `proposedSubtasks`.
- **This is the prerequisite — do it first, with tests, before grouping.**

### 2. Format grouping (one editor per format)
- Pre-pass: group video units by `creativeFormat`. Assign each
  format-group to **one editor** (the candidate that finishes it
  earliest given current capacity). 2 formats → 2 editors, not split
  evenly.
- **Relax rule:** if a single format-group can't finish by the deadline
  under one editor, allow a second editor for *that* group only — never
  silently split a format across editors otherwise.
- Edge: videos with no `creativeFormat` (legacy / unassigned) → the modal
  already prompts to assign; if still missing, fall back to the planner's
  normal allocation for those (no grouping), flagged in the preview.

### 3. Half-day bias (soft, NOT a hard rule)
- Prefer keeping an editor on one project for ≥ ~half a day (~4h) for
  flow. Implement as a **scoring bias in the allocation tiebreak**, never
  a constraint that blocks earliest-finish.
- Weigh context: remaining videos on the project, the editor's **overdue**
  items, and work **carried over** from a previous day. High-priority /
  overdue work breaks the bias.

### 4. Respect existing work (already handled)
`buildPlan` reads the global capacity grid (free-edit-hours per
editor/day across all projects), so it won't deprioritise scheduled work.
Keep that; just confirm grouping + bias don't bypass the grid.

## Modal (frontend)
- Triggered on shoot-date set in the Team Board / Projects.
- Calls a wrapper around `buildPlan` with `requestedEditorIds` = ticked
  editors; renders the preview from `proposedSubtasks` (+ `warnings`);
  Confirm writes via the `plan-apply-core` leaf paths (optimistic +
  per-leaf, same echo-guard discipline as everything else).

## Also belongs here: reformat capacity-aware scheduling
The shipped `reformat-on-approval` does the *simple* placement (master's
editor, next working day, appended priority). The locked fuller rule —
**reassign if that editor is stacked; stack ALL of a project's reformats
onto one person's day** — needs this capacity grid. Fold it in here.

## Test plan
- Unit: `videoId`/`creativeFormat` survive `buildVideoUnits` →
  `proposedSubtasks`; format-grouping puts same-format videos on one
  editor; the relax rule triggers only past the deadline; half-day bias
  doesn't override earliest-finish.
- Manual (preview): modal shows video→editor→format→day + warnings;
  Confirm writes; nothing before Confirm.

## Why design-first
Identity mapping, format grouping, and the half-day bias are exactly the
"looks right, subtly wrong" class — wrong `_videoIndex`↔`videoId` mapping
silently binds edits to the wrong videos. Resolve #1 with tests before
building #2–#3.
