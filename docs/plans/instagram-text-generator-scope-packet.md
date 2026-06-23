# Scope Packet — Instagram Text Image Generator

_Status: GATE 2 — code Codex loop converged (9→3, SHIP) · awaiting human code review · Created 2026-06-23_

## Code Codex loop trail
- **Round 1 (9 findings, 2C/1H/2M/4L):** F1 box-opacity destroyed by goo alpha-cutoff (→ opacity moved outside filter) · F2 DM Sans not embedded in export (→ best-effort woff2 inline @font-face) · F3 goo blur clipped (→ bleed padding) · F4 oversized canvas (→ scale clamp to 8192) · F5 draft lost on subtab switch (→ both subtabs kept mounted, display toggle) · F6 notch=0 not clean (→ filter gated on notch>0) · F7 magic-number height (→ overflow:hidden so no double-scrollbar; offset still tunable) · F8 double-click race (→ useRef lock) · F9 fixed filename (→ slug).
- **Round 2 (3 findings, 0C/0H/1M/2L; verdict SHIP):** all R1 fixes CONFIRMED. New: stale state across export awaits (→ snapshot text/font/bold/italic/std + clone synchronously before awaits) · italic DM Sans not embedded (→ ital axis param) · global gooId dup risk (→ useId-scoped). All adopted + verified.
- **Converged** (severity collapse — no Critical/High in R2).
- **Live verification (Chromium harness):** renders clean (Arial bold default, multi-line notch); box opacity 40% renders semi-transparent (F1); notch=30 not clipped (F3); DM Sans woff2 fetch+embed path works (F2); export untainted, corner alpha 0 (transparent), opaque box, valid image/png (with bleed + instance-scoped filter id). Temp harness deleted.

## Outcome
Editors generate a **transparent-background PNG** of an Instagram-Reels-style
caption text box (rounded white box, bold black text) that they drop straight
into a video edit (Premiere / AE / CapCut) as an overlay. The PNG is the
deliverable — an editing asset, not a finished social graphic and not an
in-app preview. PNG fidelity (true alpha transparency, pixel-accurate IG box
look) is the whole point.

Lives as a **new subtab inside the existing Editors tab** of the dashboard.

## Done looks like
Type text → adjust font / bold / italic / size / text colour / box colour /
box size → hit **Export** → a PNG downloads with a genuinely transparent
background that visually matches the organic IG Reels box style in the
reference screenshots (rounded white box, bold black text).

## Out of scope (this round)
- **Image / photo backgrounds** — transparent output only; no compositing over a background image.
- **Animation / motion** — static PNG only; no animated reveals or video output.
- **Saved presets / style library** — defaulting OUT (Jeremy's note: "it only needs to provide it as a png output"). Stateless generator, no persistence. Deferrable to a future round.
- **Multi-box layouts** — defaulting to one text box per export. Deferrable.

## Hard constraints
- **Architecture:** strongly leaning client-side only — render + export entirely in the browser (HTML canvas / SVG-to-canvas), **no API route, no Firebase Storage, no Blaze upgrade, no per-export cost.** Jeremy: "open to exploring the best option but I'd think it's 1." To be confirmed as recommended in the plan. (See memory: Firebase Storage = Blaze trap.)
- **Reuse:** existing Editors tab structure + subtab pattern + Unified Design System tokens / kit.jsx / Icon.jsx. New tab goes in its own component file (per code-style memory: never inline new tabs).

## Resolved decisions
- Outcome = overlay PNG for edits (not standalone graphic, not preset library).
- Acceptance bar = transparent PNG visually matching the reference screenshots.
- **Render style = true stepped / notched per-line hugging boxes** (Jeremy confirmed via mockup 2026-06-23). The background hugs each line's width and notches concavely between lines — NOT a single rectangle. This is the signature look and the whole point.
- **Render/export tech = native Canvas 2D, single-canvas WYSIWYG, zero new dependencies.** Rejected html2canvas/dom-to-image: adds a dep and unreliably renders `box-decoration-break` (would flatten the notch). See [[project_firebase_storage_blaze_trap]] for the zero-cost discipline.
- **Architecture = client-side only** (constraint option 1 confirmed in practice): no API route, no Firebase Storage, no Blaze upgrade.

## Open decisions (resolve at Gate 1)
- **Default font:** Arial (most IG-authentic) vs DM Sans (brand). Recommend Arial; DM Sans available in picker.
- **Subtab label:** "Caption Generator" vs "IG Text" vs "Text Boxes". Recommend "Caption Generator".
- **Extra fidelity sliders** (box opacity, corner radius, notch radius, max width): keep all vs trim to the literal spec list. Recommend keep — cheap, materially better fidelity.

## Approved plan
_(written at Gate 1)_

## Implementation deltas
- **Rendering technique changed (user-directed, not a silent build deviation).** Jeremy designed the UI in Claude design and asked to implement that design. The design renders the notch with a **two-layer goo-filter stack** (`box-decoration-break: clone` per-line boxes + an SVG `feGaussianBlur`+`feColorMatrix` alpha-cutoff filter that melds lines into the convex-outer/concave-inner notch; crisp text on an unfiltered top layer), and **exports by serializing the preview DOM into an SVG `<foreignObject>` rasterized to canvas at 3× → `toBlob` PNG**. This REPLACES the reviewed plan's native-Canvas-2D rounded-polygon algorithm (§7) entirely. Accepted because (a) Jeremy explicitly directed it, (b) it's elegant and the live preview is faithful, (c) verified to produce a genuinely transparent, untainted PNG in Chromium.
- **New risk surface the plan didn't cover (→ code Codex loop must scrutinize):** `<foreignObject>`→canvas export is known-fragile cross-browser (Safari can render blank; canvas taint on some engines; web-font embedding — DM Sans may not embed in the raster, Arial/system safe). Hardened with `await document.fonts.ready`, try/catch + user-facing error + console log, `toBlob` null guard, disabled-while-exporting. Editors are on Chrome laptops so the primary path is covered.
- **Files:** new `src/components/CaptionGenerator.jsx` (self-contained, local VX tokens, real `./Icon`, AppShell/sidebar dropped). `src/components/EditorDashboard.jsx` wrapper now hosts the `Segmented` subtab switch (Dashboard | Caption Generator). App.jsx / sidebar untouched (Jeremy's instruction).
- **Verified (isolated harness, Chromium):** mounts clean, default Arial/bold, multi-line notch renders, export → untainted canvas, corner alpha 0 (transparent), box opaque, valid `image/png` blob. Temp harness files (`caption-preview.html`, `src/captionPreviewEntry.jsx`) to be deleted before commit.
