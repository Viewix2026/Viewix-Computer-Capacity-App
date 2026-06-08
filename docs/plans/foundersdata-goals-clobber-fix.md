# Fix: founders goals clobbered — move goals to their own `/foundersGoals` node

## Problem (confirmed against prod)

Founders → Goals shows "No goals yet" although a goal was created previously.

Prod read of `/foundersData`:

```json
{"activeClients":78,"avgRetainerValue":4602,"closingRate":62,
 "currentRevenue":529693.81,"leadPipelineValue":534094,"monthlyRevenue":40420}
```

No `goals` subtree. The goal is gone from the backend. RTDB has no history, so the lost goal is
unrecoverable (single goal — recreate it).

## Root cause

Goals are stored as `/foundersData/goals/{id}`, a subtree of the shared `foundersData` blob
(`src/components/FoundersGoals.jsx:84`). That blob is written as a **whole object** by multiple
writers that don't know or preserve the `goals` child:

1. **Client bulk-write** — `src/App.jsx:397`: `if(isFounders) fbSet("/foundersData", foundersData)`
   on a 400ms debounce, from React state that initializes to `{}` (`src/App.jsx:216`) and is gated
   by a `skipWrite` ref released 500ms after the *first listener of any node* fires — not tied to
   `/foundersData`'s own load (`src/App.jsx:279`), with a 3s fallback release (`src/App.jsx:270`).
   Any flush while local `foundersData` lacks the `goals` subtree drops it.
2. **Server cron** — `api/sync-attio-cache.js:165-175`: reads the whole node, spreads `existing`
   (which includes `goals`) into `merged`, then `fbPatch("/foundersData", merged)`. RTDB `update()`
   with a `goals` key replaces the entire goals child with whatever the cron read; any goal write
   between its `fbGet` and `fbPatch` is clobbered. (Found by adversarial review — the original plan
   wrongly declared all server writers safe.)

`api/webhook-deal-won.js:559-567` is clean (metric-only patch, no spread) and is not at fault.

The deeper issue: goals share a node with metrics, and **metrics have server-side writers that
re-populate them (webhook + cron `fbPatch`), so metrics self-heal after any partial overwrite —
but nothing re-creates goals.** Goals need a node that no metric writer ever touches.

## Chosen fix: move goals to a dedicated top-level `/foundersGoals` node

This was the original intent (the stale comments in `FoundersGoals.jsx:3-4,63` already say goals
live at `/foundersGoals`). Moving them there makes the clobber **structurally impossible**: no
writer of `/foundersData` — present or future, client or server — can touch goals, and the
`recentlyWroteTo` echo-guard (keyed on the top-level path prefix, `src/firebase.js:106-113`) now
stamps `/foundersGoals` for goal writes, so it can never suppress a `/foundersData` metric echo.

Migration is free: prod has zero goals, so there is nothing to move.

Goals are written via **direct leaf writes** to `/foundersGoals/{id}` and read via their own
listener — the same pattern already used for `/accounts`, `/sales`, `/deliveries`, `/projects`.
`/foundersGoals` is **not** added to the bulk-write loop (no whole-blob overwrite is ever
re-introduced).

`/foundersData` and its metric write paths (bulk-write loop, `updateMetric`, `syncAttio`, the cron
spread) are left **unchanged** — once goals are gone from that node, those paths are safe.

### Change 1 — RTDB rules (`firebase-rules.json`)

Add a `/foundersGoals` node mirroring `/foundersData`'s rules (after line 143):

```json
"foundersGoals": {
  ".read": "auth != null && auth.token.role == 'founders'",
  ".write": "auth != null && auth.token.role == 'founders' && root.child('users').child(auth.uid).child('active').val() === true"
},
```

Deploy is a **separate** step from Vercel: `firebase deploy --only database`.

### Change 2 — App.jsx: state, listener, prop threading

- Add state next to `foundersData` (`src/App.jsx:216`):
  `const [foundersGoals, setFoundersGoals] = useState({});`
- Add a listener next to the `/foundersData` listener (`src/App.jsx:345`):
  `if(isFounders)listen("/foundersGoals",data=>{if(data)setFoundersGoals(data);});`
- Do **not** add `foundersGoals` to the bulk-write effect (`src/App.jsx:363-397`) — leaf writes only.
- Pass to `<Founders>` (`src/App.jsx:870`): `foundersGoals={foundersGoals} setFoundersGoals={setFoundersGoals}`.

### Change 3 — Founders.jsx: thread props through

- Accept `foundersGoals, setFoundersGoals` in the props destructure (`src/components/Founders.jsx:617`).
- Update the render (`src/components/Founders.jsx:936`):
  `<FoundersGoals foundersGoals={foundersGoals} setFoundersGoals={setFoundersGoals} foundersData={foundersData} />`
  (`foundersData` stays, read-only, for the auto-create's `revenueTarget`).

### Change 4 — FoundersGoals.jsx: read/write the new node via leaf writes

- `import { fbSet } from "../firebase";`
- Signature → `FoundersGoals({ foundersGoals, setFoundersGoals, foundersData })`.
- `const goals = foundersGoals || {};` (replaces `foundersData?.goals || {}`).
- `upsert`:
  ```js
  const upsert = (goal) => {
    const next = { ...goal, updatedAt: new Date().toISOString() };
    setFoundersGoals(p => ({ ...(p || {}), [goal.id]: next }));
    fbSet("/foundersGoals/" + goal.id, next);
  };
  ```
- `remove`:
  ```js
  const remove = (id) => {
    if (!window.confirm("Delete this goal?")) return;
    setFoundersGoals(p => { const g = { ...(p || {}) }; delete g[id]; return g; });
    fbSet("/foundersGoals/" + id, null);   // RTDB null = delete leaf
  };
  ```
- Auto-create revenue goal (`:66-86`): depend on `foundersData?.revenueTarget` instead of `[]` (so
  it runs once the target loads, not at mount when state is empty), guard via the existing
  `goalsList.some(g => g.source === "revenueTarget")` check, and persist with
  `fbSet("/foundersGoals/" + auto.id, auto)` plus the `setFoundersGoals` state update. `newGoal()`'s
  id (`goal-${Date.now()}-${Math.random().toString(36).slice(2,6)}`) is collision-safe at this scale.
  Note: `revenueTarget` is absent in prod, so this stays dormant until a target is set.

### Change 5 — founders-advisor.js: read goals from the new node

- Add `fbGet("/foundersGoals")` to the `Promise.all` (`api/founders-advisor.js:287-291`).
- Pass `foundersGoals: foundersGoals || {}` into `buildContext` (`:293-297`).
- In `buildContext` (`:146`, `:233`): add a `foundersGoals = {}` param and change
  `const goals = Object.values(foundersData.goals || {})` →
  `const goals = Object.values(foundersGoals || {}).filter(Boolean);`
- Update the file-header comment (`:6`) — `/foundersData` no longer holds goals.

### Change 6 (secondary, bundled) — fix the dead `updateRevenue` in `syncAttio`

Adversarial review surfaced a pre-existing latent bug unrelated to goals but in the same file:
`src/components/Founders.jsx:678` calls `updateRevenue(m.ytdRevenue)`, which is **undefined** — it
throws, is swallowed by the `.catch`, and the manual "Sync from Attio" button silently fails to
persist `currentRevenue` (and skips `setAttioLoading(false)` on the happy path). Fix by folding it
into the existing `setFoundersData` merge (`:670-677`):
`currentRevenue: m.ytdRevenue > 0 ? m.ytdRevenue : p.currentRevenue` and delete line 678. This
persists through the unchanged bulk-write path.

## What the review changed vs the first plan

- **Finding 1 (Critical):** server cron spread-clobber — now **structurally moot** (goals live in a
  different node; the cron's `existing` spread no longer contains goals and correctly round-trips
  `revenueTarget`). No cron change needed.
- **Finding 3 (Medium):** cross-leaf echo suppression — now **structurally moot** (goal writes stamp
  `/foundersGoals`, not `/foundersData`).
- **Finding 2 (High):** `syncAttio` was only a problem under the *old* plan (which removed
  `foundersData` from the bulk-write). Under this plan that loop is untouched, so the 5 metrics keep
  persisting as today; only the genuine `updateRevenue` bug remains, fixed in Change 6.

## Out of scope / non-goals

- No recovery of the deleted goal (no RTDB history).
- Metrics stay on the bulk-write path — they self-heal via server `fbPatch` and are not the bug.
- No change to `/foundersData` rules, the cron spread, `updateMetric`, or the bulk-write loop.

## Verification

1. Deploy rules: `firebase deploy --only database`.
2. Create a goal → hard reload → it persists (now under `/foundersGoals`).
3. On a fresh load, immediately edit a Dashboard-tab metric → goals are untouched (separate node).
4. Delete a goal → reload → stays deleted.
5. `firebase database:get /foundersGoals` shows the goal; `firebase database:get /foundersData`
   never gains a `goals` child.
6. Trigger / open the Advisor briefing → it lists the active goal (reads `/foundersGoals`).
7. grep: `grep -rn '"/foundersData/goals\|foundersData.goals\|goals:' src/ api/` shows no writer or
   reader still treating goals as a `/foundersData` child.

## Deploy sequencing (important)

RTDB rules must be deployed **before** the client code that writes `/foundersGoals`, or the first
goal write is permission-denied. Order: (1) `firebase deploy --only database`, (2) merge/deploy the
app to Vercel.
