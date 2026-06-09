# Enterprise Proposal Generator (`viewix-enterprise-proposal` skill)

## Context

Viewix wins enterprise/blue-chip work one-off via PO (not retainers — see the enterprise
recurring constraint). After a **proposal call** (the enterprise equivalent of the discovery /
content-blueprint call), the prospect should receive a **bespoke, designed proposal** tailored to
their brief — not the current generic "Content Blueprint" capabilities deck.

The current Viewix deck is a strong **top-of-funnel capabilities brochure + price menu**: it lists
everything Viewix does and every package price, with only "PREPARED FOR [client]" personalised. For
an enterprise proposal call that is the wrong instrument — it reads as a vendor menu.

The competitor benchmark (WeMOV's "ACCIONA x Graduate Program" deck) is a 16-page **consultative,
bespoke proposal**: opens with the client's situation, proposes a tailored approach, shows concrete
video concepts each backed by a named past-work reference, lays out a production plan + media
library, and closes with three investment tiers scaled to the brief.

**Goal:** a repeatable system where Claude **assembles** a branded, bespoke enterprise proposal —
structured like WeMOV's deck but filled with Viewix's harder proof and broader "content system"
positioning — as a **native, editable Google Slides deck**, turning a multi-hour bespoke build into
a quick draft-then-tweak.

## Output & shape (the core decision) — PIVOTED to an HTML engine

> **Pivot (post-design, Codex-reviewed):** the original plan was a native Google Slides deck. Jeremy
> designed the look in Claude Design and it came back as a **production-quality HTML deck** with a
> working PDF export engine (`deck-stage.js`, 1920×1080, one page per slide). A manual Slides rebuild
> would be lossy (gradients, type scale, the look-switcher all die) and non-repeatable. So the output
> is now the HTML engine, not Slides. (Jeremy confirmed both this and Viewix's own tier ladder.)

- **Master template = the Claude Design HTML deck** at
  `docs/plans/proposal-mockups/claude-design/enterprise-proposal/project/Viewix Enterprise Proposal.html`
  (11 slides, brand-exact, `deck-stage.js` stage + export engine, `.fld` variable-field markers, a
  5-way moodboard "look" switcher hidden in export).
- **Per-client run:** fill the keyed variable fields (see fill contract) → render a pixel-perfect
  **PDF via a headless browser** (Puppeteer/Playwright; `deck-stage.js` already paginates one slide
  per page and freezes entrance animations). No per-client design work — the design is fixed.
- **Editability:** Jeremy edits the *data* (or the HTML) and re-renders; the dotted `.fld` markers
  show in author mode and are stripped in export. A **Google Slides mirror is deferred** — addable
  later if a client needs to co-edit, but not the master.
- **Tiers:** Viewix's own **Standard / Signature / Flagship** (the first design copied the
  competitor's Essential/Advanced/Maximum Impact at their exact prices — fixed). Dollar amounts
  founder-set per client; never the competitor's numbers.
- **Runtime requirement:** an interactive Claude Code / cowork session with **Attio MCP** (identity)
  and Node + a headless browser for render. Fallbacks: pasted transcript, manual brief mode, local
  logo path.
- Honest framing (per Codex): a **proposal assembler with guardrails**, not an auto-generator. Speed
  over hand-building is preserved by manual brief mode + the fill→render pipeline.

## Honest framing (what fills the deck)

Codex round 1 established the "auto-fill from the deal" headline was oversold: at proposal stage the
Attio deal isn't won, so scope/destinations/audience are likely empty, and the `/meetingFeedback`
record is a sales-coaching score, not a project brief. So:

- **Attio supplies identity only** — company name, primary contact, deal value as a *signal*.
- **The raw proposal-call transcript is the substance.** Claude extracts a structured brief from it,
  recording the source behind every client *fact* (their situation, goal, audience). Viewix's
  *approach and concepts* may be generative but are flagged `draft`.
- **No-transcript / thin-transcript path (manual brief mode):** when the call wasn't recorded or the
  transcript is sparse (common for a first enterprise call), the skill drops to a short structured
  question set Jeremy answers directly; answers are stored as `founder_confirmed` facts. The skill
  never fills a hollow deck off a thin transcript.

## Decisions locked

- **Data source:** raw transcript (pasted, or from `/meetingFeedback` /an Attio note) as substance;
  Attio deal/company/person as identity context. → structured `proposal_brief.json`.
- **Proof references:** a curated **reference index** (JSON) seeded from
  `https://viewix.com.au/portfolio/`, with **local thumbnail assets** where used. Explicit no-match
  fallback (below).
- **Pricing:** three tiers, good/better/best. Claude drafts tier **structure + inclusions**; **dollar
  amounts are founder-supplied/confirmed — never invented** (drafted figures are visibly marked in
  the slide for confirmation). Tier names reuse Viewix's existing ladders, chosen by product line:
  - Brand / corporate (enterprise default): **Standard / Signature / Flagship** (Brand Movies ladder).
  - Social: **Starter Pack / Brand Builder / Market Leader / Market Dominator** (4-rung — the deck
    always presents **exactly three** tiers, so the skill picks the three rungs nearest the budget
    signal).
  - Meta Ads: **Standard / Premium / Deluxe**.
  Product line is inferred from the brief/transcript, not a deal field; when unknown it **defaults to
  the Brand Movies ladder**. `productLine` + resolved tier names are written into the brief.
- **Creative Direction slides:** a **curated "look" library** baked into the template — 3-4
  art-directed visual-style presets (e.g. Cinematic Corporate, Energetic Social, Interview-led Doc)
  built from real Viewix frame-grabs. **Selection:** match preset to brief signals (tone, sector,
  deliverable mix), record `matchedSignals` + rationale; **default to Cinematic Corporate when
  enterprise tone is ambiguous**; Jeremy can swap it in Slides.

## Deck structure (Viewix-ified WeMOV)

1. **Cover** — company name + logo (Drive/founder-supplied, else clean text-only), project title, date.
2. **The Brief / Overview** — the client's situation + goal in their words (from transcript).
3. **Our Approach** — 3-4 tailored pillars (generative, flagged draft).
4. **Creative Direction** — chosen "look" preset (curated frame-grabs) + visual key.
5. **Content Concepts** — 3-4 concepts, each with a named portfolio reference (local thumbnail, else
   designed text reference block) + a stated relevance rationale.
6. **Production Plan** — creative development → content days → managed media library → outputs.
7. **Media Library** — masters / selects / string-outs / transcripts (parity with WeMOV).
8. **Investment** — three tiers, structure auto-drafted, dollars confirmed by Jeremy.
9. **Proof** — approved headline stats + named case studies (usage-appropriate).
10. **Viewix system edges** *(differentiator)* — comments-to-leads, monthly boosting, AI production,
    200+-reel research. Reframes "a video project" as "a content engine."
11. **Next steps / partner close** — five-step path + "dedicated production partner".

## The fill contract (`proposal_brief.json`)

The skill extracts to a single structured file the Slides fill reads from. It is
**slide-addressable** — one section per deck slide plus shared meta — so the fill never improvises:

- `meta` — `client`, `contact`, `projectTitle`, `date`, `productLine`, `tierLadder`, `logoPath`.
- `cover` / `brief` (`problem`, `business_goal`, `audience`) / `approach` / `creativeDirection`
  (`lookPreset`) / `concepts[]` / `productionPlan` / `mediaLibrary` / `investment` (`tiers[]`) /
  `proof` (`proofClaimIds[]`) / `systemEdges` / `nextSteps`.
- **Facts are objects** — `{ value, sourceType: transcript|founder_confirmed|attio_identity,
  sourceSnippet?, confidence }`. `founder_confirmed` is the escape hatch for true facts not in the
  transcript (avoids dropping real facts). Generative fields carry `status: draft`.
- `tiers[]` — structure + inclusions; **dollar fields blank/marked until confirmed**.
- `concepts[]` — `{ idea, referenceClient, referenceId, relevanceRationale, thumbnailPath? }`.
- `creativeDirection.lookPreset` — `{ id, rationale, matchedSignals[] }`.

Jeremy's edits happen **in the generated Slides deck**, not in JSON — the brief is the fill input,
Slides is where he reviews and tweaks.

## Build plan

### Phase 0 — Claude designs the master template (one-time)

**Human checkpoint before build** — direction is approved *before* the expensive template build, so
we never build the wrong thing.

- **0a — Design direction (fast, visual):** Claude produces **2-3 distinct visual concepts** of the
  key slides (cover + Brief + a Content Concepts slide + Investment) as rendered mockups Jeremy can
  see (not a written brief — judged by eye). Jeremy picks a direction or gives notes. Low investment,
  before any Slides API plumbing. Uses the locked brand tokens: blue `#0082FA`, orange `#F87700`,
  navy `#004F99`, light `#F4F5F9`, Montserrat; logos from `public/viewix-logo.png`.
- **0a-design — Jeremy designs the look in Claude Design:** the three quick HTML mockups
  (`docs/plans/proposal-mockups/`) were directional only. Jeremy takes the visual ceiling higher in
  Claude Design using `docs/plans/proposal-mockups/claude-design-brief.md`, against the ACCIONA
  example, and hands back exported slides (PDF/images) + artifact code + the type scale/grid.
- **0b — Rebuild as the master template:** Claude reconstructs the approved Claude Design look as the
  reusable Google Slides master template (Slides API), with placeholder tokens for every variable
  field and the look presets baked in. The brief constrains the design to Slides-translatable
  elements (solid fills, simple gradients, Montserrat, image placeholders) so the rebuild is faithful.
  Jeremy signs off on the finished template once.

### 1. Reference index + thumbnails (one-time seed)
- `skills/viewix-enterprise-proposal/data/portfolio-references.json` —
  `{ client, industry, conceptType, sourceUrl, thumbnailPath?, result?, approvedForDeck, altText,
  lastReviewed }`. Hand-curate ~15-25 enterprise-relevant entries (Clayton Utz, SIG, AAGE, Prosple,
  Transgrid, WSA, Snowy Hydro, BMD Aerowest, Austmine, IMARC, Sydney Zoo, etc.) with real local
  thumbnails where used. Maintenance: refresh after major portfolio updates (no automation).

### 2. Proof claims
- `skills/viewix-enterprise-proposal/data/proof-claims.json` — `{ id, claim, source, context,
  caveat? }`. **Source of truth for the Proof slide's stats/case-study copy**
  (portfolio-references owns *concept* references — no overlap). Brief's `proofClaimIds[]` references
  by `id`.

### 3. Skill scaffold
- `SKILL.md` — trigger phrases ("enterprise proposal", "proposal deck for [client]"), inputs (Attio
  deal id / company name, transcript or manual brief mode), runtime requirement + fallbacks, flow.

### 4. Context gathering
- **Attio MCP** (identity only): company + contact + deal value signal. Reuse extractors in
  `shared/attio-extract.js`.
- **Logo:** prefer Google Drive brand-asset folder or founder-supplied path; validate size /
  transparency / aspect; on fail, clean text-only treatment (no favicon scraping).
- **Transcript:** pasted, or from `/meetingFeedback` / an Attio note (raw transcript, not the sales
  analysis). If absent/thin → manual brief mode.

### 5. Brief synthesis (Claude → `proposal_brief.json`)
- Extract client facts with source + confidence; flag missing required fields (route to manual brief
  mode rather than filling a hollow deck). Draft approach/concepts/tier structure as `status: draft`.
  Match each concept to a reference via the fallback hierarchy.

### 6. Fill + render (HTML engine — see Templatization build)
- Fill the keyed `data-field`s in the HTML master from `proposal_brief.json`, insert reference images
  + the selected look-preset, run the preflight (no leftover client tokens / stray placeholders),
  then render to PDF via headless browser using `deck-stage.js`'s one-slide-per-page print path.
  (Google Slides mirror deferred.)

## Reference no-match fallback hierarchy
1. Same industry + same concept type. 2. Same concept type, adjacent industry. 3. Same audience or
production challenge. 4. Strong general blue-chip proof. 5. No reference block (never faked/empty).
Claude must state the relevance rationale for whichever tier it lands on.

## Post-fill checks (light — output is editable, so non-blocking)
Claude surfaces a short "check these in the deck" note after filling: unconfirmed tier prices, the
logo, any low-confidence/`draft` fields, the look-preset choice. Plus mechanical sanity: every token
replaced (no stray `{{placeholder}}`), every image inserted (no empty frames), references carry a
rationale, proof claims resolve to real ids.

## Deployment (Mac mini worker, dashboard button, Firebase job queue)

Decided with Jeremy: initiated by a **button in the Viewix Dashboard**, rendered on the **always-on
Mac mini**, connected via a **Firebase RTDB job queue** (no inbound networking to the mini).

**Topology**
- **Vercel dashboard** = trigger + live status UI only (serverless can't run headless Chrome).
- **Mac mini** = always-on worker: Node + Google Chrome + firebase-admin + Attio access. Makes only
  *outbound* connections (to Firebase + Attio) — no exposed port, no tunnel, survives dynamic IP.
- **Firebase RTDB** = the message bus between them (reuses the dashboard's existing real-time sync).

**Flow**
1. Dashboard "Generate Proposal" button on a deal/account → writes `/proposalJobs/{id}` =
   `{ dealId, companyId, status: "queued", requestedBy, createdAt }`.
2. Mini worker watches `/proposalJobs`, claims a queued job via a transaction (idempotent; reboot-safe),
   assembles the brief (Attio identity + proposal-call transcript → `proposal_brief.json`), runs
   `generate.mjs` → PDF, uploads it, writes back `{ status: "ready", pdfUrl }` (or `error`).
3. Dashboard listener flips the status chip queued → generating → ready and shows the download link.

**To build (when ready — a `make-a-feature` candidate, do not build until Jeremy says go)**
- *Dashboard:* a `GenerateProposal` button (own component per code-style), a `/proposalJobs` write,
  a status chip + download link bound to the job.
- *RTDB rules:* `/proposalJobs` writable by founders/closer; mini service account full access.
- *Mini worker:* `skills/viewix-enterprise-proposal/worker.mjs` — firebase-admin child listener,
  transactional job claim, brief assembly, `generate.mjs`, upload, error/retry; kept alive via
  `launchd` (restart on reboot).
- *Mini setup:* clone repo, Node 18+, Google Chrome, firebase-admin service-account creds, Attio key.

**Open build-time decisions:** PDF storage (Firebase Storage signed URL vs Google Drive); whether the
button passes a pre-filled brief or the worker auto-assembles it (the latter = the Attio+transcript
auto-fill build, which the button's value depends on); concurrency cap on the worker.

## Out of scope (later phases)
- Dashboard "Generate proposal" button on a project/account (Phase 2 hybrid).
- Trackable shareable link with open analytics (Slides already gives a shareable link).
- Slack trigger to kick off generation.

## Verification
- **Phase 0a:** Jeremy picks one of the 2-3 design-direction mockups (or gives notes) *before* any
  template build — the human checkpoint.
- **Phase 0b:** Jeremy eyeballs the finished master template vs the WeMOV deck and signs off.
- Run against a real enterprise prospect: paste transcript (or use manual brief mode) + Attio
  identity; confirm the brief extracts, missing fields route to manual mode, and the filled Slides
  deck opens cleanly.
- Confirm unconfirmed prices render as obvious "confirm me" markers; confirm logo fallback works with
  a deliberately missing logo; confirm no stray `{{tokens}}` or empty image frames.
- Generate a second proposal for a different industry to confirm reference-matching, look-preset
  selection, and tier structure vary correctly (repeatability check).

## Codex review trail
- **Round 1** (plan): 12 findings (2 Critical, 6 High, 4 Medium). Verdict BUILDABLE_AFTER_FIXES.
  Adopted the reframe to transcript-driven + cited facts (Attio = identity only), founder-confirmed
  prices, Drive/supplied logo + text fallback, local thumbnails / text blocks + no-match hierarchy,
  the brief contract, and a QA pass; adopted lightly index metadata, runtime declaration, lightweight
  proof claims. Pushed back on a heavy per-claim permission engine. Resolved the creative-slides fork
  via a curated look-preset library.
- **Round 2** (revised plan): 8 prior fixes CONFIRMED, 4 WEAK, 0 regressed; 7 new findings (0
  Critical, 4 High, 2 Medium, 1 Low). Adopted all 7: slide-addressable schema (incl. product line +
  tier names + always-3-tiers), facts-as-objects with the `founder_confirmed` escape hatch, manual
  brief mode, look-preset selection logic + default, a review packet, and proof-claims as the Proof
  slide source of truth. Severity trend 12 → 7, Criticals 2 → 0 — **converged** (remaining surface is
  input-bound, best validated against a real transcript + render).
- **Post-review pivot** (per Jeremy): output changed from a locked PDF to **Claude designing the
  master template**, which Jeremy then took into Claude Design himself to push the visual ceiling.
- **Round 3** (design artifact review — the Claude Design HTML deck): 12 findings, verdict
  REWORK_NEEDED *to be a template*. The deck is high-quality (Codex praised the `deck-stage.js`
  export engine + type scale as worth preserving) but had two classes of problem:
  - **Competitor copying (Critical/High):** Investment shipped WeMOV's exact tier names
    (Essential/Advanced/Maximum Impact) + exact prices ($20k/$35k/$50k) + day-counts; Creative
    Direction lifted WeMOV's visual key and used the banned word "cinematic". **Fixed now:** tiers →
    Standard/Signature/Flagship, prices neutralised to founder-set placeholders, "cinematic" →
    "scroll-stopping". (Creative-direction visual-key rewrite still pending.)
  - **Static deck, not a template (Critical/High):** `.fld` markers have no keys (started fixing —
    added `data-field` on tier name/price), most client copy is unwrapped, hardcoded
    ACCIONA/"Graduate Program" tokens, fixed 4-pillar/4-concept grids + pixel heights, markers show
    in export, look-switcher persists in localStorage. All adopted; these are the templatization
    build (below).
  - **Two forks resolved:** output path → **HTML engine → auto PDF** (Codex: manual Slides rebuild is
    a fidelity-destroying dead end); tier naming → **Viewix's own ladder**.
  - **Round 4 (re-review) runs after the templatization build lands** — re-reviewing the static deck
    now would just re-find the same gaps. Plus: verify the "23+ years" proof claim before any external
    send.

- **Round 4** (templatized system + engine code): 6 findings (1 High, 3 Medium, 2 Low), verdict
  FIX-THEN-SHIP. Round-3 fixes CONFIRMED (one WEAK: some copy still author-edited). Adopted &
  **fixed now:** script-injection in `generate.mjs` (escape `</script>` + U+2028/9), repeat
  missing-field leak (fill.js clears unprovided fields), `<br>`-only sanitiser on `data-field-html`,
  IIFE export guard, keyed the recruitment-specific Next Steps tagline, copy-fit length warnings.
  **Pushed back:** Codex's broad `graduate|recruitment|qualified leads` preflight regex — Transgrid
  *is* a recruitment client, it would false-positive; and "qualified leads/cost per click" are
  Viewix's own offering language, not client-specific.
- **Severity trend: 12 → 7 → 12 → 6**, Criticals now 0, only edge-hardening left. **CONVERGED** —
  Codex called it strongly converging; the generator works end-to-end (ACCIONA + Transgrid, 3 and 4
  concepts both render clean 11-page PDFs). Remaining items are input-bound (real briefs, overflow
  tuning) + the deferred Creative-Direction visual-key Viewix rewrite.

## Templatization build (turns the HTML deck into the real template)
1. **Key every variable field** — `data-field="..."` on all client-specific text (not just tiers):
   cover promise, brief paragraphs, success criteria, pillar copy, concept names/descriptions/refs,
   tier inclusions, proof claims, close copy. Plus `data-repeat` for variable-count sections.
2. **Data-bound render** — fill from `proposal_brief.json` (the keyed fields map to it); a preflight
   that **fails export if any ACCIONA/old-client token or stray placeholder remains**.
3. **Variable-count layouts** — Approach (3–4 pillars) and Concepts (3–4 cards) with layout variants;
   clamp/flow long copy; auto-fit long company names (kill `nowrap` overflow).
4. **Export mode** — `body.export` strips `.fld` dotted markers; moodboard look set as an explicit
   build parameter (not localStorage); drop `backdrop-filter` from exported output.
5. **Fill → PDF pipeline** — Node + headless browser (Puppeteer/Playwright) renders the filled deck
   to PDF via `deck-stage.js`'s existing one-slide-per-page print path.
6. **Creative-direction rewrite** — replace WeMOV-derived visual-key language with Viewix's own.
