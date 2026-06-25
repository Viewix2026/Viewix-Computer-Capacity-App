# Scope Packet — Motion Graphics: upload a reference image

## Outcome
A third **Brand** mode — "Reference" — lets an editor drop in / pick their own image (style frame, logo, competitor graphic, moodboard). The model matches that image's look (palette, type feel, composition) when it generates, exactly like the website brand-pull but with an uploaded file instead of a site URL.

## Out of scope
- Saving the reference onto a template or per-client (the other two options Jeremy didn't pick) — parked.
- Multiple reference images at once (one image per generation).
- Server-side image storage (the image is a transient vision input, never persisted to RTDB/Storage — Firebase Storage is a Blaze trap anyway).
- Editing the reference (crop/rotate) — just downscale + send.

## Done looks like
- Brand segment shows Viewix | Client site | Reference. Picking Reference reveals a drag/drop + file picker with a thumbnail of the chosen image and a remove (×).
- Generate (and a subsequent Revise) sends the image to Opus as a vision block; the output visibly matches the reference's palette/style.
- Oversized/non-image files are rejected client-side with a clear message; the payload stays small (downscaled ≤1568px JPEG) so it's well under Vercel's 4.5MB body limit.
- Codex round on the new vision/base64/size path; preview green; merged; prod live. No firebase deploy (no new RTDB nodes).

## Hard constraints
- Reuse the existing vision path: the brand-pull already attaches `{type:"image",source:{type:"url",...}}`; add a base64 source for uploads. Reuse `buildSystemPrompt`'s brand-match block.
- Keep the request body under Vercel's 4.5MB serverless limit → downscale client-side (canvas, ≤1568px long edge — also Anthropic's optimal) before base64; server caps decoded bytes as a backstop and whitelists media types.
- No image persistence. No new deps (canvas + FileReader are native).
- Validate base64 server-side (charset + size + allowed media type) before forwarding to Anthropic.

## Resolved decisions
- **Upload at generate time** (Jeremy chose this over template-attached / library-reference). Per-generation, transient.
- **Client-side downscale to JPEG ≤1568px @ ~0.85** before encoding. Why: keeps payload ~100–500KB (under Vercel 4.5MB), matches Anthropic's optimal vision size (faster, cheaper, better), and normalizes any input format to one the API accepts. Transparency loss is fine — it's a *style* reference, not composited.
- **Carry the reference through a Revise** (re-send while the mode is Reference + an image is loaded) so refinements stay on-style.
- **Mutually exclusive with brand-pull** in the UI (one Brand mode at a time); server prefers website brand if somehow both arrive.
- **Allowed types:** JPEG/PNG/GIF/WebP in, normalized to JPEG out. Server decoded cap 3MB (backstop; real payloads are tiny).

## Open decisions
None.

## Approved plan
1. Backend `api/motion-graphics.js`: `LIMITS.referenceImageBytes`, `ALLOWED_IMAGE_TYPES`, `parseReferenceImage(body)` (data-URL or {mediaType,data}; charset + size + type checks); in handleGenerate build the vision block from brand.imageUrl OR the uploaded image; `buildSystemPrompt` gains a "match this reference image" branch when an upload is present but no website brand; ledger `brand: "reference-image"` marker.
2. Frontend `MotionGraphicsGenerator.jsx`: third Brand segment option; a drop/pick zone + thumbnail + remove; `downscaleToDataUrl` helper; `refImage` state; `callGenerate` sends `referenceImage` (generate + refine); clear messaging + size guard.
3. Codex adversarial loop → triage → fix → verify.
4. Ship: commit, preview green, PR→main, watch prod.

## Implementation deltas
- **Codex round 1 — all 4 adopted:**
  - #1 (Med) Reference mode + no image silently fell back to Viewix and burned a generation → Generate/Refine disabled (`refMissing`/`canGen`/`canRefine`) until an image is loaded.
  - #2 (Med) 3MB image + near-cap previousFragment could exceed Vercel's 4.5MB body limit → raw 413. Lowered server cap 3MB→2MB; added a client `dataUrlBytes` guard so an over-cap downscaled image is rejected before send.
  - #3 (Med) trusted the declared media type → `Buffer.from` for exact decoded length, reject `len%4===1`, and **magic-byte** sniff (JPEG FFD8FF / PNG 89504E47 / GIF87a|89a / RIFF…WEBP) so garbage is rejected at our layer, not by burning an Opus call.
  - #4 (Low) client MIME guard now uses the same explicit 4-type whitelist as the server + accept attr (drops the SVG-slips-through inconsistency).
  - Codex confirmed clean: no regex backtracking, no JSON injection (JSON.stringify encodes), no double image block (reference parsed only when !brand), deps array correct, save/update/template/ledger untouched.
