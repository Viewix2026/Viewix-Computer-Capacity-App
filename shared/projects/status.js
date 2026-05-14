// shared/projects/status.js
//
// Canonical project-status taxonomy + legacy mapping. Lives in shared/
// so the front-end (Projects.jsx, App.jsx, Capacity.jsx) AND server
// code (api/cron/capacity-stats.js, future cron/analytics endpoints)
// all agree on what "active" means. Previously this logic was
// duplicated in Projects.jsx and re-implemented inline in App.jsx —
// drift between the two surfaced as off-by-one counts on the Capacity
// dashboard.
//
// UI-only data (status pill colors / labels) stays in Projects.jsx
// because it's React-render-specific.

export const STATUS_KEYS = [
  "notStarted",
  "inProgress",
  "scheduled",
  "waitingClient",
  "stuck",
  "done",
  "archived",
];

// Pre-refactor records used "active" / "onHold" before the 7-status
// taxonomy landed. The mapping keeps old projects readable without
// requiring a backfill.
export const LEGACY_STATUS = {
  active: "inProgress",
  onHold: "waitingClient",
};

export function normaliseStatus(raw) {
  const key = LEGACY_STATUS[raw] || raw || "notStarted";
  return STATUS_KEYS.includes(key) ? key : "notStarted";
}

// "Active" = anything in the workable pipeline. Matches the filter the
// Projects tab uses for its main view (Projects.jsx:2648).
export function isActiveStatus(raw) {
  const k = normaliseStatus(raw);
  return k !== "done" && k !== "archived";
}
