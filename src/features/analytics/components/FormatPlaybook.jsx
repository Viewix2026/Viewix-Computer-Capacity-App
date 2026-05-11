// FormatPlaybook — shows which formats over-perform for this client.
//
// Reads precomputed format aggregates from
// /analytics/insights/{clientId}/{weekId}/formatPlaybook. Pure
// display — no scoring.
//
// Phase 6 ships against the v0 heuristic classifier (~70% accuracy).
// The panel carries a visible caveat. Phase 7 swaps in Claude's
// classifier with the same field shape and the caveat comes off.

import { useMemo } from "react";
import { fmtPct } from "../utils/displayFormatters";
import { FORMAT_BUCKETS } from "../config/constants";

const LABEL_BY_KEY = Object.fromEntries(FORMAT_BUCKETS.map(f => [f.key, f.label]));

export function FormatPlaybook({ playbook }) {
  // Sort formats by medianOverperf descending. Hide "other" — it's
  // a fallback bucket, not a playbook signal.
  const rows = useMemo(() => {
    const formats = playbook?.formats || {};
    return Object.entries(formats)
      .filter(([k]) => k !== "other")
      .map(([k, v]) => ({
        key: k,
        label: LABEL_BY_KEY[k] || k,
        count: v.count || 0,
        medianOverperf: v.medianOverperf ?? null,
        lastPostedTs: v.lastPostedTs ?? null,
      }))
      // Need a real signal — drop formats with no overperf measurement
      // or fewer than 2 posts (a single post isn't a pattern).
      .filter(r => r.count >= 2)
      .sort((a, b) => (b.medianOverperf || 0) - (a.medianOverperf || 0));
  }, [playbook]);

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "16px 18px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)" }}>
          Format playbook
        </div>
        {playbook?.classifierSource === "claude" ? <ClaudePill /> : <V0Pill />}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
        Which formats over-perform for this client. Sorted by median
        overperformance vs the client's own baseline.
      </div>

      {rows.length === 0 ? (
        <Empty>
          Not enough format signal yet — need at least 2 classified posts per format.
          Comes online after a few scrapes.
        </Empty>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map(r => <FormatRow key={r.key} row={r} />)}
        </div>
      )}
    </div>
  );
}

function FormatRow({ row }) {
  const wins = row.medianOverperf != null && row.medianOverperf >= 1.2;
  const loses = row.medianOverperf != null && row.medianOverperf < 0.8;
  const colour = wins ? "#10B981" : loses ? "#EF4444" : "var(--muted)";

  // Bar width: 0–3x median → 0–100%. Clamp visually.
  const fillPct = row.medianOverperf != null
    ? Math.min(100, Math.max(0, row.medianOverperf / 3 * 100))
    : 0;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "160px 1fr 70px 60px",
      alignItems: "center",
      gap: 10,
      padding: "6px 8px",
      borderRadius: 6,
      background: "var(--bg)",
    }}>
      <div style={{ fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>
        {row.label}
      </div>
      <div style={{
        position: "relative",
        height: 8, borderRadius: 4,
        background: "var(--card)",
        overflow: "hidden",
      }}>
        <div style={{
          width: `${fillPct}%`,
          height: "100%",
          background: colour,
          opacity: 0.65,
        }}/>
      </div>
      <div style={{
        fontSize: 12, fontWeight: 700, color: colour,
        fontFamily: "'JetBrains Mono', monospace",
        textAlign: "right",
      }}>
        {row.medianOverperf != null ? `${row.medianOverperf.toFixed(2)}x` : "—"}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", textAlign: "right" }}>
        n={row.count}
      </div>
    </div>
  );
}

function V0Pill() {
  return (
    <span
      title="Format classifier is a keyword-matching heuristic (~70% accuracy). Phase 7's Claude classifier hasn't run on these posts yet — recompute once ANTHROPIC_API_KEY + ANALYTICS_CLAUDE_ENABLED are set."
      style={{
        padding: "2px 8px", borderRadius: 4,
        background: "rgba(245,158,11,0.15)", color: "#F59E0B",
        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
      }}>
      v0 · improving
    </span>
  );
}

function ClaudePill() {
  return (
    <span
      title="Format classifier is Claude (Sonnet) — caption + metadata. ~85–90% expected accuracy. Manual overrides on individual posts always win."
      style={{
        padding: "2px 8px", borderRadius: 4,
        background: "rgba(16,185,129,0.15)", color: "#10B981",
        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
      }}>
      AI classified
    </span>
  );
}

function Empty({ children }) {
  return (
    <div style={{
      padding: 16, textAlign: "center",
      color: "var(--muted)", fontSize: 12,
      background: "var(--bg)",
      border: "1px dashed var(--border)", borderRadius: 8,
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}
