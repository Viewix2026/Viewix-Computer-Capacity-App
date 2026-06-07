# GHL Meta Lead → Attio (middleware)

**Owner:** Jeremy · **Endpoint:** `api/ghl-lead-webhook.js` · **Status:** built, pending Attio attribute + env var + validation

## What it does

A Meta ad lead lands in GoHighLevel as an Opportunity (pipeline `2-Step Funnel | Discovery Sessions`, source `2-Step Funnel | Meta Ads`). A GHL Custom Webhook action POSTs the opportunity + contact to this endpoint, which maintains three linked Attio records:

1. **Company** — deduped by exact name search (search-then-create).
2. **Person** — found by email; existing identity preserved, new emails created.
3. **Deal** — upsert by unique `ghl_opportunity_id`, stage `Lead`, owner Jeremy, source `Advertising`, value A$0.

## Why middleware (not GHL → Attio direct)

Jeremy already runs Vercel functions + Firebase for the Viewix Dashboard, so the marginal cost is near zero and it buys:

- Attio API key stays server-side (`process.env.ATTIO_API_KEY`); GHL only holds a shared secret.
- Durable Firebase attempt log + raw-payload capture → replayable, and we own retries (not GHL's blind retry storm).
- Branch on company match-count (GHL can't count array length) and protect existing person identity (a GHL upsert can't conditionally write).

## Flow (as implemented)

1. **Auth** — `secret` in body or `x-ghl-secret` header must equal `GHL_WEBHOOK_SECRET`. Else 401.
2. **Preflight hard-stop** — `opportunityId`, `businessName`, `email` all required. Blank → Slack alert + 422 (no retry). Guards the *plumbing* (broken merge tag, manual opp in pipeline), since a blank value collapses records onto one junk row.
3. **Durable "pending" log** written up front (`/ghlLeadSync/attempts/<hash(oppId)>`), so a mid-flight crash stays visible.
4. **Company** — query by exact name (`limit:5`):
   - **2+ matches** → ambiguous. Slack alert with candidate Attio links; lead proceeds **without** a company link (never lost, never cross-linked). Manual link later.
   - **1 match** → reuse.
   - **0 matches** → create, serialised by an RTDB transaction lock keyed on the normalised name (closes the common same-name concurrent-create race; degrades to plain create if lock infra is down — accepted TOCTOU for v1).
5. **Person** — query by email first. Found → reuse untouched (never downgrade a Current Customer to "Potential Customer" or move them off their company). Not found → create with name/email/phone/company + `contact_type: Potential Customer`. Blank phone is omitted (empty `original_phone_number` 400s). **Concurrent same-new-email race:** if the create hits an email uniqueness conflict (409 / "value_already_exists"), re-query by email and continue — the winner's record exists, so this opportunity still gets its deal instead of being dropped.
6. **Deal** — `PUT /objects/deals/records?matching_attribute=ghl_opportunity_id`. Keying on the unique opportunity id is the real refire guarantee: the same opportunity updates its one deal instead of spawning duplicates. Company/people refs included only when resolved.
7. **Result log** — `synced` (ids + companyStatus + reusedPerson) or `failed` (step + statusCode + error). Failures also Slack-alert with everything resolved so far + opp id for replay.
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
| `ghl_opportunity_id` | **does not exist yet — create it (Text, Unique)** |

Note: the Attio MCP write tools abstract value formats (owner = bare email, phone = string, name = "Last, First"). GHL/this endpoint hit the **raw REST API**, which needs the object forms above. That's why the endpoint builds raw JSON, not MCP shapes.

## Prerequisites before go-live

1. **Attio:** create Deals attribute `Ghl opportunity id` → type **Text**, **Unique = on**. Confirm api_slug is exactly `ghl_opportunity_id` (re-pull via MCP); if Attio slugs it differently, update the `matching_attribute` query string in `upsertDeal`.
2. **Vercel env:** set `GHL_WEBHOOK_SECRET` (new shared secret). `ATTIO_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `SLACK_SCHEDULE_CHANNEL_ID`, `SLACK_SCHEDULE_BOT_TOKEN` already exist.
3. **GHL workflow:** Custom Webhook → `POST https://<dashboard-domain>/api/ghl-lead-webhook` with JSON body mapping merge tags to: `secret`, `opportunityId` (`{{opportunity.id}}`), `businessName` (`{{opportunity.business_name}}`), `fullName` (`{{contact.full_name}}`), `firstName`, `lastName`, `email` (`{{contact.email}}`), `phone` (`{{contact.phone}}`). Confirm each token resolves in a test send first.

## Validation (byte-exact, before go-live)

Use a **temporary** Attio key (scopes `record_permission:read-write`, `object_configuration:read`) exported to a shell env var (never pasted in chat); revoke after. Then curl the literal calls the endpoint makes — company query/create, person query/create, deal upsert, re-run deal upsert to prove update-not-duplicate — and `DELETE` the test records. This proves the only remaining variable is GHL merge-tag wiring.

## Deferred (not v1)

- **Company in-flight duplicate race** (Codex review, medium): when a peer holds the create-lock, we re-query once and fall through to create rather than poll the lock to completion. This is a deliberate tradeoff — favouring never-missing-a-company-link (if the lock-holder crashed mid-create) over never-duplicating. Residual is a rare duplicate company (two *different* new leads, same new business name, within ~1s) that the weekly merge view covers. Revisit (lock-polling) only if Meta volume climbs.
- Cross-opportunity lead dedup · domain dedup once website capture is reliable · auto-owner reassignment to Brandon on "Meeting Booked" · UTM/campaign attributes · lead scoring · weekly orphan/duplicate-company merge view.
