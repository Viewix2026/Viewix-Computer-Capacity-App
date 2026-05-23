// ConnectedAccounts — /clients/accounts. One screen showing each
// social platform's connection state across every account the
// signed-in client can see. TikTok gets a live [Reconnect] button
// (the only platform where the client MUST self-link); other
// platforms show "We'll handle it — no action needed."

import { useEffect, useState } from "react";
import { authFetch } from "../../firebase";
import { PortalNav, MobileShell, ViewixLogo, Icon, Pill, BtnPrimary, useIsNarrow } from "./ui";

const PLATFORM_LABEL = {
  instagram: "Instagram",
  tiktok:    "TikTok",
  youtube:   "YouTube",
  linkedin:  "LinkedIn",
  facebook:  "Facebook Page",
};

const STATUS_TONE = {
  connected:    { tone: "green",  label: "Connected" },
  expiring:     { tone: "amber",  label: "Expiring soon" },
  disconnected: { tone: "red",    label: "Reconnect needed" },
  unknown:      { tone: "muted",  label: "Unknown" },
};

function PlatformTile({ accountId, tile, onReconnect, reconnecting }) {
  const status = STATUS_TONE[tile.status] || STATUS_TONE.unknown;
  const canReconnect = tile.platform === "tiktok" && (tile.status === "disconnected" || tile.status === "expiring");
  return (
    <div style={{
      padding: "16px 18px", borderRadius: 12, border: "1px solid var(--line)",
      background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12, flexWrap: "wrap",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", textTransform: "capitalize", fontWeight: 700, color: "var(--text-2)" }}>
          {(tile.platform || "?").slice(0, 2)}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{PLATFORM_LABEL[tile.platform] || tile.platform}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
            {tile.lastConnected ? `Last connected ${new Date(tile.lastConnected).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : "Awaiting first connection"}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Pill tone={status.tone}>{status.label}</Pill>
        {canReconnect && (
          <BtnPrimary onClick={() => onReconnect(accountId, tile.platform)} disabled={reconnecting}>
            {reconnecting ? "Opening…" : "Reconnect"}
          </BtnPrimary>
        )}
        {!canReconnect && tile.status !== "connected" && tile.platform !== "tiktok" && (
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>We&apos;ll handle it — no action needed.</span>
        )}
      </div>
    </div>
  );
}

export function ConnectedAccounts({ user, theme, onTheme, onSignOut, onBack }) {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState({ loading: true, accounts: [], error: null });
  const [reconnecting, setReconnecting] = useState(null); // `${accountId}::${platform}` when in-flight

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/client/social-connections");
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setState({ loading: false, accounts: [], error: j.error || `Error ${r.status}` }); return; }
        setState({ loading: false, accounts: j.accounts || [], error: null });
      } catch (e) {
        if (!cancelled) setState({ loading: false, accounts: [], error: e.message || "Network error" });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onReconnect = async (accountId, platform) => {
    const key = `${accountId}::${platform}`;
    setReconnecting(key);
    try {
      const r = await authFetch("/api/client/social-connections?action=reconnect-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, platform }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.reconnectUrl) {
        alert(`Couldn't open reconnect: ${j.error || j.detail || `Error ${r.status}`}`);
        setReconnecting(null);
        return;
      }
      // Open in a new tab; the hosted Zernio page closes itself after
      // success. We don't get a sync callback (Zernio fires
      // account.connected via webhook back to /api/zernio-webhook),
      // so we just reload the list a few seconds after opening.
      window.open(j.reconnectUrl, "_blank", "noopener,noreferrer");
      setTimeout(() => {
        (async () => {
          const r2 = await authFetch("/api/client/social-connections");
          const j2 = await r2.json().catch(() => ({}));
          if (r2.ok) setState({ loading: false, accounts: j2.accounts || [], error: null });
        })();
      }, 8000);
    } catch (e) {
      alert(`Network error: ${e.message}`);
    } finally {
      setReconnecting(null);
    }
  };

  const inner = (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: narrow ? "20px 16px 60px" : "32px 32px 80px" }}>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--heading)" }}>Connected accounts</h1>
      <p style={{ margin: "8px 0 24px", fontSize: 14, color: "var(--text-2)", lineHeight: 1.55 }}>
        Most platforms we handle on your behalf — when a connection drops, our team reconnects it through your Business Manager and you don&apos;t need to do anything.
        TikTok is the exception: TikTok requires you to re-authorise our scheduler personally from time to time. When that happens we&apos;ll email you a link, or you can use the Reconnect button here.
      </p>

      {state.loading && <div style={{ padding: 40, textAlign: "center", color: "var(--text-3)" }}><ViewixLogo size={22} style={{ margin: "0 auto 12px" }} />Loading your connections…</div>}
      {state.error && <div style={{ padding: 16, borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "var(--danger)", fontSize: 13 }}>{state.error}</div>}

      {state.accounts.map(acct => (
        <div key={acct.accountId} style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--heading)" }}>{acct.orgName}</h2>
          </div>
          {acct.tiles.length === 0 ? (
            <div style={{ padding: 18, borderRadius: 12, border: "1px dashed var(--line)", color: "var(--text-3)", fontSize: 13, textAlign: "center" }}>
              No social accounts configured yet. Your account manager will set these up at onboarding.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {acct.tiles.map(tile => (
                <PlatformTile
                  key={`${acct.accountId}::${tile.platform}`}
                  accountId={acct.accountId}
                  tile={tile}
                  reconnecting={reconnecting === `${acct.accountId}::${tile.platform}`}
                  onReconnect={onReconnect}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  if (narrow) {
    return (
      <MobileShell user={user} title="Connected accounts" back onBack={onBack} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut}>
        {inner}
      </MobileShell>
    );
  }
  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <PortalNav active="Accounts" user={user} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut} />
      <div className="vx-scroll" style={{ flex: 1, overflow: "auto" }}>{inner}</div>
    </div>
  );
}
