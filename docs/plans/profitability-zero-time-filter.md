# Profitability: drop projects with no logged timer time

Status: built, tested, ready to ship. Branch `claude/profitability-zero-time-filter`.

## What

The Founders → Profitability instrument showed a row for every project,
including the many with no timer activity (predate the timer, outsourced,
small, or stale). Those read as full-margin revenue against ~zero captured
cost and cluttered the Incomplete list. This change drops any project with
**no logged timer time** from the calculator, at both the cron (the
persisted `/profitability` truth) and the live UI recompute.

## Decision (locked with Jeremy)

**Strict: no logged time => out.** A project with zero logged timer time is
dropped EVEN IF it carries entered externals. Rejected alternatives: "keep
if real externals" (would keep fully outsourced jobs) and "keep if any
saved cost entry." Jeremy chose the most aggressive declutter.

The ONE exception is a `duplicateTaskId` collision: its hours ARE logged
but got misattributed to another project sharing a subtask id, so the row
survives so the misattribution warning stays visible instead of vanishing.

Single predicate, shared by cron and UI so they cannot drift:

```js
keepProjectRow(row) = num(row.loggedHours) > 0 || !!row.duplicateTaskId
```

## Codex adversarial review — findings and verdicts

- **HIGH 1 — duplicate-task project silently dropped. ADOPTED.** Without
  the carve-out, the second project in a subtask collision (0 hours,
  flagged) would vanish, burying the very warning it should raise. Fixed
  via the `duplicateTaskId` exception plus a regression test.
- **MED 3 — legacy numeric time logs counted as 0 hours. ADOPTED (best
  catch).** Eight other readers handle `typeof log === "number"` as
  seconds; `computeProfitability` was the lone exception, a pre-existing
  labour undercount the filter would escalate into a silent drop. Fixed to
  parse numeric logs, plus a test.
- **MED 2 — externals-only row flicker on load. DROPPED as moot.** Only
  bit under an externals-aware model; the strict predicate keys only on
  `loggedHours` (always present in the persisted base), so there is no
  `/projectCostInputs` race.
- **LOW 4 — false "no snapshot yet" if every project filters out. ADOPTED
  (1 line).** `noSnapshot` now also requires `!persistedAt`, so a real run
  that yields zero rows does not show first-run guidance.
- **LOW 5 — confirmed-zero-cost project dropped. ADOPTED as policy + test.**
  Under strict it is correctly dropped (the confirmation covers externals,
  not labour); pinned with a test so the policy is explicit.

## Files

- `shared/profitability.js` — `keepProjectRow` export; numeric-log parse in
  the hours loop; filter in `computeProfitability`.
- `src/components/FoundersProfitability.jsx` — import `keepProjectRow`,
  `.filter(keepProjectRow)` on the live rows, `noSnapshot` guard.
- `shared/__tests__/profitability.test.mjs` — strict-drop, numeric-log,
  confirmed-zero, and duplicate-survival tests; enrichment fixtures given
  logged time (zero-externals coverage retained).

## Verification

- `node shared/__tests__/profitability.test.mjs` → 27 passed.
  `attio-extract` → 24 passed. `npm run build` clean.
- Built in an isolated git worktree because the shared checkout was being
  reset by concurrent agents mid-edit.

## Effect on the live tool

The cron persists `/profitability` without zero-time rows; the UI mirrors
that immediately via live recompute. The existing snapshot is replaced on
the next cron run (05:30 Sydney). No new env, no RTDB rules change, no cron
schedule change.
