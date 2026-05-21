// api/_preprodCaptions.js
//
// Shared lookup: given a /preproduction/socialOrganic/{id} doc,
// return either a { videoId → caption } map or an ordinal-indexed
// array of captions. Used in two places:
//
//   1. api/_clientRedact.js — so the client portal Deliveries view
//      can READ-THROUGH from pre-prod when the delivery video's
//      caption snapshot hasn't fired yet (i.e. before approval).
//      Codex P1 (pass 2) catch: caption snapshot happens INSIDE
//      on-video-approved, so without a read-through the client
//      never sees the caption they're supposedly approving.
//
//   2. api/on-video-approved.js — at approval time, snapshot the
//      caption from pre-prod onto the delivery so the delivery
//      becomes the immutable record of what was approved.
//
// ─── Schema reality (Codex pass 3 P1) ──────────────────────────────
// The real socialOrganic pre-prod schema writes rows to
// preproductionDoc.scriptTable. Each row has:
//   { formatName, contentStyle, hook, textHook, visualHook,
//     scriptNotes, props, socialCaption (new — see
//     SocialOrganicResearch.jsx SCRIPT_COLUMNS), videoNumber, ... }
//
// scriptTable rows do NOT carry a videoId today. The mapping to
// delivery.videos[] is ordinal: row i ↔ video[i] (or, equivalently,
// videoNumber === i+1). If a row later carries an explicit videoId,
// that wins.
//
// Earlier passes of this helper walked nonexistent lists (`videos`,
// `posts`, `deliverables`) — returning {} against real data. Pass 3
// rewrites against the actual scriptTable schema.

const CAPTION_FIELDS = ["socialCaption", "caption", "copy"];
const SCRIPT_FALLBACK_FIELDS = ["scriptNotes", "script"];
const VIDEO_ID_FIELDS = ["videoId", "id", "deliveryVideoId"];

// Pull the caption-shaped value out of a single scriptTable row.
// Prefer explicit caption fields; fall back to scriptNotes ONLY if
// the producer hasn't written a real caption yet (so the client at
// least sees the script content instead of an empty cell — better
// than nothing while authoring is in progress).
function captionFromRow(row) {
  if (!row || typeof row !== "object") return "";
  for (const f of CAPTION_FIELDS) {
    const v = row[f];
    if (v && String(v).trim()) return String(v);
  }
  for (const f of SCRIPT_FALLBACK_FIELDS) {
    const v = row[f];
    if (v && String(v).trim()) return String(v);
  }
  return "";
}

// Returns a videoId for the row if one was explicitly stamped on it.
function rowVideoId(row) {
  if (!row) return null;
  for (const f of VIDEO_ID_FIELDS) {
    if (row[f]) return String(row[f]);
  }
  return null;
}

// Returns the scriptTable from a preprod doc, or an empty array if
// the doc isn't shaped as expected.
function scriptTable(preprod) {
  const doc = preprod?.preproductionDoc || preprod || {};
  const t = doc?.scriptTable;
  return Array.isArray(t) ? t : [];
}

// Captions keyed by videoId — only populates entries for rows that
// have an explicit videoId stamped on them. Used by the redactor +
// snapshot helpers as the PREFERRED lookup; if a row has no videoId,
// callers fall back to the ordinal helper below.
export function extractCaptionsByVideoId(preprod) {
  const out = {};
  for (const row of scriptTable(preprod)) {
    const vid = rowVideoId(row);
    if (!vid) continue;
    const cap = captionFromRow(row);
    if (cap) out[vid] = cap;
  }
  return out;
}

// Captions indexed by ordinal position. videoNumber (1-based) takes
// precedence over array index — if a producer reorders rows but
// videoNumber stays, the mapping still works. Returns an array where
// out[i] is the caption for delivery.videos[i] (i.e. videoNumber i+1).
export function extractCaptionsByOrdinal(preprod) {
  const rows = scriptTable(preprod);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cap = captionFromRow(row);
    if (!cap) continue;
    // Prefer videoNumber (1-based) when present, fall back to row index.
    const num = Number(row?.videoNumber);
    const idx = Number.isFinite(num) && num > 0 ? num - 1 : i;
    out[idx] = cap;
  }
  return out;
}

// Single-video lookup. Used in on-video-approved. videoId match
// wins; ordinal fallback covers everything else (today's scriptTable
// has no videoId).
export function captionForVideoId(preprod, videoId, videoIdx) {
  if (videoId) {
    const map = extractCaptionsByVideoId(preprod);
    if (map[String(videoId)]) return map[String(videoId)];
  }
  if (Number.isInteger(videoIdx) && videoIdx >= 0) {
    const arr = extractCaptionsByOrdinal(preprod);
    return arr[videoIdx] || "";
  }
  return "";
}
