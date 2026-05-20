// SocialConnections — producer-side admin tab. Top-level. Founder/
// Lead gated. One page that surfaces every Viewix-managed account's
// per-platform connection state, with a "Reconnect (admin)" button
// per disconnected non-TikTok platform that opens the hosted Zernio
// URL in a new tab — the team member completes the OAuth as
// themselves under the Leadsie-granted BM access.
//
// For TikTok the button changes to "Send client reconnect email"
// because TikTok mandates the client re-authorise personally.
//
// Worker heartbeat surfaced at the top so a stuck Mac Mini is
// visible without leaving the tab.

import { useEffect, useState, useMemo } from "react";
import { BTN, TH } from "../config";
import { authFetch } from "../firebase";

const PLATFORM_LABEL = {
  instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube",
  linkedin: "LinkedIn", facebook: "Facebook Page",
};

const STATUS_COLOR = {
  connected:    { fg: "#10B981", bg: "rgba(16,185,129,0.12)" },
  expiring:     { fg: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
  disconnected: { fg: "#EF4444", bg: "rgba(239,68,68,0.12)" },
  unknown:      { fg: "var(--muted)", bg: "var(--bg)" },
};

function StatusPill({ status }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.unknown;
  return (
    <span style={{ padding: "3px 10px", borderRadius: 999, background: c.bg, color: c.fg, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {status}
    </span>
  );
}

function HeartbeatBadge({ heartbeat }) {
  if (!heartbeat) {
    return (
      <span style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(239,68,68,0.1)", color: "#EF4444", fontSize: 11, fontWeight: 700 }}>
        ⚠ Mac Mini worker never heartbeated
      </span>
    );
  }
  const ageMin = Math.round((Date.now() - heartbeat.ts) / 60000);
  const stale = ageMin > 15; // worker writes every 5 min
  return (
    <span style={{
      padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
      background: stale ? "rgba(239,68,68,0.1)" : "rgba(16,185,129,0.1)",
      color: stale ? "#EF4444" : "#10B981",
    }}>
      {stale ? "⚠ Worker stale" : "✓ Worker healthy"} · {heartbeat.workerId} · {ageMin}m ago
    </span>
  );
}

export function SocialConnections() {
  const [state, setState] = useState({ loading: true, accounts: [], heartbeat: null, error: null });
  const [busy, setBusy] = useState(null); // `${accountId}::${platform}` while in-flight

  const load = async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const r = await authFetch("/api/social-admin-connections");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setState({ loading: false, accounts: [], heartbeat: null, error: j.error || `Error ${r.status}` }); return; }
      setState({ loading: false, accounts: j.accounts || [], heartbeat: j.workerHeartbeat, error: null });
    } catch (e) {
      setState({ loading: false, accounts: [], heartbeat: null, error: e.message || "Network error" });
    }
  };

  useEffect(() => { load(); }, []);

  const onReconnect = async (accountId, platform) => {
    const key = `${accountId}::${platform}`;
    setBusy(key);
    try {
      const r = await authFetch("/api/social-admin-connections?action=reconnect-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, platform }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`Failed: ${j.detail || j.error || `Error ${r.status}`}`);
        return;
      }
      if (j.reconnectUrl) {
        window.open(j.reconnectUrl, "_blank", "noopener,noreferrer");
      } else if (j.sent) {
        alert(`Client reconnect email sent to ${j.to}`);
      }
      // Refresh ~8s after the user opens the URL so any post-OAuth
      // webhook hits land in the UI.
      setTimeout(load, 8000);
    } finally {
      setBusy(null);
    }
  };

  // Sort accounts: any with disconnected/expiring tiles first.
  const sorted = useMemo(() => {
    return [...state.accounts].sort((a, b) => {
      const aHas = a.tiles.some(t => t.status !== "connected") ? 0 : 1;
      const bHas = b.tiles.some(t => t.status !== "connected") ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return (a.orgName || "").localeCompare(b.orgName || "");
    });
  }, [state.accounts]);

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Social Connections</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <HeartbeatBadge heartbeat={state.heartbeat} />
          <button onClick={load} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" }}>Refresh</button>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 28px 60px" }}>
        <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 20 }}>
          One row per provisioned account. Reconnect any non-TikTok platform from here yourself — you&apos;ll open a Zernio
          hosted link in a new tab; complete the OAuth while logged into the Viewix Business Manager and you&apos;ll see the
          client&apos;s asset in the consent picker. TikTok&apos;s "Send client reconnect email" button fires the SocialReconnect
          template to the client because TikTok mandates the account owner re-authorise personally.
        </p>

        {state.loading && <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading…</div>}
        {state.error && <div style={{ padding: 12, borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "#EF4444", fontSize: 13 }}>{state.error}</div>}

        {sorted.length === 0 && !state.loading && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", border: "1px dashed var(--border)", borderRadius: 12 }}>
            No Zernio profiles provisioned yet. Use the "Provision Zernio profile" button on each account in the Accounts tab to enable scheduled posting for that client.
          </div>
        )}

        <div style={{ display: "grid", gap: 12 }}>
          {sorted.map(acct => (
            <div key={acct.accountId} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{acct.orgName}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", marginTop: 2 }}>{acct.accountId}</div>
                </div>
              </div>
              {acct.tiles.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>No in-scope platforms set on this account.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr>
                    <th style={{ ...TH, textAlign: "left", padding: "8px 12px", width: 160 }}>Platform</th>
                    <th style={{ ...TH, textAlign: "left", padding: "8px 12px", width: 140 }}>Status</th>
                    <th style={{ ...TH, textAlign: "left", padding: "8px 12px" }}>Last connected / notes</th>
                    <th style={{ ...TH, textAlign: "right", padding: "8px 12px", width: 220 }}></th>
                  </tr></thead>
                  <tbody>
                    {acct.tiles.map(tile => {
                      const needs = tile.status === "disconnected" || tile.status === "expiring";
                      const key = `${acct.accountId}::${tile.platform}`;
                      return (
                        <tr key={tile.platform}>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", fontWeight: 600 }}>
                            {PLATFORM_LABEL[tile.platform] || tile.platform}
                          </td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}><StatusPill status={tile.status} /></td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", color: "var(--muted)" }}>
                            {tile.lastConnected ? new Date(tile.lastConnected).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                            {tile.refreshBy && (
                              <span style={{ marginLeft: 8, color: "#F59E0B" }}>
                                · expires {new Date(tile.refreshBy).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "right" }}>
                            {needs && (
                              <button
                                onClick={() => onReconnect(acct.accountId, tile.platform)}
                                disabled={busy === key}
                                style={{ ...BTN, background: "var(--accent)", color: "white", opacity: busy === key ? 0.6 : 1 }}
                                title={tile.platform === "tiktok"
                                  ? "Fires the SocialReconnect email to the client (TikTok requires the account owner to re-authorise)."
                                  : "Opens the Zernio hosted connect URL in a new tab. Complete the OAuth while logged into the Viewix Business Manager."}
                              >
                                {busy === key ? "Working…" : (tile.platform === "tiktok" ? "Email client" : "Reconnect (admin)")}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
