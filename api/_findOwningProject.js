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

// Normalise a client/project name for cross-record matching: trim,
// lowercase, collapse internal whitespace. Project + delivery both copy
// these from the same Attio fields at deal-won, so an exact normalised
// match is a reliable bridge when the explicit link is missing.
export function normName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Resolve the project that owns a delivery, with a self-heal fallback.
// PURE — performs no writes; callers decide whether to repair the link.
//
//   matchedBy: "link" — a project's links.deliveryId already points here
//              "name" — no link, but EXACTLY ONE project shares the same
//                       normalised clientName + projectName (and isn't
//                       bound to a different delivery). Safe to adopt.
//              null   — no resolution (zero matches, or ambiguous)
//   ambiguous: true when >1 candidate at the link OR name stage — fail
//              closed so callers refuse rather than guess.
//
// Shared by send-review-batch (live self-heal) and the daily-09 reconciler
// so the matching rules can't drift between them.
export function findProjectForDelivery(projects, deliveryId, delivery) {
  const list = Object.entries(projects || {})
    .map(([id, p]) => (p && typeof p === "object" ? { ...p, id: p.id || id } : null))
    .filter(Boolean);

  // 1. Authoritative: a project already links to this delivery.
  const linked = list.filter(p => (p.links || {}).deliveryId === deliveryId);
  if (linked.length === 1) return { projectId: linked[0].id, matchedBy: "link", ambiguous: false };
  if (linked.length > 1) return { projectId: null, matchedBy: null, ambiguous: true };

  // 2. Self-heal fallback: strict unique normalised name match, skipping
  //    projects already bound to a DIFFERENT delivery.
  const cN = normName(delivery?.clientName);
  const pN = normName(delivery?.projectName);
  if (!cN || !pN) return { projectId: null, matchedBy: null, ambiguous: false };

  const matches = list.filter(p => {
    const linkedTo = (p.links || {}).deliveryId;
    if (linkedTo && linkedTo !== deliveryId) return false;
    return normName(p.clientName) === cN && normName(p.projectName) === pN;
  });
  if (matches.length === 1) return { projectId: matches[0].id, matchedBy: "name", ambiguous: false };
  return { projectId: null, matchedBy: null, ambiguous: matches.length > 1 };
}
