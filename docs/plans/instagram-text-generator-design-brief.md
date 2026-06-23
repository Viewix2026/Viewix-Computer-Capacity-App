# Design Brief — Caption Generator (Instagram text box tool)

_For UI/layout design. Hand to Claude design. The caption-box OUTPUT style is
fixed (it replicates Instagram); design the TOOL UI around it._

## What it is
An internal tool in the Viewix dashboard. An editor types caption text, styles it,
and exports a **transparent-background PNG** of an Instagram-Reels-style caption box
to drop into a video edit as an overlay. It is one self-contained panel — a new
**"Caption Generator" subtab inside the existing Editors tab**.

## The output it produces (fixed — don't redesign this)
A rounded caption box, bold text. The signature trait: when text wraps to multiple
lines, the background **hugs each line's width and notches between lines** (convex
outer corners, concave inner corners) — one connected shape, NOT a plain rectangle.
White box + black text by default; box and text colours are user-controlled (e.g.
red box / white text, green box / white text). The live preview shows this exact
shape updating in real time.

## Where it lives + house style (match, don't reinvent)
- Sits inside the dashboard's existing dark chrome. The subtab is selected via the
  existing **`Segmented` control** (same pill-style segmented switcher used on the
  Founders tab): `[ Dashboard | Caption Generator ]`.
- **Dark theme tokens (use these):** bg `#0A0E17`, card/surface `#141A29`, inset
  `#0F1420`, text `#EAEEF6`, muted text `#61728C`, accent/primary `#0082FA`, border
  `#222D40`, success `#1EC081`, danger `#F2545B`. Radii: 6 / 8 / 10 / 14 / 18.
  Font: **DM Sans** (400–800). Subtle shadows only, no heavy gradients.
- Desktop-first (editors work on laptops). Should degrade gracefully to a stacked
  single column on narrow widths.

## Layout (recommended: two panes)
A **left controls panel** (~320–360px) and a **right preview pane** that fills the
rest. On narrow screens, stack: controls on top, preview below.

### Left — controls panel (grouped, scrollable)
Group the controls so it doesn't read as a wall of inputs:
1. **Text** — a multiline textarea (the editor controls line breaks with Enter).
2. **Font** — family dropdown (Arial default; also Helvetica, Impact, Verdana,
   Georgia, Courier, DM Sans); Bold toggle (on by default); Italic toggle.
3. **Size & colour** — text size slider (24–160px); text colour swatch; box colour
   swatch; box opacity slider (0–100%).
4. **Box shape** — padding slider ("box size"); corner radius slider; notch radius
   slider; alignment toggle (Left / Center, Center default).
   - Sliders should show their current numeric value inline.
   - Colour controls are native colour swatches styled to fit the dark theme.

### Right — preview pane
- The caption box renders live on a **checkerboard background** (the standard
  "transparent" indicator) so it's obvious the export has no background.
- A primary **"Export PNG"** button (accent `#0082FA`) anchored to this pane
  (e.g. top-right of the preview, or a footer bar). This is the main action.
- Optional: a tiny hint line like "Transparent PNG · drops straight into your edit."

## States to design
- **Empty** (no text yet): preview shows a neutral placeholder; Export button
  disabled.
- **Font loading** (first paint / after switching font): Export momentarily
  disabled (brief).
- **Too large** (extreme size/long text): a small inline warning near Export
  instead of a broken export.
- **Default first-run look:** white box, black bold text, centered, so it matches
  the most common Instagram caption.

## Out of scope (don't design controls for these)
No image/photo backgrounds, no animation, no saved-preset library, no multi-box
compositions. One caption box, one transparent PNG, per export.

## Reference
The visual target is the organic IG Reels caption style from the request
screenshots (white/red/green rounded boxes, bold text, the per-line notch on
multi-line captions). The notch comparison mockup shown in chat is the fidelity
bar for the output.
