// Shared avatar-URL normaliser.
//
// Producers paste any URL into Team Roster's avatar field. The common
// breakage (reported 2026-05-19: ShootTomorrow emails AND now the AM
// card on /d/ + /clients/) is a Google Drive *share* link like:
//
//   https://drive.google.com/file/d/{ID}/view?usp=drive_link
//
// That URL serves an HTML viewer page, not image bytes — <img src=…>
// shows a broken-image icon. Rewrite known Drive forms to the
// thumbnail endpoint, which returns real image bytes:
//
//   https://drive.google.com/thumbnail?id={ID}&sz=w200
//
// (Use thumbnail, not uc?export=view: lighter, less rate-limited by
// Google, and email-client friendly. Requires the file to be shared
// "anyone with the link" — true for current crew photos.)
//
// Non-Drive URLs (Slack CDN ca.slack-edge.com, our /public assets, any
// other host) pass through unchanged. Empty -> null.
//
// Used by:
//   - api/_email/getProjectContext.js  (email previews, original site)
//   - api/_clientRedact.js              (AM block returned to portal +
//                                       public /d/ delivery page)

export function normalizeAvatarUrl(url) {
  const u = (url || "").trim();
  if (!u) return null;
  if (!/drive\.google\.com/i.test(u)) return u; // not Drive — leave as-is
  let id = null;
  const fileMatch = u.match(/\/file\/d\/([\w-]+)/);
  if (fileMatch) {
    id = fileMatch[1];
  } else {
    const idParam = u.match(/[?&]id=([\w-]+)/);
    if (idParam) id = idParam[1];
  }
  if (!id) return u; // unrecognised Drive form — best-effort, leave as-is
  return `https://drive.google.com/thumbnail?id=${id}&sz=w200`;
}
