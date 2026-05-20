// api/_preprodCaptions.js
//
// Shared lookup: given a /preproduction/socialOrganic/{id} doc,
// return a Record<videoId, caption> map. Used in two places:
//
//   1. api/_clientRedact.js — so the client portal Deliveries view
//      can READ-THROUGH from pre-prod when the delivery video's
//      caption snapshot hasn't fired yet (i.e. before approval).
//      This is the bug Codex P1 caught: caption snapshot happens
//      INSIDE on-video-approved, so without a read-through the
//      client never sees the caption they're supposedly approving.
//
//   2. api/on-video-approved.js — at approval time, snapshot the
//      caption from pre-prod onto the delivery so the delivery
//      becomes the immutable record of what was approved.
//
// Both surfaces sharing this helper means the pre-approval display
// matches the snapshot exactly. No drift between "what I saw" and
// "what got recorded."
//
// The lookup is heuristic: the social-organic pre-prod schema has
// no single canonical "captions array" — captions can live under
// preproductionDoc.posts, .videos, .scripts, or .deliverables
// (the plan flagged this as Open Item #6 needing verification
// against real data). We walk all of them and merge, last-write-
// wins by videoId. If none match, we return an empty map and the
// client portal renders nothing for that row (which is fine —
// producer can fill in on the delivery side).

const CANDIDATE_LISTS = ["videos", "scripts", "posts", "deliverables"];
const CAPTION_FIELDS = ["caption", "socialCaption", "copy", "text", "script"];
const VIDEO_ID_FIELDS = ["videoId", "id", "deliveryVideoId"];

// Returns { videoId: caption } as a plain object. Empty if preprod
// is null / wrong shape / has no captions for any video.
export function extractCaptionsByVideoId(preprod) {
  const out = {};
  if (!preprod || typeof preprod !== "object") return out;
  const doc = preprod.preproductionDoc || preprod;
  if (!doc || typeof doc !== "object") return out;

  for (const listKey of CANDIDATE_LISTS) {
    const list = doc[listKey];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      // Resolve which field on this entry carries the videoId.
      let vid = null;
      for (const f of VIDEO_ID_FIELDS) {
        if (entry[f]) { vid = String(entry[f]); break; }
      }
      if (!vid) continue;
      // Find a caption-shaped field.
      let cap = "";
      for (const f of CAPTION_FIELDS) {
        if (entry[f]) { cap = String(entry[f]); break; }
      }
      if (cap) out[vid] = cap;
    }
  }
  return out;
}

// Convenience for a single-video lookup. Used in on-video-approved.
export function captionForVideoId(preprod, videoId) {
  if (!videoId) return "";
  const map = extractCaptionsByVideoId(preprod);
  return map[String(videoId)] || "";
}
