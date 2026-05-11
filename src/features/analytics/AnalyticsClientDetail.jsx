// AnalyticsClientDetail — per-account configuration view.
//
// Phase 1: this is the setup form only. No scraping, no charts, no
// scoring. Producers can:
//   - Enable / disable analytics for this account.
//   - Edit social handles (IG required, TT + YT placeholder for v2/v3).
//   - Edit per-platform toggles (only Instagram is operational in v1).
//   - Add / remove competitor handles per platform.
//   - Set a free-text niche label (the actual benchmark is the
//     competitor cohort — this label is for human reference only).
//   - Click "Refresh now" — wired to a stub endpoint that returns
//     "not implemented yet" until Phase 2 lands the ingestion pipeline.
//
// Later phases will replace the body below the config card with the
// real dashboard zones (Status Header, Winning Videos, etc.).

import { useState } from "react";
import { useAccounts } from "./hooks/useAccounts";
import { useAnalyticsConfig } from "./hooks/useAnalyticsConfig";
import { useClientDashboardData } from "./hooks/useClientDashboardData";
import { PLATFORMS } from "./config/constants";
import { normaliseHandle, displayHandle } from "./utils/displayFormatters";
import { authFetch } from "../../firebase";
import { StatusHeader } from "./components/StatusHeader";
import { WinningVideos } from "./components/WinningVideos";
import { NicheIntel } from "./components/NicheIntel";
import { WhatsWorking } from "./components/WhatsWorking";
import { NextVideoRecs } from "./components/NextVideoRecs";
import { DecayAlerts } from "./components/DecayAlerts";
import { WeeklySummary } from "./components/WeeklySummary";
import { RenewalAmmo } from "./components/RenewalAmmo";

export function AnalyticsClientDetail({ accountId, onBack }) {
  const { accounts } = useAccounts();
  const account = accounts?.[accountId];
  const { config, updateConfig, loading } = useAnalyticsConfig(accountId, account?.companyName);
  const dashboard = useClientDashboardData(accountId);
  const [showConfig, setShowConfig] = useState(false);

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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={onBack}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}>
            ← All clients
          </button>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>
              {account?.companyName || "Loading…"}
            </span>
            <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>
              {account?.partnershipType || ""}
            </span>
          </div>
        </div>

        <RefreshButton accountId={accountId} enabled={!!config?.enabled} />
      </div>

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 28px 60px" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Loading…
          </div>
        ) : !config?.enabled ? (
          // Analytics hasn't been turned on for this account yet. Show
          // the config form up front so the founder can fill in
          // handles + competitors + flip the toggle. The dashboard
          // zones only render meaningfully once data exists.
          <>
            <NotEnabledBanner />
            <ConfigForm config={config} updateConfig={updateConfig} />
          </>
        ) : (
          // Analytics is enabled. Lead with the dashboard zones; tuck
          // setup behind a collapse so the producer can edit when
          // needed but isn't distracted by config every visit.
          <>
            <DecayAlerts alerts={dashboard.insights?.decayAlerts} />
            <WeeklySummary summary={dashboard.insights?.weeklySummary} />
            <StatusHeader data={dashboard} config={config} />
            <WinningVideos videos={dashboard.videos} limit={5} />
            <WhatsWorking playbook={dashboard.insights?.formatPlaybook} />
            <NicheIntel
              data={dashboard}
              competitorsRoot={dashboard.competitorsRoot}
            />
            <NextVideoRecs recs={dashboard.insights?.nextVideoRecs} />
            <RenewalAmmo ammo={dashboard.renewalAmmo} />

            <NextPhasesHint />

            <SetupSection
              expanded={showConfig}
              onToggle={() => setShowConfig(v => !v)}
            >
              <ConfigForm config={config} updateConfig={updateConfig} />
            </SetupSection>
          </>
        )}
      </div>
    </>
  );
}

// ─── Layout helpers (Phase 4) ─────────────────────────────────────

function NotEnabledBanner() {
  return (
    <div style={{
      padding: "12px 16px",
      background: "rgba(245,158,11,0.08)",
      border: "1px solid rgba(245,158,11,0.35)",
      borderRadius: 10,
      color: "#F59E0B",
      fontSize: 12,
      fontWeight: 600,
      marginBottom: 14,
      lineHeight: 1.5,
    }}>
      Analytics isn't enabled for this account yet. Fill in handles + competitors below,
      then flip the <strong>Enable analytics</strong> toggle. The dashboard appears here
      once data starts flowing.
    </div>
  );
}

function SetupSection({ expanded, onToggle, children }) {
  return (
    <div style={{
      marginTop: 16,
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      overflow: "hidden",
    }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "12px 20px",
          background: "transparent",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "inherit",
          color: "var(--fg)",
        }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          Setup &amp; configuration
        </span>
        <span style={{
          fontSize: 11, fontWeight: 700, color: "var(--muted)",
          textTransform: "uppercase", letterSpacing: 0.4,
        }}>
          {expanded ? "Hide ▴" : "Show ▾"}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 20px 20px", borderTop: "1px solid var(--border)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function NextPhasesHint() {
  return (
    <div style={{
      marginTop: 6,
      padding: "10px 14px",
      background: "var(--bg)",
      border: "1px dashed var(--border)",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--muted)",
      lineHeight: 1.6,
    }}>
      <strong style={{ color: "var(--fg)" }}>v1 complete.</strong>{" "}
      Hook Analyzer deferred to v1.1 (data slot reserved, no UI yet).
      Next: client-facing portal (v2) + monthly digest email + TikTok / YouTube platforms.
    </div>
  );
}

// ─── Config form ──────────────────────────────────────────────────

function ConfigForm({ config, updateConfig }) {
  const inputSt = {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--input-bg)",
    color: "var(--fg)",
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
    width: "100%",
  };

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "20px 24px",
      marginBottom: 20,
    }}>
      <SectionTitle>Setup</SectionTitle>

      <FieldRow label="Enable analytics">
        <ToggleSwitch
          value={!!config.enabled}
          onChange={(next) => updateConfig({ enabled: next })}
          onLabel="Scraping enabled"
          offLabel="Off"
        />
        <Hint>
          When on, scheduled scraping begins on the next cron. Nothing is
          scraped while this is off — no Apify cost, no Firebase writes
          beyond config.
        </Hint>
      </FieldRow>

      <FieldRow label="Platforms">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PLATFORMS.map(p => {
            const active = !!config.platforms?.[p.key];
            const disabled = !p.v1;
            return (
              <button
                key={p.key}
                onClick={() => updateConfig({
                  platforms: { ...config.platforms, [p.key]: !active },
                })}
                disabled={disabled}
                title={disabled ? `${p.label} support lands in a later phase.` : undefined}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "rgba(0,130,250,0.15)" : "transparent",
                  color: disabled ? "var(--muted)" : active ? "var(--accent)" : "var(--fg)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                  fontFamily: "inherit",
                }}
              >
                {p.label}{disabled ? " · v2+" : ""}
              </button>
            );
          })}
        </div>
        <Hint>
          v1 only ships Instagram. The TikTok / YouTube toggles stay
          here so the config shape is stable and v2 / v3 are wiring,
          not redesign.
        </Hint>
      </FieldRow>

      <SectionTitle>Client handles</SectionTitle>

      {PLATFORMS.map(p => (
        <FieldRow key={p.key} label={`${p.label} handle`}>
          <input
            type="text"
            value={config.handles?.[p.key] || ""}
            onChange={e => updateConfig({
              handles: { ...config.handles, [p.key]: normaliseHandle(e.target.value) },
            })}
            placeholder={p.v1 ? "@brand" : "Configured for v2+"}
            disabled={!p.v1}
            style={{ ...inputSt, opacity: p.v1 ? 1 : 0.5 }}
          />
        </FieldRow>
      ))}

      <SectionTitle>Competitors</SectionTitle>
      <Hint>
        Your client's saved competitors define the niche cohort.
        Benchmarks compare against the median of this list. Aim for
        5–10 per platform. v1 only uses the Instagram list.
      </Hint>

      {PLATFORMS.map(p => (
        <CompetitorList
          key={p.key}
          platform={p}
          competitors={config.competitors?.[p.key] || []}
          onChange={(next) => updateConfig({
            competitors: { ...config.competitors, [p.key]: next },
          })}
        />
      ))}

      <SectionTitle>Niche label</SectionTitle>

      <FieldRow label="Niche (free text — for reference only)">
        <input
          type="text"
          value={config.niche?.freeText || ""}
          onChange={e => updateConfig({
            niche: { ...(config.niche || {}), freeText: e.target.value },
          })}
          placeholder="e.g. Sydney real-estate, Personal-brand fitness, B2B SaaS"
          style={inputSt}
        />
        <Hint>
          This text is just a human reference. The actual benchmark
          for the dashboard is the median of the competitors above.
        </Hint>
      </FieldRow>
    </div>
  );
}

// ─── Competitor sub-list ──────────────────────────────────────────

function CompetitorList({ platform, competitors, onChange }) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const handle = normaliseHandle(draft);
    if (!handle) return;
    if (competitors.some(c => c.handle === handle)) {
      setDraft("");
      return;
    }
    const next = [
      ...competitors,
      {
        handle,
        displayName: displayHandle(handle),
        addedAt: new Date().toISOString(),
        source: "viewix",
      },
    ];
    onChange(next);
    setDraft("");
  };

  const remove = (handle) => {
    onChange(competitors.filter(c => c.handle !== handle));
  };

  return (
    <FieldRow label={`${platform.label} competitors${competitors.length > 0 ? ` (${competitors.length})` : ""}`}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={platform.v1 ? "@competitor — press Enter to add" : "v2+ feature"}
          disabled={!platform.v1}
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--input-bg)",
            color: "var(--fg)",
            fontSize: 13,
            outline: "none",
            fontFamily: "inherit",
            opacity: platform.v1 ? 1 : 0.5,
          }}
        />
        <button
          onClick={add}
          disabled={!platform.v1 || !draft.trim()}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent)",
            color: "white",
            fontSize: 12,
            fontWeight: 700,
            cursor: (!platform.v1 || !draft.trim()) ? "not-allowed" : "pointer",
            opacity: (!platform.v1 || !draft.trim()) ? 0.4 : 1,
            fontFamily: "inherit",
          }}
        >
          + Add
        </button>
      </div>

      {competitors.length > 0 && (
        <div style={{
          marginTop: 8,
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}>
          {competitors.map(c => (
            <span
              key={c.handle}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px 4px 10px",
                borderRadius: 999,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                fontSize: 12,
                color: "var(--fg)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {displayHandle(c.handle)}
              <button
                onClick={() => remove(c.handle)}
                title="Remove competitor"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--muted)",
                  fontSize: 14,
                  cursor: "pointer",
                  padding: "0 2px",
                  lineHeight: 1,
                  fontFamily: "inherit",
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </FieldRow>
  );
}

// ─── Refresh button (stub for Phase 1) ────────────────────────────

function RefreshButton({ accountId, enabled }) {
  const [status, setStatus] = useState(null); // null | "pending" | "done" | "error"
  const [message, setMessage] = useState("");

  const onClick = async () => {
    if (!enabled) return;
    setStatus("pending");
    setMessage("");
    try {
      const res = await authFetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh", accountId, force: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data?.error || `HTTP ${res.status}`);
      } else {
        setStatus("done");
        setMessage(data?.message || "Refresh queued.");
      }
    } catch (err) {
      setStatus("error");
      setMessage(err?.message || "Network error");
    }
  };

  const tooltip = enabled
    ? "Trigger an Apify scrape now. Capped to 1/day per client."
    : "Enable analytics for this account first.";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        onClick={onClick}
        disabled={!enabled || status === "pending"}
        title={tooltip}
        style={{
          padding: "8px 14px",
          borderRadius: 8,
          border: "none",
          background: enabled ? "var(--accent)" : "var(--border)",
          color: "white",
          fontSize: 12,
          fontWeight: 700,
          cursor: enabled && status !== "pending" ? "pointer" : "not-allowed",
          opacity: enabled ? 1 : 0.5,
          fontFamily: "inherit",
        }}
      >
        {status === "pending" ? "Refreshing…" : "Refresh now"}
      </button>
      {message && (
        <span style={{
          fontSize: 10,
          color: status === "error" ? "#EF4444" : "var(--muted)",
          maxWidth: 240,
          textAlign: "right",
        }}>
          {message}
        </span>
      )}
    </div>
  );
}

// (Phase 1's ComingSoonPanel was removed in Phase 4 — replaced
//  inline by StatusHeader + WinningVideos + NextPhasesHint near the
//  top of this file.)

// ─── Small layout helpers ─────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 800,
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 18,
      marginBottom: 10,
      paddingBottom: 6,
      borderBottom: "1px solid var(--border)",
    }}>
      {children}
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10,
        fontWeight: 800,
        color: "var(--muted)",
        textTransform: "uppercase",
        letterSpacing: 0.4,
        marginBottom: 6,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }) {
  return (
    <div style={{
      fontSize: 11,
      color: "var(--muted)",
      marginTop: 6,
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

function ToggleSwitch({ value, onChange, onLabel = "On", offLabel = "Off" }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 6,
        border: `1px solid ${value ? "#10B981" : "var(--border)"}`,
        background: value ? "rgba(16,185,129,0.15)" : "transparent",
        color: value ? "#10B981" : "var(--muted)",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <span
        style={{
          width: 24,
          height: 14,
          borderRadius: 999,
          background: value ? "#10B981" : "var(--border)",
          position: "relative",
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: value ? 12 : 2,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "var(--card)",
            transition: "left 0.15s",
          }}
        />
      </span>
      {value ? onLabel : offLabel}
    </button>
  );
}
