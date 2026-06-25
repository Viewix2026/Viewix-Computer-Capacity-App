# Scope Packet — Motion Graphics: image slots (put real images in the boxes)

## Outcome
For box-based graphics (tier lists, this-or-that, …), Opus generates the layout with tagged **image slots**; the editor uploads an image per slot; the dashboard composites each image into its box so it rides the stack/reveal animation. Saved graphics bake the (downscaled) images in. No Firebase Storage.

## Out of scope (this round)
- **Video** in slots — CSP blocks `<video>` (media-src none) and clips can't be saved; deferred / live-only later.
- Re-editing slot images on a graphic loaded from the library (v1: loaded items render their baked images read-only; slots are editable on a fresh generation/refine).
- Free drag/resize positioning (slots only — the image fills its box).
- Per-slot captions beyond the label Opus already renders.

## Done looks like
- An **Image boxes** toggle; auto-on when a slot preset (Tier list, This or That) is applied. When on, generate emits `data-mg-slot="sN"` boxes.
- After generating, an **Images** panel lists the detected slots; uploading fills each box live (downscaled `data:` JPEG, injected by a shell applier script — rides the animation).
- Save bakes the downscaled images into the saved doc (raised cap for image graphics), server-validated (whitelisted types, magic bytes, per-image + total size caps). Library thumbnail + reload render the baked result.
- Codex loop; preview green; merged; prod live. No firebase deploy (no new RTDB node; images live inside the existing library html).

## Hard constraints
- Trust boundary unchanged: output still `injectGuard` + sandboxed-iframe CSP. Images are `data:` URIs (allowed by `img-src data:`). The slot-applier script is part of OUR shell (injectGuard), not Opus output. Opus never receives the images.
- No Firebase Storage (Blaze trap). Images baked into the library html on save; downscaled hard client-side.
- Reuse v6's canvas downscaler + `imageMagicOk`/base64 validation. Reuse the endpoint auth + helpers. Don't touch the generate hot path beyond a passed `imageSlots` flag.
- Cap discipline: per-slot decoded ≤400KB, total slots ≤1.5MB, baked doc ≤2MB (RTDB string, fine) — only raised when slots are present; non-slot graphics keep the 200KB cap.

## Resolved decisions
- **Slots, not overlay** (Jeremy) — image rides its box; Opus emits `data-mg-slot`, dashboard fills.
- **Trigger = auto on slot presets + a manual toggle** (Jeremy). Slot presets: `stier`, `thisorthat`.
- **Compositing via a shell applier** baked by injectGuard: a `<script id="__mg_slots" type="application/json">` data island + an applier IIFE that sets `[data-mg-slot]` elements' img.src / background-image from the island. Base64 data URIs can't contain `</script>`, and `<` is escaped to `<` defensively.
- **Live preview** = client swaps the island content into the server-returned guarded html (single targeted regex), re-keys the iframe. **Save** = server re-runs injectGuard WITH the validated slot map (bakes it). data: URIs throughout (blob URLs don't cross the no-same-origin sandbox reliably).
- **Downscale slots to ≤640px JPEG** (good in a box, small). Refine carries existing slot images by id (best-effort); loaded library items render baked (read-only slots in v1).

## Open decisions
None.

## Approved plan
1. Backend `api/motion-graphics.js`: LIMITS (slotImageBytes 400KB, slotsTotalBytes 1.5MB, outputHtmlSlots 2MB); `SLOT_APPLIER` script const; `injectGuard(raw,{width,height,slots})` adds the island+applier when the fragment has `data-mg-slot`, embeds the (validated) slot map, raises the cap when images present; `parseSlots(body.slots)` (key regex, data-URL + magic-byte + size validation, reuse imageMagicOk); `buildSystemPrompt(...,opts.imageSlots)` appends slot instructions; `handleGenerate` passes `imageSlots` (no images yet → empty island); `handleSave` parses + bakes slots.
2. Frontend `MotionGraphicsGenerator.jsx`: `imageSlots` toggle (auto-on for slot presets via applyTemplate); `slotImages` state; `detectSlots(html)`; an Images panel (per-slot upload, downscale ≤640px, remove); `composeSlots(html, slotImages)` for the live preview (MGFrame/present/popOut); refine carries slotImages; `saveToLibrary` sends the slot map; PRESETS get a `slots:true` flag on stier/thisorthat.
3. Codex adversarial loop (focus: applier/CSP, base64/island escaping, size caps, no unguarded path, generate-hot-path untouched).
4. Ship: commit, preview green, PR→main, watch prod.

## Implementation deltas
- **Codex round 1 — 4 adopted (2 Med, 2 Low); 4 areas confirmed clean (composeSlots/escape parity, detectSlots no false positives on the applier text, handleUpdate leaf-write, empty-island no-op):**
  - #1 (Med) the model controls the fragment → could emit its own `id="__mg_slots"` island that shadows ours (getElementById/regex pick the first). CSP still blocks any real exploit, but it breaks slot filling. Fixed both ways: injectGuard strips any model-emitted `__mg_slots` script; the applier binds to its island by **DOM adjacency** (`document.currentScript.previousElementSibling`, verify id), not by id.
  - #3 (Med) `__proto__`/`constructor`/`prototype` passed the slot-id regex. Reject them in parseSlots (`RESERVED_KEY`) and `hasOwnProperty`-guard the applier's reads (+ typeof string).
  - #4 (Low) total cap was only enforced post-decode → estimate decoded size from base64 length and reject cumulative overflow before `Buffer.from`.
  - #6 (Low) applyTemplate now syncs `imageSlots` both ways (on for slot presets, off otherwise) and clears `slotImages` so a prior graphic's uploads don't carry to a different template.
