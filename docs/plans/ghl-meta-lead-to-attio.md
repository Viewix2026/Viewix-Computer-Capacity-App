# GHL Meta Lead → Attio (middleware)

**Owner:** Jeremy · **Endpoint:** `api/ghl-lead-webhook.js` · **Status:** built + hardened + two-step capture + adapted to GHL's real survey payload (contact-keyed); pending `GHL_WEBHOOK_SECRET` env var + GHL workflow wiring

## What it does

A Meta/Social lead completes a funnel **survey** in GoHighLevel. The workflow's **Webhook** action POSTs the **contact** to this endpoint (the survey trigger gives a contact, **not** an opportunity — there's no opportunity id). It maintains up to three linked Attio records:

1. **Company** — deduped by exact name search (search-then-create). **Optional** — only when the payload carries a company name (GHL's survey trigger often doesn't).
2. **Person** — found by email; existing identity preserved, new emails created. First/last derived from `full_name` when GHL sends only that.
3. **Deal** — keyed by unique **`ghl_contact_id`** (one deal per contact; a returning lead updates it rather than duplicating), owner Jeremy, source `Advertising`, value A$0. Stage driven by which funnel step fired (see below).

### GHL payload shape (real, captured)

GHL sends the contact's standard fields at the **top level** (snake_case) and any custom rows nested under **`customData`**:

```json
{ "contact_id": "TaYkOp8F9qB0mzhZXW9M", "full_name": "Con Koumoulas",
  "email": "lead@example.com", "phone": "+61419617571",
  "company_name": "Water World Pty Ltd",
  "customData": { "secret": "…", "stage": "Meeting Booked" } }
```

So the endpoint **flattens `customData`** and reads snake_case-first with camelCase fallback. The auth `secret` and the optional `stage` live under `customData`. **GHL auto-includes the contact fields** — the only custom-data rows you add in GHL are `secret` (always) and `stage` (STEP 2 only).

## Two-step capture (Lead → Meeting Booked)

The same contact flows through two GHL funnel steps, each wired to this endpoint with its own optional `stage` (under `customData`):

- **STEP 1 — opt-in** (Nurture workflow): sends **no** `stage` → the Deal is **created at `Lead`**.
- **STEP 2 — booking confirmed**: sends `stage: "Meeting Booked"` → the **same** Deal is **advanced to `Meeting Booked`**.

Stage moves are **forward-only** (ranked by pipeline order `Lead < Meeting Booked < Quoted < On Hold < Won < Lost`): a STEP 2 reminder firing repeatedly, or a deal the sales team has moved to Quoted/Won, can never be pulled backwards. `value`/`owner`/`source` are never touched on update. Unknown `stage` values are ignored (never written). If STEP 2 fires with no prior Deal (STEP 1 missed/failed), the Deal is created directly at `Meeting Booked`. Verified against the live API end-to-end (opt-in → booking → repeat reminder → manual Quoted → reminder cannot regress).

## Why middleware (not GHL → Attio direct)

Jeremy already runs Vercel functions + Firebase for the Viewix Dashboard, so the marginal cost is near zero and it buys:

- Attio API key stays server-side (`process.env.ATTIO_API_KEY`); GHL only holds a shared secret.
- Durable Firebase attempt log + raw-payload capture → replayable, and we own retries (not GHL's blind retry storm).
- Branch on company match-count (GHL can't count array length) and protect existing person identity (a GHL upsert can't conditionally write).

## Flow (as implemented)

1. **Auth** — `secret` from `customData.secret` (GHL's nesting), top-level `secret`, or `x-ghl-secret` header must equal `GHL_WEBHOOK_SECRET`. Else 401.
2. **Preflight hard-stop** — `contact_id` + `email` required (company/business name is **optional**). Blank → Slack alert + 422 (no retry). Guards the *plumbing* (mis-nested customData, wrong trigger): a blank key collapses records (blank email → one empty person, blank contact id → one empty deal).
3. **Durable "pending" log** written up front (`/ghlLeadSync/attempts/<hash(contact_id)>`, raw payload), so a mid-flight crash stays visible.
4. **Company** — only if a company name is present; else skipped (`companyStatus: none`). When present, query by exact name (`limit:5`):
   - **2+ matches** → ambiguous. Slack alert with candidate Attio links; lead proceeds **without** a company link (never lost, never cross-linked). Manual link later.
   - **1 match** → reuse.
   - **0 matches** → create, serialised by an RTDB transaction lock keyed on the normalised name (closes the common same-name concurrent-create race; degrades to plain create if lock infra is down — accepted TOCTOU for v1).
5. **Person** — query by email first. Found → reuse untouched (never downgrade a Current Customer to "Potential Customer" or move them off their company). Not found → create with name (first/last derived from `full_name` if needed) / email / phone / company + `contact_type: Potential Customer`. Blank phone is omitted (empty `original_phone_number` 400s). **Concurrent same-new-email race:** if the create hits an email uniqueness conflict (409 / "value_already_exists"), re-query by email and continue — the winner's record exists, so the lead still gets its deal instead of being dropped.
6. **Deal** — keyed by the unique `ghl_contact_id`, **edit-safe, not a blind upsert**. Query by contact id first: no deal → `POST` create (stage `Lead` or the requested stage, owner Jeremy, source `Advertising`, value A$0); existing deal → `PATCH` that backfills associations and advances the stage **forward-only**, deliberately leaving `value`/`owner`/`source` (and any non-forward stage) untouched — so a refire/retry/replay can never reset a deal the sales team advanced (e.g. Quoted / A$5000). The query→create window is closed by Attio's uniqueness on `ghl_contact_id`: a racing second create hits a uniqueness conflict and recovers by re-querying + refreshing the winner. Empirically verified end-to-end against live Attio.
7. **Result log** — `synced` (ids + companyStatus + reusedPerson) or `failed` (step + statusCode + error). Failures also Slack-alert with everything resolved so far + contact id for replay.
8. **Response / retry ownership** — on Attio failure we write the failure log **strictly**: if it succeeds we return 200 (suppress GHL retry; we own replay). If even the durable write fails (Firebase down/misconfigured) we return **502 so GHL retries** rather than silently lose the lead — the Slack alert flags the degraded path. GHL retry is safe because every step is idempotent (company lock+requery, person query-first + 409-recovery, deal upsert by unique key). Bad secret (401) and unusable payload (422) are the only other non-200s.

## Verified Attio facts (live schema, 2026)

| Thing | Value |
|---|---|
| Owner member id | `e90aec93-f56e-4f28-8df8-065c63ab1a2d` (member email `hello@viewix.com.au`) |
| Deals `stage` | status; write title `Lead` (exists) |
| Deals `source` | select; `Advertising` (exists) |
| Deals `owner` | actor-reference, required → `[{referenced_actor_type:"workspace-member", referenced_actor_id}]` |
| Deals `value` | currency AUD |
| Companies `name` | text, **not unique** → search only, never an upsert matcher |
| People `email_addresses` | unique |
| `ghl_contact_id` | **created** — Text, Unique (title "GHL Contact Id", api_slug `ghl_contact_id`, confirmed via API). Was `ghl_opportunity_id`; renamed since GHL's survey trigger sends a contact id, not an opportunity id. |

Note: the Attio MCP write tools abstract value formats (owner = bare email, phone = string, name = "Last, First"). GHL/this endpoint hit the **raw REST API**, which needs the object forms above. That's why the endpoint builds raw JSON, not MCP shapes.

## Prerequisites before go-live

1. ~~**Attio:** create the deal dedup attribute.~~ **Done** — `ghl_contact_id` (Text, Unique) created/renamed via API.
2. **Vercel env:** set `GHL_WEBHOOK_SECRET` (shared secret; must match the `secret` custom-data value in every GHL workflow). `ATTIO_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `SLACK_SCHEDULE_CHANNEL_ID`, `SLACK_SCHEDULE_BOT_TOKEN` already exist.
3. **GHL workflows (4 total: STEP 1 + STEP 2 per funnel — Meta Ads & Social Retainer):** each is a dedicated "→ Attio Sync" workflow (clone the funnel-step's Nurture workflow to inherit the exact **Survey Submitted** trigger, strip its actions, add one **Webhook** action). Webhook → `POST https://planner.viewix.com.au/api/ghl-lead-webhook`.
   - **Custom data is minimal** — GHL auto-includes the contact fields (`contact_id`, `full_name`, `email`, `phone`, `company_name`) in its standard payload, so you only add:
     - `secret` = the `GHL_WEBHOOK_SECRET` value (**all** workflows)
     - `stage` = `Meeting Booked` (**STEP 2 workflows only**; STEP 1 omits it → Deal stays at `Lead`)
   - Test each with GHL's **"Test workflow"** (pick a real contact) — the survey trigger can't be fired by hand. Both funnels share the same endpoint + secret; Deals never collide (keyed by `ghl_contact_id`).

## Validation (byte-exact, before go-live)

Use a **temporary** Attio key (scopes `record_permission:read-write`, `object_configuration:read`) exported to a shell env var (never pasted in chat); revoke after. Then curl the literal calls the endpoint makes — company query/create, person query/create, deal upsert, re-run deal upsert to prove update-not-duplicate — and `DELETE` the test records. This proves the only remaining variable is GHL merge-tag wiring.

## Deferred (not v1)

- **Company in-flight duplicate race** (Codex review, medium): when a peer holds the create-lock, we re-query once and fall through to create rather than poll the lock to completion. This is a deliberate tradeoff — favouring never-missing-a-company-link (if the lock-holder crashed mid-create) over never-duplicating. Residual is a rare duplicate company (two *different* new leads, same new business name, within ~1s) that the weekly merge view covers. Revisit (lock-polling) only if Meta volume climbs.
- Cross-opportunity lead dedup · domain dedup once website capture is reliable · auto-owner reassignment to Brandon on "Meeting Booked" · UTM/campaign attributes · lead scoring · weekly orphan/duplicate-company merge view.
