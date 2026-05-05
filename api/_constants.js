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

// ─── Client business goal ──────────────────────────────────────
// Set per /accounts/{id}.goal by the account manager. The value
// rolls through to the linked project rows + the editor's task
// rows so everyone touching the work sees, at a glance, what the
// client is actually trying to achieve. Drives visual differentiation
// only — no business logic forks on it.
export const CLIENT_GOAL_LEADS          = "leads";
export const CLIENT_GOAL_AWARENESS      = "awareness";
export const CLIENT_GOAL_ENGAGEMENT     = "engagement";
export const CLIENT_GOAL_BRAND_BUILDING = "brandBuilding";

export const CLIENT_GOAL_OPTIONS = [
  CLIENT_GOAL_LEADS,
  CLIENT_GOAL_AWARENESS,
  CLIENT_GOAL_ENGAGEMENT,
  CLIENT_GOAL_BRAND_BUILDING,
];

export const CLIENT_GOAL_LABELS = {
  [CLIENT_GOAL_LEADS]:          "Leads",
  [CLIENT_GOAL_AWARENESS]:      "Awareness",
  [CLIENT_GOAL_ENGAGEMENT]:     "Engagement",
  [CLIENT_GOAL_BRAND_BUILDING]: "Brand Building",
};

// Palette picked for max distance from each other AND from existing
// pill colours used elsewhere in the app (status / stage). Brand
// Building gets purple — green was a candidate but reads as "Done"
// in the status-pill space, which is the wrong association.
export const CLIENT_GOAL_COLORS = {
  [CLIENT_GOAL_LEADS]:          "#EF4444", // red
  [CLIENT_GOAL_AWARENESS]:      "#0082FA", // blue
  [CLIENT_GOAL_ENGAGEMENT]:     "#F97316", // orange
  [CLIENT_GOAL_BRAND_BUILDING]: "#8B5CF6", // purple
};
