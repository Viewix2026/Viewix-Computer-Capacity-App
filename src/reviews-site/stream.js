// src/reviews-site/stream.js
//
// Pure, DOM-free helpers for the reviews wall. Kept separate from
// main.js so node --test can exercise them (api/__tests__/).

export const AVATAR_COLOURS = ["#0082FA", "#004F99", "#AE3A00"]; // brand only

export const hashName = (s) =>
  [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export const avatarColour = (name) =>
  AVATAR_COLOURS[hashName(name) % AVATAR_COLOURS.length];

export const initials = (s) =>
  String(s).split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

// Badge text derives from API meta — never hardcoded (design rule).
export function badgeText(meta) {
  if (!meta || !meta.count) return null;
  const rating = meta.rating != null ? Number(meta.rating).toFixed(1) : null;
  if (rating == null) return null;
  return { rating, count: meta.count };
}

// Merge stream: a testimonial after EVERY 3rd review — fixed index
// rule from the design spec ("after review index 2, 5, 8..."), holds
// as the count grows; testimonials cycle if slots outnumber them, and
// unused testimonials append at the tail.
export function buildStream(reviews, testimonials) {
  const stream = [];
  let v = 0;
  (reviews || []).forEach((r, i) => {
    stream.push({ kind: "review", data: r });
    if ((i + 1) % 3 === 0 && testimonials?.length) {
      stream.push({ kind: "video", data: testimonials[v % testimonials.length] });
      v++;
    }
  });
  while (v < (testimonials?.length || 0)) {
    stream.push({ kind: "video", data: testimonials[v] });
    v++;
  }
  return stream;
}

// Real-thumbnail facade (Jeremy 2026-06-12: the brand-gradient facade
// hid what each video was). Ordered candidate URLs, best first:
// maxresdefault (1280px) only exists for HD uploads, hqdefault (480px)
// exists for every YouTube video — the <img> walks the list on error.
// Vimeo has no keyless thumbnail endpoint, so an empty list keeps the
// gradient facade.
export function thumbnailUrlsFor(t) {
  if (!t || t.provider !== "youtube" || !t.videoId) return [];
  const id = encodeURIComponent(t.videoId);
  return [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];
}

// Slice the stream into N row chunks (design: 4 rows, sequential
// chunks, alternating direction, per-row duration).
export const ROWS = 4;

// Motion is defined as constant SPEED, not fixed duration. The design
// file shipped fixed durations (52-70s) tuned to its 15-card demo; the
// -50% loop distance scales with track width, so the same duration on
// the real 80+-card stream moved ~6x the pixels per second and felt
// frantic (Jeremy 2026-06-13: "very disorienting"). Per-row variation
// keeps the organic drift the design wanted. ~28px/s crosses a 1400px
// viewport in ~50s — inside the design's stated 30-60s intent.
export const ROW_SPEEDS_PPS = [30, 24, 28, 22];

// Seamless loop = translateX(-50%), so the loop distance is HALF the
// track's scroll width. Returns a css duration string, floored so a
// degenerate narrow track can never spin.
export function durationForTrack(scrollWidthPx, pxPerSecond) {
  const distance = Math.max(0, Number(scrollWidthPx) || 0) / 2;
  const pps = Math.max(1, Number(pxPerSecond) || 1);
  return `${Math.max(20, Math.round(distance / pps))}s`;
}

export function rowChunks(stream, rows = ROWS) {
  const per = Math.ceil(stream.length / rows) || 1;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const items = stream.slice(i * per, (i + 1) * per);
    if (items.length) out.push(items);
  }
  return out;
}
