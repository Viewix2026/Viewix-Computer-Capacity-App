# Plan — Dashboard Requests: one-question-at-a-time + interactive buttons

Feature slug: `dashboard-requests-interactive-questions`. Branch:
`claude/dashboard-requests-interactive-questions`. Builds on the merged #314 pipeline.

> QA gate: hardened by a Claude red-team adversarial loop in-session (stand-in). The real Codex loop
> (Jeremy's Mac) runs before merge, as with #314.

## Outcome
The intake bot asks clarifying questions **one at a time** instead of one bundled message, and for
questions whose answer is a clear set of choices (which tab? how often? severity?) it shows
**pressable buttons**. Open-ended questions still take a typed reply. Buttons and typed answers feed
the exact same transactional intake state, so nothing about the create-once / cap / crash-safety
guarantees from #314 changes.

## Design
- **Shared core (`api/_dashboard-intake.js`):** move the state machine out of the events listener so
  the new interactivity endpoint reuses it verbatim — `threadPath`, `RX`, `MAX_QUESTION_ROUNDS`,
  `ensureIntakeState`, `recordReply` (fill last pending answer / keep as note), `triage`,
  `createTicketFromState`, `renderQuestion`, the Claude call + tools. No behaviour change to the
  copied logic; just relocation + the two additions below.
- **One question per turn:** the `ask_clarification` tool + system prompt now ask for exactly ONE
  question per turn (no bundled bullets). `MAX_QUESTION_ROUNDS` 3 → **5** (one-at-a-time needs a few
  more rounds; still a hard cap with the same forceSubmit fallback).
- **Optional buttons:** `ask_clarification` gains an optional `options: string[]` (2–6 short
  choices). When present, the round is stored as `{ q, a:null, options }` and rendered as a Block Kit
  `actions` block of buttons; when absent it's a plain-text question (today's behaviour). A context
  line invites a typed reply either way.
- **Button clicks (`api/slack-request-interactivity.js`):** new endpoint, mirrors
  `slack-interactivity.js` (bodyParser:false, signature-verified, immediate-200 + waitUntil, payload
  is URL-encoded `payload=` JSON). On a `dr_ans_*` action it resolves the chosen option **from the
  stored round** (index in the button value — never trusts client-sent label), records it via the
  same `recordReply`, disables the buttons on the original message (`chat.update`), and re-runs
  `triage`. Inert 200 until `SLACK_REQUEST_SIGNING_SECRET` exists.
- **Bonus:** convert `**bold**` → Slack `*bold*` in posted questions (fixes the literal-asterisks
  cosmetic seen in testing).

## Trust / safety (unchanged invariants)
- Buttons carry only `rootTs::index`; the answer text is read from the server-side stored `options`,
  so a forged payload can't inject arbitrary answers.
- `recordReply` is transactional; double-click or click+type can't lose or double-fill (a second
  answer with no pending slot becomes a note, exactly as #314).
- Interactivity endpoint signature-verified with the same signing secret; inert no-op until set.

## Jeremy's one-time setup (after merge)
- Slack app → **Interactivity & Shortcuts** → enable → Request URL
  `https://<prod>/api/slack-request-interactivity` → Save → reinstall if prompted.
- No new env vars (reuses `SLACK_REQUEST_*`).

## Out of scope
- Buttons for the final ticket type/priority (board owns those).
- Editing a submitted answer after the buttons are disabled (just type a correction in-thread).
