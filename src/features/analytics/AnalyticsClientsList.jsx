// AnalyticsClientsList — the command centre. One card per eligible
// account, sorted alphabetically. Each card shows the company name,
// partnership type, the current "Enable analytics" state, and (in
// later phases) a status badge + momentum score.
//
// Eligibility rule (Phase 1): an account appears here if it has a
// partnershipType set. It does NOT auto-enable scraping — that
// requires the founder to flip the per-card "Enable" toggle.
// Control beats guessing.
//
// Per the plan, this list filters to active customers but doesn't
// conflate "shows up" with "actually getting scraped." Those are
// two different states, gated on different fields.

import { useState } from "react";
import { useAccounts } from "./hooks/useAccounts";
import { useAnalyticsConfig } from "./hooks/useAnalyticsConfig";

export function AnalyticsClientsList({ onSelect }) {
  const { eligible, loading } = useAccounts();

  return (
    <>
      <div style={{
        padding: "12px 28px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "var(--card)",
      }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>
            Analytics
          </span>
          <span style={{ marginLeft: 8, fontSize: 12, color: "var(--muted)" }}>
            Viewix Growth Intelligence
          </span>
        </div>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: "rgba(0,130,250,0.15)",
            color: "var(--accent)",
            fontSize: 9,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
          title="Phase 1: config UI only. Ingestion + scoring + dashboard land in Phases 2–7."
        >
          Phase 1 · Setup
        </span>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 28px 60px" }}>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
          Eligible accounts (partnership type is set) appear below. Click into one
          to configure handles + competitors + niche label. Nothing is scraped or
          costs anything until you flip the "Enable analytics" toggle on the card.
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Loading accounts…
          </div>
        ) : eligible.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: "center",
            color: "var(--muted)",
            background: "var(--card)",
            border: "1px dashed var(--border)",
            borderRadius: 12,
            fontSize: 13,
          }}>
            No eligible accounts yet. Accounts appear here once they have a
            partnership type set in the Accounts tab.
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 14,
          }}>
            {eligible.map(account => (
              <AccountCard
                key={account.id}
                account={account}
                onSelect={() => onSelect?.(account.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// Per-account card. Hosts the inline "Enable analytics" toggle so
// founders can flip on a client without opening the detail view.
// Clicking anywhere else on the card opens the detail view.
function AccountCard({ account, onSelect }) {
  const { config, updateConfig, loading } = useAnalyticsConfig(account.id, account.companyName);
  const [hover, setHover] = useState(false);

  const enabled = !!config?.enabled;

  const toggleEnabled = (e) => {
    e.stopPropagation();
    updateConfig({ enabled: !enabled });
  };

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--card)",
        border: `1px solid ${enabled ? "rgba(16,185,129,0.45)" : hover ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 12,
        padding: "16px 18px",
        cursor: "pointer",
        transition: "all 0.15s",
        boxShadow: enabled ? "0 0 12px rgba(16,185,129,0.18)" : "none",
      }}
    >
      <div style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 10,
        marginBottom: 10,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 15,
            fontWeight: 800,
            color: "var(--fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {account.companyName || "Untitled account"}
          </div>
          <div style={{
            fontSize: 10,
            fontWeight: 700,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
            marginTop: 4,
          }}>
            {account.partnershipType || "—"}
          </div>
        </div>

        <button
          onClick={toggleEnabled}
          disabled={loading}
          title={enabled ? "Analytics is enabled for this account. Click to disable." : "Click to enable analytics — scraping starts on next cron run."}
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            borderRadius: 6,
            border: `1px solid ${enabled ? "#10B981" : "var(--border)"}`,
            background: enabled ? "rgba(16,185,129,0.18)" : "transparent",
            color: enabled ? "#10B981" : "var(--muted)",
            fontSize: 10,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            cursor: loading ? "default" : "pointer",
            fontFamily: "inherit",
          }}
        >
          {loading ? "…" : enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      <div style={{
        fontSize: 11,
        color: "var(--muted)",
        lineHeight: 1.5,
      }}>
        {enabled
          ? "Configured. Phase 2 will start scraping on the next cron."
          : "Click to configure handles + competitors."}
      </div>
    </div>
  );
}
