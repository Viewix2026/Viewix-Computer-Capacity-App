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

// Slice the stream into N row chunks (design: 4 rows, sequential
// chunks, alternating direction, per-row duration).
export const ROWS = 4;
export const ROW_DURATIONS = ["52s", "64s", "58s", "70s"];

export function rowChunks(stream, rows = ROWS) {
  const per = Math.ceil(stream.length / rows) || 1;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const items = stream.slice(i * per, (i + 1) * per);
    if (items.length) out.push(items);
  }
  return out;
}
