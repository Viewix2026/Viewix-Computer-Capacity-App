// Client portal — Analytics tab (design section 04, "Growth
// Intelligence").
//
// DESKTOP renders the proportioned multi-zone dashboard
// (AnalyticsDashboard, .vx tokens) faithful to the Claude Design.
// MOBILE keeps the mobile-first /r/ report body (PortalBody, scoped
// under .viewix-portal + CSS_LIGHT) — the design's own mobile is a
// single column, and the /r/ shareable link stays one implementation.
//
// Data comes from /api/client/analytics — the same client-safe
// /analytics/public projection the /r/ page reads, resolved server-side
// because the accountId → portalShortId mapping is staff-only.

import { useEffect, useState } from "react";
import { PortalNav, MobileShell, ViewixLogo, Icon, useIsNarrow } from "./ui";
import { CSS_LIGHT } from "../../config";
import { PortalBody } from "../../features/clientPortal/ClientPortal";
import { AnalyticsDashboard } from "./AnalyticsDashboard";

function GatheringState({ narrow }) {
  return (
    <div style={{ padding: narrow ? "48px 24px" : "80px 40px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
      <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", color: "var(--accent)" }}><Icon.spark /></div>
      <h2 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 600, color: "var(--heading)" }}>We're collecting your first month of data</h2>
      <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
        Your dashboard fills in as we go - we'll let you know the moment something's ready to review.
        Questions in the meantime? Message <span style={{ color: "var(--accent)" }}>hello@viewix.com.au</span>.
      </p>
    </div>
  );
}

// Valid sign-in but no /clientAccess registry entry. Mirrors the
// Dashboard's no-access state rather than promising data collection
// that isn't happening.
function NoAccessState({ narrow }) {
  return (
    <div style={{ padding: narrow ? "48px 24px" : "80px 40px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
      <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", color: "var(--accent)" }}><Icon.shield /></div>
      <h2 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 600, color: "var(--heading)" }}>No analytics linked yet</h2>
      <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
        Your email isn't linked to an account yet. If you're expecting access, reach out to your Viewix account manager or message{" "}
        <span style={{ color: "var(--accent)" }}>hello@viewix.com.au</span> and we'll sort it straight away.
      </p>
    </div>
  );
}

export function Analytics({ user, theme, onTheme, onSignOut, onNav, authFetch }) {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState({ loading: true, error: "", accounts: [], hasAccess: true });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", accounts: [], hasAccess: true });
    (async () => {
      try {
        const r = await authFetch("/api/client/analytics");
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setState({ loading: false, error: j.error || `Error ${r.status}`, accounts: [], hasAccess: true }); return; }
        setState({ loading: false, error: "", accounts: j.accounts || [], hasAccess: j.hasAccess !== false });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message || "Network error", accounts: [], hasAccess: true });
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch, user]);

  const accounts = state.accounts;
  const current = accounts.length ? accounts[Math.min(selected, accounts.length - 1)] : null;

  let inner;
  if (state.loading) {
    inner = <div style={{ padding: 80, textAlign: "center", color: "var(--text-3)" }}><ViewixLogo size={24} style={{ margin: "0 auto 14px" }} />Loading your analytics...</div>;
  } else if (state.error) {
    inner = <div style={{ padding: 80, textAlign: "center", color: "var(--text-2)" }}>We couldn't load your analytics.<div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>{state.error}</div></div>;
  } else if (!current) {
    inner = state.hasAccess ? <GatheringState narrow={narrow} /> : <NoAccessState narrow={narrow} />;
  } else {
    const switcher = accounts.length > 1 && (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: narrow ? "16px 16px 0" : "16px 36px 0", maxWidth: narrow ? 720 : undefined, margin: narrow ? "0 auto" : undefined }}>
        {accounts.map((a, i) => {
          const active = i === Math.min(selected, accounts.length - 1);
          return (
            <button key={a.accountId} onClick={() => setSelected(i)} style={{
              padding: "7px 14px", borderRadius: 999, fontSize: 12,
              fontWeight: active ? 600 : 500,
              border: active ? "1px solid var(--accent-line)" : "1px solid var(--line)",
              background: active ? "var(--accent-soft)" : "var(--surface)",
              color: active ? "var(--accent)" : "var(--text-2)",
            }}>{a.name}</button>
          );
        })}
      </div>
    );
    inner = narrow ? (
      <>
        {switcher}
        {/* Mobile: the /r/ report body. minHeight:0 overrides the
            standalone page's 100vh; letterSpacing resets .vx tracking. */}
        <div className="viewix-portal" style={{ minHeight: 0, letterSpacing: "normal" }}>
          <style>{CSS_LIGHT}</style>
          <PortalBody p={current.projection} embedded />
        </div>
      </>
    ) : (
      <>
        {switcher}
        <AnalyticsDashboard p={current.projection} company={current.name} />
      </>
    );
  }

  if (narrow) {
    return (
      <MobileShell user={user} title="Analytics" menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut} activeTab="Analytics" onNav={onNav}>
        {inner}
      </MobileShell>
    );
  }
  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <PortalNav
        active="Analytics" user={user} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)}
        theme={theme} onTheme={onTheme} onSignOut={onSignOut} onNav={onNav}
        context={current ? (<><span style={{ color: "var(--text-3)" }}>{current.name}</span><span style={{ color: "var(--text-4)" }}>/</span><span style={{ color: "var(--text)" }}>Growth intelligence</span></>) : null}
      />
      <div className="vx-scroll" style={{ flex: 1, overflow: "auto" }}>{inner}</div>
    </div>
  );
}
