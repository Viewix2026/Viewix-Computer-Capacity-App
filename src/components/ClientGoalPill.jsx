// ClientGoalPill — small read-only pill that renders the client's
// business goal (Leads / Awareness / Engagement / Brand Building).
// Set per /accounts/{id}.goal by the account manager, then surfaced
// downstream on the project rows and the editor's task rows so
// everyone touching the work sees what the client is actually
// trying to achieve at a glance. Renders nothing when goal is unset
// or unknown — preserves layout without leaving a sentinel chip.
import { CLIENT_GOAL_LABELS, CLIENT_GOAL_COLORS } from "../config";

export function ClientGoalPill({ goal, size = "sm", style }) {
  if (!goal || !CLIENT_GOAL_LABELS[goal]) return null;
  const label = CLIENT_GOAL_LABELS[goal];
  const color = CLIENT_GOAL_COLORS[goal];
  const isMd = size === "md";
  return (
    <span
      title={`Client goal: ${label}`}
      style={{
        display: "inline-flex", alignItems: "center",
        padding: isMd ? "3px 9px" : "2px 7px",
        borderRadius: 999,
        background: `${color}22`,           // ~13% alpha tint
        color,
        border: `1px solid ${color}55`,     // ~33% alpha border
        fontSize: isMd ? 10 : 9,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        whiteSpace: "nowrap",
        ...style,
      }}>
      {label}
    </span>
  );
}
