// api/_frameioUrl.js
//
// Frame.io URL → fileId resolver. Codex audit caught that the inline
// regex used previously (`/(?:files|reviews)\/([a-z0-9-]{6,})/`)
// captured the FIRST segment after `/reviews/`, which is the
// REVIEW id, not the file id. Frame.io review URLs are shaped:
//
//   https://app.frame.io/reviews/<reviewId>/<fileId>
//   https://f.io/<shortcode>                       ← can't resolve client-side
//   https://app.frame.io/files/<fileId>
//   https://app.frame.io/projects/<projectId>/files/<fileId>
//
// We need to grab the actual <fileId>, not the review/project/short
// code. This helper is single-use across api/on-video-approved.js,
// api/cron/social-asset-reconcile.js, and
// api/client/posting-preferences.js so the fix lands in one place.

const SHAPES = [
  // /reviews/<reviewId>/<fileId>  — fileId is the SECOND id
  /\/reviews\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]{6,})/,
  // /projects/<projectId>/files/<fileId>
  /\/projects\/[A-Za-z0-9_-]+\/files\/([A-Za-z0-9_-]{6,})/,
  // /files/<fileId>
  /\/files\/([A-Za-z0-9_-]{6,})/,
  // /file/<fileId>  (older Frame.io URL shape, observed in legacy data)
  /\/file\/([A-Za-z0-9_-]{6,})/,
];

// Returns a Frame.io fileId or null if no recognised shape matched.
// f.io shortcodes intentionally return null — they can only be
// resolved via a Frame.io API redirect lookup, which we don't do
// here. Callers should fall back to writing the asset row with
// status:"failed" + a clear error so the producer knows to paste a
// full-form URL or set frameioFileId explicitly.
export function parseFrameioFileId(link) {
  const s = String(link || "");
  if (!s) return null;
  for (const re of SHAPES) {
    const m = re.exec(s);
    if (m && m[1]) return m[1];
  }
  return null;
}
