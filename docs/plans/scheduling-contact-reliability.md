# Scheduling contact reliability

Stop the recurring `skipped_missing` Slack nags by (1) moving them to where the
team acts and making each one say *why* it fired, (2) pushing a proactive list
of projects that will trigger the contact-missing case, and (3) closing the gaps
that let projects get created without a client contact in the first place.

Three independent pieces. Decisions locked with Jeremy 2026-06-07.
Revised after Codex adversarial review round 1 (triage notes inline).

---

## Background — why projects arrive un-emailable

The `daily-09` scheduling cron skips a client email and increments
`counters.skipped_missing` when [`resolveProjectEmailRecipients`](../../api/_email/getProjectContext.js)
returns no `to`. Email resolves from `accounts/{accountId}.clientContact.email`
first, then falls back to `project.clientContact.email`. No valid email on
either → skip → the `:warning: … did not go to plan — skipped_missing=N` post.

**`skipped_missing` is NOT contact-only** (Codex F2). In `daily-09` Pass 1 it
also increments for a bad shoot status ([line 181](../../api/cron/daily-09.js):
status not in `SHOOT_OK_STATUS`) and a missing subtask id ([line 194](../../api/cron/daily-09.js)).
The missing-email case is [line 190](../../api/cron/daily-09.js) (Pass 1) and
[line 336](../../api/cron/daily-09.js) (Pass 3). This matters for Piece 2 (the
digest can't claim to explain every nag unless we either split the counter or
make each nag self-describing — we do the former).

Root cause of the missing contact: the deal-won webhook
([`api/webhook-deal-won.js:142-143`](../../api/webhook-deal-won.js)) reads
`firstName` / `clientEmail` straight off the Zapier payload, but those fields
live on the **linked person record in Attio, not the deal record**. Zapier
isn't fetching the person, so they arrive blank and the project is created
un-emailable. The webhook does not self-heal.

The only repair today is the nightly [`sync-attio-cache.js`](../../api/sync-attio-cache.js)
cron (19:00 UTC = 5:00am AEST, before daily-09's 8/9am AEST runs). It has these
holes that leave projects permanently broken:

- Only fetches a person when the deal has **exactly one** associated person
  ([`extractDealPersonId`](../../shared/attio-extract.js) returns `null` for 0 or >1).
- Capped at **50 people/run** (`MAX_PEOPLE_FETCH_PER_RUN`).
- Only fires on a **confident deal match**. Matching is foreign-key first:
  projects carry their won deal's Attio **record id** in `project.attioCompanyId`
  (Zapier mislabels the deal id as `companyId`; `attioDealId` is null today), and
  [`matchDealEntry`](../../shared/attio-extract.js) keys on `attioDealId ||
  attioCompanyId` against `byRecordId`, falling back to name matching. So a
  project with a working FK matches reliably; only projects whose FK misses the
  cache AND whose name is ambiguous fall through unmatched. **(Codex F5 — earlier
  draft wrongly said matching was name-only; corrected. We do NOT touch the
  matcher.)**

---

## Piece 1 — Route the scheduling cron summaries to #scheduling

**Decision:** move only the `daily-09` Pass 1 (ShootTomorrow) and Pass 3
(InEditSuite) summary posts. Hard pass-crash alerts (`postCronPassError`) and
every other prod-mgmt alert stay where they are.

**Changes:**
- [`api/_email/send.js`](../../api/_email/send.js): add an optional channel-id
  param.
  - `postProdAlert(text, channelId = PROD_MGMT_CHANNEL_ID)`
  - `postCronSummary(label, counters, channelId)` → forwards `channelId` to
    `postProdAlert`. Default unchanged, so existing callers are unaffected.
- [`api/cron/daily-09.js`](../../api/cron/daily-09.js): the two
  `postCronSummary(...)` calls (Pass 1 ~line 461, Pass 3 ~line 491) pass the
  scheduling channel id as the third arg. Leave `postCronPassError` calls
  untouched (still prod-mgmt).
- **Channel id (Jeremy 2026-06-07): `C0B2JG54GJX`** (the #scheduling channel).
  Use the codebase's established pattern — a hardcoded default with an env
  override, mirroring `PROD_MGMT_CHANNEL_ID` at [send.js:56](../../api/_email/send.js):
  `const SCHEDULING_CHANNEL_ID = process.env.SLACK_SCHEDULING_CHANNEL_ID || "C0B2JG54GJX";`
  This works on deploy with zero new Vercel config and is decoupled from
  `SLACK_SCHEDULE_CHANNEL_ID` (no dependency on whether the brain channel and
  #scheduling are the same record).

**Verify before build (Codex F10):** `grep -rn "postCronSummary" api/` finds
**three** callers — daily-09 Pass 1, daily-09 Pass 3, and
[`zernio-webhook.js:347`](../../api/zernio-webhook.js). Confirm the zernio caller
does **not** pass a third arg so it stays on the default prod-mgmt channel. Only
the two daily-09 calls move.

**Verify before build (Codex F9):** confirm the Slack bot (`SLACK_SCHEDULE_BOT_TOKEN`)
is a member of `C0B2JG54GJX` — `postProdAlert` uses `chat.postMessage` and fails
soft on a non-member, which would silently drop the nag. If the scheduling bot
already posts the daily digest into this exact channel it's already a member;
otherwise `/invite` the Viewix Dashboard app once. First real run will confirm
(or log the warning).

---

## Piece 1b — Make each nag say *why* it skipped (Codex F2)

So that no `skipped_missing` post is ever a mystery (and to honour Piece 2's
"the list explains the nags" promise), split the single counter into its real
causes and name them in the summary line.

**Changes:**
- [`api/_email/send.js`](../../api/_email/send.js) `newCounters()`: replace
  `skipped_missing` with `skipped_no_email`, `skipped_bad_status`,
  `skipped_no_subtask_id` (keep a derived total for back-compat in the summary if
  needed).
- [`api/cron/daily-09.js`](../../api/cron/daily-09.js): increment the specific
  counter at each site — line 181 → `skipped_bad_status`, line 190/336 →
  `skipped_no_email`, line 194 → `skipped_no_subtask_id`.
- `postCronSummary`: the "didn't go to plan" trigger is `failed > 0 || any
  skipped_* > 0`; the message lists each non-zero cause with a plain-English
  tail (e.g. "no client email — fix the project record" / "shoot status not
  schedulable" / "shoot has no subtask id").

The digest (Piece 2) proactively lists the `skipped_no_email` class. The other
two are operational anomalies (a producer put a shoot on hold, or a malformed
subtask) — the self-describing nag is the fix for those; they don't need a
proactive list.

---

## Piece 2 — Proactive "missing client contact" list in the daily digest

**Decision:** Slack digest only, no UI. Fold into the existing 8:50am
[`scheduling-daily-digest.js`](../../api/scheduling-daily-digest.js) as a new
additive section (same pattern as the Custom-sales block — renders only when
non-empty, doesn't gate on flags).

**Predicate (Codex F4 — mirror the cron's send gate, not a loose "future
shoot"). A project appears when it has at least one subtask matching:**

- **Shoot path:** `stage === "shoot"` AND `startDate >= today` AND
  `status ∈ SHOOT_OK_STATUS` AND `st.id` present — i.e. a shoot that *will*
  trigger a ShootTomorrow send, not an archived/done/onHold one, **AND**
- the project's email is unresolvable:
  [`resolveProjectEmailRecipients`](../../api/_email/getProjectContext.js)
  returns no `to`.

(In-progress edits — Pass 3 — are date-agnostic, so include any subtask with an
edit stage in `inProgress` whose project has no resolvable email.)

**firstName (Codex F8):** a blank first name does **not** block the send
(daily-09 falls back to "there"). So list it, but as a *cosmetic* row, visually
separated from the *blocking* no-email rows. Section title: **"Client contact
gaps"** with two groups — ":no_entry: No email (send blocked)" and
":warning: First name missing (sends as 'there')".

**Changes:**
- Import `resolveProjectEmailRecipients` into the digest (single source of truth
  — no re-implemented email logic).
- Add `adminGet("/accounts")` to the digest's parallel read (needed for
  canonical email resolution).
- New helper `collectContactGaps(projects, accounts, today)` → `{ blocked: [],
  firstNameOnly: [] }` rows of `{ clientName, firstName, email, projectName,
  shortId, reason }` where `reason` is read from the sync's diagnostic stamp
  (see Piece 3) so the digest can say *why* a blocked project isn't auto-fixing
  (e.g. "no contact in Attio", "multiple contacts — pick one", "ambiguous deal
  match").
- New `buildContactGapsBlock(gaps)` → cap each group ~10 with `+N more`. Render
  only when non-empty. Insert in both the all-clear and flagged paths of
  `buildDigestBlocks`.

---

## Piece 3 — Harden the nightly Attio backfill

**Decision:** fix the connection in the nightly cron only. No webhook change.

**Changes to [`sync-attio-cache.js`](../../api/sync-attio-cache.js) +
[`attio-extract.js`](../../shared/attio-extract.js):**

1. **Multi-person deals — do NOT auto-pick (Codex F1, was the original plan's
   idea; rejected).** No source field exposes a primary-contact signal or a
   reliable ordering for `associated_people`, so "first with an email" can email
   a finance/assistant contact about a shoot. Instead: detect a deal with >1
   associated person and a blank project contact, and **stamp the project** so
   Piece 2 surfaces it for a human to set. Never write a guessed contact.

2. **Zero-person deals.** Nothing to fetch — leave blank, stamp "no contact in
   Attio", surface in the digest.

3. **Validate the email before writing (Codex F6).** `extractPersonEmail`
   returns the first email cell without an `@`-check. Apply the same `EMAIL_LIGHT`
   (`@` + length) guard `resolveProjectEmailRecipients` uses before patching
   Firebase, so a malformed Attio email never lands as the client address.

4. **Bound each fetch (Codex F7).** Add a per-request `AbortController` timeout
   (e.g. 8s) so one stalled Attio person request can't burn the 300s run budget
   and silently skip the rest of the sync. Count timeouts/failures for the run
   log. **Not doing** full 429 backoff/retry — premature at Viewix's deal volume
   (dozens, not thousands).

5. **Raise the cap modestly.** `MAX_PEOPLE_FETCH_PER_RUN` 50 → **100** (not 150).
   With multi-person deals no longer fetched, the per-night single-person backlog
   is tiny; 100 + bounded fetches is ample and converges any historical backlog
   over a couple of nights.

6. **Diagnostic stamp.** When a project's contact stays blank after the backfill
   attempt, write a small additive marker (e.g.
   `project.contactBackfill = { status: "ok" | "blocked_zero" | "blocked_multi"
   | "blocked_ambiguous", checkedAt }`) so the digest can show the reason without
   re-running the matcher. Additive-only, leaf-patched.

7. **Name collisions stay no-guess.** Don't touch the matcher — ambiguous
   projects keep their contact blank, get stamped `blocked_ambiguous`, and show
   in the digest.

Preserve all existing safety: additive-only, leaf-patch the still-blank child
field, re-read the leaf right before writing so a producer edit is never
clobbered, per-id isolation so one bad fetch skips only that person.

---

## Accepted residual risks

- **Same-day-won, next-day shoot.** A deal won *after* the 5:00am AEST sync with
  a shoot the next day can still miss its day-before email — only the (declined)
  webhook inline-fetch option would have closed that window. The daily-09
  same-day fallback (posts to #scheduling when a shoot is booked too late for the
  day-before email) softens it — **but** that fallback only fires when the shoot
  has a subtask id (Codex F11); a missing-id shoot gets neither the day-before
  email nor the same-day fallback, only the Piece 1b nag. Acceptable; revisit if
  it bites.
- **Weekend blind preview (Codex F3) — DECIDED: accept it (Jeremy, 2026-06-07).**
  The contact list stays weekday-only; Piece 1b makes any weekend
  `skipped_no_email` nag self-explanatory, so a Saturday-won/Sunday-shoot project
  still gets an actionable Sunday nag, just no proactive preview. Weekend shoots
  are the rare case — not worth decoupling the contact check from the weekday
  digest gate.

---

## Codex round-1 triage summary

Adopted: F1 (no auto-pick), F2 (split counter), F4 (tighten predicate), F5 (fix
Background facts), F6 (validate email), F7 (AbortController; **pushed back** on
429 backoff), F8 (firstName cosmetic), F9 (confirm bot membership), F10 (3
callers), F11 (residual note). Surfaced as a fork: F3 (weekend coverage).
Verdict was BUILDABLE_AFTER_FIXES; all must-fix items (F1, F2, F3, F5) are
resolved — F3 decided as "accept, weekday-only" (Jeremy, 2026-06-07).

---

## Build order

1. Piece 1 + 1b (smallest, isolated; routing + self-describing nags).
2. Piece 3 (data fix at the source + diagnostic stamp).
3. Piece 2 (the digest that reports what's left, reading the stamp).
Each ships independently.
