# Plan — Instagram Text Image Generator (Editors subtab)

_Draft for Codex adversarial review (Step 3). Folds into the Scope Packet's
"Approved plan" at Gate 1. Companion: `instagram-text-generator-scope-packet.md`._
_Codex round 1 + 2 triage folded in (see §13)._

## 1. Goal (from Packet)
A new subtab inside the **Editors** tab. Editor types text, tweaks
font / bold / italic / size / text colour / box colour / box padding / radii /
alignment, hits **Export**, and downloads a **transparent-background PNG** of an
Instagram-Reels-style caption box to drop into a video edit. Client-side only,
zero backend, zero new runtime cost, zero new dependencies.

## 2. Reference fidelity — THE signature look
When caption text wraps to multiple lines, the background **hugs each line's
width** and **steps/notches between lines**, reading as one connected shape — NOT
a single uniform rectangle. The inner corner where a wide line meets a narrower
line is a **concave (notched) rounded corner**; outer corners are convex rounded.
Single-line text is the degenerate case = one rounded pill (no notch).

## 3. Architecture decision (resolved)
**Single `<canvas>` is both the live preview and the export source (WYSIWYG),
drawn with native Canvas 2D. Zero new dependencies.**
- One pure draw function `drawCaption(ctx, layout, opts)` renders the notched
  outline + text from a precomputed `layout` (§7g). The same canvas is shown in
  the preview (scaled via CSS) and exported via `canvas.toBlob()` → preview/export
  divergence is structurally impossible.
- Native Canvas 2D + already-installed `file-saver` (`package.json:26`,
  lazy-imported like `runsheetDocx.js:338`).
- **Rejected:** HTML/CSS `box-decoration-break: clone` + html2canvas/dom-to-image
  — adds a dependency AND the screenshot libs don't reliably honor it (flatten the
  notch). Transparency: canvas never background-filled; PNG keeps true alpha.

## 4. Integration (EditorDashboard.jsx wrapper)

### New file: `src/components/CaptionGenerator.jsx`
Flat in `src/components/` (per code-style memory it gets its own file).
Self-contained — **takes no props**. Imports `Segmented` from `./kit`, uses
`var(--*)` tokens, lazy-imports `file-saver`.

### Edit: `src/components/EditorDashboard.jsx` (the 9-line wrapper)
```jsx
const [sub, setSub] = useState("Dashboard");
return (
  <div style={{ fontFamily:"'DM Sans',…", background: embedded?"transparent":"var(--bg)", … }}>
    <div style={{ padding:"10px 28px", borderBottom:"1px solid var(--border)", background:"var(--card)" }}>
      <Segmented options={["Dashboard","Caption Generator"]} active={sub} onSelect={setSub} />
    </div>
    {sub === "Dashboard"
      ? <EditorDashboardViewix projects={projects} …all existing props… />
      : <CaptionGenerator />}
  </div>
);
```
- **`Segmented` real signature (verified kit.jsx:191):** `Segmented({ options, active, onSelect })` — `options` = array of strings, `active` = string, `onSelect(option)`. (Not `tabs`/`onChange`.)
- The strip sits in the wrapper, ABOVE EditorDashboardViewix's `editorId` picker
  gate, so the Caption Generator subtab is reachable without picking an editor.
- **Chrome note (resolved):** on "Dashboard" the user sees the slim subtab strip
  then EditorDashboardViewix's own content header — a nav strip + a content header,
  not two tab bars. **Recommended (A):** keep the strip in the wrapper (low blast
  radius). **Alternative (B), Gate 1:** hoist the switch inside EditorDashboardViewix
  above its picker gate — rejected by default (entangles a 2,214-line file).

No App.jsx change. No backend, schema, Firebase, or new dependency.

## 5. Controls (the panel)
| Control | UI | Default | Notes |
|---|---|---|---|
| Text | multiline `<textarea>` | "" | user controls line breaks with Enter |
| Font family | `<select>` curated list | Arial | system + already-loaded fonts only (§6) |
| Bold | toggle | on | |
| Italic | toggle | off | |
| Text size | range (px) | 64 | 24–160 |
| Text colour | `<input type=color>` | **#111111** | matches scope reference (black text) |
| Box colour | `<input type=color>` | **#FFFFFF** | matches scope reference (white box) |
| Box opacity | range 0–100% | 100% | |
| Padding (box size) | range (px) | 28 | horizontal padding per line + outer vertical padding |
| Corner radius `r` | range (px) | 22 | outer convex radius |
| Notch radius `s` | range (px) | 14 | inner concave (step) radius |
| Alignment | Segmented L/C | Center | |
| Max box width | range (px) | 720 | the **box** max width; text wraps to `maxWidth − 2·padX` (§7a) |

Export button → transparent PNG. **Disabled when** text empty/whitespace OR a font
load is pending (§6).

## 6. Rendering coordinates, scale, fonts
- **One scale, no DPR.** All geometry is computed in **export pixels** = (CSS px
  control values) × effective `SCALE` (base `2`, may be reduced by the preflight
  §7g). Multiply font size, padding, `r`, `s` by `SCALE`; size the canvas to the
  computed bbox (§7g); draw with **no `ctx.scale()` transform**. **Ignore
  `window.devicePixelRatio`** — never combined with `SCALE`. `measureText` at the
  scaled font returns scaled widths directly → one coordinate space throughout.
- **Preview** = the same canvas shown via CSS `max-width:100%`, on a **CSS
  checkerboard background on the wrapper `<div>`** (never drawn on the canvas).
  Every draw begins with `ctx.clearRect(0,0,w,h)` and nothing else before the shape.
- **Fonts (race-free, incl. font switching — Codex F5/R2-F3):** picker offers only
  no-async-load faces — **DM Sans** (already loaded) + system **Arial, Helvetica,
  Impact, Verdana, Georgia, Courier New**. A single `ensureFont(fontString)` helper
  wraps `await document.fonts.load(fontString)`. It runs before EVERY measure/redraw
  that follows a font-affecting change (family/bold/italic/size) AND in the export
  handler, guarded by a **monotonic request id** so a stale load can't overwrite a
  newer draw. Export is disabled while any load is pending. First mount also awaits
  `document.fonts.ready`. This closes the preview↔export width-divergence race.

## 7. Draw algorithm — union outline as a rounded rectilinear polygon
`arcTo` only makes convex fillets (Codex F1), so we round each corner with explicit
`ctx.arc` and pinned center/sign math (Codex R2-F1/F2). All math below is in export
px (§6).

### 7a. Layout pass (pure, no canvas state mutation)
1. Font string: `${italic?"italic ":""}${bold?"700":"400"} ${size}px "${family}"`.
2. After `ensureFont`, set the font on an offscreen measuring context.
3. Split text on `\n` → paragraphs; word-wrap each so each line's `textW ≤
   (maxWidth − 2·padX)` (so the final **box** ≤ maxWidth — Codex R2-F7). Clamp the
   wrap target to a sane min (≥ `4·padX`). Flatten to `lines[]`. A blank line → a
   min-width band (`= 2·padX`).
4. **Per-line height from real metrics (Codex R2-F5):** `m_i = measureText(line)`;
   `asc = max_i m_i.actualBoundingBoxAscent`, `desc = max_i m_i.actualBoundingBoxDescent`
   (fallback `asc+desc = size·1.0` when metrics unavailable). `bandH = asc + desc`.
   Interior bands touch; outer vertical padding `padY (= padding)` is added only
   above the first and below the last band.
5. `boxW_i = textW_i + 2·padX`; `canvasW = max_i(boxW_i)`;
   `canvasH = padY + lines.length·bandH + padY`.
6. Per-line horizontal extents (no negative coords — origin at canvas top-left):
   **Center** → `xL_i = (canvasW − boxW_i)/2`, `xR_i = xL_i + boxW_i`.
   **Left** → `xL_i = 0`, `xR_i = boxW_i`.
   Band vertical extent: `yTop_i = padY + i·bandH`, `yBot_i = yTop_i + bandH`;
   the whole block's outer top = `0`, outer bottom = `canvasH`.

### 7b. Build the union polygon (one closed clockwise ring)
Walk the **right edge top→bottom** from `(xR_0, 0)`: at each band boundary where
`xR` changes emit shelf vertices `(xR_i, yBot_i)` then `(xR_{i+1}, yBot_i)`; end at
`(xR_last, canvasH)`. Cross the **bottom** to `(xL_last, canvasH)`. Walk the **left
edge bottom→top**, emitting mirrored shelf vertices where `xL` changes, up to
`(xL_0, 0)`. Close. Collapse zero-length edges (equal-width adjacent bands → no
shelf). The outer top/bottom edges span `xL_0..xR_0` and `xL_last..xR_last`.

### 7c. Round every corner — pinned center + sign math (Codex R2-F1/F2)
For each vertex `V` with incoming unit dir `dIn`, outgoing unit dir `dOut` (axis-
aligned), right-hand normal `nR(d) = (−d.y, d.x)`:
- **Turn sign:** `z = dIn.x·dOut.y − dIn.y·dOut.x`. `z > 0` → **convex**, radius `r`;
  `z < 0` → **concave (notch)**, radius `s`. (Worked, clockwise y-down: rectangle
  corner `z=+1` convex; right-shelf outer corner `z=+1` convex; right-shelf inner
  corner `z=−1` concave; left-shelf inner corner `z=−1` concave; left-shelf outer
  `z=+1` convex — verified both sides from one ring.)
- **Radius clamp (Codex F3):** clamp `R` to half of each adjacent edge length; for
  the two corners sharing an edge, if `R_a + R_b > edgeLen`, scale both by
  `edgeLen/(R_a+R_b)`. Applies to every edge (shelves AND short vertical bands).
- **Tangent points:** `Pin = V − R·dIn`, `Pout = V + R·dOut`.
- **Arc center:** `convex → C = V + R·(nR(dIn)+nR(dOut))`;
  `concave → C = V − R·(nR(dIn)+nR(dOut))`. (For perpendicular axis-aligned edges
  the bracket is a length-√2 diagonal, so `C` sits the inscribed-circle distance
  `R√2` from `V`. Verified: rectangle top-right `dIn=(1,0),dOut=(0,1)` → `C=V+(−R,R)`
  inside; right notch `dIn=(−1,0),dOut=(0,1)` → `C=V+(s,s)` outside → curves inward.)
- **Draw:** `lineTo(Pin)` then `ctx.arc(C.x, C.y, R, angle(C→Pin), angle(C→Pout),
  anticlockwise)` choosing the boolean that traverses the **90° minor arc** (the
  always-correct one for both convex and concave).
After tracing the ring, `ctx.fill()` **once** (box colour at box opacity).

### 7d. Single line (Codex F4)
Automatic: `lines.length === 1` → a 4-vertex rectangle, all `z=+1` convex `r` → a
rounded rect. No special branch.

### 7e. Text
After the fill, draw each line (fill = text colour), `textBaseline="middle"`,
`textAlign` per alignment, x at line center/left, y `= yTop_i + bandH/2`.

### 7f. Build-time geometry verification (must do before wiring controls)
Render and eyeball: **"Hi"** → pill; **"Hello World"/"Hi"** → one concave notch per
side, no bumps; **"Hi"/"Hello World"/"OK"** (narrow-wide-narrow) → concave notches
at all four interior step corners, convex elsewhere, **no self-intersection**. Add a
tiny assertion in dev that the four known corners classify convex/concave as above.

### 7g. Layout/preflight helper — runs before canvas allocation (Codex R2-F4/F6)
`computeLayout(opts) → { lines, canvasW, canvasH, effectiveScale, perLine }` does
§7a fully, then **before any canvas is sized**: if `canvasW > 8192 || canvasH >
8192 || canvasW·canvasH > 30e6`, reduce `effectiveScale` until it fits (down to 1),
else flag `tooLarge`. Both preview and export size their canvas from this helper's
output, so an oversized canvas is never allocated/zeroed first.

## 8. Export
```
const { canvasW, canvasH, tooLarge } = computeLayout(opts);
if (tooLarge) { showInlineWarning(); return; }
// size export canvas to (canvasW,canvasH), ensureFont, drawCaption, then:
canvas.toBlob((blob) => { if (!blob) return; saveAs(blob, filename); }, "image/png");
```
- **Filename (sanitised):** `const slug = text.trim().slice(0,40).replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase(); const filename = \`caption-${slug || "untitled"}.png\`;`
- `toBlob` null callback guarded.

## 9. Out of scope this round (deferred)
- "Single solid rectangle" box-style toggle. · Image/photo backgrounds · animation
  · saved presets/style library · multi-box · custom/Google font uploads ·
  redraw debounce (Codex F13 — see §13).

## 10. "Done looks like" verification
1. `preview_start`; Editors → Caption Generator subtab.
2. Type "Juggling 3 other\nclients", box red (#FB4D4D), text white, bold.
3. `preview_screenshot` → wide line + narrower line read as one connected shape with
   a concave notch at the step (matches the mockup).
4. Export → PNG downloads; confirm transparent bg (checkerboard shows through;
   `preview_eval` canvas corner pixels for alpha 0).
5. `preview_console_logs` clean.

## 11. Edge cases (pre-empted)
Single line → pill (§7d). · Equal-width adjacent → straight edge (collapsed). · Short
shelf/band → joint clamp (§7c), no self-intersect. · Blank line → min-width band. ·
Long line → wrapped to `maxWidth−2·padX`; explicit `\n` honored. · `toBlob` null →
guarded. · Empty/whitespace → clearRect+return, Export disabled. · Tall fonts/accents
(Impact, "Ágy") → metric-based `bandH` (§7a). · Emoji → system emoji font. · Font not
loaded / switched → `ensureFont` + request id (§6). · Huge size → preflight scale
reduction / warning (§7g). · Left vs center align → only staircased side(s) differ.

## 12. Open decisions for Gate 1
- **Default font:** Arial (IG-authentic) vs DM Sans (brand). Recommend Arial.
- **Subtab label:** "Caption Generator" vs "IG Text" vs "Text Boxes". Recommend "Caption Generator".
- **Integration chrome:** wrapper strip [A, recommended] vs hoist inside EditorDashboardViewix [B].
- **Extra fidelity sliders** (opacity, radii, max width): keep all [recommended] vs trim.

## 13. Codex triage trail
**Round 1 (13 findings, 2C/6H/3M/2L) — adopted:** F1 arcTo→explicit arc · F2 turn-
classify (no mirror) · F3 joint radius clamp · F4 single-line auto · F5 font gating ·
F6 checkerboard off-canvas · F7 one-scale-no-DPR · F8 max-dim guard · F9 chrome
note+fork · F11 empty guard · F12 filename. **Pushed back:** F10 (Segmented really is
`{options,active,onSelect}`, verified kit.jsx:191). **Deferred:** F13 debounce
(non-critical at ~5-editor scale; revisit if lag reported).
**Round 2 (8 new, 1C/3H/3M/1L; trend 13→8) — adopted all:** R2-F1 explicit arc-center
formula (§7c) · R2-F2 pinned cross-product sign with worked corners (§7c) · R2-F3
font-switch re-gating + request id (§6) · R2-F4 preflight before allocation (§7g) ·
R2-F5 metric-based `bandH` (§7a) · R2-F6 origin/canvas-size derivation (§7a, no
negative coords) · R2-F7 max-width minus padding (§7a) · R2-F8 white-box/black-text
defaults (§5). Confirmed solid: §7b vertex ordering, §6 transparent model, §4
integration, §8 filename.
