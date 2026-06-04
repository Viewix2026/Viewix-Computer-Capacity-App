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

// Collect the canonical videoIds carried by a project's subtasks
// (subtasks may be array- or object-shaped in RTDB).
function subtaskVideoIds(project) {
  const raw = project?.subtasks;
  const subs = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return subs.filter(Boolean).map(s => s.videoId).filter(Boolean);
}

// Resolve the project that owns a delivery, with self-heal fallbacks.
// PURE — performs no writes; callers decide whether to repair the link.
// Always returns the RTDB KEY as projectId (authoritative for write
// paths) even if a record's embedded `.id` field has drifted.
//
//   matchedBy: "link"    — a project's links.deliveryId already points here
//              "videoId" — no link, but EXACTLY ONE project's subtasks share
//                          a canonical videoId with this delivery's videos.
//                          The reliable bridge for Meta Ads orphans, whose
//                          delivery name ("<client> Meta Ads") never equals
//                          the project's deal name.
//              "name"    — no link/videoId, but EXACTLY ONE project shares the
//                          normalised clientName + projectName.
//              null      — no resolution (zero matches, or ambiguous)
//   ambiguous: true when >1 candidate at any stage — fail closed so callers
//              refuse rather than guess.
//
// Shared by send-review-batch (live self-heal) and the daily-09 reconciler
// so the matching rules can't drift between them.
export function findProjectForDelivery(projects, deliveryId, delivery) {
  const list = Object.entries(projects || {})
    .map(([key, p]) => (p && typeof p === "object" ? { key, p } : null))
    .filter(Boolean);

  // 1. Authoritative: a project already links to this delivery.
  const linked = list.filter(({ p }) => (p.links || {}).deliveryId === deliveryId);
  if (linked.length === 1) return { projectId: linked[0].key, matchedBy: "link", ambiguous: false };
  if (linked.length > 1) return { projectId: null, matchedBy: null, ambiguous: true };

  // Candidates for a heuristic adopt: never steal a delivery a project is
  // already (intentionally) bound to.
  const notBoundElsewhere = ({ p }) => {
    const linkedTo = (p.links || {}).deliveryId;
    return !linkedTo || linkedTo === deliveryId;
  };

  // 2. Canonical videoId bridge — exact, survives name drift.
  const deliveryVideoIds = new Set(
    (Array.isArray(delivery?.videos) ? delivery.videos : [])
      .map(v => v && v.videoId).filter(Boolean)
  );
  if (deliveryVideoIds.size) {
    const vid = list.filter(notBoundElsewhere).filter(({ p }) =>
      subtaskVideoIds(p).some(id => deliveryVideoIds.has(id))
    );
    if (vid.length === 1) return { projectId: vid[0].key, matchedBy: "videoId", ambiguous: false };
    if (vid.length > 1) return { projectId: null, matchedBy: null, ambiguous: true };
  }

  // 3. Strict unique normalised name match.
  const cN = normName(delivery?.clientName);
  const pN = normName(delivery?.projectName);
  if (!cN || !pN) return { projectId: null, matchedBy: null, ambiguous: false };

  const matches = list.filter(notBoundElsewhere).filter(({ p }) =>
    normName(p.clientName) === cN && normName(p.projectName) === pN
  );
  if (matches.length === 1) return { projectId: matches[0].key, matchedBy: "name", ambiguous: false };
  return { projectId: null, matchedBy: null, ambiguous: matches.length > 1 };
}
