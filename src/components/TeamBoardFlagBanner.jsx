// TeamBoardFlagBanner — inline warning banner that appears above the
// Team Board grid after a drag commits a write the scheduling brain
// flagged. Deterministic-only at this surface (no LLM call): we
// render the enriched flag facts so the banner is fast and free.
//
// Each line follows the pattern:
//   <Client> — <Subtask> · <what was wrong> · <suggested next step>
//
// A delayed Slack post (see api/scheduling-flag-flusher.js) does the
// LLM-narrated follow-up 3 minutes later if the flag is still active
// by then — gives the producer time to self-fix without pinging the
// channel.
//
// Backend pre-enriches every flag with `personName`, `projectName`,
// `clientName`, `subtaskName`. The banner trusts those fields and
// falls back gracefully when they're absent.

import { useEffect, useState } from "react";

const COLORS = {
  hard: { bg: "#FEE2E2", border: "#FCA5A5", text: "#991B1B" },
  warning: { bg: "#FEF3C7", border: "#FDE68A", text: "#92400E" },
  info: { bg: "#DBEAFE", border: "#BFDBFE", text: "#1E40AF" },
};

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

const TEAM_BOARD_URL = "/#projects/teamBoard";

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
        padding: "12px 14px",
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
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          ⚠️ Heads up — {flags.length} {flags.length === 1 ? "flag" : "flags"} on this drag
        </div>
        <ul style={{ margin: 0, padding: "0 0 0 18px" }}>
          {flags.map((f, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              {renderFlagLine(f)}
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
          A reminder will post to <code>#scheduling</code> in ~3 min if it's still active. Drag again to fix.
        </div>
        <div style={{ marginTop: 8 }}>
          <a
            href={TEAM_BOARD_URL}
            style={{
              display: "inline-block",
              padding: "5px 10px",
              background: palette.text,
              color: palette.bg,
              borderRadius: 4,
              textDecoration: "none",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            View Team Board
          </a>
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

// Render a single flag line. Each branch lays out the subject (client
// + subtask + person), the "what's wrong" detail, and a brief
// "suggested next step" so the producer doesn't just see a bare fact.
function renderFlagLine(f) {
  const date = friendlyDate(f.date || f.startDate);
  const person = f.personName || "(someone)";
  const clientName = f.clientName ? `${f.clientName}` : "";
  const projectName = f.projectName || "";
  const subtaskName = f.subtaskName || "";
  const subject = formatSubject({ clientName, projectName, subtaskName });

  switch (f?.kind) {
    case "fixedTimeConflict": {
      const items = (f.subtasks || []).map(s => `${s.clientName ? `${s.clientName} ` : ""}${s.subtaskName || s.name || ""}`).filter(Boolean);
      return (
        <span>
          <strong>Time clash on {date}</strong> — {person} on {items.join(" + ") || "two timed jobs"}.
          <em style={{ opacity: 0.8 }}> Move one of them, or set times that don't overlap.</em>
        </span>
      );
    }
    case "multipleUntimedShoots":
      return (
        <span>
          <strong>{person} on multiple untimed shoots {date}</strong> — add start/end times to each, or confirm the day is shared.
        </span>
      );
    case "offDayAssigned":
      return (
        <span>
          <strong>{subject || person} assigned to {person} on {date}</strong> — but {person} isn't rostered that day.
          <em style={{ opacity: 0.8 }}> Reassign, or update the weekly schedule.</em>
        </span>
      );
    case "dailyHardOverCapacity":
      return (
        <span>
          <strong>{person} hard over-capacity on {date}</strong> — {fmtHours(f.plannedHours)}h planned (cap is 10h).
          <em style={{ opacity: 0.8 }}> Move some work to a quieter day, or split across editors.</em>
        </span>
      );
    case "dailyOverCapacity":
      return (
        <span>
          <strong>{person} over-capacity on {date}</strong> — {fmtHours(f.plannedHours)}h planned (target is 8h).
          <em style={{ opacity: 0.8 }}> Consider shifting one task off this day.</em>
        </span>
      );
    case "dailyUnderCapacity":
      return (
        <span>
          {person} under-loaded on {date} — only {fmtHours(f.plannedHours)}h planned.
        </span>
      );
    case "weekDataMismatch":
      return f.subkind === "shootInWeekDataNoSubtask"
        ? <span>Schedule grid says <strong>{person}</strong> is on a shoot {date} but no shoot subtask is assigned. <em style={{ opacity: 0.8 }}>Assign one or update the grid.</em></span>
        : <span>Shoot subtask <strong>{subject || ""}</strong> on {date} but the schedule grid doesn't show "shoot" for {person}. <em style={{ opacity: 0.8 }}>Update the weekly grid.</em></span>;
    case "unassignedScheduled":
      // shouldn't appear in drag scope after the v1 fix, but render
      // gracefully in case a downstream caller still passes one.
      return <span><strong>{subject || `Subtask scheduled for ${date}`}</strong> with no assignee.</span>;
    default:
      return <span>Flag: {f?.kind || "unknown"}.</span>;
  }
}

// "Emesent — Shoot" / "Emesent · Brand Refresh — Edit" / fallback.
function formatSubject({ clientName, projectName, subtaskName }) {
  const parts = [];
  if (clientName && projectName && clientName !== projectName) parts.push(`${clientName} · ${projectName}`);
  else if (clientName) parts.push(clientName);
  else if (projectName) parts.push(projectName);
  if (subtaskName) parts.push(subtaskName);
  return parts.join(" — ");
}

// "2026-05-13" → "Wed 13 May" (compact, no year — the year clutters)
function friendlyDate(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d)) return iso;
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" }).format(d);
}

function fmtHours(n) {
  if (n == null) return "0";
  // Strip trailing zeros — "8.0h" reads worse than "8h", but "8.5h" stays.
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r);
}
