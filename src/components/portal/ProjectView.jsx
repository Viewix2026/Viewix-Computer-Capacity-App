import { useEffect, useState } from "react";
import { PortalNav, MobileShell, Label, Pill, PhaseTrack, Icon, ViewixLogo, useIsNarrow } from "./ui";
import { Deliveries } from "./Deliveries";
import { PreProduction } from "./PreProduction";
import { PostingSchedule } from "./PostingSchedule";

function clientColor(name) {
  const palette = ["#0082fa", "#f87700", "#1b9b6e", "#7c3aed", "#c2410c", "#0a3c3a", "#be123c"];
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
const ClientMark = ({ name, logo, box = 56 }) => {
  const [broken, setBroken] = useState(false);
  if (logo?.url && !broken) {
    return (
      <div style={{ width: box, height: box, borderRadius: 10, background: logo.bg || "#fff", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flex: "0 0 auto", boxShadow: "0 4px 14px -6px rgba(15,18,26,0.25)" }}>
        <img src={logo.url} alt={name || "Client"} onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "contain", padding: box * 0.16 }} />
      </div>
    );
  }
  const initials = (String(name || "?").match(/\b\w/g) || ["?"]).slice(0, 2).join("").toUpperCase();
  const bg = clientColor(name);
  return (
    <div style={{ width: box, height: box, borderRadius: 10, background: `linear-gradient(145deg, ${bg}, ${bg}cc)`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: box * 0.36, flex: "0 0 auto", boxShadow: `0 5px 16px -5px ${bg}99` }}>{initials}</div>
  );
};

const PHASE_META = ["Stage 1 of 4 · Kickoff", "Stage 2 of 4 · Shooting", "Stage 3 of 4 · Editing", "Stage 4 of 4 · Review"];

// Every video approved → the posting-schedule surface is meaningful.
function allApprovedDetail(d) {
  const c = d?.deliveries?.counts || {};
  return (c.total || 0) > 0 && c.approved === c.total;
}

// The project page IS the videos (no Deliveries tab — per Jeremy,
// 2026-06-13). Pre-production and Posting schedule open as their own
// views via quiet links, with a back-to-videos affordance. The view
// lives in the URL (/clients/p/{id}[/preprod|/schedule]) so dashboard
// quick-link chips can deep-link and back/refresh behave.
export function ProjectView({ projectShortId, view = "videos", onViewChange = () => {}, user, theme, onTheme, onSignOut, onBack, onNav, authFetch }) {
  const narrow = useIsNarrow();
  const setView = onViewChange;
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState({ loading: true, error: "", data: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", data: null });
    (async () => {
      try {
        const r = await authFetch(`/api/client/project?id=${encodeURIComponent(projectShortId)}`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setState({ loading: false, error: j.error || `Error ${r.status}`, data: null }); return; }
        setState({ loading: false, error: "", data: j });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message || "Network error", data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch, projectShortId]);

  const d = state.data;

  let inner;
  if (state.loading) {
    inner = <div style={{ padding: 80, textAlign: "center", color: "var(--text-3)" }}><ViewixLogo size={24} style={{ margin: "0 auto 14px" }} />Loading project...</div>;
  } else if (state.error) {
    inner = (
      <div style={{ padding: 80, textAlign: "center", color: "var(--text-2)" }}>
        We couldn't open this project.
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>{state.error}</div>
        <button onClick={onBack} style={{ marginTop: 16, color: "var(--accent)", fontWeight: 600, fontSize: 13 }}>← Back to projects</button>
      </div>
    );
  } else {
    const ready = d.deliveries?.counts?.ready || 0;
    const totalV = d.deliveries?.counts?.total || 0;
    inner = (
      <>
        {/* Header */}
        <div style={{ padding: narrow ? "14px 16px" : "24px 32px", borderBottom: "1px solid var(--line)", background: "var(--surface)", display: "flex", alignItems: "center", gap: narrow ? 12 : 18, flexWrap: "wrap" }}>
          {!narrow && (
            <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 8, color: "var(--text-3)", fontSize: 13, border: "1px solid var(--line)", background: "var(--bg-2)" }}><Icon.back /> Projects</button>
          )}
          <ClientMark name={d.orgName} logo={d.logo} box={narrow ? 40 : 56} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ margin: 0, fontSize: narrow ? 18 : 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--heading)" }}>{d.projectName}</h1>
              <Pill tone={d.status === "archived" ? "muted" : "blue"}>{d.status === "archived" ? "Delivered" : "In progress"}</Pill>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, color: "var(--text-3)", fontSize: 13, flexWrap: "wrap" }}>
              <span>{d.orgName}</span><span>·</span><span>{d.productLine || "Project"}</span>
            </div>
          </div>
          {d.deliveries?.available && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--bg-2)" }}>
              <div><Label style={{ fontSize: 10 }}>Ready</Label><div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{ready}<span style={{ color: "var(--text-3)" }}>/{totalV}</span></div></div>
            </div>
          )}
        </div>

        {/* Phase strip */}
        <div style={{ padding: narrow ? "16px 16px 22px" : "22px 32px 26px", background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            {!narrow && <Label style={{ fontSize: 10 }}>Project stage</Label>}
            <div style={{ flex: 1, maxWidth: 560 }}><PhaseTrack current={d.phase} compact={narrow} /></div>
            {!narrow && <><div style={{ flex: 1 }} /><span className="mono" style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase" }}>{PHASE_META[d.phase] || ""}</span></>}
          </div>
        </div>

        {view === "videos" ? (
          <>
            {/* Quiet links to the project's other surfaces. Pre-production
                shows only when a review is actually linked; Posting
                schedule shows only once every video is approved (it's
                empty/meaningless before then). The bar hides entirely
                when neither qualifies. */}
            {(() => {
              const links = [
                d.preproduction?.available && { k: "preprod", label: "Pre-production", icon: <Icon.doc /> },
                allApprovedDetail(d) && { k: "schedule", label: "Posting schedule", icon: <Icon.cal /> },
              ].filter(Boolean);
              if (!links.length) return null;
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: narrow ? "12px 16px 0" : "16px 32px 0", flexWrap: "wrap" }}>
                  {links.map(l => (
                    <button key={l.k} onClick={() => setView(l.k)} style={{
                      display: "inline-flex", alignItems: "center", gap: 8,
                      padding: "8px 14px", borderRadius: 999,
                      border: "1px solid var(--line)", background: "var(--surface)",
                      color: "var(--text-2)", fontSize: 13, fontWeight: 500,
                    }}>
                      {l.icon} {l.label} <Icon.arrow style={{ color: "var(--text-3)" }} />
                    </button>
                  ))}
                </div>
              );
            })()}
            <Deliveries deliveries={d.deliveries ? { ...d.deliveries, orgName: d.orgName } : null} accountManager={d.accountManager} narrow={narrow} />
          </>
        ) : (
          <>
            <div style={{ padding: narrow ? "12px 16px 0" : "16px 32px 0" }}>
              <button onClick={() => setView("videos")} style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "8px 14px", borderRadius: 999,
                border: "1px solid var(--line)", background: "var(--bg-2)",
                color: "var(--text-2)", fontSize: 13, fontWeight: 500,
              }}>
                <Icon.back /> Back to videos
              </button>
            </div>
            {view === "preprod" && <PreProduction preproduction={d.preproduction} narrow={narrow} />}
            {view === "schedule" && <PostingSchedule projectShortId={projectShortId} authFetch={authFetch} narrow={narrow} />}
          </>
        )}
      </>
    );
  }

  const brand = d ? { name: d.orgName, logo: d.logo } : null;

  if (narrow) {
    return (
      <MobileShell user={user} brand={brand} title={d?.projectName || "Project"} back onBack={onBack} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} onSignOut={onSignOut} activeTab="Projects" onNav={onNav}>
        {inner}
      </MobileShell>
    );
  }
  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <PortalNav
        active="Projects" user={user} brand={brand} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)}
        onSignOut={onSignOut} onNav={onNav}
        context={d ? (<><span style={{ color: "var(--text-3)", cursor: "pointer" }} onClick={onBack}>{d.orgName}</span><span style={{ color: "var(--text-4)" }}>/</span><span style={{ color: "var(--text)" }}>{d.projectName}</span></>) : null}
      />
      <div className="vx-scroll" style={{ flex: 1, overflow: "auto" }}>{inner}</div>
    </div>
  );
}
