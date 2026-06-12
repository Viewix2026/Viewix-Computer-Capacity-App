# Design brief — viewixreviews.com.au

**For:** a Claude design session. This brief is self-contained — everything you
need is in this document. The deliverable comes back to the dev team to
implement inside an existing Vite/React codebase, so precision on tokens and
states matters more than pixel-perfection.

## The one-line job

A single public page at **viewixreviews.com.au**: all of Viewix's five-star
Google reviews (~61 of them) slowly and continuously scrolling across the
screen, with client video testimonials interleaved among the review cards, one
headline, and one CTA to **viewix.com.au**. It's a sales-proof page — prospects
get sent this link in proposals and follow-ups. Its only job is to make the
credibility question feel settled.

## About Viewix (voice context)

Viewix is a Sydney social-video production agency. Performance marketers who
make video, not videographers who dabble in marketing. The page copy must be
direct and commercially sharp — conversational Aussie business tone, outcome
focused, confident without arrogance. **Never use:** "cinematic", "passionate
about", "best in class", "world class", "cutting edge", "bespoke", "tailored
solutions", or American hype language.

## Brand system (complete — no other reference needed)

### Colours

| Token | Hex | Use |
|---|---|---|
| Viewix Blue | `#0082FA` | Primary. Headlines, links, key elements |
| Viewix Orange | `#F87700` | Accent ONLY (~10% of layout). CTA, highlights |
| Light Grey | `#F4F5F9` | Backgrounds, cards |
| Dark Navy | `#004F99` | Dark backgrounds, premium sections |
| Dark Orange | `#AE3A00` | Hover states |
| Mid Grey | `#CBCCD1` | Borders, dividers, secondary text |
| Text on light | `#1A1A2E` | Body text |
| White | `#FFFFFF` | Text on dark/blue |

Ratio rule: 60% neutral (white / Light Grey, or Dark Navy if you go dark) /
30% Blue / 10% Orange. Orange never dominates. No new colours (no reds,
greens, purples).

### Typography

Montserrat only (Google Fonts; weights 300–700). Headings Bold/SemiBold in
Blue (or White on dark), body Regular, min 14px, line-height 1.5–1.6. All-caps
only for short labels/buttons. Fallback: Arial → Helvetica → sans-serif.

### Logo

Jeremy will supply `Viewix_Logo_Transparent.png` (orange V mark + blue
wordmark, transparent background). **Use the supplied PNG — never recreate the
logo in SVG/CSS/text.** Clear space = height of the "i" in "iewix" on all
sides. Approved placements for this page: on White use the standard
orange-V/blue-wordmark version; on Dark Navy the wordmark must be white.
Favicon: the standalone V icon (white background / blue icon, or navy
background / orange icon).

## Page anatomy

1. **Headline block** — fixed/hero layer. Pick or beat one of these (final
   pick is yours to recommend, Jeremy decides):
   - "See what our clients say" *(Jeremy's starting point — safe)*
   - "Don't take our word for it."
   - "Every review. Unedited. All five stars."
   - "What working with Viewix is actually like."
   Subline option: live rating badge (see below) can do the factual work, so
   the headline can stay short.
2. **Live rating badge** — "5.0 ★ · 61 Google reviews" rendered from live
   data. **Do not hardcode the number 61 anywhere in static copy** — the count
   comes from the API and will grow. Treat it as `{rating} ★ · {count} Google
   reviews`.
3. **The review wall** — the page's body and texture: review cards in slow,
   continuous horizontal motion (marquee-style). Desktop can run 2–3 rows
   (alternating directions is fine); mobile is a single column (vertical
   marquee or static stack — your call, but specify it).
4. **Video testimonial cards** — interleaved at fixed slot positions among the
   review cards (e.g. one testimonial after every ~8 reviews — exact rhythm is
   yours, but it must be a FIXED rule by index, not random, and must hold as
   the review count grows). Visually distinct from review cards but in the
   same family.
5. **One CTA** — to `https://viewix.com.au`. Orange, the page's single loudest
   element. Label in brand voice (e.g. "See the work" — your call). No
   secondary CTA, no nav menu, no footer link clutter. A small footer line
   with the logo and ABN-style basics is fine.

## Data contracts (design to these exact shapes)

**Review card** receives:
```
{
  authorDisplayName: "Sarah Mitchell",
  rating: 5,                       // integer 1–5, render as stars
  text: "…review body, 0–1200 chars…",
  createdAt: "2026-03-14",         // render as relative or "Mar 2026"
  ownerReply: { text, createdAt }  // OPTIONAL — design may show or omit; if
                                   // shown, visually subordinate
}
```
- **No author photos.** Avatars are monogram initials (derive colour from the
  name within the brand palette). Google profile photo URLs rot — they are
  not available, don't design around them.
- **Long text:** decide and specify the rule — clamp at N lines with
  expand-on-tap, or size cards to content with a max. Cards of varying height
  are fine; unreadable walls are not.
- Mark each card subtly as a Google review (a small "G" or "Google review"
  caption is fine; don't fake Google's own UI chrome).

**Testimonial card** receives:
```
{
  provider: "youtube" | "vimeo",
  videoId: "abc123",
  clientName: "Clayton Utz",
  title: "Quarterly shoot-day program",
  aspect: "16:9"                   // may occasionally be "9:16"
}
```
- Renders as a **thumbnail + play button — the video iframe loads only on
  click** (performance + privacy requirement, non-negotiable). Design the
  pre-click state and the playing state. Lock the aspect ratio in CSS before
  load so nothing shifts.

## States you must design (not optional)

1. **Normal** — reviews + testimonials flowing.
2. **Empty / pre-launch** (`hasData: false`) — no reviews yet: a coherent
   testimonials-led layout with headline + CTA. Must not look broken.
3. **Paused** — motion stopped via the pause control.
4. **Reduced motion** (`prefers-reduced-motion`) — NO marquee: a static,
   scrollable grid of the same cards. Design this properly, it's not a
   fallback afterthought.

## Motion & accessibility constraints (engineering will enforce these)

- Marquee = CSS-transform animation only, duplicated track for a seamless
  loop. Slow: a card should take roughly 30–60s to cross the viewport —
  ambient, not a ticker.
- Hover pauses; plus **one visible, keyboard-focusable pause/play toggle**
  (serves keyboard, touch, and screen-reader users). Place it where it's
  findable but quiet.
- The duplicated loop track is `aria-hidden` — screen readers hear each
  review once.
- Contrast: body text must hit WCAG AA against its background.

## Deliverables (back to Jeremy)

1. **A single self-contained HTML file** — inline CSS, Montserrat via Google
   Fonts, all four states reachable (a tiny inline JS toggle for demo states
   is fine), populated with realistic dummy data in the exact shapes above
   (~15 reviews + 2 testimonials is enough to show the rhythm). This file is
   the spec the dev side implements from.
2. **OG share image** — static, 1200×630, on-brand, for link previews of
   viewixreviews.com.au.
3. **Your recommended headline + CTA label**, one line on why.
4. (Optional) favicon treatment per the logo-icon rules above.

## Hard don'ts

- No review filtering/search UI, no "leave a review" form, no nav, no second
  CTA, no extra pages.
- No hardcoded review counts in copy.
- No always-loaded video iframes.
- No new brand colours, no recreated logo, no hype copy.
