# Scope Packet — Enterprise Proposal: Dashboard page

Feature slug: `proposal-dashboard-page`. Conductor: make-a-feature. Created Step 1.
Parent plan: `docs/plans/enterprise-proposal-generator.md` (full, Codex-reviewed).

## Outcome
From the Viewix Dashboard, a founder/closer can kick off an enterprise proposal for a prospect and
watch it go **queued → generating → ready**, then download the finished PDF — without touching a
terminal or JSON. The dashboard is the trigger + status surface; the Mac mini worker does the render.

## Out of scope (this round)
- The Mac mini **worker** (firebase-admin listener that renders + writes back) — separate build.
- The **Attio + transcript brief auto-fill** — separate build.
- The renderer itself — already built at `skills/viewix-enterprise-proposal/` (done).
- Editing the proposal deck design.

## Done looks like
- A dashboard surface (tab or embedded action — see Open decisions) where a founder/closer triggers a
  proposal; it writes a `/proposalJobs/{id}` record to RTDB.
- The UI reflects live status via the existing RTDB listener pattern: queued → generating → ready
  (download link) / error (message). No page refresh needed.
- RTDB security rules for `/proposalJobs` are written (founders/closer write; worker service-account
  reads/writes) and ready to deploy via `firebase deploy --only database`.
- Verified in the local preview: triggering writes a well-formed job; a simulated worker status flip
  (queued→generating→ready with a pdfUrl) renders correctly through to a working download link.

## Hard constraints
- **Job schema must match what the worker will consume** (per parent plan):
  `/proposalJobs/{id} = { dealId, companyId, status, requestedBy, createdAt }` →
  worker writes back `{ status: "ready", pdfUrl }` or `{ status: "error", error }`.
- New feature in its **own `src/components/<Feature>.jsx`** — never inlined in App.jsx. App.jsx only
  registers the sidebar icon + a conditional render block and passes state/setState props.
- Role-gated to **founders/closer** (`isFounder` / `role==="closer"`), matching the Sale tab.
- Inline styles + the CSS theme in `src/config.js`. Reuse existing RTDB sync-hook + status-badge +
  share/download-link patterns rather than inventing new ones.
- RTDB rules live in `firebase-rules.json`, deploy separately (not via Vercel).
- Vercel/dashboard must **not** attempt to render (no headless Chrome on serverless) — write-only.

## Resolved decisions (from the parent plan, already settled)
- Initiation = dashboard button; Transport = Firebase RTDB job queue; mini never accepts inbound.
- Output = PDF produced by the worker; dashboard shows a download link.

## Open decisions (resolve at Gate 1 unless exploration proves one is blocking → Step 2.5)
- **Surface & attachment point:** standalone "Proposals" tab (lists jobs + a "New proposal" action
  with manual prospect entry) vs an embedded "Generate proposal" button on an existing record
  (Accounts / Projects / Sale). Hinges on whether pre-won enterprise prospects actually exist as
  records in the dashboard today — exploration to confirm.
- **PDF destination** the worker will target (Firebase Storage signed URL vs Drive) — affects only
  how the dashboard renders the link; default to "whatever `pdfUrl` the worker writes".

## Approved plan (fast-pathed — Jeremy said "build the page" ×2; additive, low-risk diff)
- **`src/components/Proposals.jsx`** (new, lazy) — founders/closer tab. New-proposal form (company,
  contact email, creative look, optional Attio-deal picker) writes a job; live list of jobs with a
  status badge (queued/generating/ready/error) + Download PDF link (guarded by `validateLinkUrl`).
- **`src/sync/useProposalJobsSync.js`** (new) — `{enabled}`-gated `/proposalJobs` listener
  (object→array), no echo-suppression (no local-editable fields).
- **`src/App.jsx`** — lazy import; `useProposalJobsSync({enabled:isFounder||role==="closer"})` below
  the role flags; `Proposals` SideIcon (📋) + render block, both gated `isFounder||role==="closer"`.
- **`firebase-rules.json`** — `/proposalJobs`: top-level read for founders/closer; per-`$jobId`
  **create-only** write (status must be `queued`, id matches, requestedBy.uid==auth.uid, no
  pdfUrl/error). Worker uses admin SDK → bypasses rules. Deploy via `firebase deploy --only database`.

## Resolved decisions
- **Surface = standalone "Proposals" tab** (not a button on an existing record). Exploration proved
  pre-won prospects live ONLY in `/attioCache` — `/accounts` & `/projects` are won-only.
- **Prospect source = /attioCache picker (founders/manager) + manual entry (all roles).** Closers are
  read-denied on /attioCache, so the picker is skipped for them and they use manual entry.
- **Job schema** (enriches the parent plan's `{dealId,companyId}`):
  `{ id, status, companyName, contactEmail, companyId, dealId (Attio deal record_id), stage,
  lookVariant, requestedBy:{uid,name}, createdAt }`; worker writes `{ status, pdfUrl, error, ... }`.

## Implementation deltas
- Security hardening (Codex code-loop C1): write rule is create-only with field validations so a
  staffer can't spoof `status:"ready"`+a `pdfUrl`. Only the admin worker mutates a job post-create.
- Listener gated by role + suppression removed (Codex H2/H3) so a worker status flip always shows live.
- **Accepted Low (v1):** no dashboard cancel/retry path — only the worker mutates a job. If the worker
  crashes leaving a job stuck at `generating`, it must self-recover or the row stays until cleared.
  Revisit (add a founders-only reset) if it bites. Not in the rules JSON (strict JSON, no comments).

## Codex review trail (code loop)
- **Round 1:** 6 findings (1 Critical, 2 High, 1 Med, 2 Low) — all adopted/fixed. Critical was the
  write-rule spoof hole; Highs were the ungated listener + the wrong echo-suppression.
- **Round 2:** all 6 prior fixes CONFIRMED; 1 new Medium (null-uid guard) fixed; optimistic-upsert
  race traced clean; Codex withdrew its own theoretical double-attach finding. **Converged** (6 → 1).
- Verification: `npm run build` green; rules JSON valid. Live preview not applicable (app is
  Google-SSO gated) — manual check is below.
