// Nurture — sequence hub. Wraps a per-sequence sub-tab nav (Lapsed Proposals,
// Lead Re-engagement, Lost Revival, Won Retention, Win-Back, Anniversary).
//
// Only Lapsed Proposals is populated for v1; the rest render a stub card
// describing the sequence's intent/trigger/data/actions until the cron
// workers for each one come online.
//
// Header bar (sync timestamp + Refresh from Attio button) lives here so
// it's visible from every sub-tab, not just Lapsed.
//
// Sub-tabs are lazy-loaded so unused sequences don't ship JS until clicked.
// Sub-tab state lives in App.jsx (see foundersTab/saleTab pattern) so it
// survives the Nurture component's mount/unmount cycles.
//
// Deep-linking via #nurture/<subTab> follows the same pattern as
// Preproduction (route.subTab → setNurtureTab on mount).

import { lazy, Suspense, useEffect, useState } from "react";
import { BTN } from "../config";
import { authFetch } from "../firebase";

const NurtureLapsed           = lazy(() => import("./NurtureLapsed").then(m => ({ default: m.NurtureLapsed })));
const NurtureLeadReengagement = lazy(() => import("./NurtureLeadReengagement").then(m => ({ default: m.NurtureLeadReengagement })));
const NurtureLostRevival      = lazy(() => import("./NurtureLostRevival").then(m => ({ default: m.NurtureLostRevival })));
const NurtureWonRetention     = lazy(() => import("./NurtureWonRetention").then(m => ({ default: m.NurtureWonRetention })));
const NurtureWinBack          = lazy(() => import("./NurtureWinBack").then(m => ({ default: m.NurtureWinBack })));
const NurtureAnniversary      = lazy(() => import("./NurtureAnniversary").then(m => ({ default: m.NurtureAnniversary })));

const SUB_TABS = [
  { key: "lapsed",       label: "Lapsed Proposals" },
  { key: "leadReeng",    label: "Lead Re-engagement" },
  { key: "lostRevival",  label: "Lost-deal Revival" },
  { key: "wonRetention", label: "Won Retention" },
  { key: "winBack",      label: "Win-Back" },
  { key: "anniversary",  label: "Anniversary" },
];
const VALID_KEYS = new Set(SUB_TABS.map(t => t.key));

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

export function Nurture({ attioDeals, isFounder, nurtureTab, setNurtureTab, route }) {
  const [syncing, setSyncing] = useState(false);
  const lastSyncedAt = attioDeals?.lastSyncedAt;
  const activeTab = nurtureTab || "lapsed";

  // Hash-routing: #nurture/<subTab> → switch sub-tab on mount/route change.
  // Mirrors the pattern in Preproduction.jsx:107–123.
  useEffect(() => {
    if (!route?.subTab) return;
    if (VALID_KEYS.has(route.subTab) && activeTab !== route.subTab) {
      setNurtureTab(route.subTab);
    }
  }, [route?.subTab]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      const r = await authFetch("/api/sync-attio-cache", { method: "POST" });
      const d = await r.json();
      console.log("Sync result:", d);
    } catch (e) {
      console.error("Sync failed:", e);
    } finally {
      setSyncing(false);
    }
  };

  if (!isFounder) {
    return <div style={{ padding: 40, color: "var(--muted)" }}>Founders only.</div>;
  }

  return (
    <>
      {/* Header bar — sub-tab nav + sync state + refresh button */}
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Nurture · Sequence Hub</span>
            <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
              {SUB_TABS.map(t => (
                <button key={t.key} onClick={() => setNurtureTab(t.key)} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: activeTab === t.key ? "var(--card)" : "transparent", color: activeTab === t.key ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--bg)", padding: "3px 8px", borderRadius: 4 }}>
              {lastSyncedAt ? `Synced ${fmtDate(lastSyncedAt)}` : "Not yet synced"}
            </span>
            <button onClick={triggerSync} disabled={syncing} style={{ ...BTN, background: "var(--accent)", color: "white", opacity: syncing ? 0.6 : 1 }}>
              {syncing ? "Syncing…" : "Refresh from Attio"}
            </button>
          </div>
        </div>
      </div>

      {/* Sub-tab content */}
      <Suspense fallback={<div style={{ padding: 40, color: "var(--muted)", fontSize: 13 }}>Loading…</div>}>
        {activeTab === "lapsed"       && <NurtureLapsed attioDeals={attioDeals} />}
        {activeTab === "leadReeng"    && <NurtureLeadReengagement />}
        {activeTab === "lostRevival"  && <NurtureLostRevival />}
        {activeTab === "wonRetention" && <NurtureWonRetention />}
        {activeTab === "winBack"      && <NurtureWinBack />}
        {activeTab === "anniversary"  && <NurtureAnniversary />}
      </Suspense>
    </>
  );
}
