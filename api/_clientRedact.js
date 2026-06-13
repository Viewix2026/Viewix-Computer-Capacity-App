// api/_clientRedact.js
//
// The single redaction choke point for the client portal. RTDB rules
// cannot project fields, so the client API NEVER returns a filtered raw
// record — it returns a freshly built display object with ONLY the
// allowlisted fields. A new sensitive field added to /projects,
// /deliveries, /accounts or /preproduction is hidden by default because
// it is simply never copied here.
//
// HARD RULE: never read dealValue, producerNotes, attioCompanyId,
// attioDealId, commissioned, links.accountId, project lead / internal
// owners / assignees, or anything else, into these outputs. Only the
// fields explicitly assembled below leave the server.
//
// Pinned by api/_clientRedact.test.mjs.

import { extractCaptionsByVideoId, extractCaptionsByOrdinal } from "./_preprodCaptions.js";
import { normalizeAvatarUrl } from "./_avatarUrl.js";

// Client-facing video status vocab is the same as the staff side.
//
// `preprodCaptionsById` + `preprodCaptionsByIdx` are pre-built by
// redactProjectDetail from the linked /preproduction/socialOrganic
// doc. Read-through fallback so the client SEES the caption while
// deciding whether to approve. Codex P1 (pass 2) caught the original
// gap; pass 3 corrected the schema walk (scriptTable, not the
// nonexistent videos/posts/deliverables lists).
//
// Snapshot precedence: delivery's own caption (frozen at approval) →
// pre-prod read-through by videoId (if scriptTable row carries one)
// → pre-prod read-through by ordinal position (today's reality —
// scriptTable rows are linked 1:1 to delivery.videos[] by index).
// After approval the delivery wins forever — even if pre-prod gets
// edited later, the client portal keeps showing the exact text the
// client signed off.
function videoRow(v, idx, preprodCaptionsById, preprodCaptionsByIdx) {
  const videoId = v?.id || v?.videoId || null;
  const snapshotted = v?.caption ? String(v.caption) : "";
  let fallback = "";
  if (!snapshotted) {
    if (videoId && preprodCaptionsById && preprodCaptionsById[videoId]) {
      fallback = preprodCaptionsById[videoId];
    } else if (preprodCaptionsByIdx && preprodCaptionsByIdx[idx]) {
      fallback = preprodCaptionsByIdx[idx];
    }
  }
  return {
    n: idx + 1,
    idx,                                   // RTDB array index — write path target
    id: videoId,                           // video id — write path target
    title: String(v?.name || ""),
    link: v?.link ? String(v.link) : "",
    viewixStatus: String(v?.viewixStatus || ""),
    revision1: String(v?.revision1 || ""),
    revision2: String(v?.revision2 || ""),
    posted: !!v?.posted,
    caption: snapshotted || fallback,
  };
}

export function deliveryCounts(videos) {
  const arr = Array.isArray(videos) ? videos : [];
  const total = arr.length;
  const ready = arr.filter(v => v && (v.viewixStatus === "Ready for Review" || v.viewixStatus === "Completed")).length;
  // approved/changes are LATEST-wins (R2 over R1), matching `waiting`
  // below and the reconciler's deriveViewixStatus. A toggled-back video
  // (R1 Approved, R2 Need Revisions) is NOT currently approved — it's
  // back with Viewix. OR-across-revisions wrongly counted it as both,
  // which made allApproved (Schedule gate) fire mid-revision.
  const latestRev = v => (v && (v.revision2 || v.revision1)) || "";
  const approved = arr.filter(v => latestRev(v) === "Approved").length;
  const posted = arr.filter(v => v && v.posted).length;
  const changes = arr.filter(v => latestRev(v) === "Need Revisions").length;
  // Cuts genuinely awaiting the CLIENT: delivered, and the latest
  // revision response (R2 wins over R1, mirroring the reconciler's
  // deriveViewixStatus) is neither Approved nor Need Revisions.
  // NOT ready - approved: those two counts live on orthogonal axes
  // (viewixStatus vs revision fields), so a toggled-back video
  // (R1 Approved, R2 Need Revisions, ball back with Viewix) would
  // silently cancel a genuinely-waiting cut from a subtraction.
  const waiting = arr.filter(v => {
    if (!v || !(v.viewixStatus === "Ready for Review" || v.viewixStatus === "Completed")) return false;
    const latest = v.revision2 || v.revision1;
    return latest !== "Approved" && latest !== "Need Revisions";
  }).length;
  return { total, ready, approved, posted, changes, waiting };
}

// Heuristic phase for the Kickoff -> Shooting -> Editing -> Review track
// (mirrors the client-journey email touchpoints). There is no explicit
// per-project phase field in the data model, so this is derived and
// intentionally coarse. Returns 0..3.
export function derivePhase(project, delivery, preprod) {
  if (project?.status === "archived") return 3;
  const videos = Array.isArray(delivery?.videos) ? delivery.videos : [];
  const anyDeliverable = videos.some(v => v && (
    v.viewixStatus === "Ready for Review" || v.viewixStatus === "Completed" || v.posted ||
    v.revision1 || v.revision2));
  if (anyDeliverable) return 3;                       // Review
  if (videos.length > 0) return 2;                    // Editing
  const ps = String(preprod?.status || "").toLowerCase();
  if (ps === "review" || ps === "approved" || ps === "exported") return 1; // Shooting
  return 0;                                            // Kickoff
}

function clean(v) {
  const s = String(v || "").trim();
  return s || null;
}

function resolveAccountManagerEditor(account, editors) {
  const target = clean(account?.accountManager)?.toLowerCase();
  if (!target || !editors) return null;
  // Deterministic order: object maps iterate in insertion order, arrays in
  // index order — stable across calls either way.
  const list = Array.isArray(editors) ? editors : Object.values(editors);
  // Match account.accountManager to /editors by case-insensitive trimmed name.
  const matches = list.filter(ed => clean(ed?.name)?.toLowerCase() === target);
  if (matches.length > 1) {
    // First match wins (deterministic), but a duplicate normalized name means
    // the client could be shown the wrong AM contact — surface it server-side.
    console.warn(`[accountManagerBlock] ${matches.length} editors normalize to "${target}"; using the first. Fix duplicate roster names.`);
  }
  return matches[0] || null;
}

// Curated PUBLIC account-manager block. Intentionally client-visible
// (user-decided brief amendment). Prefer the matching /editors roster
// record for rich public details, then fall back to the account-level
// override fields. Never copies projectLead or any other internal owner
// field.
export function accountManagerBlock(account, editors = null) {
  const editor = resolveAccountManagerEditor(account, editors);
  const name = clean(editor?.name) || clean(account?.accountManager);
  // Pass the photo URL through the shared Drive-share-link normaliser so
  // a Google Drive `/file/d/{ID}/view` URL pasted into Team Roster
  // becomes a renderable `drive.google.com/thumbnail?id=…` URL the
  // browser <img> can actually display. Non-Drive URLs pass through.
  const rawPhoto = clean(editor?.avatarUrl) || clean(account?.accountManagerPhoto);
  return {
    name,
    photo: normalizeAvatarUrl(rawPhoto),
    phone: clean(editor?.phone) || clean(account?.accountManagerPhone),
    email: clean(editor?.email) || clean(account?.accountManagerEmail),
    bookingUrl: clean(editor?.bookingUrl) || clean(account?.accountManagerBookingUrl),
  };
}

function orgName(project, account) {
  return String(account?.companyName || project?.clientName || "").trim() || "Your organisation";
}

// The client's own brand mark from the account record. `logoUrl` may be
// a Google Drive share link (serves HTML, not bytes), so it runs through
// the same normaliser the AM photo uses. `bg` carries the producer's
// logoBg preference so a white-on-transparent mark sits on the right
// surface. null when no logo is set — the UI falls back to initials.
// Mirrors buildClientLogo() used by the public /d/ delivery page.
function clientLogo(account) {
  const url = normalizeAvatarUrl(clean(account?.logoUrl));
  return url ? { url, bg: clean(account?.logoBg) || "white" } : null;
}

// Dashboard list item. NOT a filtered project — a built projection.
export function redactProjectListItem({ project, account, delivery, preprod, editors }) {
  const counts = deliveryCounts(delivery?.videos);
  return {
    projectId: project?.shortId || null,          // shortId, not raw internal id
    orgName: orgName(project, account),
    logo: clientLogo(account),                     // {url,bg} or null → UI falls back to initials
    projectName: String(project?.projectName || "Untitled project"),
    status: project?.status === "archived" ? "archived" : "active",
    phase: derivePhase(project, delivery, preprod),
    productLine: project?.productLine || null,
    counts,
    needsYou: counts.waiting > 0,
    hasPreprod: !!preprod,                         // a resolved preprod node → pre-prod link is live
    accountManager: accountManagerBlock(account, editors),
  };
}

// ─── redactConnectionStatus ────────────────────────────────────────
// Per-platform social-account connection state served to the client
// portal Connected Accounts view (/clients/accounts). NEVER leaks any
// Zernio internals — profileId, accessUrl, refresh tokens, etc. The
// client knows: which platform, whether it's connected, when it was
// last connected, whether action is needed. Nothing more.
//
// `refreshBy` is a proactive token-expiry hint. Zernio's published
// event vocabulary doesn't include a dedicated refresh event, so this
// stays null today; the field is kept so the portal can surface a
// "reconnect soon" nudge if/when Zernio exposes expiry timing.
export function redactConnectionStatus({ platform, status, lastConnected, refreshBy }) {
  return {
    platform: String(platform || ""),
    status: String(status || "unknown"),     // "connected" | "disconnected" | "expiring"
    lastConnected: lastConnected || null,
    refreshBy: refreshBy || null,
  };
}

// ─── redactScheduleItem ────────────────────────────────────────────
// One row of the client portal Posting Schedule tab. Strips
// everything that isn't safe to surface: zernioPostId, zernioMediaUrl,
// frameioFileId, clientReferenceId, batchId, profileId. The client
// sees the post they're getting, when it goes out, where, and its
// current status — read-only for v1. Reschedule / change-caption from
// the portal is deferred (Phase 7+).
export function redactScheduleItem(item, video) {
  return {
    videoName: String(video?.name || video?.title || ""),
    postAt: item?.postAt || null,
    caption: item?.caption ? String(item.caption) : "",
    platforms: Array.isArray(item?.platforms) ? item.platforms.map(String) : [],
    trialReel: !!item?.trialReel,
    status: String(item?.status || "pending"),  // "pending" | "posted" | "failed" | "cancelled"
    permalink: item?.permalink ? String(item.permalink) : null,
  };
}

// Per-project detail. Deliveries rows + a pre-production handle. The
// pre-production review itself is rendered by the existing, already
// client-safe ClientReview cockpit (the same one /p/{shortId} serves
// in production today) — so detail returns a handle (type + shortId +
// url), never the raw /preproduction node.
export function redactProjectDetail({ project, account, delivery, preprod, deliveryUrl, preprodUrl, editors }) {
  const videos = Array.isArray(delivery?.videos) ? delivery.videos : [];
  const counts = deliveryCounts(videos);
  const preprodType = project?.links?.preprodType || null; // "metaAds" | "socialOrganic"
  // Build the pre-prod caption fallback ONCE per detail-render so we
  // don't re-walk the preprod doc per video. Only socialOrganic has
  // captions today — metaAds preprod is ad-scripts, not posting copy.
  // Two maps because today's scriptTable rows don't carry videoIds —
  // the ordinal lookup is the working path; the by-id lookup is
  // future-proofing for when rows do carry explicit videoIds.
  const preprodCaptionsById  = (preprodType === "socialOrganic" && preprod) ? extractCaptionsByVideoId(preprod) : {};
  const preprodCaptionsByIdx = (preprodType === "socialOrganic" && preprod) ? extractCaptionsByOrdinal(preprod) : [];
  return {
    projectId: project?.shortId || null,
    orgName: orgName(project, account),
    logo: clientLogo(account),
    projectName: String(project?.projectName || "Untitled project"),
    status: project?.status === "archived" ? "archived" : "active",
    phase: derivePhase(project, delivery, preprod),
    productLine: project?.productLine || null,
    accountManager: accountManagerBlock(account, editors),
    deliveries: delivery ? {
      available: true,
      deliveryId: delivery.id || null,            // leaf write path target
      shortId: delivery.shortId || null,
      url: deliveryUrl || null,
      counts,
      rows: videos.map((v, i) => videoRow(v, i, preprodCaptionsById, preprodCaptionsByIdx)),
    } : { available: false },
    preproduction: preprod && preprodType ? {
      available: true,
      type: preprodType,                          // socialOrganic embeds; metaAds deep-links
      embeddable: preprodType === "socialOrganic",
      shortId: preprod.shortId || null,
      url: preprodUrl || null,
    } : { available: false },
  };
}
