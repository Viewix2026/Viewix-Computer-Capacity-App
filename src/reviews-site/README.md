# viewixreviews.com.au page source

Implemented from the Claude-design hand-off spec, kept verbatim at
`docs/plans/viewix-reviews-design/viewixreviews.html`. Plan + decisions:
`docs/plans/viewix-reviews-site-scope-packet.md`.

- `main.js` — page logic. Reviews come from `GET /api/public/reviews`
  at runtime; testimonials are imported at build time.
- `stream.js` — pure helpers (interleave rule, badge, monograms),
  unit-tested by `api/__tests__/reviews-sync.test.mjs`.
- `sample-data.js` — `vite dev` only (no /api functions locally).
  Never ships: the import is gated on `import.meta.env.DEV`.

## testimonials.json

Build-time content, edit + deploy to update. Schema per entry:

```json
{
  "provider": "youtube",        // "youtube" | "vimeo"
  "videoId": "abc123",
  "clientName": "Clayton Utz",
  "title": "Quarterly shoot-day program",
  "aspect": "16:9"              // "16:9" | "9:16"
}
```

Interleave rule (from the design): a video card after EVERY 3rd
review, fixed by index; testimonials cycle if slots outnumber them;
unused ones append at the stream tail. An empty array is valid — the
wall renders reviews-only and the pre-launch empty state shows just
the headline/CTA/syncing line.
