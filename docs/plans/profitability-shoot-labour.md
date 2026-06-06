# Profitability: capture un-timed shoot labour from the schedule

Status: built, tested, ready for review. Branch `claude/profitability-shoot-labour`.

## Why

The margin instrument's labour comes only from `/timeLogs` (timer time).
Shoots are almost never timed (crew are on location), so a project's shoot
labour read as $0 and contribution looked far too healthy. Jeremy flagged
the National Renewable Network row: 15.9 logged hours / $536 labour (pure
editor rate, no shoot), with a whole shoot's labour missing.

## Decisions (locked with Jeremy)

- **Auto from the schedule.** Shoots are `stage === "shoot"` subtasks under
  `/projects/{id}/subtasks` carrying booked `startTime`/`endTime`,
  `assigneeIds` (crew, ids match `/laborCosts` + `/editors`), and dates.
- **Real booked window when present; estimate when not.** Missing/invalid
  times fall back to `EST_SHOOT_DAY_HOURS` (8h) per scheduled day, labelled
  estimated, NOT flagged Incomplete (Jeremy's call: always a number).
- **Internal crew only.** Costs people with a rate in `/laborCosts`.
  Freelance shoot crew without an editor id stay in the Crew external.
- **Each assigned crew member costed for the FULL window** (2 crew on a 6h
  shoot = 12 person-hours; both work the whole booking, not split).
- **Only adds cost to projects already showing** (logged time). A shoot-only
  project with zero logged time stays dropped (keepProjectRow unchanged), so
  we don't re-introduce rosy unrealised rows.

## How

- `shootHoursByPersonForProject(project, loggedTaskIds)` reads shoot subtasks
  with a `startDate` and >= 1 assignee, derives hours from the booked window
  (or estimate), and sums per crew person. Returns `{ byPerson, estimated }`.
- **Double-count AND under-count guard:** `computeProfitability` collects
  logged hours per subtask per person and passes them in; for a shoot the
  timer partly captured, only the UN-timed remainder of the booked window is
  added (logged 4h of a 6h shoot => 2h scheduled), so a partial log neither
  double-counts nor hides the rest.
- `recomputeRow` prices `shootHoursByPerson` at crew rates into a separate
  `shootLabour` line (missing rate => `missingLabourRate`, reused), folded
  into `productionCost`. `shootHoursByPerson` + `shootHoursEstimated` are
  persisted so the client reprices live without loading `/projects`.
- **UI:** the per-project table's Labour column now shows logged + shoot
  combined (so Deal − Labour − Ext − Commission reconciles to Contribution).
  The expandable breakdown splits it: Labour (logged), Shoot hours, Shoot
  labour (tagged "(est)" when estimated).

## Edge handling

- Shoot partly/fully timed → only the un-timed remainder of the window is
  added (logged hours are truth; never double-counted, never under-counted).
- Absurd day span (stale/typo endDate) → capped at `MAX_SHOOT_DAYS` (14) and
  flagged estimated, so one bad date can't distort the totals.
- Shoot with no assigned crew → skipped (freelance go in externals).
- Shoot with times but no startDate → not costed (treated as an unscheduled
  draft; a deliberate gate, not flagged).
- No booked times → estimate, labelled.
- Multi-day booking → days × daily window.

## Codex adversarial review — findings + verdicts

- **HIGH partial-log under-count. ADOPTED.** First cut skipped a shoot
  entirely if any time was logged on it, losing the un-timed remainder
  (false profit). Now subtracts logged-on-shoot per person from the window.
- **MED unbounded day span. ADOPTED.** Capped at `MAX_SHOOT_DAYS`, flagged
  estimated when capped.
- **MED shoot with times but no startDate => silent $0. PUSHED BACK.**
  Requiring startDate is the deliberate "is it scheduled" gate; undated
  shoots are drafts, intentionally not costed. Flagging would contradict the
  estimate-don't-flag choice.
- **LOW rate panel missed shoot-only crew. ADOPTED.** `loggedPersonIds` now
  includes `shootHoursByPerson` ids so a shoot-only crew with no rate is
  settable.
- **LOW stale UI copy. ADOPTED.** Description now mentions scheduled shoot
  labour.

## Files

- `shared/profitability.js` — `EST_SHOOT_DAY_HOURS`, shoot helpers,
  `shootHoursByPersonForProject`, shoot pricing in `recomputeRow`, loggedTaskIds
  guard + base wiring in `computeProfitability`, `shootLabour` rollup total.
- `src/components/FoundersProfitability.jsx` — combined Labour column +
  breakdown shoot lines.
- `shared/__tests__/profitability.test.mjs` — 12 shoot tests (window pricing,
  full-window-per-crew, estimate, multi-day, no-crew skip, missing-rate,
  shoot-only-dropped, pure helper, round-trip, partial-log remainder,
  fully-logged, span cap).

## Verification

- `node shared/__tests__/profitability.test.mjs` → 39 passed. Build clean.
- The cron reads full `/projects` (`adminGet`), so subtask times flow through.
  Shoot hours refresh on each cron run; the client reprices rates live off the
  persisted `shootHoursByPerson` (same pattern as logged hours).

## Open / future

- `EST_SHOOT_DAY_HOURS = 8` is one documented constant; change if Viewix's
  typical shoot day differs.
- A multi-day booking with a stale far-future endDate would over-estimate;
  reflects the booking, labelled estimated.
