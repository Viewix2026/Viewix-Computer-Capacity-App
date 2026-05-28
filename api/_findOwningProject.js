// Shared reverse-lookup: given a `/projects` object and a delivery id,
// find the single project that links to it.
//
// RTDB has no native query-by-child for our layout, so callers pass the
// whole `/projects` object (scanned in-process). Fine at Viewix's scale.
//
// **Fails closed on ambiguity (>1 match).** If two project records ever
// share the same `links.deliveryId`, attributing the delivery to either
// risks acting on the wrong account — silently writing to the wrong
// org's `/socialAssets`, sending an AM card for the wrong account, or
// stamping `viewixStatus` against an unrelated project. Returning
// `{ project: null, ambiguous: true }` lets callers refuse the action
// (200 no-op or 409) instead of guessing.
//
// Codex audit (2026-05-28) caught that `api/public/delivery-am.js` was
// the only endpoint that did this — `posting-preferences.js` and
// `on-video-approved.js` were still taking the first match. Hoisting
// the helper here so every reverse-lookup uses the same semantics.

export function findOwningProject(projects, deliveryId) {
  const matches = Object.values(projects || {}).filter(
    p => p && (p.links || {}).deliveryId === deliveryId
  );
  if (matches.length === 1) return { project: matches[0], ambiguous: false };
  return { project: null, ambiguous: matches.length > 1 };
}
