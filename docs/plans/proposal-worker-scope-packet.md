# Scope Packet — Enterprise Proposal: Claude-powered Mac mini worker

Feature slug: `proposal-worker`. Conductor: make-a-feature. Parent plan:
`docs/plans/enterprise-proposal-generator.md`. Dashboard page shipped in PR #276; renderer engine
committed in PR #280.

## Outcome
A queued job from the dashboard's Proposals tab becomes a finished proposal PDF with no terminal
work: the Mac mini worker drafts the brief from Attio + the proposal-call transcript via Claude,
Jeremy reviews the draft and confirms tier prices **in the dashboard**, and on approval the worker
renders + uploads the PDF and the row flips to Ready with a download link. One build collapses the
former "worker" + "auto-fill" phases and closes the price-confirmation hole.

## Out of scope (this round)
- Slack *trigger* to create proposals (notify-on-ready/error pings are in; creation stays in the dashboard).
- Editing the deck design / template.
- Auto-send to the client (Jeremy always sends manually).
- Multi-worker scaling (one mini, one worker; claim logic is still transactional for reboot safety).

## Done looks like
- `workers/proposal-renderer/worker.mjs` runs on the mini under launchd: claims a queued job
  (transactional), drafts a cited brief via Claude, writes it back as `draftBrief` + status `review`.
- Dashboard Proposals tab: a `review` row expands to show the draft (brief copy, concepts + named
  references, tier structure) with editable fields and **required tier-price inputs**; Approve flips
  it to `approved`; worker renders via the committed `generate.mjs`, uploads the PDF to Firebase
  Storage, writes `pdfUrl` + `ready`.
- Status chain live end-to-end: queued → drafting → review → approved → generating → ready | error,
  with Retry on error.
- RTDB rules updated for the new transitions (review→approved edits, error→queued retry,
  founders-only delete) and deployed.
- Verified: a dry-run mode locally (fixture job + real transcript, live Claude call, local render,
  no upload), then one supervised end-to-end run on prod RTDB with Jeremy's go.

## Hard constraints
- Reuse the repo's own patterns (exploration-confirmed):
  - `api/_fb-admin.js` — `getAdmin()`, `adminGet/Set/Patch`, `runRtdbTransaction`,
    `getStorageBucket()` (bucket `viewix-capacity-tracker.firebasestorage.app` already wired).
  - `workers/social-asset-transfer/worker.js` — the existing worker convention (atomic claim,
    status writeback, `WORKER_ID`, Slack ping on failure). New worker lives in `workers/`.
  - Claude call pattern from `api/founders-advisor.js` (fetch-based, `ANTHROPIC_API_KEY`,
    prompt caching via `cache_control`). Default model `claude-sonnet-4-6`, env-overridable.
  - Transcript source `/meetingFeedback`: `{ transcript, clientName, meetingType
    (discovery|blueprint|nurture), salesperson, recordingUrl }` — search by `clientName`,
    prefer blueprint/discovery, newest first.
  - Attio via `ATTIO_API_KEY` + `shared/attio-extract.js` extractors (identity only, per the
    locked plan).
- Brief rules are the locked ones from the parent plan: client facts carry
  `sourceType (transcript|founder_confirmed) + sourceSnippet + confidence`; generative fields
  flagged draft; **dollar amounts never invented** — prices enter via the dashboard review panel;
  thin/no transcript → draft what's known and flag missing required fields (manual-mode prompts in
  the review panel), never a hollow confident brief.
- `lookVariant` comes from the job (the dashboard form already collects it) — the worker does not
  choose the look.
- The worker renders with the **committed** renderer (`skills/viewix-enterprise-proposal/`), child-
  process invocation of `generate.mjs`; its preflight stays the last gate before render.
- Mini makes outbound connections only (Firebase, Attio, Anthropic). No inbound, no tunnel.
- All keys already exist in `.env.local` (`FIREBASE_SERVICE_ACCOUNT`, `ATTIO_API_KEY`,
  `ANTHROPIC_API_KEY`); the mini gets its own `.env` copy. Prod-RTDB testing needs Jeremy's
  explicit go (standing rule).

## Resolved decisions
- One Claude-powered worker (collapses worker + auto-fill) — Jeremy, this session.
- Review/price-confirmation happens in the dashboard review panel (closes the price hole).
- PDF delivery: **Firebase Storage + permanent tokened download URL** (recommended default —
  confirm at Gate 1; alternative is Drive, which adds Drive creds to the mini for little gain).
- Slack ping on ready/error via existing `SLACK_WEBHOOK_URL` (cheap, useful; not a trigger).

## Open decisions (Gate 1)
- PDF storage: Firebase Storage tokened URL (recommended) vs Google Drive.

## Plan (rev 2 — Codex round 1 folded in)

**Schema contract (Codex F1, Critical):** the canonical brief schema is the **renderer's existing
flat schema** (`client.name`, `project.name/titleHtml`, `proposal.date`, `cover.promise`,
`brief.para1/para2`, `brief.success[0..2].{title,desc}`, `approach.intro`, `concepts[]`
`{lbl,title,channel,desc,ref}`, `tier.{1,2,3}.{name,price,bestFor}`, `nextSteps.tagline`,
`lookVariant`) — proven by `generate.mjs` + `fill.js` and the two committed example briefs. Claude
emits exactly this, plus a **`_meta` envelope** the renderer ignores: per-field provenance
(`sourceType: transcript|inferred`, `sourceSnippet`, `confidence`), `transcript`
(`{id, clientName, meetingType, createdAt, recordingUrl}` or `null`), `missingFields[]`, and
`flags[]` (URLs/emails/instruction-like text found in client-facing fields → shown in review). A
schema-validation test runs against the committed example briefs **before any Claude work starts**.

1. **Data seeds** (renderer skill dir): `portfolio-references.json` (~15 curated enterprise-relevant
   references) + `proof-claims.json` (approved stats with context). Claude's prompt selects concept
   `ref`s only from the index.
2. **Worker** `workers/proposal-renderer/`:
   - `worker.mjs` — `child_added` + `child_changed` listener on `/proposalJobs`; **serialized**
     processing (one job at a time, no concurrency).
   - **Claims (Codex F2):** transactional claim (queued→drafting, approved→generating) stamps
     `workerId`, `claimToken` (fresh per attempt), `claimedAt`, `heartbeat`. Heartbeat ticks
     **during** the Claude call and the Chrome render. Terminal writes (`review`/`ready`/`error`)
     are transactions that verify `status+workerId+claimToken` still match — a superseded attempt
     aborts silently. Boot/periodic recovery requeues only stale-token claims with no newer
     terminal state.
   - **Stage A (draft):** Attio identity via a **proposal-specific helper** that finds a deal by
     `record_id` in `/attioCache` regardless of stage (the existing `buildDealIndex` is Won-only —
     Codex F10), API fallback on cache miss. **Transcript (Codex F3):** normalised match
     (case/punctuation/legal-suffix-insensitive) of `/meetingFeedback.clientName` vs the job's
     `companyName`; prefer blueprint/discovery, newest first. 0 matches → `review` with
     `transcript:null` + manual-mode prompts; >1 plausible → `review` with `candidates[]` listed for
     selection; exactly 1 → used, with full provenance in `_meta.transcript` **always shown in the
     review panel**. **Claude call (Codex F4):** forced tool-use with an input schema matching the
     contract (structured output, not freeform JSON); transcript passed as quoted data; validator
     checks required fields, tier/concept counts, length budgets, and flags URLs/emails/
     instruction-phrases in client-facing fields; one retry on schema failure, then `error`.
     Model `claude-sonnet-4-6`, env-overridable. Prices emitted as `"$00,000"` always.
   - **Stage B (render):** on `approved`, re-validate prices parse as money (worker-side — Codex
     F5), write the brief to a **per-job temp file** (`.render.${jobId}.${pid}.html` — Codex F11,
     small `generate.mjs` change), run `node generate.mjs`, upload to Storage at
     `proposals/{jobId}/{Company}-Proposal.pdf` with a **firebaseStorageDownloadTokens URL**; write
     `pdfUrl` + `storagePath` (token rotation possible later — Codex F9) + `ready`.
   - Errors → `error` + message + Slack ping (`SLACK_WEBHOOK_URL`); `ready` also pings.
   - `--once --dry` mode: fixture job + real transcript, live Claude, local render, no upload.
   - **Ops (Codex F8):** a real LaunchAgent plist committed with the worker — absolute Node + repo
     paths, `WorkingDirectory`, `EnvironmentVariables` from a `.env` loader, `StandardOutPath`/
     `StandardErrorPath` + rotation note, `KeepAlive`; README covers auto-login, `pmset -a sleep 0`,
     Chrome path override, and a smoke-test command.
3. **Dashboard** (`Proposals.jsx` + hook — Codex F7): new badges (drafting/review/approved). The
   review panel is a **dedicated component with local draft state + dirty tracking** so the live
   listener can't clobber in-progress edits; three price inputs gated by a money parser —
   **Approve disabled until all three parse** (Codex F5) — double-submit guard, awaitable write +
   error surface; shows `_meta` provenance (transcript used, low-confidence fields, flags,
   candidates when >1 transcript); Retry button on `error` (→`queued`, clears error fields).
4. **Rules** (Codex F6 — coarse, explicit transitions; nested validation stays in UI+worker):
   create-only-queued (as shipped); staff update only `review`→`approved` (may touch `draftBrief`,
   `status`; `pdfUrl`/`error`/`requestedBy`/`createdAt` must be unchanged); staff update only
   `error`→`queued`; delete founders-only. Deploy via `firebase deploy --only database`.
5. **Verify:** schema test vs example briefs; dry-run end-to-end locally; rules round-trip
   (allowed + forbidden transitions); then one supervised prod run (Jeremy's go) → real Ready row +
   downloadable PDF.

**Defense-in-depth for prices (Codex F5):** dashboard money-parser gate → worker re-validation →
`generate.mjs` preflight extended to reject blank/non-money tier prices (not just `$00,000`).

### Round-2 refinements (Codex round 2 — all adopted)
- **`_meta` strip (R2-1):** Stage B strips `_meta` (and any review-only keys) from the approved
  brief before invoking `generate.mjs` — the preflight scans the rendered DOM, so provenance
  text/snippets must never enter the render. `renderBrief = omit(approvedBrief, "_meta")`.
- **`errorPhase` retry routing (R2-2):** errors carry `errorPhase: "draft"|"render"`. Dashboard
  Retry routes by phase: draft-phase → `queued` (re-draft); render-phase → `approved` (re-render
  with the founder-confirmed brief — approved edits and prices are never discarded).
- **Approve = full-schema gate (R2-3):** the review panel's Approve requires the complete flat
  brief schema to validate (all required client-facing fields non-empty, counts, lengths), not just
  the three prices; the worker re-runs the same validator at the top of Stage B.
- **Candidate-selection resume (R2-4):** choosing a transcript candidate (or supplying one in
  manual mode) re-queues the job with `selectedTranscriptId`; Stage A uses it directly and skips
  matching. Rules additionally allow staff `review`→`queued`.
- **Rule semantics (R2-5):** immutable-field protection uses value equality
  (`newData.child('pdfUrl').val() == data.child('pdfUrl').val()`), never `hasChild` (which would
  block first approvals where the field is absent). Only `status`, `draftBrief`, and
  `selectedTranscriptId` may change on staff transitions.

### Round-3 refinements (rules-section closure — both adopted)
- **Full transition set in rules (R3-1/R3-2):** the staff `.write` on `$jobId` is a disjunction of
  six explicit branches, each keyed on `!data.exists()` (create) or `data.status → newData.status`
  pairs — never a broad "new status == queued" match:
  1. CREATE: `!data.exists()` ∧ status `queued` ∧ `requestedBy.uid == auth.uid` ∧ no pdfUrl/error.
  2. APPROVE: `review → approved` (status/draftBrief may change).
  3. RE-DRAFT / candidate select: `review → queued` (status/draftBrief/selectedTranscriptId).
  4. RETRY draft-phase: `error (errorPhase != 'render') → queued`, asserting
     `!newData.hasChild('error') && !newData.hasChild('errorPhase')` (fields cleared).
  5. RETRY render-phase: `error (errorPhase == 'render') → approved`, same clearing assertions.
  6. DELETE: founders-only (`data.exists() && !newData.exists()`).
  Immutable fields (`pdfUrl`, `requestedBy`, `createdAt`) use value-equality in branches 2-5.

### Codex review trail (plan)
- **Round 1:** 11 findings (1 Critical, 7 High, 3 Medium) — all adopted (schema contract frozen to
  the renderer's flat schema, claim tokens, transcript provenance + candidates, structured output +
  flag-don't-block sanitation, three-layer price gate, coarse rules, review-panel local state, real
  launchd ops, tokened Storage URL, any-stage Attio lookup, per-job temp files).
- **Round 2:** 10/11 CONFIRMED, 1 WEAK; 5 new (2 High, 2 Medium + 1 folded) — all adopted above.
- **Round 3 (final verification, requested by Jeremy):** 3 CONFIRMED, 2 WEAK; 2 new Highs, both
  localised to the rules section (missing `error→approved` transition; Retry field-clearing blocked
  by the mutable-field whitelist) — both adopted as the Round-3 refinements. Severity trend
  **11 → 5 → 2**, no structural findings — **converged**. Storage decision confirmed by Jeremy:
  Firebase Storage tokened link. Build green-lit ("then we'll build").

## Implementation deltas
- None material — built to plan. Minor: the dashboard review panel lives inside `Proposals.jsx` as a
  local `ReviewPanel` component (same-file cohesion) rather than a separate file; `fbUpdateAsync`
  added to `src/firebase.js` (awaitable patch, needed for rules-denial surfacing).

## Codex review trail (code)
- **Round 1:** 7 findings (1 High, 2 Medium, 4 Low) — all adopted: `finish()`/`sweep()` cold-cache
  snapshot guards, stale `selectedTranscriptId` now errors instead of silently drafting
  transcript-less, distinctive-name guard on containment matching, `lookVariant` sanitation,
  Re-draft clears `selectedTranscriptId`, README env examples fixed. Certified clean: claim tokens,
  listener echo handling, the full 6-branch rules walk, ReviewPanel state model, `_meta` hygiene.
- **Round 2:** all 7 CONFIRMED, **0 new defects** — verdict **SHIP** (7 → 0, converged). Probe
  answers: cold-cache drop path is ship-as-is (worst case one wasted Claude call, sweep recovers);
  matching guard excludes only containment for short single-token names (exact match still works);
  applied the top-level `LOOK_VARIANTS` import tidy.
- Verification: worker/schema/prompt parse; schema tests 5/5 (both example briefs pass strict mode,
  draft-with-real-price rejected, `_meta` strip); renderer regression renders; price-preflight
  refuses `$00,000`; dashboard `npm run build` green; rules JSON valid.
- **Live dry-run: PASSED** (fixture Transgrid transcript → Sonnet 4.6 → validated draft at
  `workers/proposal-renderer/out/dry-draft.json`). Caught + fixed two real bugs static review
  couldn't: the schema-retry message lacked the required `tool_result` block (API 400), and
  copy-length budgets were hard-fails where the renderer only warns (now soft-flag ≤15% over,
  hard-fail beyond). Draft quality verified: every client fact cited verbatim, prices held at
  `$00,000` despite a budget figure in the transcript, all concept refs from the index,
  `missingFields` actionable. **Still pending:** the supervised prod pass (part of mini setup).

## Built files
- `workers/proposal-renderer/`: `worker.mjs`, `brief-schema.mjs`, `prompt.mjs`, `fixtures/job.json`,
  `com.viewix.proposal-renderer.plist`, `README.md`, `.gitignore`
- `skills/viewix-enterprise-proposal/`: `data/portfolio-references.json`, `data/proof-claims.json`
  (new seeds). `generate.mjs` stays as committed on main — the `_meta` strip and price gate are
  enforced worker-side (`toRenderBrief` + `validateBrief(requirePrices:true)`), the renderer's
  existing DOM-level `$00,000` check backstops, and the worker serializes jobs (no temp-file overlap).
- `src/components/Proposals.jsx` (badges, ReviewPanel, retry routing), `src/firebase.js`
  (`fbUpdateAsync`), `firebase-rules.json` (6-branch `/proposalJobs` state machine)
