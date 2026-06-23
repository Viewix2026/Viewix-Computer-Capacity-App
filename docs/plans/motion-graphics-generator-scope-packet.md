# Scope Packet — Motion Graphics Generator

Status: **Built + code-reviewed — at Gate 2** (make-a-feature pipeline). Plan
approved at Gate 1; built; 2 Codex code-review rounds to convergence; awaiting
Jeremy's code review before ship.
Owner: Jeremy
Created: 2026-06-23

---

## Context / why

An editor needed motion graphics for a video. He fed his basic motion graphics
into Claude, Claude built an animated webpage, he screen-recorded it and dropped
it into the cut. We want to productize that exact move as an editor toolkit tab —
mirroring how we shipped the Caption/Text Generator ([CaptionGenerator.jsx](../../src/components/CaptionGenerator.jsx), PR #332).
The difference from the caption tool: captions are pure client-side styling with
no AI; motion graphics' whole value is a **live Claude call that writes a
self-contained animated HTML page**, branded and correctly sized, that the editor
captures into the video.

---

## Outcome

Fast self-serve generation **and** a reusable library. An editor who needs a
motion graphic opens **Editors → Motion Graphics**, describes it in plain
language, picks dimensions, and gets a branded, correctly-sized animation playing
in a framed preview they can screen-record. Good ones get saved to a shared
library every editor can reuse and re-render.

## Done looks like (manual demo only this round)

Verified end-to-end in the live preview:
1. Type a prompt ("lower third, client name slides in from left, Viewix blue"),
   pick 1920×1080, Generate → a branded animation renders in the framed preview.
2. "Refine" with a follow-up ("make the text bigger, slow it down") → updated
   animation replaces it.
3. Present mode → animation plays full-bleed at true pixel dimensions on a
   chroma background, looping, ready to screen-record.
4. Save to library → reload the tab → the saved graphic is listed and
   re-renders from the library.
5. Endpoint computes + records token usage and a per-generation cost.

## Out of scope (this round)

- **Client-facing / sharing** — internal editor tool only.
- **Multi-scene / timeline sequencing** — one graphic per generation.
- **Grid-of-N variations** — single generate + a "refine this" follow-up only.
- **In-tool code editing** — a read-only "view source / copy" peek only; no editor.
- **One-click in-browser video export (Canvas + WebM-alpha)** — export is
  screen-record this round (see Resolved decision: export). Canvas/WebM stays a
  possible later phase.
- **Automated endpoint tests** — manual verification this round; `.test.mjs` in a
  `__tests__/` dir is the saved-for-later follow-up.

## Hard constraints

- **Model: `claude-opus-4-7`** on every generation (latest Opus, already in use
  in `api/founders-advisor.js` / `api/_scheduling-narrate.js`). Track token usage
  + computed cost per generation.
- **Reuse, do not reinvent:** `requireRole` / `sendAuthError` / `actorFrom`
  ([api/_requireAuth.js](../../api/_requireAuth.js)); raw-fetch Anthropic call in the
  [api/meeting-feedback.js](../../api/meeting-feedback.js) `callClaude` shape
  (`x-api-key`, `anthropic-version: 2023-06-01`, ephemeral system cache);
  frontend `fbSetAsync` / `fbListenSafe` / `authFetch` from
  [src/firebase.js](../../src/firebase.js); `Segmented` subtab pattern in
  [EditorDashboard.jsx](../../src/components/EditorDashboard.jsx); `kit.jsx`
  primitives; [Icon.jsx](../../src/components/Icon.jsx); `config.js` design tokens;
  [ViewixLoader.jsx](../../src/components/shared/ViewixLoader.jsx) for loading.
- **Model id discipline:** never `claude-haiku-4-6` (404s). Opus 4.7 is the only
  model this feature calls.
- Endpoint must be in `api/` root (not a `*.test.mjs`, which deploys as a live endpoint).

---

## Resolved decisions

- **Export = DOM/CSS + screen-record (highest quality).** Claude returns a single
  self-contained animated **HTML page**. Full browser rendering gives the highest
  visual ceiling (gradients, blur, SVG filters, web fonts, 3D transforms). Export
  is a clean **Present mode** the editor screen-records. The generated graphic
  has a transparent background; the preview/present surface sits on a
  user-selectable **chroma colour** (green/magenta/black/white/checkerboard) so
  the editor can key it out in their NLE. *(Why: Jeremy asked which is highest
  quality — DOM/CSS is, and it's also the lowest-risk path. Canvas+WebM-alpha
  capped the visual ceiling and carried a real Premiere-import risk.)*
- **Model = always Opus 4.7**, no toggle. *(Why: output quality is the whole
  product; editors don't generate at high volume. Cost is tracked, not capped.)*
- **Persistence = shared org library** at `/motionGraphicsLibrary/*`, written
  **only via the authenticated server endpoint** (NOT the client SDK — see Codex
  11/round-2-8). Client writes are disabled (`.write:false`); the frontend reads
  via `fbListenSafe`. *(Why: shared editor knowledge like `formatLibrary`, but with
  server-stamped provenance + server-authoritative cost.)*
- **Cost ledger is server-authoritative.** The endpoint writes a usage/cost record
  on **every** generation (not just saved ones) to `/aiUsage/motionGraphics/{id}`
  via firebase-admin, so the future stats tab has complete data even for throwaway
  generations. *(Why: "keep track of cost per generation" must not depend on the
  user choosing to save.)*
- **Synchronous generate** (request → response within maxDuration), not a
  job/poll loop. *(Why: simpler; Opus generation fits comfortably under a 120s
  function budget, matching the synchronous pattern in meeting-feedback.js.)*
- **Portrait export = screen-record-with-caveats for v1; pixel-perfect export is a
  fast-follow phase (Mac-mini headless render).** v1 present mode is a scaled-to-fit
  sandboxed present route + pop-out + honest portrait copy. Phase 2 adds a "Render
  to video" action that enqueues a job the Mac-mini worker (Puppeteer at exact
  dimensions + ffmpeg) turns into a clean 1080×1920 file — keeps full DOM richness,
  pixel-perfect, no WebM/Premiere risk. *(Why: ships the useful tool now; the proper
  export reuses the existing `proposal-renderer` pm2 box and beats Canvas/WebM on
  both quality and import-compatibility. Codex 12 resolved.)*

### Security & integrity decisions (from Codex round 1 — adopted)

- **Sandbox + CSP is the enforced boundary, not the prompt.** Every rendered or
  saved graphic runs in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`)
  AND carries a strict CSP injected by *us* as the first `<head>` child:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'
  https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:
  blob:; media-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none';
  navigate-to 'none'`. No `connect-src` → fetch / XHR / beacon / WebSocket are
  blocked, killing the exfiltration channel. No external `<script src>` / `<img src>`.
  `media-src`/`worker-src 'none'` are explicit (not left to fallback) so `<video>`/
  Workers fail predictably, not mysteriously. `injectGuard` also **strips any
  model-emitted `<meta http-equiv="refresh">` and any model CSP meta** before
  injecting ours. *(Closes Codex 1, 2, 10; round-2 2, 7.)* Push back on a full
  HTML-AST allowlist — CSP is the robust boundary; a tag blocklist is bypassable.
  Residual accepted: a sandboxed frame with no `allow-same-origin` holds nothing
  sensitive to exfiltrate even if it self-navigates, so `navigate-to` is best-effort.
- **Library HTML is untrusted forever.** It is *only ever* rendered inside that
  same sandbox+CSP iframe, **never as a top-level document and never injected into
  the dashboard DOM**. "Present"/"Pop out" opens an in-app, chrome-less route
  (`/present?id=…` style) that itself embeds the sandbox+CSP iframe — it does NOT
  open the raw HTML as a top-level tab (that would escape the sandbox). Re-rendering
  another editor's saved graphic is therefore contained. *(Closes Codex 3; round-2 1.)*
- **`trial` cannot generate.** Generate is gated to `["founders","lead","manager","editor"]`.
  Trial users can view/use the library (read) but not spend Opus. *(Closes Codex 4.)*
- **Paid action also checks `/users/{uid}/active`.** `requireRole` only checks the
  role claim; a deactivated user's still-valid token would otherwise spend. The
  generate handler does an inline `adminGet('/users/${uid}/active')` and rejects
  if not `true`. *(Closes Codex 5.)*
- **Server-side input bounds + circuit-breaker.** Dimensions whitelisted to the 3
  presets (arbitrary W×H rejected); `prompt` ≤ 2000 chars; `refineInstruction` ≤
  1000; `previousHtml` ≤ 100KB; returned HTML rejected if > 200KB. A generous
  per-user **daily generation cap (e.g. 100/day)** at `/aiUsage/dailyCount/{uid}/{YYYY-MM-DD}`,
  incremented via `runRtdbTransaction` (`_fb-admin.js`) that aborts atomically at
  the cap (no read-then-write race), **before** the Opus call — a failed generation
  consuming quota is acceptable for a runaway-loop breaker. Trips only on a bug/loop,
  never on real use. *(Closes Codex 6; round-2 5. Push back on a full per-dollar
  budget — premature at this volume.)*
- **Frontend abort + server timeout.** `authFetch` wrapped in an `AbortController`
  (~115s, just under maxDuration 120) with a retryable error UI; the endpoint
  gives the Anthropic fetch its own timeout so it returns JSON before Vercel kills
  it. *(Closes Codex 7.)*
- **Cost ledger stores RAW token counts.** The Claude helper returns `{ html, usage }`
  (not text-only like meeting-feedback's). Every `/aiUsage` record stores raw
  `input_tokens` / `output_tokens` / cache tokens (immutable truth) PLUS the
  `model`, the `rate` used, and `pricedAt`, so cost can be recomputed if a guessed
  rate was wrong. ⚠ Verify Opus 4.7 per-MTok rates via the claude-api skill at
  build time. *(Closes Codex 8, 9. Push back on a separate pricing-table node —
  stamping the rate per record is enough at this scale.)*
- **Library saved via the server, not the client SDK.** Save is an authenticated
  endpoint action that server-stamps `createdBy` from the token, re-runs
  `injectGuard`, and writes via firebase-admin. `/motionGraphicsLibrary` client
  **write rule = false**. **Cost is server-authoritative:** save takes the
  `generationId` returned by `generate` and copies the cost from that ledger record
  — it **ignores any client-supplied `cost`/`usage`**. Editors can't forge
  `createdBy` / `cost`. Cost analytics read `/aiUsage` only. *(Closes Codex 11;
  round-2 4.)*
- **Metadata / HTML written atomically.** A single multi-path `update()` writes
  `/motionGraphicsLibrary/meta/{id}` (name, dims, createdBy, createdAt, cost,
  generationId) and `/motionGraphicsLibrary/html/{id}` (the guarded HTML) together,
  so there's no orphaned-meta-without-html state. The tab listens only to `meta`
  (cheap); the blob is `fbGet`-loaded on selection; the UI still handles a null
  blob defensively (offer archive). *(Closes Codex 13; round-2 6.)*

## Open decisions

_All resolved. The portrait-export fork (Codex 12) was settled at Gate 1 —_
_see Resolved decisions: "Portrait export"._

## Noted for a later session (NOT this build)

- **Founders → Statistics tab**: platform size, usage, AI/API costs and related
  metrics. This build seeds it by writing an authoritative per-generation cost
  ledger at `/aiUsage/motionGraphics/*`. Design that tab as its own feature.
- **Phase 2 — "Render to video" (Mac-mini headless export)**: a `/motionGraphicsJobs`
  queue + a pm2 worker step on the Mac mini (Puppeteer loads the guarded HTML at
  exact W×H, records the loop, ffmpeg → clean video file) + UI status polling.
  Pixel-perfect portrait, full DOM richness, no NLE-import risk. Mirrors the
  `proposal-renderer` worker pattern. The fast-follow right after v1 lands.

---

## Proposed plan (becomes "Approved plan" at Gate 1)

### 0. Shared helper — `injectGuard(html, { width, height })`
A pure function (in the endpoint, exported for reuse) that takes Claude's raw
output and returns a render-safe doc. **Parser-based, deterministic** (uses
`node-html-parser` — a tiny new dep — not regex, so malformed input can't drop the
CSP; round-2 3):
1. Strip markdown ``` fences. Expect exactly one HTML document or one fenced HTML
   block; if zero or many, **reject** (throw a clear error the UI shows).
2. Parse; synthesize missing `<html>`/`<head>`/`<body>` if absent.
3. **Remove** any model-emitted CSP meta and any `<meta http-equiv="refresh">`.
4. Insert, as `head.children[0]`, our CSP meta + a base style reset
   (`html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:Wpx;height:Hpx}`).
   W/H come from the validated preset whitelist (not free text), so no CSS injection.
5. Reject if the serialized result exceeds 200KB.
This is the single trust boundary; both `generate` and `save` run output through it.

### 1. New endpoint — `api/motion-graphics.js`
- Skeleton mirrors `api/analytics.js`: `handleOptions` → `setCors` → POST-guard →
  `requireRole(req, …)` → `sendAuthError` on failure → dispatch on `body.action`.
- Reuse inline `fbGet/fbSet/fbPatch` admin+REST-fallback helpers (copy from
  `api/social-organic.js`), plus `adminSet`/`adminGet`.
- `callClaude(system, userContent)` in the `meeting-feedback.js` shape **but
  returning `{ text, usage }`** (the original discards usage — we need it; round-2 8
  consistency: the helper returns `text`, `injectGuard` turns it into `html`,
  `generate` returns `html`). Model `claude-opus-4-7`; `max_tokens` ~8000; ephemeral
  system cache; its own fetch timeout so it returns before Vercel kills the function.
- `PRICE` constant `{ inPerMTok, outPerMTok, pricedAt }` ⚠ **verify Opus 4.7 rates
  via the claude-api skill at build time — do not ship a guessed price.**
- **Actions:**
  - **`generate`** — roles `["founders","lead","manager","editor"]` (NOT trial).
    Steps: validate inputs (whitelist dims to the 3 presets; `prompt`≤2000;
    `refineInstruction`≤1000; `previousHtml`≤100KB) → inline active-check
    `adminGet('/users/${uid}/active') === true` → atomic daily-cap transaction at
    `/aiUsage/dailyCount/${uid}/${date}` (abort at 100) → build system prompt →
    Opus call (timed) → `injectGuard(text, dims)` → compute cost from raw usage ×
    PRICE → write ledger `/aiUsage/motionGraphics/${genId}` (actor, model, raw
    tokens, cost, rate, pricedAt, ts, dims) → return **`{ id: genId, html, usage,
    cost, model }`**. `previousHtml` + `refineInstruction` present → iteration
    (prior HTML as context).
  - **`save`** — same roles. Input `{ generationId, html, name? }`. Looks up
    `/aiUsage/motionGraphics/${generationId}` for the **authoritative cost + dims**
    (ignores any client cost/usage; round-2 4), re-runs `injectGuard`, server-stamps
    `createdBy` (`actorFrom`), and writes meta + html in **one atomic multi-path
    `update('/motionGraphicsLibrary', {…})`** (round-2 6). Returns the new id.
  - **`archive`** — same roles. Soft-deletes by patching `meta/${id}/archived = true`
    (admin write).
- **System prompt** bakes in: Viewix palette (`--accent #0082FA`, `--orange
  #F87700`, dark/light neutrals), DM Sans + JetBrains Mono via Google Fonts
  `@import`, and hard rules: ONE self-contained HTML doc, inline CSS+JS only (no
  external deps beyond Google Fonts), **transparent background**, `html,body` sized
  exactly to W×H, no scrollbars, animation loops cleanly over ~`durationSec`,
  return ONLY raw HTML. (The CSP/reset is enforced by `injectGuard` regardless.)
- Add `"api/motion-graphics.js": { "maxDuration": 120 }` to `vercel.json`.

### 2. New component — `src/components/MotionGraphicsGenerator.jsx`
- Layout clones the CaptionGenerator shape: left control panel + right preview.
- **Controls:** prompt textarea; dimensions segmented (1080×1920 / 1920×1080 /
  1080×1080); optional duration; chroma-background swatch
  (green/magenta/black/white/checkerboard); Generate button (ViewixLoader while
  awaiting, `AbortController` ~115s + retryable error); after a result, a "Refine"
  input + regenerate.
- **Preview:** sandboxed `<iframe sandbox="allow-scripts" srcDoc={guardedHtml}>`
  (no `allow-same-origin`) sized to the chosen dimensions, scaled to fit via CSS
  `transform: scale()`, on the chosen chroma background. Replay/loop = re-mount via
  a changed React `key` (Codex confirmed this reliably restarts CSS/JS animation).
- **Present mode:** scaled-to-fit overlay on the chroma background with safe-margin
  guides and the **scale factor shown**, plus a **"Pop out"** that opens an in-app
  chrome-less present route (still a sandbox+CSP iframe — not raw HTML in a tab) for
  clean OS-level capture. Honest copy: native portrait (1080×1920) capture needs a
  tall display or the deferred WebM export.
- **View source:** modal showing the guarded HTML + copy button (read-only).
- **Library:** `fbListenSafe("/motionGraphicsLibrary/meta", …)` (metadata only —
  cheap); grid of saved items (name, dims, creator, cost); click → `fbGet`
  `/motionGraphicsLibrary/html/${id}` → load into preview + re-render (handle a
  null blob gracefully → offer archive). "Save to library" passes the current
  `generationId` to the **endpoint** (`authFetch` actions `save` / `archive`),
  never a direct client write (write rule is `false`).
- All endpoint calls via `authFetch("/api/motion-graphics", …)` + the
  `readJsonResponse` non-JSON-safe parse helper (SocialOrganicResearch pattern).

### 3. Wire the subtab — `src/components/EditorDashboard.jsx`
- Import `MotionGraphicsGenerator`; add `"Motion Graphics"` to the `Segmented`
  `options`; add a `display:` toggle div rendering it, passing
  `currentUserEmail` / `viewerRole` already received as props.

### 4. RTDB rules — `firebase-rules.json`
- `motionGraphicsLibrary`: `.read` = any role; **`.write` = false** (server/admin
  only — client SDK bypassed for integrity). `.indexOn: ["createdAt"]` on `meta`
  only if we sort by it client-side (else omit — Codex 13: it's inert without a
  matching `orderByChild` query).
- `aiUsage`: `.read` = founders only (feeds the future stats tab); **`.write` = false**
  (firebase-admin bypasses rules, so the endpoint still writes).
- ⚠ Rules deploy is a **separate** `firebase deploy --only database` step, not Vercel.

---

## Codex plan-review trail (2 rounds → converged)

**Round 1** — 13 findings (4 High), BUILDABLE_AFTER_FIXES. Adopted: 1, 2 (via CSP),
3, 4, 5, 6 (bounds + breaker; not full budget), 7, 8, 9 (raw tokens + per-record
rate; not a pricing-table node), 10 (CSS+CSP injection; not an AST allowlist), 11,
13. Surfaced as the Gate-1 fork: 12 (portrait capture). Pushed back: heavyweight
HTML-AST allowlist, full per-dollar budget, separate pricing-table node — premature
for ~5 editors at low volume.

**Round 2** — 8 findings (1 High, 4 Med, 3 Low), BUILDABLE_AFTER_FIXES. The High
was a flaw the round-1 *fix* introduced (pop-out escaping the sandbox) — adopted.
All 8 adopted (mostly tightening): in-app sandboxed present route, parser-based
`injectGuard`, server-authoritative cost via `generationId`, atomic cap transaction,
atomic meta+html write, explicit media/worker CSP, fixed the stale client-write
bullet. Round 2 also *confirmed* key assumptions: role strings `founders/manager/
editor/lead` exist in `_roles.js`, the Google-Fonts CSP chain is correct, no client
reads `/aiUsage`, 200KB+JSON is within Vercel's body limit.

**Convergence:** severity trend 4-High → 1-High(→0 after fix) → nitpicks. Round 1
was high-value (architecture); round 2 caught one real new-surface High and tightened
the trust boundary; a round 3 on the *plan* would chase wording. Remaining concerns
are implementation-detail (the exact `injectGuard` parse, the present route) — better
reviewed as **real code** in the Step-4 Codex loop. Plan loop stopped here.

### Verification (manual, end-to-end)
- `npm run dev`, log in, Editors → Motion Graphics.
- Generate → refine → present → save → reload → re-render (the Done list above).
- Confirm via preview tools: no console errors, the iframe renders, the
  `/api/motion-graphics` network call returns html+cost, and a ledger record +
  library record appear in RTDB.
- Watch the Opus call returns within maxDuration.

---

## Implementation deltas (filled only if the build deviates — Gate 1.5)

Two non-material deltas discovered while reading the real code. Neither trips the
Gate-1.5 rule (no data-contract-with-persistence change, no auth-boundary weakening,
no added runtime dep — one is removed; no cost/perf/user-visible change). Logged for
the record:

1. **Auth: an in-endpoint RTDB role+active cross-check (revised after the code review).**
   Initially dropped the planned active-read as redundant with token revocation —
   `verifyIdToken(token, true)` + `revokeRefreshTokens` on deactivate/delete already
   block a *deactivated* user. But the code Codex loop (finding 2) correctly noted
   `admin-users.js:setRole` does **not** revoke on a *role demotion*, so a demoted
   editor keeps the stale `editor` claim for ≤1h and could still spend Opus.
   `setRole` writes the new role to `/users/{uid}/role` synchronously (line 124), so
   `handleGenerate` now reads `/users/${uid}` and 403s unless `active !== false` AND
   `normalizeRole(role) ∈ GENERATE_ROLES`. Closes the demotion window using the
   authoritative RTDB record — no change to shared auth code.

2. **`injectGuard` wraps a model FRAGMENT in our own shell instead of parsing a full
   doc — no `node-html-parser` dependency.** The model returns a fragment; `injectGuard`
   wraps it in a shell *we* fully control (our CSP meta first, size reset, Google-Fonts
   `@import`). The CSP meta is guaranteed first-in-head because the head is ours. The
   code Codex loop (finding 4) caught that *global* tag-stripping corrupted fragments
   that merely mention `</body>`/`</head>` in a JS string or CSS value, so the final
   design only unwraps when the output **clearly** starts with `<!doctype`/`<html>`
   (greedy body extraction); a genuine fragment passes through untouched. The
   sandbox (no `allow-same-origin`) + this shell's CSP is the boundary, not the
   unwrapping. 17 adversarial `injectGuard` assertions pass.

## Codex code-review trail (2 rounds → converged)

**Round 1** — 9 findings (2 High, 5 Med, 2 Low), FIX-THEN-SHIP. Adopted: failed/
rejected paid calls now always ledgered with a `status`; demotion-window auth gate
(delta 1); `injectGuard` corruption fix (delta 2); API-key check moved into generate;
opaque client errors (no Anthropic/Firebase leak); archive errors surfaced; CSP meta
ordered first. **Pushed back** (context-grounded): save-stores-client-HTML provenance
(sandboxed + 5 trusted editors + separate authoritative spend ledger) and
library-read active-gating (the whole repo reads editor data on `role != null`; reads
aren't spend).

**Round 2** — all 9 prior findings CONFIRMED; 3 new (1 Med, 2 Low), all adopted:
synchronous `abortRef` re-entry guard + unmount-abort (prevents double-billing on
double-click/cancel-then-generate); greedy full-doc body extraction; resilient ledger
write (retry + log, never discards a successful generation). Trend 2-High → 0-High.

**Convergence:** severity collapsed; remaining bug class is **input-bound** — the next
defects only surface by running real Opus generations through the deployed endpoint
with real auth (the Vercel-preview ship gate), not by reviewing the abstraction further.

## Verification done

- `node --check api/motion-graphics.js` ✓ · `npx vite build` ✓ (EditorDashboard bundle compiles the new subtab).
- `injectGuard` unit assertions (17) ✓ — CSP-first-in-head, no-corruption of fragments
  mentioning `</body>`/`</head>`, full-doc unwrap strips the model's CSP and keeps only
  ours, greedy extraction, fence handling, oversize/empty rejection.
- In-browser (preview): the exact CSP+shell renders a CSS/JS animation in
  `sandbox="allow-scripts"`, DM Sans loads, the sandboxed iframe is unreadable from the
  parent (isolation), and an inline `fetch()` to an external URL is **BLOCKED** by the CSP.
- **Not verifiable locally** (no `vercel dev`; SSO-gated): the live generate→save→library
  round trip through the endpoint with real auth. Verifies on the Vercel preview deploy.
