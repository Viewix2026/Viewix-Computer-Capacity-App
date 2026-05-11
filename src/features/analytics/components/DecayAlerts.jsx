// DecayAlerts — compact strip rendered above the fold when one or
// more formats have decayed meaningfully. Each alert names the
// format, the prior baseline, the current performance, and the
// drop percentage — auditable from the underlying data.
//
// Reads precomputed alerts from
// /analytics/insights/{clientId}/{weekId}/decayAlerts. Frontend
// just renders.

import { FORMAT_BUCKETS } from "../config/constants";

const LABEL_BY_KEY = Object.fromEntries(FORMAT_BUCKETS.map(f => [f.key, f.label]));

export function DecayAlerts({ alerts }) {
  const list = Array.isArray(alerts) ? alerts : [];
  if (list.length === 0) return null;

  return (
    <div style={{
      background: "rgba(239,68,68,0.08)",
      border: "1px solid rgba(239,68,68,0.35)",
      borderRadius: 10,
      padding: "10px 14px",
      marginBottom: 16,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 800, color: "#EF4444",
          textTransform: "uppercase", letterSpacing: 0.5,
          padding: "2px 8px", borderRadius: 999,
          background: "rgba(239,68,68,0.15)",
          border: "1px solid rgba(239,68,68,0.5)",
        }}>
          Content decay
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>
          Formats that used to work but are dropping.
        </span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {list.map((a, i) => (
          <div key={i} style={{
            fontSize: 12, color: "var(--fg)", lineHeight: 1.5,
          }}>
            <span style={{ fontWeight: 700, color: "#EF4444" }}>
              {LABEL_BY_KEY[a.format] || a.format}:
            </span>{" "}
            {a.message}
          </div>
        ))}
      </div>
    </div>
  );
}
