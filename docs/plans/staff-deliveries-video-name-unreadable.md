# Fix: "Video Name" column unreadable on staff Deliveries table

## Context

Slack report (Mon, 2026-06-03): *"the video name on the client dashboard is impossible to read"* with a screenshot showing the `VIDEO NAME` header wrapped onto two lines and a name cell rendering only a single character ("E").

Clarified surface: this is the **internal staff dashboard** (Projects → Deliveries subtab), not the client portal. The component is `src/components/Deliveries.jsx` (the staff one rendered from `Projects.jsx:3820`), distinct from the client-facing `src/components/portal/Deliveries.jsx`.

## Root cause — column collapse, not contrast

Text colour is fine: the name `<input>` uses `inputSt` → `color: var(--fg)` (#E8ECF4) on `var(--input-bg)` (#0F1520) in the staff dark theme. High contrast.

The real problem is **table column width** under `table-layout: auto`:

- The videos table (`Deliveries.jsx:481`) uses default `table-layout: auto` and `width: 100%`.
- Every column except Video Name has a large fixed width: Link 200, Viewix Status 140, Rev1 120, Rev2 120, Caption 200, Notes 180, Posted 80, delete 40 ≈ **1080px**.
- The **Video Name `<th>` (line 483) has no width**, and its `<input>` (line 506) uses `width: 100%`, which gives the cell a *weak* minimum-content width (the input demands no intrinsic width).
- Under auto layout, scarce width is allocated to the explicit-width columns; the name column, having only a weak minimum, gets starved. Depending on content it either compresses to a sliver or the table overflows — and the wrapper (`Deliveries.jsx:480`) uses `overflow: "hidden"`, so any overflow is **clipped** rather than scrollable. Either way there's no escape valve. *(Note: this is allocation starvation, not a literal collapse-to-zero — but the visible result is the one-character sliver in the screenshot, plus the two-line wrapped header.)*

A secondary aggravator (Codex #3): `inputSt` uses `width: 100%` with padding + border under default `box-sizing: content-box`, so every input is ~26px wider than its cell — extra overflow inside each cell.

## Fix

All edits in `src/components/Deliveries.jsx`:

1. **Box-size all inputs** — `Deliveries.jsx:282` (`inputSt`, a local const in this file — *not* config.js): add `boxSizing: "border-box"` so `width:100%` inputs fit their cells (fixes Video Name, Link, Notes, and the Caption textarea at once).
2. **Reserve width for the name column** — `Deliveries.jsx:483`: give the Video Name `<th>` `width: 260` (matching the explicit-width pattern of the other `<th>`s).
3. **Give the table a deterministic floor** — `Deliveries.jsx:481`: add `minWidth` to the table so the name column's floor is *guaranteed*, not negotiated, and the scroll trigger is predictable. Basis ≈ 1340 column-width content sum **plus cell padding** (th 8×10, td 6×12 are content-box, so they add on top) → real floor ≈ 1550. Final number tuned in the isolated harness (see Verification).
4. **Add a horizontal-scroll escape valve** — `Deliveries.jsx:480`: change the wrapper `overflow: "hidden"` → `overflowX: "auto", overflowY: "hidden"` so when the full table exceeds the staff content width it scrolls instead of squeezing/clipping. Border-radius corners still clip cleanly; `auto` shows no scrollbar when it fits.

This is the strong combo Codex flagged (#7/#9): wrapper `overflowX:auto` + table `minWidth` + per-column widths + `border-box` inputs. No theme/colour changes, no data-model changes.

### Rejected / deferred (Codex triage)
- **`tableLayout: fixed` (#8)** — rejected: switches the layout algorithm across all 9 columns for no gain here; the additive constraints above are lower-risk.
- **Print `@media` (#12)** — irrelevant for an internal screen tool.
- **`white-space:nowrap` on th (#10)** — unnecessary once the width is reserved.
- **Narrow-viewport sticky first column (#11)** — horizontal scroll is acceptable for an internal table; revisit only if staff use it on tablets.

## Verification

The staff app needs Google SSO + Firebase, so full in-app verification is awkward. Primary verification is an **isolated layout harness**:

- Build a standalone HTML file replicating the exact table structure, the 9 column widths, `inputSt`, the wrapper, and the proposed edits. Open it in the preview at container widths 900 / 1100 / 1280 / 1600px.
- Confirm: name column never drops below ~220px (use a long sample name); header "VIDEO NAME" stays on one line; horizontal scroll appears only when the table exceeds the container; no input overflows its cell. Tune the table `minWidth` here so the floor holds across all widths.
- Check no ancestor in `Projects.jsx` traps/hides the new horizontal scroll (Codex #4).
- If staff app is reachable: open Projects → a delivery with videos → Deliveries subtab and confirm the same.
- Spot-check the client-facing `portal/Deliveries.jsx` is untouched (different file, different surface).
