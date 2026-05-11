// NextVideoRecs — the session-ends-in-actions zone.
//
// Reads precomputed recs from
// /analytics/insights/{clientId}/{weekId}/nextVideoRecs. The
// Recommendation Quality Gate is enforced AT WRITE TIME in
// api/_analyticsRecsBuilder.js — anything that hit the array has
// all five required fields plus passed the confidence/sample-size
// rules. This component renders what's there, no filtering.
//
// Low-confidence recs are visually demoted (smaller, muted) per the
// plan, not hidden, so the founder can still see them.

export function NextVideoRecs({ recs }) {
  const list = Array.isArray(recs) ? recs : [];

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "16px 18px",
    }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)", marginBottom: 4 }}>
        Next video recommendations
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
        Rules-driven for v1 — every rec is reproducible from the
        underlying data. Phase 7 layers Claude framing on top.
      </div>

      {list.length === 0 ? (
        <Empty>
          No recommendations yet. Either there's not enough scored
          data, or no rule fired with high-enough confidence.
        </Empty>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {list.map((rec, i) => <RecCard key={rec.ruleId + "_" + i} rec={rec} />)}
        </div>
      )}
    </div>
  );
}

function RecCard({ rec }) {
  const isLow = rec.confidence === "low";
  return (
    <div style={{
      background: "var(--bg)",
      border: `1px solid ${isLow ? "var(--border)" : "var(--border)"}`,
      borderRadius: 8,
      padding: isLow ? "10px 14px" : "14px 16px",
      opacity: isLow ? 0.75 : 1,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
      }}>
        <ConfidencePill level={rec.confidence} />
        <RuleTag ruleId={rec.ruleId} />
        {isLow && <LowConfidencePrefix />}
      </div>

      <div style={{
        fontSize: isLow ? 13 : 14,
        fontWeight: 700,
        color: "var(--fg)",
        lineHeight: 1.4,
        marginBottom: 6,
      }}>
        {rec.idea}
      </div>

      <div style={{
        fontSize: 11,
        color: "var(--muted)",
        lineHeight: 1.5,
        marginBottom: 8,
      }}>
        {rec.rationale}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SourceLinks sourceIds={rec.sourceIds} />
        {rec.whyMightBeWrong && (
          <span
            title={rec.whyMightBeWrong}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#F59E0B",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              cursor: "help",
              padding: "2px 6px",
              borderRadius: 4,
              background: "rgba(245,158,11,0.10)",
              border: "1px solid rgba(245,158,11,0.30)",
            }}>
            ⓘ Why this might be wrong
          </span>
        )}
      </div>
    </div>
  );
}

function ConfidencePill({ level }) {
  const colour = level === "high" ? "#10B981" : level === "med" ? "#0082FA" : "#9CA3AF";
  const label = level === "high" ? "High confidence"
              : level === "med" ? "Medium confidence"
              : "Low confidence";
  return (
    <span style={{
      padding: "3px 8px",
      borderRadius: 999,
      background: `${colour}22`,
      color: colour,
      border: `1px solid ${colour}55`,
      fontSize: 9, fontWeight: 800,
      textTransform: "uppercase", letterSpacing: 0.4,
    }}>
      {label}
    </span>
  );
}

function RuleTag({ ruleId }) {
  // Render the rule id as a small monospace tag so anyone can audit
  // which rule fired by reading the card.
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      color: "var(--muted)",
      fontFamily: "'JetBrains Mono', monospace",
      padding: "2px 6px",
      borderRadius: 4,
      background: "var(--card)",
      border: "1px solid var(--border)",
    }}>
      {ruleId}
    </span>
  );
}

function LowConfidencePrefix() {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color: "var(--muted)",
      textTransform: "uppercase", letterSpacing: 0.4,
    }}>
      · take with a grain of salt
    </span>
  );
}

function SourceLinks({ sourceIds }) {
  if (!sourceIds || sourceIds.length === 0) return null;
  return (
    <span style={{
      fontSize: 10,
      color: "var(--muted)",
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <span style={{ opacity: 0.65, marginRight: 4 }}>source:</span>
      {sourceIds.slice(0, 3).map((id, i) => (
        <span key={id} style={{ marginRight: i < sourceIds.length - 1 ? 6 : 0 }}>
          {id}
        </span>
      ))}
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
