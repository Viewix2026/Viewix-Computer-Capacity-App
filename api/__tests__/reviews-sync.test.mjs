// node --test api/__tests__/reviews-sync.test.mjs
//
// Unit tests for the viewixreviews.com.au pipeline: normalization,
// publish gate, merge/lifecycle, meta, and the page's pure stream
// helpers. Triggering inputs mirror the Codex plan-review findings
// they guard against (F3 partial scrape, F7/F10 lifecycle, R2#3
// first-publish deadlock, R2#7 unstable ids).

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeApifyItem, dedupeById, publishGate, parseMinCount,
  DEFAULT_MIN_COUNT, mergeReviews, liveReviews, computeMeta, rtdbKeyForId,
} from "../_reviewsSync.js";
import {
  buildStream, rowChunks, badgeText, initials, avatarColour, fmtDate, AVATAR_COLOURS,
} from "../../src/reviews-site/stream.js";

const NOW = "2026-06-11T00:00:00.000Z";

const apifyItem = (over = {}) => ({
  reviewId: "ChdDSUhN/abc+def=",
  name: "Sarah Mitchell",
  stars: 5,
  text: "Great team.",
  publishedAtDate: "2026-04-18T03:00:00.000Z",
  reviewUrl: "https://maps.google.com/?review=1",
  ...over,
});

// ── normalizeApifyItem ──────────────────────────────────────────────

test("normalize: happy path maps the canonical fields", () => {
  const r = normalizeApifyItem(apifyItem());
  assert.equal(r.id, "google:ChdDSUhN/abc+def=");
  assert.equal(r.sourceReviewId, "ChdDSUhN/abc+def=");
  assert.equal(r.authorDisplayName, "Sarah Mitchell");
  assert.equal(r.rating, 5);
  assert.equal(r.text, "Great team.");
  assert.equal(r.createdAt, "2026-04-18T03:00:00.000Z");
  assert.equal(r.ownerReply, null);
});

test("normalize: rejects items without a stable review id (R2#7)", () => {
  assert.equal(normalizeApifyItem(apifyItem({ reviewId: undefined })), null);
  assert.equal(normalizeApifyItem(apifyItem({ reviewId: "   " })), null);
  assert.equal(normalizeApifyItem(null), null);
});

test("normalize: rejects out-of-range or missing ratings", () => {
  assert.equal(normalizeApifyItem(apifyItem({ stars: undefined, rating: undefined })), null);
  assert.equal(normalizeApifyItem(apifyItem({ stars: 0 })), null);
  assert.equal(normalizeApifyItem(apifyItem({ stars: "nope" })), null);
});

test("normalize: accepts alternate actor field names", () => {
  const r = normalizeApifyItem({
    review_id: "alt-1", reviewerName: "Ben Tran", rating: 4,
    textTranslated: "Solid.", publishedAt: "2026-01-19",
    responseFromOwnerText: "Thanks Ben", responseFromOwnerDate: "2026-01-21",
  });
  assert.equal(r.id, "google:alt-1");
  assert.equal(r.authorDisplayName, "Ben Tran");
  assert.equal(r.rating, 4);
  assert.equal(r.text, "Solid.");
  assert.deepEqual(r.ownerReply, { text: "Thanks Ben", createdAt: new Date("2026-01-21").toISOString() });
});

test("normalize: rating-only review keeps empty text; bad date becomes null", () => {
  const r = normalizeApifyItem(apifyItem({ text: undefined, publishedAtDate: "not-a-date" }));
  assert.equal(r.text, "");
  assert.equal(r.createdAt, null);
});

test("normalize: rejects non-Google origins so they never render as Google reviews (code F1)", () => {
  assert.equal(normalizeApifyItem(apifyItem({ reviewOrigin: "Tripadvisor" })), null);
  assert.notEqual(normalizeApifyItem(apifyItem({ reviewOrigin: "Google" })), null);
  assert.notEqual(normalizeApifyItem(apifyItem({})), null); // absent field still accepted
});

// ── parseMinCount (code F3 — env typos must not collapse the floor) ─

test("parseMinCount: unset/empty/garbage/zero all fall back to the default", () => {
  assert.equal(parseMinCount(undefined), DEFAULT_MIN_COUNT);
  assert.equal(parseMinCount(""), DEFAULT_MIN_COUNT);
  assert.equal(parseMinCount("abc"), DEFAULT_MIN_COUNT);
  assert.equal(parseMinCount("0"), DEFAULT_MIN_COUNT);
  assert.equal(parseMinCount("-5"), DEFAULT_MIN_COUNT);
  assert.equal(parseMinCount("45"), 45);
});

test("parseMinCount: garbage env can never let an empty scrape publish an empty wall", () => {
  const g = publishGate({ newCount: 0, currentLiveCount: 0, minCount: parseMinCount("abc") });
  assert.equal(g.pass, false);
});

// ── rtdbKeyForId / dedupe ───────────────────────────────────────────

test("rtdbKeyForId produces RTDB-safe keys for base64ish ids", () => {
  const key = rtdbKeyForId("google:ChdDSUhN/abc+def=");
  assert.ok(!/[.#$/\[\]]/.test(key), `unsafe chars in ${key}`);
});

test("dedupeById keeps first occurrence", () => {
  const a = { id: "google:1", text: "first" };
  const b = { id: "google:1", text: "second" };
  assert.deepEqual(dedupeById([a, b, { id: "google:2" }]).map((r) => r.text ?? null), ["first", null]);
});

// ── publishGate ─────────────────────────────────────────────────────

test("gate: first publish passes at/above the env floor", () => {
  assert.equal(publishGate({ newCount: 61, currentLiveCount: 0, minCount: 50 }).pass, true);
  assert.equal(publishGate({ newCount: 50, currentLiveCount: 0, minCount: 50 }).pass, true);
});

test("gate: first publish blocks below the floor (R2#3 — env override is the escape hatch)", () => {
  const g = publishGate({ newCount: 48, currentLiveCount: 0, minCount: 50 });
  assert.equal(g.pass, false);
  assert.match(g.reason, /48/);
  // Lowered floor (the documented override) lets the same scrape through.
  assert.equal(publishGate({ newCount: 48, currentLiveCount: 0, minCount: 45 }).pass, true);
});

test("gate: a partial scrape can never shrink the live wall past 80% (F3)", () => {
  assert.equal(publishGate({ newCount: 40, currentLiveCount: 61, minCount: 50 }).pass, false);
  assert.equal(publishGate({ newCount: 55, currentLiveCount: 61, minCount: 50 }).pass, true);
});

// ── mergeReviews lifecycle ──────────────────────────────────────────

const normalized = (id, over = {}) => ({
  id: `google:${id}`, source: "google", sourceReviewId: id, sourceUrl: null,
  authorDisplayName: "A", rating: 5, text: "t", createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null, ownerReply: null, ...over,
});

test("merge: new reviews get firstSeen/lastSeen; createdAt falls back to now", () => {
  const { reviews, stats } = mergeReviews({}, [normalized("a", { createdAt: null })], NOW);
  const r = reviews[rtdbKeyForId("google:a")];
  assert.equal(stats.added, 1);
  assert.equal(r.firstSeenAt, NOW);
  assert.equal(r.createdAt, NOW);
  assert.equal(r.deletedAt, null);
});

test("merge: changed text marks updatedAt and preserves firstSeenAt", () => {
  const key = rtdbKeyForId("google:a");
  const existing = { [key]: { ...normalized("a"), firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", deletedAt: null } };
  const { reviews, stats } = mergeReviews(existing, [normalized("a", { text: "edited" })], NOW);
  assert.equal(stats.updated, 1);
  assert.equal(reviews[key].updatedAt, NOW);
  assert.equal(reviews[key].firstSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(reviews[key].text, "edited");
});

test("merge: missing reviews tombstone, already-tombstoned keep their date (F10)", () => {
  const keyA = rtdbKeyForId("google:a");
  const keyB = rtdbKeyForId("google:b");
  const existing = {
    [keyA]: { ...normalized("a"), firstSeenAt: NOW, lastSeenAt: NOW, deletedAt: null },
    [keyB]: { ...normalized("b"), firstSeenAt: NOW, lastSeenAt: NOW, deletedAt: "2026-05-01T00:00:00.000Z" },
  };
  const { reviews, stats } = mergeReviews(existing, [], NOW);
  assert.equal(stats.tombstoned, 1); // only A newly tombstoned
  assert.equal(reviews[keyA].deletedAt, NOW);
  assert.equal(reviews[keyB].deletedAt, "2026-05-01T00:00:00.000Z");
});

test("merge: a review that reappears on Google is resurrected", () => {
  const key = rtdbKeyForId("google:a");
  const existing = { [key]: { ...normalized("a"), firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-05-01T00:00:00.000Z" } };
  const { reviews } = mergeReviews(existing, [normalized("a")], NOW);
  assert.equal(reviews[key].deletedAt, null);
});

// ── meta ────────────────────────────────────────────────────────────

test("meta: live count + 1dp average, tombstones excluded", () => {
  const { reviews } = mergeReviews({}, [normalized("a", { rating: 5 }), normalized("b", { rating: 4 })], NOW);
  const withTombstone = mergeReviews(reviews, [normalized("a", { rating: 5 })], NOW).reviews;
  const meta = computeMeta(withTombstone, NOW);
  assert.equal(meta.count, 1);
  assert.equal(meta.rating, 5);
  assert.equal(liveReviews(withTombstone).length, 1);
});

test("meta: empty map yields null rating, zero count", () => {
  assert.deepEqual(computeMeta({}, NOW), { rating: null, count: 0, lastSyncAt: NOW });
});

// ── page stream helpers ─────────────────────────────────────────────

const reviewsOf = (n) => Array.from({ length: n }, (_, i) => ({ authorDisplayName: `R${i}`, rating: 5, text: "x", createdAt: NOW }));
const vids = (n) => Array.from({ length: n }, (_, i) => ({ provider: "youtube", videoId: `v${i}`, clientName: `C${i}`, aspect: "16:9" }));

test("stream: testimonials spread evenly by stride, no tail cluster", () => {
  const s = buildStream(reviewsOf(61), vids(22));
  const kinds = s.map((x) => x.kind);
  // every testimonial appears exactly once
  assert.equal(kinds.filter((k) => k === "video").length, 22);
  // the stream never ends in a glued video block of more than one
  assert.notEqual(kinds.slice(-2).join(","), "video,video");
  // max run of consecutive videos is 1 when reviews outnumber videos
  assert.equal(/video,video/.test(kinds.join(",")), false);
  // deterministic: same inputs, same stream
  assert.deepEqual(s, buildStream(reviewsOf(61), vids(22)));
});

test("stream: sparse supply spaces videos by stride, dense supply still places all", () => {
  const sparse = buildStream(reviewsOf(9), vids(2)).map((x) => x.kind);
  // 2 videos in 9 reviews land at thirds, not glued anywhere
  assert.deepEqual(sparse.filter((k) => k === "video").length, 2);
  assert.equal(/video,video/.test(sparse.join(",")), false);
  const dense = buildStream(reviewsOf(3), vids(9)).map((x) => x.kind);
  assert.equal(dense.filter((k) => k === "video").length, 9);
});

test("stream: empty testimonials yields reviews-only; empty reviews yields videos-only", () => {
  assert.equal(buildStream(reviewsOf(5), []).every((x) => x.kind === "review"), true);
  assert.equal(buildStream([], vids(3)).every((x) => x.kind === "video"), true);
  assert.equal(buildStream([], vids(3)).length, 3);
});

test("rowChunks: splits into at most 4 non-empty sequential rows", () => {
  const chunks = rowChunks(buildStream(reviewsOf(15), vids(6)));
  assert.ok(chunks.length <= 4 && chunks.length > 0);
  assert.equal(chunks.flat().length, buildStream(reviewsOf(15), vids(6)).length);
  assert.ok(chunks.every((c) => c.length > 0));
});

test("badge: derives from meta, hidden when absent (never hardcoded)", () => {
  assert.deepEqual(badgeText({ rating: 5, count: 61 }), { rating: "5.0", count: 61 });
  assert.equal(badgeText({ rating: null, count: 0 }), null);
  assert.equal(badgeText(null), null);
});

test("monograms: two initials, brand palette only", () => {
  assert.equal(initials("Sarah Mitchell"), "SM");
  assert.equal(initials("Cher"), "C");
  assert.ok(AVATAR_COLOURS.includes(avatarColour("Sarah Mitchell")));
});

test("fmtDate: en-AU month-year, safe on garbage", () => {
  assert.match(fmtDate("2026-03-14"), /Mar(ch)? 2026/);
  assert.equal(fmtDate(null), "");
  assert.equal(fmtDate("not-a-date"), "");
});

// ── cron auth contract (reviews-sync relies on _cronAuth semantics) ─

test("cronAuth: bearer CRON_SECRET authorizes but never unlocks force", async () => {
  const { isAuthorizedCron } = await import("../_cronAuth.js");
  process.env.CRON_SECRET = "s3cret";
  process.env.CRON_TEST_SECRET = "t3st";
  const r = isAuthorizedCron({ headers: { authorization: "Bearer s3cret" }, url: "/api/cron/reviews-sync" });
  assert.deepEqual({ ok: r.ok, secretValid: r.secretValid }, { ok: true, secretValid: false });
});

test("cronAuth: CRON_TEST_SECRET query unlocks force; forged x-vercel-cron is rejected", async () => {
  const { isAuthorizedCron } = await import("../_cronAuth.js");
  process.env.CRON_SECRET = "s3cret";
  process.env.CRON_TEST_SECRET = "t3st";
  const manual = isAuthorizedCron({ headers: {}, url: "/api/cron/reviews-sync?secret=t3st&force=1" });
  assert.deepEqual({ ok: manual.ok, secretValid: manual.secretValid }, { ok: true, secretValid: true });
  const forged = isAuthorizedCron({ headers: { "x-vercel-cron": "1" }, url: "/api/cron/reviews-sync?force=1" });
  assert.equal(forged.ok, false);
});

// ── edge middleware root routing (middleware.js) ────────────────────
// Vercel serves filesystem index.html for "/" BEFORE rewrites — the
// middleware closes that gap for the reviews host only.

test("middleware: reviews apex root rewrites to /reviews.html", async () => {
  const { rootRouteFor } = await import("../../middleware.js");
  assert.deepEqual(rootRouteFor("viewixreviews.com.au"), { action: "rewrite", pathname: "/reviews.html" });
  assert.deepEqual(rootRouteFor("VIEWIXREVIEWS.COM.AU"), { action: "rewrite", pathname: "/reviews.html" });
});

test("middleware: www root 308s to apex; every other host falls through", async () => {
  const { rootRouteFor } = await import("../../middleware.js");
  assert.deepEqual(rootRouteFor("www.viewixreviews.com.au"), { action: "redirect", location: "https://viewixreviews.com.au/" });
  assert.deepEqual(rootRouteFor("planner.viewix.com.au"), { action: "next" });
  assert.deepEqual(rootRouteFor("viewix-computer-capacity-app.vercel.app"), { action: "next" });
  assert.deepEqual(rootRouteFor(null), { action: "next" });
  // a port suffix must not break host matching
  assert.deepEqual(rootRouteFor("viewixreviews.com.au:443"), { action: "rewrite", pathname: "/reviews.html" });
});

test("thumbnails: youtube gets maxres→hq candidates, vimeo/garbage stay gradient", async () => {
  const { thumbnailUrlsFor } = await import("../../src/reviews-site/stream.js");
  assert.deepEqual(thumbnailUrlsFor({ provider: "youtube", videoId: "8-xMK87huo4" }), [
    "https://i.ytimg.com/vi/8-xMK87huo4/maxresdefault.jpg",
    "https://i.ytimg.com/vi/8-xMK87huo4/hqdefault.jpg",
  ]);
  assert.deepEqual(thumbnailUrlsFor({ provider: "vimeo", videoId: "123" }), []);
  assert.deepEqual(thumbnailUrlsFor(null), []);
  assert.deepEqual(thumbnailUrlsFor({ provider: "youtube" }), []);
});

test("motion: duration derives from track width at constant px/s", async () => {
  const { durationForTrack } = await import("../../src/reviews-site/stream.js");
  // 18000px track -> 9000px loop at 30px/s = 300s
  assert.equal(durationForTrack(18000, 30), "300s");
  // design-demo scale: 2000px track at 24px/s ≈ 42s
  assert.equal(durationForTrack(2000, 24), "42s");
  // degenerate inputs can never produce a fast spin: zero width floors
  // at 20s, an absurd speed request floors at 20s, and a zero speed
  // clamps to 1px/s (slower is always safe)
  assert.equal(durationForTrack(0, 30), "20s");
  assert.equal(durationForTrack(500, 99999), "20s");
  assert.equal(durationForTrack(500, 0), "250s");
});
