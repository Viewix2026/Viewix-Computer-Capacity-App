# Plan — Dashboard Bug/Feature Request Automation

Feature slug: `dashboard-request-automation`. Branch: `claude/dashboard-request-automation-3y6wku`.

> **QA gate:** this plan was hardened by an independent adversarial review pass (Claude red-team
> stand-in) in this session — see "Adversarial review trail" at the bottom. The *real* Codex loop
> (Jeremy's Mac, OpenAI-authed) is an end-of-run check-off item, since the Codex CLI / OpenAI creds
> are not present in the cloud build environment.

## Outcome

A team member drops a bug or feature request in the `#dashboard-feature-requests` Slack channel.
The Viewix bot threads on the message, asks targeted clarifying questions (where in the dashboard,
expected vs actual, screenshot), and once it has enough to act, files a ticket into a **Requests**
Kanban board living as a new sub-tab in the Founders tab. When a ticket is marked **Ready**, a
GitHub issue is opened as a build brief; a cloud Claude Code session (Jeremy's Max plan) picks it
up, drafts a plan, asks Jeremy any strategy questions, and opens a PR. On merge, the card moves to
**Done** and a ✅ reaction lands on the original Slack message. Jeremy's only recurring touch:
strategy answers + clicking merge.

## Why this is mostly assembly, not greenfield

The repo already runs this exact shape for `#scheduling`:
- `api/slack-schedule-listener.js` — Events API entry, signature-verified, `waitUntil` async work,
  Claude intent extraction, threaded replies.
- `api/_slack-helpers.js` — `verifySlackSignature`, `slackPostMessage({thread_ts})`,
  `slackAddReaction`, `slackSwapReaction`, `readRawBody`, `randomShortId`.
- `api/_fb-admin.js` — `adminGet/adminSet/adminPatch`, `runRtdbTransaction` (admin writes bypass
  RTDB rules, so bot-created tickets need no client rule).
- `firebase-rules.json` `proposalJobs` — the template for a role-gated, create-only,
  field-validated job collection.
- `src/components/Founders.jsx` — sub-tab nav (line 693) + render switch (line 711+); role gate
  (`founders`) already upstream in `App.jsx`. `@dnd-kit` is already a bundled dep (drag-drop board
  for free).
- Claude call pattern: `api/founders-advisor.js` / `slack-schedule-listener.js`
  (`https://api.anthropic.com/v1/messages`, `x-api-key: ANTHROPIC_API_KEY`).

## Build order (4 phases)

### Phase 1 — Requests board + store (FULLY AUTONOMOUS, ships this session)
- **Data model** `/dashboardRequests/{ticketId}`:
  ```
  id, title, body, type: 'bug'|'feature', status: 'triage'|'ready'|'building'|'review'|'done',
  priority: 'low'|'med'|'high'|null, source: 'slack'|'manual',
  requestedBy: { slackUserId|null, name }, slack: { channelId, messageTs, threadTs, permalink }|null,
  screenshots: [{ permalink, name }], clarifications: [{ q, a }], plan: string|null,
  github: { issueNumber, issueUrl, prUrl }|null,
  createdAt (number, ms), updatedAt (number, ms), createdByUid|null
  ```
  `createdAt`/`updatedAt` are **always numeric `Date.now()`** (Codex R1-F8: don't mix string/number
  under the `createdAt` index). `screenshots` store the Slack **permalink** (opens in Slack), not a
  raw private file URL — see F7 below.
- **Trust boundary (Codex R1-F1/F2 — the core rework):** the client is **read-only** on
  `/dashboardRequests`. RTDB rules validate the *merged* node, so a client `update({status})` would
  leave every other field client-writable — forging `github.prUrl`, `requestedBy`, or `status:'done'`
  is trivial under any rule that only checks `status`. So **all mutations go through authenticated
  server endpoints** that verify the caller's role token (`_requireAuth`, founders) and write via the
  Admin SDK:
  - `api/dashboard-requests.js` — `POST {action:'create'|'update'|'delete', ...}`. `create` builds a
    `triage`/`source:'manual'` ticket; `update` applies a **validated status transition** (server owns
    the DAG) + whitelisted field edits, stamping `updatedAt`; `delete` founders-only. The backend, not
    a rule, owns the state machine. Drag-to-move in the UI calls `update`.
- **New sub-tab component** `src/components/FoundersRequests.jsx`: a 5-column Kanban
  (Triage → Ready → Building → Review → Done) reading `/dashboardRequests` via `fbListen`,
  drag-to-move via `@dnd-kit` → `authFetch('/api/dashboard-requests', {action:'update'})`, a card
  detail drawer (body, clarifications, screenshot links, plan, GitHub links), and a manual
  **New ticket** form → `authFetch(... {action:'create'})`.
- **Wire-up** in `Founders.jsx`: add `{ key: "requests", label: "Requests" }` to the nav array
  (line 693) and `{foundersTab === "requests" && <FoundersRequests />}` to the render switch.
- **RTDB rules** (`firebase-rules.json`): new `dashboardRequests` block — **read `founders` only**
  (Codex R1-F4: a `manager` cannot reach the Founders tab at all — `App.jsx:934` +
  `roles.js:37`, so founders-only is the honest gate), **`.write: false` for clients** (all writes
  are Admin-SDK via the endpoints, which bypass rules), `.indexOn: ["createdAt"]`. Also
  `dashboardRequestsIntake` (Phase 2 thread state): `.read`/`.write` false (admin-only).
- **Verify:** `npm run build` clean; dev server renders the board; manual create + drag persists via
  the endpoint.

### Phase 2 — Slack intake → ticket (code autonomous; activation needs Jeremy's setup)
- **New endpoint** `api/slack-request-listener.js`, cloned from `slack-schedule-listener.js`:
  signature-verified (`SLACK_REQUEST_SIGNING_SECRET`), scoped to channel
  `SLACK_REQUEST_CHANNEL_ID`, posts with `SLACK_REQUEST_BOT_TOKEN`. **Inert until those env vars
  exist** (returns 500/no-op without the signing secret, same as the scheduling listener) — so
  shipping the code changes nothing in prod until Jeremy configures it.
- **Clarifying loop:** on a new top-level message, Claude (cheap model, **`claude-haiku-4-6`**
  default — Codex R1-F3: `claude-haiku-4-5` is invented and 404s; `-4-6` is the id in
  `social-organic.js:498`) decides whether the report is actionable or needs clarification, and
  drafts 1–3 targeted questions; the bot threads them. Thread state (collected Q&A, screenshot
  permalinks) is kept under `/dashboardRequestsIntake/{rootTs}` (admin-written). When Claude judges
  "enough info," it writes a ticket into `/dashboardRequests` at `triage` and confirms in-thread.
  - **Bound the LLM:** Claude only *interprets* (actionable? what to ask? title/summary). The
    backend owns ticket creation, dedup, and the max-questions cap (hard stop at N=3 rounds → create
    ticket with whatever's gathered, flagged "needs detail").
  - **Concurrency (Codex R1-F6):** the scheduler is stateless per message and only dedups by
    `event_id`; the intake loop *accumulates* multi-round state, so two distinct user replies are
    distinct events that bypass `event_id` dedup. Every intake mutation (Q&A append, the
    question-count increment, and the **`ticketCreated` guard**) MUST use
    `runRtdbTransaction`/`mutateRecord` (`_fb-admin.js`), or the cap and double-create guard are
    both racy. The "already created a ticket?" check is a transaction on a flag, never read-then-write.
  - **Screenshots (Codex R1-F7):** a browser cannot fetch a private `files.slack.com` URL with the
    bot token (and must not — that leaks the token to the client), and the scheduler deliberately
    drops `subtype`-bearing / `file_shared` events (`slack-schedule-listener.js:101`) — i.e. the
    very events that carry files — so there is **no existing pattern to reuse**. Phase 2 therefore
    stores the file **`permalink`** (resolved via `files.info`) and renders it as a *link that opens
    in Slack*, not an inline `<img>`. Inline preview (a founder-auth'd server image-proxy endpoint)
    is an explicit later nicety, out of scope here.
- **Event dedup + ack-fast:** reuse the scheduler's `event_id` dedup TTL and immediate-200 +
  `waitUntil` pattern, but **handle file/subtype events** the scheduler filters out (needed for
  screenshot capture).
- **Inert-on-deploy (Codex R1-F5):** the endpoint returns a clean **200 no-op** when its env vars
  are unset (not a 500 — repeated 500s make Slack disable the subscription). The merge is safe
  because no Events URL points at it until Jeremy wires it **last**, after the env vars exist.

### Phase 3 — Handoff to cloud Claude Code (code autonomous; trigger wiring needs Jeremy)
- When a ticket moves to **Ready** (drag in UI, or bot), open a GitHub issue formatted as a build
  brief (title, body, clarifications, screenshot links, acceptance criteria) and stamp
  `github.issueNumber/issueUrl` back on the ticket; move it to **Building**.
- The GitHub→Claude Code trigger (issue → cloud session on the Max plan) is configured on Jeremy's
  side (likely the same mechanism that launched this session). Claude Code drafts a plan, asks
  Jeremy strategy questions, opens a PR referencing the issue.

### Phase 4 — Close the loop (code autonomous; depends on Phase 2 bot scopes)
- PR merged (issue closed / `prUrl` set + merged) → ticket → **Done**, and `slackAddReaction` puts
  ✅ on the original Slack message (`slack.channelId` + `slack.messageTs`). Reuses the helper the
  scheduler already calls.

## What only Jeremy can do (the end-of-run check-off batch)
1. **Slack app:** create/extend the app for `#dashboard-feature-requests`; scopes
   `channels:history`, `chat:write`, `reactions:write`, `files:read`; subscribe `message.channels`
   + `file_shared`; point the Events URL at `/api/slack-request-listener`. Invite the bot to the
   channel.
2. **Vercel env vars:** `SLACK_REQUEST_SIGNING_SECRET`, `SLACK_REQUEST_BOT_TOKEN`,
   `SLACK_REQUEST_CHANNEL_ID` (+ optional `SLACK_REQUEST_MODEL`). Register
   `api/slack-request-listener.js` in `vercel.json`.
3. **GitHub→Claude Code trigger** for the Ready→issue handoff (Phase 3).
4. **Deploy RTDB rules** (`firebase deploy --only database`) after reviewing the Phase 1 PR.
5. **Run the real Codex adversarial loop** on the plan + the built code on the Mac.
6. Ongoing by design: answer strategy questions, click merge.

## Hard constraints
- Reuse existing patterns; no new Slack/Firebase/Claude plumbing invented.
- Bot writes via Admin SDK only; client (dashboard) writes governed by new create-only/field-checked
  rules. No write path that lets a non-founder/manager mutate tickets.
- Phase 2 endpoint must be a no-op without its env vars (no prod behaviour change on merge).
- Intake LLM is cost-bounded: cheap model, ≤3 clarifying rounds, hard backend cap, dedup so Slack
  retries never double-ask or double-create.
- Founders-tab gating (`role === 'founders'`) already restricts who sees the board; don't loosen it.

## Out of scope (this round)
- Editing/closing tickets *from* Slack (board is the source of truth for status; Slack is intake +
  the ✅ at the end).
- Re-hosting screenshots off Slack; SLA/notifications/aging automation; multi-channel intake.
- Auto-merging PRs (Jeremy always merges).

## Adversarial review trail
**Round 1 (plan) — Claude red-team stand-in, this session. Verdict: REWORK → resolved.**
- R1-F1/F2 [CRITICAL]: RTDB rule for drag-to-status was unsound (merged-node validation lets a
  client forge unpinned fields). **Resolved:** client is read-only; all mutations via authenticated
  Admin-SDK endpoints (`api/dashboard-requests.js`) that own the state machine.
- R1-F3 [CRITICAL]: `claude-haiku-4-5` invented. **Resolved:** `claude-haiku-4-6`.
- R1-F4 [MAJOR]: founders/manager contradiction (managers can't see the Founders tab).
  **Resolved:** founders-only read + tab gate.
- R1-F5 [MAJOR]: "inert" was actually a 500. **Resolved:** clean 200 no-op when unconfigured;
  Events URL wired last.
- R1-F6 [MAJOR]: intake concurrency. **Resolved:** transactional Q&A append + `ticketCreated` guard.
- R1-F7 [MAJOR]: browser can't render private Slack file URLs. **Resolved:** store/render the Slack
  permalink; inline image-proxy deferred.
- R1-F8 [MINOR]: `createdAt` type drift. **Resolved:** numeric `Date.now()` everywhere.
- Confirmed sound (no change): `slackAddReaction` signature, `thread_ts` posting, `waitUntil` +
  `event_id` dedup, `adminGet/Set/Patch` rule-bypass, `@dnd-kit` deps, sub-tab wire-up location.

**Round 2 (Phase 1 built code) — Claude red-team stand-in, this session. Verdict: REWORK → CONVERGED.**
- R2-F1 [CRITICAL]: `Card` spread `{...listeners}` + bare `onClick` opened the drawer on every
  drag-drop. **Resolved:** `wasDragging` ref + 200ms swallow window, ported from `TeamBoard.jsx`.
- R2-F2 [MAJOR]: raw `fbListen` blanks the board on token refresh. **Resolved:** `fbListenSafe`.
- R2-F3 [MAJOR]: drawer selects flickered. **Resolved:** `pending` optimistic overlay merged as
  `view`, cleared on RTDB echo (with priority null/"" normalization).
- R2-F4 [MINOR/MAJOR]: `id` path-injection into the RTDB path. **Resolved:** `validId()`
  (`/^[A-Za-z0-9_-]{1,120}$/`) on update + delete.
- R2-F7/F8 (cheap robustness): override-clear narrowed to confirm-or-delete; `DragOverlay` renders a
  hookless `CardBody` (no duplicate `useDraggable` id).
- Convergence pass: all four blocking findings verified resolved, no regressions → **APPROVE**.

**Round 3 (Phases 2–4 built code) — Claude red-team stand-in, this session. Verdict: REWORK → CONVERGED.**
- R3-F1 [CRITICAL]: concurrent thread replies silently dropped an answer. **Resolved:** unprompted
  replies captured as `{q:null}` notes (rendered as "They added: …" / "Additional detail").
- R3-F2 [CRITICAL]: Phase 3 duplicate-GitHub-issue race (failed stamp re-fired creation).
  **Resolved:** transactional `pending` claim; claim released only when no issue was created, so an
  issue can never be created twice. Stamp-failure best-effort records the issue identity.
- R3-F4 [MAJOR]: thread stranded at the question cap on an LLM error. **Resolved:** minimal-ticket
  fallback at the cap.
- R3-F6 [MAJOR]: a new request inside an already-filed thread was swallowed. **Resolved:** one-time
  hint via a raw abort-if-set transaction (posts exactly once).
- R3-F7 [MAJOR]: a manual "not planned" issue close falsely said "shipped". **Resolved:** gate
  issue-close completion on `state_reason === "completed"`; PR-merge path independent.
- R3-F9 [MINOR]: GitHub `@mention`/`#ref` injection from Slack text. **Resolved:** `ghSafe()` (U+200B)
  on all user-controlled fields; permalinks left raw.
- Security posture confirmed sound: verify-before-ack, constant-time signatures, inert paths do no
  work. Convergence pass: all six resolved, no regressions → **APPROVE**.
- Coverage: `api/__tests__/dashboard-requests.test.mjs` (validId / buildTicket invariants /
  referencedIssues), `node --test` green.

**Status: Phases 1–4 built.** Remaining is Jeremy-only setup (Slack app + scopes, Vercel env vars,
GitHub PAT + webhook + Events URL wired last, deploy RTDB rules) and the **real Codex loop** on the
Mac against this plan + the full diff.

## Environment variables (Jeremy's one-time setup)
All new endpoints are **inert** (clean 200 no-op) until their secrets exist, so deploying the code
changes nothing in prod until these are set and the Slack Events / GitHub webhook URLs are wired
**last**.

| Var | Phase | Notes |
|-----|-------|-------|
| `SLACK_REQUEST_SIGNING_SECRET` | 2 | Slack app signing secret (Events API) |
| `SLACK_REQUEST_BOT_TOKEN` | 2 + 4 | `xoxb-…`; scopes `channels:history`, `chat:write`, `reactions:write`, `files:read`. Also used for the ✅ reaction in Phase 4 |
| `SLACK_REQUEST_CHANNEL_ID` | 2 | the `#dashboard-feature-requests` channel id; invite the bot to it |
| `SLACK_REQUEST_ALLOWED_USER_IDS` | 2 | optional comma-list to fence intake to the team |
| `SLACK_REQUEST_MODEL` | 2 | optional; default `claude-haiku-4-6` |
| `ANTHROPIC_API_KEY` | 2 | already configured in the project |
| `GITHUB_REQUESTS_TOKEN` | 3 | PAT with issues:write on the target repo |
| `GITHUB_REQUESTS_REPO` | 3 | `owner/name` |
| `GITHUB_REQUESTS_WEBHOOK_SECRET` | 4 | shared secret for the GitHub webhook (issues + pull_request events) |

Endpoints: Slack Events URL → `/api/slack-request-listener`; GitHub webhook → `/api/github-request-webhook`
(subscribe to `issues` + `pull_request`). Both registered in `vercel.json`. Deploy RTDB rules with
`firebase deploy --only database` after merging.
