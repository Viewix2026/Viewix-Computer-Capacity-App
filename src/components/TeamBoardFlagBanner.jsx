// TeamBoardFlagBanner — inline warning banner that appears above the
// Team Board grid after a drag commits a write that the scheduling
// brain flagged as problematic.
//
// Deterministic-only at this surface (no LLM call): we render the
// raw flag facts so the banner is fast and free. A delayed Slack
// post (see api/scheduling-flag-flusher.js) does the LLM-narrated
// follow-up 3 minutes later if the flag is still active by then —
// gives the producer time to self-fix without pinging the channel.
//
// Auto-dismiss after 30 seconds. Producer can dismiss earlier with
// the X. Accepts a list of flag objects from the backend as-is.

import { useEffect, useState } from "react";

const COLORS = {
  hard: { bg: "#FEE2E2", border: "#FCA5A5", text: "#991B1B" },
  warning: { bg: "#FEF3C7", border: "#FDE68A", text: "#92400E" },
  info: { bg: "#DBEAFE", border: "#BFDBFE", text: "#1E40AF" },
};

// Mirror FLAG_SEVERITY in shared/scheduling/flags.js. Keep here so
// the component renders without importing the shared module (which
// would force pure-JS-React-friendly bundling — easier to keep this
// component standalone).
const SEVERITY = {
  fixedTimeConflict: "hard",
  multipleUntimedShoots: "warning",
  offDayAssigned: "hard",
  inOfficeIdle: "info",
  dailyUnderCapacity: "info",
  dailyOverCapacity: "warning",
  dailyHardOverCapacity: "hard",
  editOverrun: "warning",
  weekDataMismatch: "warning",
  unassignedScheduled: "info",
};

const AUTO_DISMISS_MS = 30_000;

export default function TeamBoardFlagBanner({ flags, onDismiss }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [flags, onDismiss]);

  if (!visible || !flags || flags.length === 0) return null;

  // Top severity wins for the banner colour. Producer can read each
  // line for the specific issue.
  const topSeverity = flags
    .map(f => SEVERITY[f.kind] || "info")
    .reduce((acc, s) => (rank(s) > rank(acc) ? s : acc), "info");
  const palette = COLORS[topSeverity] || COLORS.info;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: "10px 14px",
        margin: "0 0 12px",
        color: palette.text,
        fontSize: 13,
        lineHeight: 1.5,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          ⚠️ Heads up — {flags.length} {flags.length === 1 ? "flag" : "flags"} on this drag
        </div>
        <ul style={{ margin: 0, padding: "0 0 0 18px" }}>
          {flags.map((f, i) => <li key={i}>{describeFlag(f)}</li>)}
        </ul>
        <div style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>
          A reminder will post to #scheduling in ~3 min if it's still active. Drag again to fix.
        </div>
      </div>
      <button
        onClick={() => { setVisible(false); onDismiss?.(); }}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: palette.text,
          fontSize: 18,
          fontWeight: 600,
          cursor: "pointer",
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        ×
      </button>
    </div>
  );
}

function rank(s) {
  return s === "hard" ? 2 : s === "warning" ? 1 : 0;
}

// Deterministic flag → human text. The Slack-side narration uses
// Opus for nicer prose; this banner stays plain so it's instant.
function describeFlag(f) {
  switch (f?.kind) {
    case "fixedTimeConflict":
      return `Time conflict on ${f.date} — overlapping timed work for the same person.`;
    case "multipleUntimedShoots":
      return `Multiple untimed shoots on ${f.date}. Add times or confirm this is deliberate.`;
    case "offDayAssigned":
      return `Editor not working on ${f.date} per the schedule grid, but has work assigned.`;
    case "dailyOverCapacity":
      return `Over-capacity on ${f.date} — ${f.plannedHours}h planned (target ${f.capacityHours || 8}h).`;
    case "dailyHardOverCapacity":
      return `Hard over-capacity on ${f.date} — ${f.plannedHours}h planned.`;
    case "weekDataMismatch":
      return f.subkind === "shootInWeekDataNoSubtask"
        ? `Schedule grid says "shoot" on ${f.date} but no shoot subtask is assigned.`
        : `Shoot subtask on ${f.date} but schedule grid doesn't show "shoot".`;
    case "unassignedScheduled":
      return `Subtask scheduled for ${f.startDate} with no assignee.`;
    default:
      return `Flag: ${f?.kind || "unknown"}.`;
  }
}
