# Attio Won-deal → project carry-across: numberOfVideos + clientContact self-heal

**Status:** approved to build (2026-06-04). Threads 1 + 3 only. Thread 2 (edits
auto-creation) is sequenced after — see "Deferred" at the bottom.

Reviewed by Codex over 3 rounds; all adopted findings are baked into the spec
below. The guiding discipline (mirrors the `cd9055c` dealValue fix): **additive-
only, confident-match-or-nothing, never guess.**

---

## Problem
Two fields that should arrive from an Attio Won deal are unreliable on the
project record, and nothing ever corrects them:

1. **Number of Videos** — blank/wrong on the project detail page
   (`Projects.jsx:2771`) vs the deal's `number_of_videos`.
2. **Client firstName/email** — missing on some projects, so `daily-09.js` skips
   ShootTomorrow / InEditSuite client emails (`skipped_missing`).

Root theme: the deal-won webhook is the only writer, it depends on the Zapier
payload being complete, and there is no self-heal.

## Confirmed facts (verified against live Attio + code)
- Attio deals carry number attribute `number_of_videos` (id `43b6d087-…`),
  populated on most Won deals (Masterton 96, Meta Ads Deluxe 30, McRae 9); some
  are legitimately `0` (footage-only); some legacy deals omit it.
- The client email is NOT on the deal — it's on the linked **person**
  (`email_addresses[]` + `name`), reached via the deal's
  `associated_people[].target_record_id`.
- `/attioCache.data` (written by `sync-attio-cache.js`) holds every raw deal with
  full `values`, so `number_of_videos` and `associated_people` are already
  cached. People emails are NOT cached (people aren't fetched).
- `sync-attio-cache.js` step 5 already loops projects to backfill `clientName`,
  but its loop early-exits on `if (p.clientName) continue;` (`:202`) — so the new
  backfills must NOT live inside that loop.
- `buildDealIndex` (`attio-extract.js`) only indexes Won deals with `value > 0`
  (`:145`); `profitability.js` `attioClaimCounts` only counts claims when
  `m.value > 0` (`:279`).
- `resolveProjectEmailRecipients` (`getProjectContext.js:150`) prefers
  `account.clientContact.email`, falling back to `project.clientContact.email`.
  The webhook never sets `account.clientContact`, so the project value is what
  matters for webhook-created projects.

---

## Shared helper (used everywhere a video count is parsed)
`parseVideoCount(raw)` in a shared module:
- absent / `""` / non-numeric → `null`
- else → `Math.trunc(Number)` clamped to integer **0..500** (Masterton's 96 is
  the real-world max; 500 is a safety ceiling). Preserves an explicit `0`.

Use it consistently in: webhook `validatePayload`, all webhook write sites
(project, preprod metaAds, preprod social, confirmation email props), the
placeholder-video loop, and the cron backfill.

---

## Thread 1 — numberOfVideos

### 1a. Webhook hardening (`api/webhook-deal-won.js`)
- Read the field under all observed key shapes (the newer Attio fields already
  use bracket fallbacks because Zapier sends capitalised/spaced keys):
  `body.numberOfVideos ?? body["Number of Videos"] ?? body.number_of_videos`.
- **`validatePayload` must read the SAME fallback keys** before validating —
  otherwise a value under a new key bypasses validation and drives the
  placeholder loop (which has no cap today). Validate via `parseVideoCount`.
- Replace every `parseInt(numberOfVideos) || null` (4 write sites + the
  placeholder loop) with `parseVideoCount(...)`, preserving `0`. The placeholder
  loop is naturally capped by the 0..500 clamp.
- **Diagnostics (PII-safe):** log `Object.keys(req.body)` only — never the body —
  so the next real Won deal reveals the actual Zapier key. Remove once confirmed.

### 1b. Cron backfill (`api/sync-attio-cache.js` + `shared/attio-extract.js`)
- `extractNumberOfVideos(d)`: reads `d.values.number_of_videos[0].value`; returns
  a number incl. `0`, or `null` when the attribute is absent (distinguish 0 from
  missing).
- `buildDealIndex(attioCache, { includeZeroValue = false } = {})`: when
  `includeZeroValue`, index every Won deal that has a `recordId` regardless of
  `value`. Default `false` keeps profitability's current semantics byte-for-byte.
  Each index entry carries `value`, `numberOfVideos`, `personId`, `companyId`,
  `closeDate`, `recordId`.
- Backfill runs in a **NEW loop over all projects**, independent of the
  clientName early-exit. Build the index once with `includeZeroValue: true`.
- **Separate carry-across claim counter** (not profitability's value-gated one):
  count every confident `dealId` across all projects; a deal claimed by >1
  project is ambiguous for all claimants → no write. This is required because
  zero-value deals are now indexable.
- For each project whose `numberOfVideos` is null/undefined: resolve its deal
  (same confident name+company discipline as `resolveDealValue`; ambiguous/tie →
  skip), then **re-read the leaf** `/projects/{id}/numberOfVideos` immediately
  before writing and only patch if still blank (guards the cron-vs-manual-edit
  race). Leaf-write the value (incl. `0`).

---

## Thread 3 — client firstName/email

### Concrete extractors (`shared/attio-extract.js`, mirror `extractDealCompanyId`)
- `extractDealPersonId(d)`: returns the associated person's `target_record_id`
  **only when there is exactly one** associated person; `null` for zero or >1
  (never guess which contact).
- `extractPersonEmail(person)`: `person.values.email_addresses[0].email_address`
  (fall through `.value`); `null` if none.
- `extractPersonFirstName(person)`: from `person.values.name[0].first_name` if
  present, else `full_name.split(/\s+/)[0]`; mononym → whole name; `null` if none.

### Backfill (same NEW project loop as Thread 1)
1. Collect distinct `personId`s for projects whose `clientContact.email` is
   blank AND whose deal confidently matched (single-person deals only).
2. Fetch each **per-id**: `GET https://api.attio.com/v2/objects/people/records/{id}`,
   each in its own try/catch. **No batch endpoint.** Cap at **50 people fetches
   per run**; log how many remain so a large historical backlog converges over a
   few nights instead of timing out the cron. Optional small concurrency pool.
3. For each resolved person with a usable email: **leaf-patch only the blank
   child fields** — re-read `/projects/{id}/clientContact` right before writing,
   set `clientContact/email` and/or `clientContact/firstName` only where still
   blank (never overwrite an existing firstName or email). A person without an
   email → skip (stays blank; never write a fake address).

### Accepted known-partials (documented, not bugs)
- Write project-level only. Fixes the common case (account.clientContact blank →
  project fallback fires). Does NOT correct a stale/wrong account email.
- Fixes only the **email** branch of `skipped_missing`. InEditSuite (email-only
  gate) is fully fixed. ShootTomorrow also skips on bad shoot status / missing
  subtask id (`daily-09.js:180-195`) — separate causes, untouched here.

---

## Decisions (resolved with Jeremy)
- **Additive-only** for both threads — fill blanks, never override. Producer
  inline edits and any present value survive.
- **Scope/sequence:** backfills (1+3) now; edits (2) after.

## Tests
- `parseVideoCount`: `"5"`→5, `5`→5, `0`→0, `5.9`→5, `999`→500, `""`/`undefined`/
  `"abc"`→null, `-3`→0.
- `extractNumberOfVideos`: number, preserves 0, null when absent.
- `extractDealPersonId`: single→id, zero→null, **>1→null**.
- `extractPersonEmail` / `extractPersonFirstName`: present, absent, mononym.
- `buildDealIndex({includeZeroValue:true})` indexes a 0-value Won deal; default
  still excludes it (profitability unaffected). Entries carry numberOfVideos +
  personId.
- Backfill: blank field + confident match → writes; present field → untouched;
  ambiguous/tie or >1 claimant → skip; deal person without email → skip; per-run
  50-fetch cap respected.

## Verification before merge
- Gate on Vercel preview green; run the cron's manual POST trigger against
  preview and confirm a known-blank project gets backfilled and a known-set one
  is untouched. Then merge via PR to main, watch prod deploy + the next nightly.

---

## Deferred — Thread 2 (edits auto-creation), NOT in this change
The "# videos → # edits + name carry-through" already exists on two paths:
**Social Organic** (`social-organic.js` `handlePushToRunsheet`) and **Meta Ads**
(`meta-ads.js` `handlePushToRunsheet`) create one edit-stage subtask per
`scriptTable` row on preprod approval, carry the video name, and index-bind to
the delivery video via a canonical `videoId`. Gaps to close later:
1. Edit count is driven by preprod `scriptTable`, not `project.numberOfVideos` —
   they can diverge.
2. One-off / Live Action deals get delivery placeholder videos but **no edit
   subtasks** (no preprod-approval path).

## Out of scope
- Zapier-side mapping changes (not editable from the repo; webhook fallback +
  cron self-heal make the system tolerant anyway).
- Account-level `clientContact` backfill.
- Reconciling existing `/deliveries` placeholder rows against a corrected count.
