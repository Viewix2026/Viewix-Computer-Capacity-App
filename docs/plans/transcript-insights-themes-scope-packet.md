# Scope Packet — Transcript Insights Lab: Canonical Themes

**Status:** Gate 2 PASSED 2026-06-13 — shipping. Post-deploy: verify
`meta/themeBackfill.missingAfterRun === 0` (1–3 hourly cron runs), then dump
+ eyeball the per-theme distribution (revisit classifier if `otherCount`
>10%).

## Codex code-loop trail

- **Round 1:** 3 findings (1 Med / 2 Low), FIX-THEN-SHIP — zero
  Critical/High (the two plan-loop rounds pre-hardened the design).
  - ADOPTED (Med): phase-2 sweep starvation — phase 1 now reserves
    headroom directly (`msLeft() < 90s` stops starting extractions)
    instead of a fixed 240s deadline an overrunning call could blow past.
  - ADOPTED (Low, cheap half): CLASSIFY_SYSTEM_PROMPT exported + smoke
    test (every key listed, no unrendered `${}` placeholders, JSON example
    shape intact). Cron-arithmetic mocking deferred — network/RTDB-bound,
    marginal value.
  - DEFERRED (Low): an all-"other" classifier response passes the quality
    gate by design (monitoring-not-blocking: visible as a giant
    Uncategorised group + `otherCount` in meta). Trigger to revisit:
    backfill `otherCount` >10% at post-deploy verification.
- **Convergence:** stopping rule met at round 1 (no Critical/High).
  Verification: 12/12 unit tests, vite build green. Clean per review:
  taxonomy module, ESM import boundary, mutateRecord guard, prompt
  rendering, merge pre-read scoping, severity/sources logic.

## Implementation deltas (vs approved plan)

- Theme-group headers show item count, ×Σweight (total mentions) and
  per-severity counts; Σ score drives the sort but isn't displayed (raw
  weight×multiplier is meaningless to readers). Display detail only — not
  a Gate-1.5 material deviation.
- Browser-preview verification skipped: the lab is SSO + role gated;
  visual sign-off = Gate 2 + Jeremy's prod eyeball per Done criteria.

## Codex plan-loop trail

- **Round 1:** 12 findings (7 High / 4 Med / 1 Low), BUILDABLE_AFTER_FIXES.
  Adopted 10 (cron time budget, meta child-path writes, permanent sweep not
  one-shot, cross-type merge validation, classifier output contract,
  `${type}:${theme}` group keys, per-batch failure recovery, merge-bar
  titles, severity-count headers, taxonomy decision rules, src/lib module
  placement). Pushed back 1 ("mutateRecord doesn't exist" — it's at
  api/_fb-admin.js:95; Codex wasn't shown that file).
- **Round 2:** 8/12 priors CONFIRMED, 4 WEAK (all refined in text: phase-1
  loop time check, pre-read merge validation, classifier 20% quality gate,
  search clears merge selection); 1 new High (verification wording
  contradicted the 1–3-run budget — fixed), 2 Med (phrasing + preflight
  audit — audit run against the prod dump: zero merges ever, clean), 2 Low
  non-issues (sweep scale accepted at SMB volume; vercel.json confirmed
  coherent).
- **Convergence:** severity trend 12(7H) → 5 new(1H, textual). Round-2
  findings were dominated by refinements of round-1 fixes (self-churn), no
  design-level defects remained; remaining risk (classifier quality on real
  data) is input-bound — validated at the post-deploy eyeball gate, not by
  more plan review.
**Created:** 2026-06-13
**Branch/PR:** TBD

## Outcome

Each of the three categories (Objections, Pain Points, Content Ideas) collapses
into a small set of canonical themes (e.g. Money, Timing, Trust/Proof, Niche
clarity), ranked by weighted frequency. Clicking a theme drills down to the
underlying real examples and their specific coaching advice. Simplified top
level, evidence preserved underneath. "I'm bootstrapped" rolls up under the
Money theme instead of living as its own card among 464.

## Out of scope (this round)

- Theme-over-time trend charts
- Any in-app UI for managing/editing the theme list
- Re-mining transcripts from scratch

## Done looks like

- All existing insights (~464) classified into themes, near-zero left
  uncategorised
- Themes view renders in both the Founders subtab and the read-only Training
  mirror
- The next analysed call auto-classifies its new insights into a theme
- Jeremy sanity-checks the top themes per category before ship

## Hard constraints

- Layer on the existing pipeline: reuse the inline Sonnet pass and self-heal
  cron; `theme` becomes an added field on insights
- Training mirror stays read-only
- No new infra

## Resolved decisions

- **Outcome shape:** themes-with-drill-down (not flat consolidated cards, not
  tag-only grouping) — keeps the per-call coaching advice as evidence under a
  simplified top level.
- **Migration:** existing items ARE reclassified (not forward-only).
- **Taxonomy origin:** LLM drafts candidate themes per category from the
  existing data; Jeremy edits/approves the list at the plan gate (Gate 1); after
  that the list is fixed in code and classification is deterministic against it.

## Open decisions

- (populate during exploration/planning)

## Draft plan (pre-Gate 1)

### Candidate taxonomy (drafted from the real 464 items, 2026-06-13 prod pull)

Every theme also gets an implicit `other` fallback per category (rendered as
"Uncategorised", sorted last). Slugs are stable keys stored on records; labels
are display-only.

**Objections (92 items → 8 themes)**

| slug | label | covers |
|---|---|---|
| `money` | Money & budget | bootstrapped / pre-revenue, sticker shock, budget ceiling, no budget allocated, thin margins, discount fishing, retainer-vs-one-off price confusion |
| `timing` | Not yet / no urgency | offer still being built, waiting on premises/launch/leave, pure exploration mode, soft timelines, "putting out feelers" |
| `authority` | Someone else signs off | spouse/partner veto, CEO/board approval, silent investors, enthusiastic gatekeeper with no authority |
| `trust-proof` | Show me proof | needs case studies / ROI evidence, first-time-buyer anxiety, no sector-specific examples, doubts agency fits their vertical |
| `competition` | Competitors & alternatives | shopping other agencies, cheaper rival quotes, incumbent freelancer/videographer/media buyer, "AI tools can do this" |
| `commitment-risk` | Commitment & risk | lock-in fear, retainer rejected (wants one-off test), starter-pack-first instinct, fear of sinking a shoot into unproven messaging |
| `scope-fit` | Scope & fit | wants more than video (holistic marketing), wants less (locked brief, filming only), package confusion, single-vendor preference, production-logistics friction (locations, talent, footage ownership, confidentiality) |
| `stalling` | Stalls & evasion | "send me the document", "leave it with me", vague catch-up next steps, dodging live decision calls, async-only comms |

**Pain Points (164 items → 10 themes)**

| slug | label | covers |
|---|---|---|
| `lead-flow` | Leads dried up / growth stalled | feast-or-famine, referral ceiling, enquiries stopped, local invisibility, can't scale past word-of-mouth |
| `bandwidth` | Owner has no time | owner-operator at capacity, self-filming/editing, can't nurture leads, content falls off when busy |
| `diy-quality` | DIY content undermines the brand | low-fi/AI content reads cheap against a premium offer, fear of embarrassing first impression |
| `ad-performance` | Paid funnel underperforming | high CPL, creative fatigue, clicks without conversions, wrong-fit leads, boosting instead of campaigns, website not converting |
| `invisible-value` | Offer invisible or hard to explain | complex intangible service, market doesn't know full scope, USP lost in commodity comparison, two-sided audience messaging |
| `credibility-gap` | Thin online presence erodes trust | dormant socials, faceless brand, no testimonials, fails tender/credibility checks, profile "looks spun up yesterday" |
| `vendor-failures` | Burned by past agencies/vendors | no transparency, wrong-audience content, zero creative strategy, agencies refusing video, unusable assets |
| `org-blockers` | Internal & regulatory blockers | head-office control, franchise budget holders, compliance (AHPRA/ASIC/legal review), fragmented stakeholders, split budgets |
| `deadline-pressure` | Hard deadline / launch pressure | fixed events, recruitment windows, market-entry dates, learning-phase math compressing production |
| `measurement` | Can't measure / prove ROI | no conversion tracking, offline attribution gaps, mixed paid/organic reporting, must justify ROI upward to non-marketing directors |

(Resolved at Gate 1: `measurement` promoted to its own theme — 10 pain
themes total. Disambiguation: can't PROVE value → `measurement`; can't get
PERMISSION/approval → `org-blockers`.)

**Content Ideas (208 items → 8 themes)**

| slug | label | covers |
|---|---|---|
| `hooks-formats` | Hooks & creative formats | contrarian hooks, pattern interrupts, split screens, match cuts, named series formats, platform-specific tone |
| `proof-stories` | Proof points & case studies | client results (137% lift, 76% CPL cut), before/afters, sceptic-to-believer arcs, testimonial formulas |
| `roi-math` | ROI & funnel math | live calculators, reverse-engineered revenue closes, LCTR/benchmark explainers, "one booking pays for itself" |
| `positioning` | Viewix positioning angles | production company vs agency, performance-marketer framing, local vs offshore/AI, honest capability admissions |
| `founder-authenticity` | Founder-led & authenticity | founder on camera, authentic environments vs polish, camera-shy workarounds, low-fi-beats-produced stories |
| `education-explainers` | Education & explainer angles | demystifying processes (auctions, off-plan), comparison explainers, regulatory tailwinds as hooks, niche education |
| `sales-technique` | Closing & call techniques | live audits as trust builders, deposit-link-on-call close, urgency frames, graceful disqualification, champion coaching |
| `org-strategy` | Organic/paid strategy frameworks | organic-first sequencing, boost-and-test, post-ID social-proof carryover, funnel-stage campaign structure, compliance copywriting |

### Technical plan

**1. Taxonomy module — `src/lib/insightThemes.js` (new)**
Plain-data ESM module (ZERO imports, no secrets, pure constants): `THEMES =
{ objection: [...], painPoint: [...], contentIdea: [...] }` with `{ key,
label, blurb }` per theme, plus `validTheme(type, key)` and `OTHER_KEY =
"other"`. Lives on the src/ side so the client bundle can never be poisoned
by a server-only import creeping in; the api/ files import it via relative
path (Vercel's tracer follows the import, plain ESM, no node deps). Blurbs
double as the classifier's decision rules, so each includes explicit
boundary disambiguation, e.g.:
- `trust-proof` vs `competition`: a named rival/incumbent/alternative in
  play → `competition`; asking for evidence/examples/case studies →
  `trust-proof`.
- `scope-fit` vs `org-blockers` (pain): friction about what Viewix
  does/delivers → `scope-fit`; friction inside the prospect's own org
  (approvals, compliance, head office) → `org-blockers`.
- `commitment-risk` vs `money`: "can't afford it" → `money`; "can afford it
  but won't lock in / wants a small test" → `commitment-risk`.

**2. Extraction prompt — `api/_transcript-insights.js`**
- Append the per-type theme list (key + blurb) to `EXTRACTION_SYSTEM_PROMPT`.
- New items must return `"theme": "<key>"`; server validates with
  `validTheme(type, key)`, falls back to `"other"`. Increments inherit the
  existing item's theme — no write needed. (An increment landing on a
  still-unthemed item during the transition window stays unthemed and is
  picked up by the next hourly sweep — see 3.)
- New export `classifyInsightThemes(items, apiKey)`: batch classifier (one
  Sonnet call per ≤40 items, input = id/type/title/description, output =
  strict JSON `{id → theme}`). Output contract enforced in code: response
  must be a plain object with string values; parsed ids must be ⊆ the
  batch's ids (unknown ids dropped + logged), every value must pass
  `validTheme` for that item's type (invalid → `"other"`, counted),
  malformed JSON → that batch writes NOTHING and is retried next run.
  **Quality gate:** if >20% of a batch's entries are invalid/unknown, fail
  the whole batch (no writes) — parseable garbage must not bulk-write
  `"other"` at scale. The run summary reports `otherCount` so a junk
  classifier shows up in numbers, not silently as "0 missing".

**3. Backfill sweep — `api/cron/transcript-insights-selfheal.js` (phase 2)**
A PERMANENT second phase after the existing extraction scan (mirrors the
self-heal philosophy: hourly sweep, idempotent, self-quieting — not a
one-shot migration gated on a done flag):
- Scan `/transcriptInsights/items` (any status) for records missing `theme`;
  zero missing → no-op (one read, no model calls). Reading all items hourly
  is intentionally accepted at SMB volume (~460 items, single-digit daily
  growth); revisit only if the KB approaches five figures.
- **Shared time budget** (round-1+2 Codex findings): the function has 300s
  total and phase 1 can already burn ~15 Sonnet calls. Track elapsed ms
  from handler start; **the phase-1 extraction loop also checks it** (no
  new extraction call starts past ~240s — today nothing stops phase 1
  consuming the full window), phase 2 runs only with ≥60s remaining and
  stops batching at ≤30s left. 464 items = 12 batches of ≤40, so the
  backfill likely takes 1–3 hourly runs depending on phase-1 load — the
  sweep makes pace irrelevant. (A single hung Anthropic fetch can still
  blow the 300s wall — pre-existing failure mode, unchanged by this
  feature, healed by the next hourly run.)
- Classify in batches of ≤40 via `classifyInsightThemes`; per-batch
  try/catch (a failed batch is logged and naturally retried next run via
  the missing-theme scan — no resume bookkeeping needed).
- Write per item via `mutateRecord` (exists: `api/_fb-admin.js:95`) with the
  guard `cur.theme ? abort : set` — never clobbers a theme set concurrently
  by the inline extraction path.
- Meta stamping via **child-path writes** (`adminPatch` on
  `/transcriptInsights/meta`), NOT the current whole-object `adminSet` —
  which today would wipe any sibling key every hour. Fix the existing
  `backlogDrained` write to `adminPatch` in the same touch. Stamp
  `meta/themeBackfill = { at, classified, otherCount, missingAfterRun }`.
- No manual button, no new endpoint, no vercel.json change.

**4. UI — `src/components/TranscriptInsightsLab.jsx`**
- Default render becomes theme groups keyed by **`${type}:${themeKey}`**
  (themes are per-type; a bare-theme key would collapse the three `other`
  groups across categories). Header row per group: type badge (visible in
  All), theme label, item count, Σ score, per-severity counts (explicitly
  "max" semantics — no single ×1-high item silently branding a whole theme);
  groups sorted by Σ score desc; click to expand into the existing insight
  cards (which keep expand-for-sources, archive/merge controls in founders
  view).
- Category pills unchanged.
- Active search flattens to the current flat card list (results never hide
  behind collapsed groups).
- Missing/`other` theme renders in an "Uncategorised" group, last.
- `readOnly` mirror behaviour unchanged — same component, controls hidden.
- Merge selection: only same-`type` pairs selectable (second pick of a
  different type disabled); merge bar shows the selected items' titles so a
  selection inside a later-collapsed group stays visible; selection clears
  on filter/tab change AND on search-query change (search is a filter —
  today it doesn't clear `mergeSel`).

**5. Merge endpoint hardening — `api/transcript-insights.js`**
(Plan originally left this untouched; round-1 Codex found a real
pre-existing hole that themes make worse.) Server-side validation: merge
requires `survivor.type === loser.type` (409 otherwise), checked via a
**pre-read of both records BEFORE the loser-archive transaction** — the
current code archives the loser first, so a late check would strand an
archived loser on a rejected merge. `type` is immutable after creation, so
the pre-read check is race-free; the existing transactions still re-check
active status. Cross-type merges today already corrupt the KB semantically
(objection evidence folded into a content idea); with themes they'd also
corrupt theme grouping. Survivor keeps its own theme — same-type
cross-theme merges remain legal and are the founder's call.
(Audited 2026-06-13 prod dump: `mergedFrom` is empty on all 464 items — no
merge has ever been run, so no pre-existing cross-type corruption to
repair.)

**6. Untouched**
`firebase-rules.json` (server-only writes stay), vercel.json, RTDB paths,
`api/meeting-feedback.js` (inline trigger passes through unchanged — theme
handling lives entirely inside `extractAndMergeInsights`).

**7. Verification**
- `npm run build` green; preview deploy green (prod verify after merge —
  preview URLs are SSO-walled).
- Once the sweep reports `meta/themeBackfill.missingAfterRun === 0` (likely
  1–3 hourly runs depending on phase-1 load — NOT necessarily the first
  run): re-run the read-only dump, assert 0 items missing `theme`, and
  report the per-theme distribution + `otherCount` for the eyeball check.
- Next analysed sales call writes a themed insight (observe via dump or UI).

### Open decisions (for Gate 1)

- Promote measurement/attribution pains to a 10th `measurement` theme, or
  leave folded into `org-blockers`? (Draft folds them in.)
- Theme list final wording — Jeremy edits labels/blurbs freely at the gate;
  slugs become permanent after first classification run.

## Approved plan

Approved at Gate 1 (2026-06-13): the "Draft plan (pre-Gate 1)" section above,
verbatim, including the post-loop hardening and the 10-theme pain taxonomy
(`measurement` promoted). Jeremy approved without edits.

## Implementation deltas

- (only if the build deviates; logged via Gate 1.5)
