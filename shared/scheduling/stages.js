// shared/scheduling/stages.js
//
// Subtask stage definitions. Single source of truth — extracted from
// src/components/Projects.jsx where these used to live as private
// module constants. The dashboard's render path imports the same
// values from here so colour cues stay aligned with the brain.
//
// Pure JS, no React/admin imports.

// Ordered list of stages. Order matters in some UI contexts (dropdowns)
// so kept identical to the original Projects.jsx definition.
export const STAGE_OPTIONS = [
  { key: "preProduction", label: "Pre Production", color: "#8B5CF6" },
  // Shoot is red — visually loud (filming days are the most logistics-
  // sensitive moment of a project) and distinct from the pink Stuck
  // status, the brighter delete-button red, and the orange Revisions
  // stage.
  { key: "shoot",         label: "Shoot",          color: "#DC2626" },
  { key: "revisions",     label: "Revisions",      color: "#F97316" },
  // Edit uses the Viewix accent blue (matches --accent in config.js).
  { key: "edit",          label: "Edit",           color: "#0082FA" },
  { key: "hold",          label: "Hold",           color: "#EAB308" },
];

// Lookup table by stage key. Mirrors the previous private map in
// Projects.jsx so consumer code reads identically.
export const STAGE_MAP = Object.fromEntries(STAGE_OPTIONS.map(s => [s.key, s]));

// Just the keys, ordered. Convenient for places that need an enum-like
// list (e.g., Slack tool schemas).
export const STAGE_KEYS = STAGE_OPTIONS.map(s => s.key);

// Default labels per stage — used when creating a new subtask without
// a manually-set name.
export const STAGE_DEFAULT_NAMES = {
  preProduction: "Pre Production",
  shoot: "Shoot",
  revisions: "Revisions",
  edit: "Edit",
  hold: "Hold",
};

// Infer a sensible stage from the subtask's name when no `stage` field
// has been written yet. Saves the producer from having to retro-tag
// every existing subtask manually after the stage system shipped — the
// four default phases (and any video subtasks named after a phase)
// light up correctly on first render.
//
// Order of checks matters: "revision" before "shoot" so "reshoot"
// doesn't false-match shoot first; "timeline" before generic "edit"
// because "Selects timeline + kick off video" is the producer's
// hand-off into edit phase.
export function inferStage(subtask) {
  if (subtask?.stage && STAGE_MAP[subtask.stage]) return subtask.stage;
  const name = (subtask?.name || "").toLowerCase();
  if (name.includes("pre production") || name.includes("preproduction") || name.includes("pre-production")) return "preProduction";
  if (name.includes("revision")) return "revisions";
  if (name.includes("shoot")) return "shoot";
  if (name.includes("timeline")) return "edit";
  if (name.includes("edit")) return "edit";
  return "preProduction";
}

// Helpers used by the brain's capacity calc.
export const FIXED_TIME_STAGES = new Set(["shoot"]);   // shoots always fixed-time-ish
export const FLEXIBLE_STAGES = new Set(["edit", "revisions", "preProduction"]);  // these stack into daily load
// preProduction can be either: timed when startTime/endTime are set
// (a planning call), flexible otherwise (admin work). Capacity calc
// branches on whether the subtask has times.
