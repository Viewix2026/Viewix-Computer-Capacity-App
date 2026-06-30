# Format / reel thumbnail permanence — options analysis

*Updated after one round of Codex adversarial review (findings folded in below).*

**Problem.** Format cards render a branded gradient instead of a real video
frame in two surfaces:

1. **Proposal "Formats we'll produce"** (`FormatCard` in
   `src/components/preproduction/ClientReviewUI.jsx:202`) renders **no `<img>` at
   all** — gradient + play glyph only. Even a YouTube `@shorts` example (which has
   a permanent free still) shows nothing. The mapping at
   `src/components/preproduction/ClientReview.jsx:126` even discards the
   `thumbnail` field. Straight gap.
2. **Format Library cards** (`src/components/FormatLibrary.jsx:281`) *are* wired
   (poster mode) but fall back to the gradient whenever there is no YouTube URL
   and the scraped Instagram still has expired. **Most of the library is
   Instagram**, so most cards go blank ~24h after scrape.

The gradient-fallback pattern is app-wide (analytics `PostCard`,
`CompetitorWatchlist`, `RenewalAmmo`, client-portal `PreviewTile`,
`SocialOrganicResearch`). A durable fix should generalise.

## What already exists (history)

- **PR #126** (`api/_analyticsThumbnails.js`, commit `17686cb`) built the
  "snapshot bytes → store → serve our copy" fix against **Firebase Storage**. It
  **does its own server-side byte download** (IG-friendly UA fetch → Buffer → 4 MB
  cap → `persistThumbnailsBulk` concurrency 8). That download half is reusable
  against any backend.
- **PR #128** (`87022fa`) reverted it because Firebase Storage forces a **Blaze
  upgrade** on the Firebase project. `getStorageBucket()` in `api/_fb-admin.js` is
  now dead scaffolding pointing at the deleted module.

So the capture is proven; only the storage backend's billing cliff sank it.

> **Correction (Codex #2):** the live scrape does **not** download bytes itself.
> `api/social-organic.js:411` hands the CDN **URL** to Anthropic for vision;
> Anthropic fetches it. We never hold the bytes. So B/C must add a real download
> step — exactly the #126 `downloadBytes` code. There is no "we already have the
> bytes" free lunch, but the download is cheap and proven.

## Platform map — can we get a permanent, free still?

| Source | Permanent free still? | Mechanism / notes |
|---|---|---|
| **YouTube / Shorts** | **YES** | `https://i.ytimg.com/vi/{id}/hqdefault.jpg` — permanent, free, no auth. Wired in Format Library via `youTubeIdFromUrl`; **not** in proposal cards. `hqdefault` is the safe size; detect the 120×90 grey "no thumb" via `naturalWidth <= 120` (already handled in `ReelPreview`). |
| **Instagram** | **NO** | No dependable unauthenticated durable thumbnail. Apify `displayUrl` is a CDN-signed URL that 403s within hours. The `/p/{shortcode}/embed` iframe renders a live frame but is heavy/flaky in grids. **Only durable path = capture the provider URL's bytes while it is valid and self-host.** |
| **TikTok** | **Partial** | Public oEmbed (`/oembed?url=`) returns `thumbnail_url` with no token, but it is a TikTok CDN URL that also expires. Same capture-and-self-host approach. Small share of library. |

> **Correction (Codex #3):** earlier draft anchored on "IG oEmbed thumbnail
> removed 3 Nov 2025 + needs token." The app uses the raw `/embed` iframe, not the
> oEmbed API, so oEmbed policy doesn't drive any option here. Treat it as: *IG
> oEmbed is not a dependable unauthenticated durable thumbnail source; recheck
> exact field availability before building against it.* Don't anchor on the date.

> **Correction (Codex #1) — the real capture rule.** "Snapshot at scrape" is too
> narrow. The rule is **snapshot whenever a valid provider URL is available**,
> from *every* lifecycle entry point, not just the bulk scraper:
> scrape ingest, shortlist save, manual "add example", manual "add format", and a
> proposal-generation backfill when an example lacks a persisted thumbnail. The
> clean shape is one shared server endpoint, e.g.
> `persistExternalThumbnail({ url, platform, source })`, that all of those call.
> For a manually-pasted IG URL (no scrape), resolve the still via a single-URL
> Apify call first; `og:image` page-scraping is a brittle *fallback*, not the lead.

## Options

### A — Minimal: free frames only
Wire YouTube `hqdefault` into the proposal cards (and keep it in the library).
IG/TikTok keep the branded gradient.
- **Pro:** trivial, no backend, fixes every YouTube/Shorts card immediately.
- **Con:** nothing for the Instagram majority — the actual complaint.
- **Verdict:** necessary sub-step of everything below, insufficient alone.

### B — Snapshot → Vercel Blob
Resurrect `persistThumbnail` (#126) targeting **Vercel Blob** instead of Firebase
Storage, invoked via the shared `persistExternalThumbnail` endpoint. Store the
permanent Blob URL on `post.thumbnail` / `example.thumbnail`. Fold in A.
- **Pro:** permanent, CDN-served, **no RTDB payload bloat** (URL not bytes),
  app-wide, reuses proven #126 code.
- **Con / caveats (Codex #4, #5, #10):**
  - **Plan/ToS trap, not trap-free.** "Multiple crons proves Pro" is **false** —
    Hobby now allows 100 cron jobs. Blob's Hobby tier is *non-commercial*; a
    commercial agency dashboard shouldn't rely on it, and if the project is (or
    is later assumed to be) Hobby, Blob pauses on limit. **B is only safe on a
    confirmed paid Pro project.** Set Spend Management, add
    `BLOB_READ_WRITE_TOKEN`.
  - **Public URLs.** Blob public objects live on a public
    `*.public.blob.vercel-storage.com` domain — fine for already-public reel
    frames, but document the exposure (esp. client-facing proposals).
  - **Idempotency must use explicit metadata**, not the #126
    `storage.googleapis.com` URL-prefix check (Blob URLs differ → duplicate
    uploads). Store `thumbnailPersisted`, `thumbnailProvider`,
    `thumbnailSourceUrl`, `thumbnailPersistedAt`; deterministic pathnames +
    `allowOverwrite`.
- **New surface:** `@vercel/blob` dependency + token.

### C — Snapshot → RTDB base64 (separate node)
Same capture, store the JPEG as a base64 data URI in a dedicated
`/thumbCache/{platform}/{videoId}` node, loaded **lazily by id** — never inline in
the format/post list listeners. Fold in A.
- **Pro:** no new vendor, **no plan/ToS dependency at all**, matches the Motion
  Graphics base64-in-RTDB precedent, all existing Firebase infra.
- **Scale is fine (Codex #6):** ~1,800 thumbs × 33–60 KB ≈ 60–108 MB stored; a
  proposal loads ~12 thumbs (<1 MB); a 200-card browse 7–12 MB. Well under RTDB
  limits (10 MB max string / 16 MB SDK write / 256 MB REST). The *only* real
  hazard is a mistaken **parent listener** on `/thumbCache` pulling everything at
  once — guard against it.
- **Con / caveats (Codex #6, #7):**
  - Strict discipline: one child per thumbnail, read per visible card by id,
    never under `/formatLibrary`, never a parent listen. Add a lint/review guard.
  - **Image-processing dependency.** No `sharp`/`jimp` in the repo today. To keep
    base64 small you either add `sharp` (native dep, cold-start/bundle cost) **or**
    — preferred to preserve C's no-new-dep advantage — **store raw bytes under a
    size cap** (skip/queue if the source still is > ~120 KB; IG stills are
    typically ~50–80 KB). Add `sharp` only if real stills come back large.

### D — On-demand caching proxy
`/api/thumb?shortcode=…` fetches a fresh still on first request, streams with
`Cache-Control: immutable`.
- **Non-starter as drawn (Codex):** by first view the displayUrl is usually
  already expired, so it has nothing fresh to fetch unless it re-scrapes
  (expensive). The capture still has to happen while the URL is valid — which is
  what B/C already do. Only viable if it *also* persists at add/scrape time, at
  which point it collapses into B/C.

### E — Lazy live IG embed iframe
IntersectionObserver-mount `/embed` iframes, cap concurrency, gradient underlay.
- **Non-starter for grids:** the exact white-box/rate-limit/heaviness failure that
  made the grid drop embeds. Acceptable only for low-count detail/proposal embeds.

## Cross-cutting work items (independent of storage choice)

- **Proposal wire-up (Codex #9, High-value).** Even after B/C persist a URL, the
  client proposal stays gradient until: `ClientReview.jsx:126` stops discarding
  `thumbnail`, `ClientReviewUI.jsx:210` renders poster mode (YouTube-frame-first),
  and format-library examples carry persisted thumbnails before a proposal is
  generated. This is mandatory and is essentially Option A's wiring extended.
- **Backfill (Codex #8).** The Apify cache (`/caches/apifyScrapes`, 14-day TTL)
  holds the *same expiring URLs* — already dead for most records, so it is **not**
  a viable backfill source. Backfill = re-scrape (try a recent cached URL with a
  HEAD first, else re-scrape). The **Format Library** (the actual complaint) is
  small — dozens-to-low-hundreds of formats — so its backfill is cheap. Analytics
  history (~1,800 posts ≈ $4.68, throttled under the $5/day Apify cap) can largely
  be left to **self-heal forward** on the next scrape rather than bulk-backfilled.
- **Observability (Codex #11).** `onError` currently hides failures silently — a
  token misconfig, IG field rename, or failed backfill degrades to gradient with
  no signal. Store `thumbnailPersisted` / `thumbnailError`, log persist
  success/fail counts per scrape run, and add an admin audit listing "examples
  with a URL but no persisted thumbnail." *(Pushed back on the suggested
  client-side Slack beacon — over-built for this scale; the flag + audit is enough
  signal.)*
- **Legal/ToS (Codex #10).** Self-hosting a snapshot is a *copy*, legally distinct
  from hotlinking/embedding. Internal-dashboard risk is low; public Blob URLs and
  client-facing proposals raise it slightly. Keep source/attribution links, don't
  index the assets, delete on request. Don't frame it as "same exposure" as
  hotlinking — it isn't, but for reference reels shown in a proposal it's low
  stakes.

## Recommendation (post-review)

**Vercel plan confirmed: Pro, Active** (screenshot 2026-06-30 — $20 included
credit, $200 on-demand budget at 21%, Spend Management on). So B's plan/ToS trap
is **off the table** — Blob is fully safe to use commercially here.

Both B and C are now viable. The remaining differences, at Viewix's scale:

- **C + A — recommended.** Adds **no new vendor and no new dependency** (existing
  Firebase + the existing Motion-Graphics base64-in-RTDB pattern), and keeps this
  **off the Vercel on-demand meter Jeremy is actively budgeting** ($41.60/$200) —
  RTDB is Firebase Spark (free, separate bill). Base64 data URIs also travel with
  an exported/emailed proposal (self-contained), where external Blob URLs would
  need a live fetch. Only cost: render-time discipline (lazy per-id loads) and a
  possible `sharp` (avoidable via a byte cap).
- **B + A — also fine now.** Public Blob URLs keep RTDB lean and give clean
  shareable CDN URLs (useful if stills are ever consumed outside the app). Costs
  pennies/mo on the Vercel meter. Picks up a `@vercel/blob` dependency + token and
  the metadata-idempotency caveat. Pick this if you specifically want the stills
  as external URLs.

Both paths share the **same three mandatory work items** regardless: the proposal
wire-up, the multi-entry-point `persistExternalThumbnail` capture, and the
observability fields. Pick the storage backend; the rest is identical.

D and E are out.
