// api/_constants.js
// Canonical literal values shared between the frontend bundle and
// Vercel serverless functions. Anything that appears as both a
// frontend dropdown option AND a server-side comparison target
// belongs here — the two layers used to drift (notify-revision.js
// once checked "Needs Revisions" while the dropdown wrote
// "Need Revisions", silently dropping every flagged round). One
// module, one source of truth.
//
// Frontend imports via src/config.js re-exports so existing
// component import paths don't change. Vite happily bundles this
// file from outside src/ — the Sale.jsx → api/_tiers.js import is
// the existing precedent.

// ─── Client-facing revision-round options ──────────────────────
// Empty-string entry is intentional: it represents the unset state
// before the client picks anything, distinct from "Approved" /
// "Need Revisions". Order is the dropdown order.
export const REVISION_APPROVED       = "Approved";
export const REVISION_NEED_REVISIONS = "Need Revisions";
export const CLIENT_REVISION_OPTIONS = ["", REVISION_APPROVED, REVISION_NEED_REVISIONS];

export const CLIENT_REVISION_COLORS = {
  [REVISION_APPROVED]:       "#10B981",
  [REVISION_NEED_REVISIONS]: "#EF4444",
};

// ─── Viewix-side video lifecycle status ────────────────────────
// Producer-managed (with one exception: the editor's Finish flow
// auto-flips a video to Ready for Review on a "client review"
// submit, see EditorDashboardViewix.jsx).
export const VIEWIX_STATUS_IN_DEVELOPMENT  = "In Development";
export const VIEWIX_STATUS_READY_FOR_REVIEW = "Ready for Review";
export const VIEWIX_STATUS_NEED_REVISIONS   = "Need Revisions";
export const VIEWIX_STATUS_COMPLETED        = "Completed";

export const VIEWIX_STATUSES = [
  VIEWIX_STATUS_IN_DEVELOPMENT,
  VIEWIX_STATUS_READY_FOR_REVIEW,
  VIEWIX_STATUS_NEED_REVISIONS,
  VIEWIX_STATUS_COMPLETED,
];

export const VIEWIX_STATUS_COLORS = {
  [VIEWIX_STATUS_IN_DEVELOPMENT]:   "#F59E0B",
  [VIEWIX_STATUS_READY_FOR_REVIEW]: "#0082FA",
  [VIEWIX_STATUS_NEED_REVISIONS]:   "#EF4444",
  [VIEWIX_STATUS_COMPLETED]:        "#10B981",
};
