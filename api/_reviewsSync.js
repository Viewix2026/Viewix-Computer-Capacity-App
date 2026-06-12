// api/_reviewsSync.js
//
// Pure logic + Apify client for the viewixreviews.com.au sync pipeline.
// The cron (api/cron/reviews-sync.js) orchestrates; everything testable
// lives here. Plan: docs/plans/viewix-reviews-site-scope-packet.md.
//
// Provider seam: fetchAllReviews() is the only function the cron calls
// to obtain normalized reviews. Today it runs an Apify Google Maps
// reviews actor; when Google Business Profile API access lands, only
// this module's fetch side changes — the normalized shape is the
// contract and the merge/gate/meta logic is provider-agnostic.

// ── Normalized review shape ─────────────────────────────────────────
// {
//   id: "google:<sourceReviewId>",
//   source: "google",
//   sourceReviewId, sourceUrl,
//   authorDisplayName, rating (1–5 int), text,
//   createdAt (ISO), updatedAt (ISO|null),
//   ownerReply: { text, createdAt|null } | null,
//   firstSeenAt, lastSeenAt, deletedAt (ISO|null)   ← merge-managed
// }

const APIFY_BASE = "https://api.apify.com/v2";

// Default actor: Compass' Google Maps reviews scraper. Override with
// APIFY_REVIEWS_ACTOR if the chosen actor differs at go-live.
export const DEFAULT_REVIEWS_ACTOR = "compass~google-maps-reviews-scraper";

// RTDB keys can't contain . # $ / [ ] — Google review ids are base64ish
// and can carry "/" and "=". base64url is RTDB-safe and reversible.
export function rtdbKeyForId(id) {
  return Buffer.from(String(id), "utf8").toString("base64url");
}

// ── Normalization (Apify item → normalized review) ──────────────────
// Field names vary across Google Maps reviews actors; we accept the
// common candidates and REJECT anything without a stable source id —
// dedupe and tombstoning both hang off it (Codex R2#7).
export function normalizeApifyItem(item) {
  if (!item || typeof item !== "object") return null;
  // The actor can scrape non-Google origins (Tripadvisor etc.) when
  // reviewsOrigin isn't pinned — never let one render as a Google
  // review (Codex code-review F1). Belt (input) and braces (here).
  if (item.reviewOrigin && String(item.reviewOrigin).toLowerCase() !== "google") return null;
  const sourceReviewId = firstString(item.reviewId, item.review_id, item.id);
  if (!sourceReviewId) return null;

  const rating = Number(item.stars ?? item.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;

  const text = firstString(item.text, item.textTranslated, item.reviewText) || "";
  const createdAt = toIso(item.publishedAtDate ?? item.publishAt ?? item.publishedAt);
  const ownerReplyText = firstString(item.responseFromOwnerText, item.ownerResponse);

  return {
    id: `google:${sourceReviewId}`,
    source: "google",
    sourceReviewId,
    sourceUrl: firstString(item.reviewUrl, item.url) || null,
    authorDisplayName: firstString(item.name, item.reviewerName, item.author) || "Google user",
    rating: Math.round(rating),
    text,
    createdAt,
    updatedAt: null,
    ownerReply: ownerReplyText
      ? { text: ownerReplyText, createdAt: toIso(item.responseFromOwnerDate) }
      : null,
  };
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Dedupe a scrape by id (actors occasionally repeat items across pages).
export function dedupeById(reviews) {
  const seen = new Map();
  for (const r of reviews) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

// REVIEWS_MIN_COUNT parsing: unset/empty/garbage all land on the safe
// default — a typo'd env var must never collapse the floor to 0 and
// let an empty scrape publish an empty wall (Codex code-review F3).
export const DEFAULT_MIN_COUNT = 50;
export function parseMinCount(raw) {
  if (raw == null || raw === "") return DEFAULT_MIN_COUNT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_COUNT;
}

// ── Publish gate (Codex F3 / R2#3) ──────────────────────────────────
// Never let a partial scrape silently shrink the wall. The floor is an
// env-set absolute (verified Google count before launch, adjustable so
// a legitimate undercount can't deadlock), plus a relative 80% guard
// against regressions once live.
export function publishGate({ newCount, currentLiveCount, minCount }) {
  const floor = Math.max(Number(minCount) || 0, Math.ceil(0.8 * (currentLiveCount || 0)));
  if (newCount >= floor) return { pass: true, floor };
  return {
    pass: false,
    floor,
    reason: `scrape returned ${newCount} reviews; floor is ${floor} ` +
      `(min=${minCount}, current live=${currentLiveCount})`,
  };
}

// ── Merge / lifecycle (Codex F7/F10) ────────────────────────────────
// Full-scrape diff against the stored map (keyed by rtdbKeyForId):
//   · new id        → firstSeenAt=now
//   · changed text/rating/reply → updatedAt=now
//   · present       → lastSeenAt=now, deletedAt cleared (resurrection)
//   · missing       → soft tombstone (deletedAt=now) — callers only run
//     this after the publish gate passed, i.e. a validated-complete scrape.
export function mergeReviews(existingMap, scraped, nowIso) {
  const out = {};
  const seenKeys = new Set();
  let added = 0, updated = 0, tombstoned = 0;

  for (const r of scraped) {
    const key = rtdbKeyForId(r.id);
    seenKeys.add(key);
    const prev = existingMap?.[key];
    if (!prev) {
      out[key] = {
        ...r,
        createdAt: r.createdAt || nowIso,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        deletedAt: null,
      };
      added++;
      continue;
    }
    const changed =
      prev.text !== r.text ||
      prev.rating !== r.rating ||
      (prev.ownerReply?.text || null) !== (r.ownerReply?.text || null);
    out[key] = {
      ...prev,
      ...r,
      createdAt: prev.createdAt || r.createdAt || nowIso,
      firstSeenAt: prev.firstSeenAt || nowIso,
      updatedAt: changed ? nowIso : prev.updatedAt || null,
      lastSeenAt: nowIso,
      deletedAt: null,
    };
    if (changed) updated++;
  }

  for (const [key, prev] of Object.entries(existingMap || {})) {
    if (seenKeys.has(key)) continue;
    if (!prev.deletedAt) tombstoned++;
    out[key] = { ...prev, deletedAt: prev.deletedAt || nowIso };
  }

  return { reviews: out, stats: { added, updated, tombstoned } };
}

export function liveReviews(reviewsMap) {
  return Object.values(reviewsMap || {}).filter((r) => r && !r.deletedAt);
}

// Meta the public endpoint serves: live count + 1dp average rating.
export function computeMeta(reviewsMap, nowIso) {
  const live = liveReviews(reviewsMap);
  const count = live.length;
  const rating = count
    ? Number((live.reduce((a, r) => a + (r.rating || 0), 0) / count).toFixed(1))
    : null;
  return { rating, count, lastSyncAt: nowIso };
}

// ── Apify client (start / status / dataset) ─────────────────────────

export function buildActorInput() {
  const placeUrl = process.env.REVIEWS_PLACE_URL;
  const placeId = process.env.REVIEWS_PLACE_ID;
  if (!placeUrl && !placeId) {
    throw new Error("Neither REVIEWS_PLACE_URL nor REVIEWS_PLACE_ID is configured");
  }
  const input = {
    language: "en",
    maxReviews: 999,
    reviewsSort: "newest",
    reviewsOrigin: "google", // never mix in other-platform reviews (F1)
    personalData: true, // reviewer display names are the card content
  };
  if (placeUrl) input.startUrls = [{ url: placeUrl }];
  else input.placeIds = [placeId];
  return input;
}

export async function startReviewsRun({ token, actorId, input }) {
  const url = `${APIFY_BASE}/acts/${actorId}/runs?token=${encodeURIComponent(token)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Apify run start ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const runId = data.data?.id;
  if (!runId) throw new Error("Apify didn't return a run id");
  return { runId, datasetId: data.data?.defaultDatasetId || null };
}

export async function getRun({ token, runId }) {
  const r = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(`Apify get run ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data.data; // { status, defaultDatasetId, ... }
}

export const TERMINAL_FAIL = new Set(["FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]);

export async function getDatasetItems({ token, datasetId }) {
  const r = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true&limit=5000`
  );
  const data = await r.json();
  if (!r.ok) throw new Error(`Apify dataset ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return Array.isArray(data) ? data : [];
}
