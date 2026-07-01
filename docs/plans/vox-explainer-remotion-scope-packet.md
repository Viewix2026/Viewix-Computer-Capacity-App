# Scope Packet — Vox-Style Explainer Videos (Claude Code + Remotion)

Status: **Gate 0 — draft scope packet, awaiting Jeremy's review** to enter the
make-a-feature pipeline. Nothing built yet. This packet captures a workflow Jeremy
shared as a YouTube tutorial and reframes it as a Viewix feature so it can be
greenlit (or scoped down) before any code.
Owner: Jeremy
Created: 2026-07-01
Source: tutorial video Jeremy shared — "I made this entire Vox-style explainer video
using only Claude Code + Remotion" (a 47-second US/Iran "downfall of empire"
explainer, built step by step in the video). This packet is the video's method,
written up in our house scope-packet style. The video content is the sole input;
no code has been written against it.

---

## Context / why

We already ship the **Motion Graphics Generator**
([MotionGraphicsGenerator.jsx](../../src/components/MotionGraphicsGenerator.jsx) +
[api/motion-graphics.js](../../api/motion-graphics.js), Editors → Motion Graphics).
It generates **one self-contained animated HTML graphic per generation** — a lower
third, a stat pop, a single branded moment the editor screen-records. Its scope
packet ([motion-graphics-generator-scope-packet.md](./motion-graphics-generator-scope-packet.md))
deliberately put **"Multi-scene / timeline sequencing"** and a real **"Render to
video"** step **out of scope**, noting both as later phases.

The video Jeremy shared is exactly that deferred next step: a **multi-scene,
narrated explainer film** (Vox-style) assembled from many scenes that share one
locked background, driven by a voiceover script, and **rendered to a finished 1080p
MP4** — not screen-recorded. It's the difference between "make me a stat card" and
"make me a 47-second explainer with 6 scenes, VO, music, and a clean export."

The video's core claim is that Claude Code + [Remotion](https://www.remotion.dev)
(React that renders to real video) collapses the "hire a motion designer / know
After Effects" barrier. That maps directly onto our existing move (editor describes
a graphic → Claude writes it → capture) but upgrades it from **DOM/screen-record**
to **Remotion/true-render** and from **single graphic** to **sequenced film**.

---

## Outcome

An editor (or founder) can turn a **script** into a **finished, branded,
Vox-style explainer video** without touching After Effects or writing code —
describing scenes in plain English, previewing them live in Remotion Studio, and
rendering a clean MP4 with voiceover and music mixed in.

This is a **separate, heavier tool** than the current single-graphic generator.
The open question below is whether it lives as a new Editors subtab, a founders
tool, or a project-attached deliverable — see Open decisions.

## The workflow the video demonstrates (verbatim method, our wording)

The video walks 5 stages. Capturing them precisely because they *are* the spec:

1. **Script as the timeline.** A table where each row is one voiceover beat:
   `voiceover line | foreground asset | midground asset | image prompt(s)`. The
   script drives everything downstream — scene count, scene durations, and which
   cutouts appear. (Video ch.2, "Planning: the script & visual style".)
2. **Lock a visual system.** One shared background across every scene; one font
   set; one accent palette. Only the **midground** (halftone character cutouts)
   and **foreground** (structures/scenery) change per scene. This is what gives
   the "one continuous shot" Vox feel instead of hard cuts.
3. **Assets → black-and-white halftone cutouts.** Transparent PNG cutouts of
   subjects (e.g. Trump, the White House, an oil tanker, a green-screen ocean
   clip) are pulled via image tools, then Claude Code is told to render each
   "black and white with a halftone pattern" for that papery, magazine texture.
   In the video these come from **Magnific / Higgsfield via MCP connectors**
   (see External dependencies — we do not have these connectors in this repo).
4. **Build scenes in Remotion.** Folder-per-scene architecture; each scene is a
   **3-layer composition**: `background` (locked/shared) → `midground` (halftone
   character cutouts springing in) → `foreground` (structures). Animation uses
   just two Remotion primitives — **`spring()`** (the pop-ins) and
   **`interpolate()`** (everything else) — plus a signature offset **red marker
   stroke** behind each cutout for a subtle 3D lift. Editor tunes each element via
   **prop controls** in Remotion Studio (scale / X / Y), saving the numbers.
5. **Assemble → VO → music → render.** Claude stitches scenes into a **master
   sequence** back-to-back, each scene lasting exactly as long as its narration.
   Voiceover generated in **ElevenLabs** (video uses "Kate — Cinematic British RP
   narrator"), dropped in, and Claude syncs each scene to start/end on its own
   narration line. Then music/SFX, then **render to a 1080p MP4** (or hand the bare
   composition to Premiere for audio there).

## Done looks like (to be firmed at Gate 1)

A first shippable slice, verified end-to-end:
1. Paste/define a script table (beats + prompts) → the tool scaffolds a Remotion
   project with one scene per beat, the locked background, and placeholder cutouts.
2. Preview the sequence live (Remotion Studio or an embedded player) with the
   3-layer + spring/interpolate look and per-element prop controls.
3. Attach a voiceover track → scenes auto-sequence to the narration.
4. Render → a clean **1080p MP4** with VO (+ optional music) lands somewhere the
   editor can download (Firebase Storage), the way the proposal PDF does.

---

## Out of scope (proposed — confirm at Gate 1)

- **Replacing the current Motion Graphics Generator.** This is additive; the
  single-graphic tool stays as-is for lower-thirds / stat pops.
- **In-app After-Effects-grade timeline editor.** Editing is prop controls +
  plain-English prompts to Claude, exactly as the video shows — not a keyframe UI.
- **Auto-sourcing cutouts without a connector.** Cutout generation depends on an
  image tool (see External dependencies); v1 may require the editor to drop
  transparent PNGs into the scene folders manually.
- **Client-facing / self-serve.** Internal editor/founder tool first, like the
  motion-graphics generator shipped.

## Hard constraints (inherited from house patterns)

- **Reuse, do not reinvent.** Auth via `requireRole` / `sendAuthError` / `actorFrom`
  ([api/_requireAuth.js](../../api/_requireAuth.js)); the raw-fetch Anthropic call
  shape from [api/meeting-feedback.js](../../api/meeting-feedback.js) /
  [api/motion-graphics.js](../../api/motion-graphics.js); frontend `authFetch` /
  `fbListenSafe` / `fbGet` from [src/firebase.js](../../src/firebase.js); the
  `Segmented` subtab pattern + `canMotion` gating already in
  [EditorDashboard.jsx](../../src/components/EditorDashboard.jsx); `config.js`
  design tokens; the Viewix palette (`--accent #0082FA`, `--orange #F87700`),
  DM Sans + JetBrains Mono.
- **Model-id discipline.** Use a current model id per the `claude-api` skill at
  build time; never ship a guessed model string (the motion-graphics packet's rule).
- **Cost ledger.** Any Claude/render spend records to `/aiUsage/*` server-side, the
  same server-authoritative way `api/motion-graphics.js` does — rendering a film is
  more expensive than one graphic, so this matters more here.
- **Untrusted-output boundary still applies.** If we ever render model-authored
  code, it runs isolated (the motion-graphics sandbox/CSP lesson); a Remotion render
  worker executes project code, so it must run on **our** infra (the Mac-mini
  worker), never in a user's browser with ambient credentials.

---

## Open decisions (the forks a Gate-1 plan must settle — Jeremy's calls)

1. **Where does render run?** Remotion renders via a headless Chromium + a Node
   process — this cannot run in a Vercel function the way single-graphic generation
   does. Strong candidate: reuse the **Mac-mini worker pattern** already proven for
   proposals ([workers/proposal-renderer](../../workers/proposal-renderer/README.md),
   [proposal-worker-scope-packet.md](./proposal-worker-scope-packet.md)) — a
   `/explainerJobs` queue + a pm2/LaunchAgent worker that runs `remotion render`
   and uploads the MP4 to Storage, with a `queued → building → rendering → ready |
   error` status chain mirroring the proposal worker. **Alternative:** Remotion
   Lambda (managed cloud render) — no Mac-mini dependency but new infra/billing.
2. **How much does the editor touch a repo vs. a UI?** The video is a Claude Code
   power-user flow (open Claude Code, prompt it, tweak Remotion Studio). Do we
   productize that into a **dashboard tool** (editor never sees code), or ship a
   **guided template repo + skill** the way we ship other Claude-driven flows?
3. **Cutout image sourcing.** The video relies on **Magnific / Higgsfield MCP
   connectors** for cutouts + green-screen clips. We don't have those connectors.
   Options: (a) manual PNG drop-in for v1; (b) reuse an image path we already have;
   (c) add a connector — a separate decision with its own cost/security review.
4. **Where it lives + who can spend.** New Editors subtab (like Motion Graphics,
   `canMotion` roles)? A founders tool? Project-attached deliverable? Rendering a
   film is a bigger spend than a graphic — gating and a daily cap matter.
5. **Scope of v1.** Smallest useful slice: e.g. "script table → scaffolded Remotion
   project + live preview" first, with VO-sync and one-click render as the
   fast-follow — mirroring how motion-graphics shipped screen-record first and
   deferred pixel-perfect render to a Phase 2.

## External dependencies / new surface (flag for review)

- **Remotion** — new runtime dependency and a **new build/render target** distinct
  from the Vite app. Licensing note: Remotion has a company-size-based licence;
  confirm Viewix's standing before adopting.
- **ElevenLabs** — voiceover generation (video uses it manually). In-app vs.
  editor-does-it-externally is an Open decision.
- **Magnific / Higgsfield (or equivalent) image connector** — cutout + green-screen
  sourcing (Open decision 3).
- A **render host** (Mac-mini worker or Remotion Lambda) — Open decision 1.

---

## Why this is a scope packet and not a build (process note)

Every feature in this repo starts as a scope packet through plan gates before code
(see the `docs/plans/*-scope-packet.md` set). This one is **large and
architecturally significant** — a new render runtime, a new worker/host, an
external image connector, and non-trivial spend — so blind-scaffolding a Remotion
project from a video would skip the gate that catches exactly those forks. The
video gives us the *method*; the Open decisions above are what a person (Jeremy)
should settle before we build. Once greenlit, this becomes the Gate-1 "Approved
plan" and enters the same Codex plan-review → build → code-review loop the
motion-graphics feature went through.

## Build status

- **Stage 1 — Explainer Storyboard Generator: BUILT** (this branch). The
  buildable, infra-free slice — "the script that acts as the timeline" — shipped
  as an Editors subtab that mirrors the Motion Graphics architecture exactly:
  - `api/explainer-storyboard.js` (route) + `api/_explainerStoryboard.js` (pure,
    unit-tested logic — the `normalizeStoryboard` trust boundary): `generate` /
    `save` / `archive`, Sonnet 4.6, atomic daily-cap breaker, server-authoritative
    cost ledger at `/aiUsage/storyboards/*`, fresh RTDB role/active re-check.
  - `src/components/ExplainerStoryboard.jsx`: topic/script → editable scene table
    (locked visual system + per-beat voiceover, midground/foreground assets, and
    image-gen prompts), refine-in-plain-English, copy-as-Markdown / download-JSON,
    save to a shared server-only library (`/storyboardLibrary`), reload.
  - Wired into `EditorDashboard.jsx` (`canMotion` roles), `vercel.json`
    maxDuration, `firebase-rules.json` (`storyboardLibrary` read-any / write-false),
    and `api/__tests__/explainer-storyboard.test.mjs` (10 assertions, all green).
  - This is intentionally the no-new-infra slice: no Remotion runtime, no render
    host, no external image connector — so it ships now and produces the exact
    artifact the later stages consume.
- **Stages 2–5 (scene build, VO sync, render to MP4): NOT built** — they carry the
  Open decisions above (render host, cutout connector, Remotion adoption). They
  stay gated on Jeremy's calls.

## Next step

Jeremy reviews the shipped Stage 1, then settles Open decisions 1–5 (especially
render host + Remotion adoption) to greenlight Stages 2–5. If the immediate want
is instead "scaffold a starter Remotion template to play with," that's a smaller,
separate task — say the word.
