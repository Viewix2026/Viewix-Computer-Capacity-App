# Scope Packet — viewixreviews.com.au reviews wall

**Status:** LIVE-PENDING-DNS 2026-06-12 — shipped via PR #296 (22f279e);
first sync verified in prod (61 reviews, 5.0, publish gate passed);
testimonials (22 from Jeremy's YouTube playlist) + cron-auth refactor in
follow-up PR; DNS cutover is the only remaining step.
**Created:** 2026-06-11

## Implementation deltas (Gate 1.5 — none material)

No material deviations from the approved plan. Notes:
- Design superseded brief copy (approved in its own design thread): headline
  "Glad you're here.", CTA label "www.viewix.com.au", owner replies not
  rendered, testimonial every 3rd review, 4 marquee rows.
- Clamp-toggle scheduling hardened beyond the design file (its rAF/IO-only
  scheduling never fires in hidden/background tabs — found during preview
  verification).
- Code loop adds: reviewsOrigin pinned to Google (input + normalize), atomic
  single-write publish, REVIEWS_MIN_COUNT parse hardening. Pushed back on a
  concurrency lease (single daily writer by design; revisit if a second
  writer ever appears).
- Firebase rules untouched: default-deny already covers /reviewsSite (admin
  SDK bypasses rules) — no separate rules deploy needed.

## Launch checklist — state at 2026-06-12

1. ~~Testimonials~~ DONE — 22 entries from the "Client Testimonials"
   playlist; the duplicate Masari landscape cut was dropped in favour of
   the 9:16 Short (reverse by editing testimonials.json).
2. ~~Vercel env~~ DONE — REVIEWS_PLACE_URL (Maps CID URL for the verified
   Dulwich Hill listing, 5.0/61), REVIEWS_MIN_COUNT=55.
3. ~~Domains~~ DONE — apex + www attached, SSL pre-issued.
4. ~~First sync~~ DONE — published 61/61 through the gate,
   lastSyncAt 2026-06-12T13:14Z. Cron-auth refactored to _cronAuth
   (manual runs = ?secret=$CRON_TEST_SECRET&force=1).
5. Post-DNS done checks: JSON-not-HTML on the reviews host, /r/x route
   leak spot-check, OG preview, phone check.
6. ~~DNS~~ DONE 2026-06-12 — GoDaddy: A @ → 216.150.1.1, CNAME www →
   2694a2e192df6154.vercel-dns-017.com (Vercel's current records, not the
   legacy ones first documented here); www 308s to apex. SITE IS LIVE.
   Post-launch additions: bare-root host routing needed edge middleware
   (middleware.js, PR #300 — Vercel serves filesystem index.html for "/"
   before rewrites), and testimonial facades got real YouTube thumbnails
   on Jeremy's feedback (maxres→hq fallback, still click-to-load).

## Outcome

viewixreviews.com.au IS the website for that domain: a sales-proof URL Jeremy
drops into proposals, signatures, and follow-ups. Prospects land on a full wall
of real Google reviews slowly scrolling across the screen, a headline along the
lines of "See what our clients say" (copy to be workshopped), and one CTA back
to viewix.com.au / booking.

## Scope

**In:**
- Scrolling wall of ALL Google reviews (not the 5-review Places API subset)
- ALL Viewix video testimonials interleaved through the scrolling reviews
- Headline + one CTA
- Single page, mobile + desktop

**Out (this round):**
- Filtering/search/sorting of reviews
- Review-submission / "leave a review" flow
- Conversion-landing machinery (forms, retargeting pixels, A/B)
- Any additional pages

## Done looks like

- Live on viewixreviews.com.au in prod, real review data, smooth slow scroll
  verified on phone and desktop.
- **Design hand-off:** Jeremy will have Claude design produce the page design
  from a brief we write. The design brief is a deliverable of this pipeline
  (brand guidelines applied). We build the data pipeline + page scaffolding and
  implement the final design.

## Hard constraints

- Viewix brand guidelines apply (use viewix-brand-guidelines skill for the brief).
- Cost ceiling: no recurring subscriptions. Apify runs (~cents/run) acceptable;
  end state is the free official GBP API.

## Resolved decisions

- Outcome = the whole site for the domain, with CTA (not a bare brand wall).
- Video testimonials are in scope, spread through the review stream.
- Design is produced externally (Claude design) from our brief; we implement.
- **Review sourcing: Apify now, GBP API later.** Ship on an Apify Google Maps
  reviews pull (all reviews, ~cents/run, scheduled re-run for freshness), then
  swap the sync to the official Google Business Profile API once access is
  approved. Storage layer must be source-agnostic so the swap is sync-side only.

## Gate 1 decisions (2026-06-11)

- **Where it lives:** same repo + same Vercel project, second Vite entry,
  host-routed. Approved with the plan.
- **Sequencing:** everything waits for the external Claude design — no v1
  throwaway design, domain goes live once. The design brief is the immediate
  deliverable (docs/plans/viewix-reviews-design-brief.md).
- **CTA:** one CTA → viewix.com.au (not the booking link).

## Open items (content, not decisions)

- **Video testimonial inventory** — Jeremy to provide URLs + client names;
  becomes src/reviews-site/testimonials.json. *Trigger: before build.*
- **Headline copy** — options offered in the design brief; final pick lands
  with the design.
- **Claude-design output** — the build trigger.

## Draft plan v3 (pre-Gate 1 — Codex rounds 1–2 folded, round 3 verdict BUILDABLE_AS_IS)

### Architecture — recommended: same repo, second Vite entry

- `vite.config.js`: add `rollupOptions.input = { index: 'index.html', reviews:
  'reviews.html' }` (multi-page build). The reviews entry is a tiny
  self-contained page — no dashboard code, no Firebase client SDK. Build check:
  `dist/reviews.html` exists and its hashed assets resolve.
- `vercel.json`: host-scoped rules for `viewixreviews.com.au` AND
  `www.viewixreviews.com.au` placed BEFORE all existing SPA rewrites.
  `/api/*` and `/assets/*` pass through untouched; every other path on the
  reviews host rewrites to `/reviews.html` (catch-all — dashboard routes like
  `/d/`, `/r/` can never leak onto the reviews domain).
- Domain added to the existing Vercel project (apex + www, www → apex redirect).

Why same-repo: one deploy pipeline, direct reuse of Apify integration, cron
auth, firebase-admin helpers, env vars. No CORS, no second project to babysit.

*Alternative (Gate 1 decision):* separate Vercel project/repo fetching from a
CORS-enabled dashboard endpoint. Cleaner separation, more moving parts.

### Data pipeline — cron-only, validated publish (no webhook)

1. **Sync cron `api/cron/reviews-sync.js`** — CRON_SECRET-gated, **daily**
   schedule. Every invocation first checks for a pending runId and ingests its
   dataset if the run finished; it starts a NEW Apify scrape only when
   `lastSuccessfulSyncAt` is older than 7 days. So the scrape is weekly but a
   slow run is picked up within a day, not a week (Codex R2#1). **Timeout
   safety (R2#2):** `pendingRunId` is persisted immediately after the actor
   run starts, BEFORE polling; polling stops at an internal ~240s cutoff and
   exits cleanly; `pendingRunId` is cleared only after a successful publish or
   a confirmed terminal failure. Verify the Vercel plan's `maxDuration`
   ceiling during build — the design degrades gracefully to short-poll +
   next-day pickup either way. Single writer — no webhook, no `_apifyProcess`
   sidecar contract (Codex F13: webhook leg was over-engineering).
2. **Validated publish gate (Codex F3, R2#3)** — scrape staged under its
   runId; publish to `/reviewsSite/reviews` only if the run SUCCEEDED and
   `newCount >= max(REVIEWS_MIN_COUNT, 0.8 × currentCount)`.
   `REVIEWS_MIN_COUNT` is an env var set from the verified Google review
   count before launch — adjustable, so a legitimate undercount can't
   deadlock the first publish. On gate failure: keep the live set and alert
   with the actual counts via Slack — reuse the posting pattern in
   `api/_slack-helpers.js` (or add a one-function `postCronAlert()` wrapper;
   R2#6). Never silently shrink the wall.
3. **Provider-neutral review schema (Codex F7, R2#7)** — `id =
   `${source}:${sourceReviewId}``; for Apify, `sourceReviewId = item.reviewId`
   (verify the chosen actor's field name during build); items lacking a stable
   source ID are rejected and counted in the alert. Fields: `id`, `source`,
   `sourceReviewId`, `sourceUrl`, `authorDisplayName`, `rating`, `text`,
   `createdAt`, `updatedAt`, `ownerReply? { text, createdAt? }`,
   `firstSeenAt`, `lastSeenAt`, `deletedAt?`. No avatar URLs — Google avatar
   links rot/hotlink-block; the page renders monogram initials.
4. **Lifecycle (Codex F10)** — each validated-complete scrape diffs source IDs
   against stored: update changed text/rating (`updatedAt`), tombstone missing
   (`deletedAt`, soft) — tombstoning only ever follows a validated-complete
   scrape. Endpoint excludes tombstoned.
5. **GBP swap seam** — one `fetchAllReviews(): NormalizedReview[]` boundary;
   Apify implementation now, GBP later. The schema above (native
   `sourceReviewId`, `updatedAt`, `ownerReply`) is what makes the swap a
   module replacement instead of a migration.
6. **RTDB rules** — `/reviewsSite`: client reads unnecessary (endpoint-only),
   client writes denied; admin SDK only.

### Testimonials — build-time repo JSON (no RTDB, no seed script)

`src/reviews-site/testimonials.json`, repo-tracked, imported at build time:
`{ provider: 'youtube'|'vimeo', videoId, clientName, title, aspect,
thumbOverride? }`. Updating = edit JSON + deploy (rare changes; simpler than
Codex's suggested seed script, far simpler than an admin UI). Lite embeds:
thumbnail + play button, iframe injected on click only (YouTube nocookie /
Vimeo), `title` + `allow` attrs set, CSS `aspect-ratio` locked pre-load to
prevent layout shift. Unknown providers render as a linked card, never a
broken embed.

### Public read endpoint

`api/public/reviews.js` — delivery-am.js redaction pattern: admin SDK reads
`/reviewsSite`, returns `{ meta: { rating, count, lastSyncAt }, reviews: [...] }`
(curated fields only, tombstones excluded), `Cache-Control: s-maxage=3600,
stale-while-revalidate=86400`. Page makes ONE fetch. **Empty state (Codex F6):**
before first sync the endpoint returns `{ hasData: false }` and the page
renders headline + CTA + testimonials gracefully; launch ordering puts DNS
cutover AFTER the first verified sync, so prospects can never see an empty
wall. Launch verification reads payload fields (lastSyncAt, count) with a
cache-buster, not the cached edge copy (Codex F9).

### Page

- Slow continuous marquee of review cards (CSS transform, duplicated track for
  seamless loop — duplicate track `aria-hidden` (Codex F11)). Pause control:
  one visible pause/play toggle, keyboard-focusable — covers keyboard, touch,
  and screen-reader users in a single control; hover also pauses.
  `prefers-reduced-motion` → static grid. Mobile: single column.
- **Interleave contract (R2#5):** reviews stable-sorted (`createdAt` desc, `id`
  tiebreak); testimonials inserted at fixed slot indices, independent of weekly
  count drift. When `hasData: false`, the page renders a coherent
  testimonials-led layout (this state and the slot rules go in the design
  brief).
- Headline ("See what our clients say" — copy workshopped in the design brief),
  live rating badge ("5.0 ★ · 61 Google reviews" from meta), one CTA.
- SEO/share: title, meta description, static `reviews-og.png` (1200×630,
  produced in the design session, verified via prod HTML fetch — launch
  blocker, Codex F14).

### Design hand-off

Design brief written with the viewix-brand-guidelines skill: headline copy
options, motion spec, a11y requirements above, monogram avatars, OG image
deliverable, and the exact per-card data shape so the external design matches
what we render. Jeremy takes it to Claude design; we implement the returned
design. Build sequencing (ship our own v1 first vs wait for the external
design) is a Gate 1 decision.

### Manual steps (Jeremy) — ordered

1. Provide the video testimonial list (URLs + client names).
2. Deliver the Claude-design output (incl. OG image) when ready.
3. LAST, after first verified sync: point viewixreviews.com.au DNS at Vercel
   (apex + www) — domain goes live only once data is proven.

### Done checks (revised per Codex F6/F9, R2#4/#8)

- `dist/reviews.html` emitted; assets resolve on the reviews host.
- Public endpoint returns non-empty real reviews on the production domain
  (cache-busted payload check: count ≥ REVIEWS_MIN_COUNT, fresh lastSyncAt).
- `GET viewixreviews.com.au/api/public/reviews` returns JSON, not HTML — the
  host catch-all must not swallow `/api/*` (R2#4).
- Dashboard routes spot-checked on the reviews host (`/r/x`, `/d/x`) — serve
  the reviews page, not the dashboard.
- Cron wiring verified (R2#8): vercel.json cron entry exists; env vars set in
  Vercel (`APIFY_API_TOKEN`, `REVIEWS_PLACE_ID`, `REVIEWS_MIN_COUNT`,
  `CRON_SECRET`); one manual authenticated invocation succeeds end-to-end and
  a scheduled run is observed in the Apify console.
- Smooth slow scroll on phone + desktop; pause toggle works by keyboard and
  tap; reduced-motion serves the static grid.
- Testimonials render and play; OG preview renders on a real share.

## Implementation deltas

*(only if the build deviates)*
