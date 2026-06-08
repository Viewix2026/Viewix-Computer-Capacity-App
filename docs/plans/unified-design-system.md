# Unified Design System — Foundation + Chrome

Source: Claude Design handoff bundle ("Viewix — Unified Design Language"). The
designer built a token system, a line-icon set, a colour-coded "Pop" sidebar
rail, and shared primitives, then mocked the tabs against them. Full makeover
was estimated at ~45–50 dev days. This ship is **Phase 0 + 1 only**: the
foundation everything inherits, plus the chrome.

## Decisions (locked)
- **Scope:** Foundation + chrome. No per-tab reskins this ship.
- **Rail:** Pop (vivid gradient tile per tab hue). Glyph = **emoji** — after
  seeing the line-vs-emoji comparison, Jeremy chose the original emoji inside
  the Pop tiles (`RAIL_GLYPH = "emoji"` in UIComponents). Line set stays a
  one-flag swap.

## Work

### 1. Tokens — `src/config.js` (CSS `:root`)
Keep existing variable **names** (60 files consume `--bg/--card/--accent/...`)
so every tab inherits the refined palette with zero edits. Deepen values to the
design ramp and **add** the new tokens the kit introduces.
- Deepen: `--bg #0A0E17`, `--card #141A29`, `--border #222D40`,
  `--border-light #1A2231`, `--muted #61728C`, `--fg #EAEEF6`,
  `--accent-soft rgba(0,130,250,0.13)`, `--input-bg #0E131F`, `--bar-bg #19202F`.
- Add: `--rail #0D1220`, `--card-2 #19202F`, `--inset #0E131F`,
  `--border-soft #1A2231`, `--fg-2 #9DABC2`, `--faint #3D4B62`,
  `--accent-bright #3DA2FF`, `--orange #F87700` + `--orange-soft`,
  `--success #1EC081` + soft, `--amber #F5A623` + soft, `--danger #F2545B`,
  `--purple #9B7BF0` + soft, `--pink #EC6FA8`, radii `--r1..--r5`,
  `--shadow1/2/3`, `--glow`.

### 2. Icon set — `src/components/Icon.jsx` (new)
Port `ICON_PATHS` + `<Icon>` (24px line, stroke 1.7) from `kit.jsx`. Shared
primitive, exported.

### 3. Pop sidebar rail — `src/components/UIComponents.jsx` `SideIcon`
Rewrite `SideIcon` into the Pop rail item: signature hue per tab, line glyph in
a soft tinted tile, active = vivid gradient ignite + glow + edge marker. Add
`name` + `hue` props; keep `icon` (emoji) for the comparison variant behind a
module flag (`RAIL_GLYPH = "line" | "emoji"`). Update the ~13 call sites in
`App.jsx` to pass `name`/`hue`. Widen rail to 76px, `--rail` background, new
"V." mark. Hue map matches the designer's `NAV_ITEMS`.

### 4. Header — `src/App.jsx` header bar
Light touch: switch header + sidebar backgrounds to `--rail`, add the bell
glyph next to the user chip. Don't disturb per-tab content.

### 5. Shared kit — `src/components/kit.jsx` (new, additive)
Port the primitives (Btn, Toggle, StatusPill, Tag, DataChip, ConfigChip,
SectionHeader, MetricCard, Segmented, Tabs, ProgressBar, Monogram) as real
React components wired to the CSS-var tokens (not a JS token object, so they
theme correctly). Available for tabs to adopt in later phases. Zero regression
risk — nothing imports it yet.

## Verify
Dev server + screenshots: Pop rail (line icons), Pop rail (emoji variant), and
2–3 existing tabs (Home, Projects, Founders) to confirm the deeper tokens read
well everywhere. Check console for errors.

## Out of scope (later phases)
Per-tab reskins, the client light portal, Projects.jsx refactor, wiring kit
primitives into existing tabs.

### Accounts reskin — reconcile mockup against reality (when done)
The handoff's Accounts mockup (`ds/tabs-b.jsx`) invents features that don't fit
the real data model. If/when Accounts is reskinned, DROP or rework these:
- **Avg. MRR KPI** — not tracked anywhere, and MRR isn't a clean concept given
  enterprise/gov buy one-off via PO (only SMB is truly recurring). Don't show a
  blended MRR. See [[project_enterprise_recurring_constraint]].
- **Uniform 5-dot milestone track** — must be partnership-aware. Real code blanks
  `finalLive / boostingStrategy / manyChat` for Meta Ads accounts
  (`META_ADS_BLANKED_KEYS`); those only run Signing → Go Live. A fixed five-step
  track misrepresents every Meta Ads client.
- The milestone-track *concept* is sound (matches `MILESTONE_DEFS`); keep it.
  Of the mockup KPIs, only "Due This Week" maps to real computed data.
