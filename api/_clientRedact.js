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

import { extractCaptionsByVideoId } from "./_preprodCaptions.js";

// Client-facing video status vocab is the same as the staff side.
//
// `preprodCaptions` is a { videoId → caption } map pre-built by
// redactProjectDetail from the linked /preproduction/socialOrganic
// doc. We use it as a read-through fallback so the client can SEE
// the caption alongside the video DURING approval (Codex P1 fix:
// the caption snapshot itself only fires inside on-video-approved,
// so without this fallback the client would approve a video without
// ever seeing the copy they're supposedly approving).
//
// Snapshot precedence: delivery's own caption (frozen at approval)
// → pre-prod read-through (pre-approval state). After approval the
// delivery wins forever — even if pre-prod gets edited later, the
// client portal keeps showing the exact text the client signed off.
function videoRow(v, idx, preprodCaptions) {
  const videoId = v?.id || v?.videoId || null;
  const snapshotted = v?.caption ? String(v.caption) : "";
  const fallback = (videoId && preprodCaptions) ? (preprodCaptions[videoId] || "") : "";
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
  const approved = arr.filter(v => v && (v.revision1 === "Approved" || v.revision2 === "Approved")).length;
  const posted = arr.filter(v => v && v.posted).length;
  const changes = arr.filter(v => v && (v.revision1 === "Need Revisions" || v.revision2 === "Need Revisions")).length;
  return { total, ready, approved, posted, changes };
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
  const list = Array.isArray(editors) ? editors : Object.values(editors);
  // Match account.accountManager to /editors by case-insensitive trimmed name.
  // First match wins; current AM names are unique in the Viewix roster.
  return list.find(ed => clean(ed?.name)?.toLowerCase() === target) || null;
}

// Curated PUBLIC account-manager block. Intentionally client-visible
// (user-decided brief amendment). Prefer the matching /editors roster
// record for rich public details, then fall back to the account-level
// override fields. Never copies projectLead or any other internal owner
// field.
export function accountManagerBlock(account, editors = null) {
  const editor = resolveAccountManagerEditor(account, editors);
  const name = clean(editor?.name) || clean(account?.accountManager);
  return {
    name,
    photo: clean(editor?.avatarUrl) || clean(account?.accountManagerPhoto),
    phone: clean(editor?.phone) || clean(account?.accountManagerPhone),
    email: clean(editor?.email) || clean(account?.accountManagerEmail),
    bookingUrl: clean(editor?.bookingUrl) || clean(account?.accountManagerBookingUrl),
  };
}

function orgName(project, account) {
  return String(account?.companyName || project?.clientName || "").trim() || "Your organisation";
}

// Dashboard list item. NOT a filtered project — a built projection.
export function redactProjectListItem({ project, account, delivery, preprod, editors }) {
  const counts = deliveryCounts(delivery?.videos);
  return {
    projectId: project?.shortId || null,          // shortId, not raw internal id
    orgName: orgName(project, account),
    projectName: String(project?.projectName || "Untitled project"),
    status: project?.status === "archived" ? "archived" : "active",
    phase: derivePhase(project, delivery, preprod),
    productLine: project?.productLine || null,
    counts,
    needsYou: counts.ready > 0 && counts.approved < counts.total,
    accountManager: accountManagerBlock(account, editors),
  };
}

// ─── redactConnectionStatus ────────────────────────────────────────
// Per-platform social-account connection state served to the client
// portal Connected Accounts view (/clients/accounts). NEVER leaks any
// Zernio internals — profileKey, accessUrl, refresh tokens, etc. The
// client knows: which platform, whether it's connected, when it was
// last connected, whether action is needed. Nothing more.
//
// `refreshBy` is Zernio's proactive token-expiry warning (best-in-
// class — neither upload-post nor self-host backends have this). When
// present, the portal can nudge the client BEFORE the token actually
// dies, instead of finding out via a failed post.
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
// frameioFileId, clientReferenceId, batchId, profileKey. The client
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
  // Build the pre-prod caption fallback map ONCE per detail-render so
  // we don't re-walk the preprod doc per video. Only socialOrganic has
  // captions today — metaAds preprod is ad-scripts, not posting copy.
  const preprodCaptions = (preprodType === "socialOrganic" && preprod)
    ? extractCaptionsByVideoId(preprod)
    : {};
  return {
    projectId: project?.shortId || null,
    orgName: orgName(project, account),
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
      rows: videos.map((v, i) => videoRow(v, i, preprodCaptions)),
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
