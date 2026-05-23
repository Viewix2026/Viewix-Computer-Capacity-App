import { useEffect, useState } from "react";
import {
  PortalNav, MobileShell, SectionTag, Label, Pill, PhaseTrack,
  BtnPrimary, BtnGhost, Icon, ManagerPhoto, ViewixLogo, useIsNarrow,
} from "./ui";

// Deterministic brand block from the org name (we have no per-client
// logo assets — initials on a stable colour is the robust substitute).
function clientColor(name) {
  const palette = ["#0082fa", "#f87700", "#1b9b6e", "#7c3aed", "#c2410c", "#0a3c3a", "#be123c"];
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
const ClientMark = ({ name, size = "sm" }) => {
  const box = size === "sm" ? 44 : 64;
  const initials = (String(name || "?").match(/\b\w/g) || ["?"]).slice(0, 2).join("").toUpperCase();
  const bg = clientColor(name);
  return (
    <div style={{
      width: box, height: box, borderRadius: 10, background: bg, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 800, fontSize: box * 0.36, letterSpacing: "0.02em",
      flex: "0 0 auto", boxShadow: `0 4px 14px -4px ${bg}88`,
    }}>{initials}</div>
  );
};

const AmAvatar = ({ am, size = 32 }) => {
  const initials = (String(am?.name || "VX").match(/\b\w/g) || ["V"]).slice(0, 2).join("").toUpperCase();
  return am?.photo ? (
    <img src={am.photo} alt={am.name} style={{ width: size, height: size, borderRadius: 999, objectFit: "cover", border: "2px solid var(--surface)", boxShadow: "0 0 0 1px var(--line-2)" }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: 999, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", fontSize: size * 0.4, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "2px solid var(--surface)", boxShadow: "0 0 0 1px var(--line-2)" }}>{initials}</div>
  );
};

const STATUS_TONE = { active: "blue", archived: "muted" };
function statusLabel(p) {
  if (p.status === "archived") return "Delivered";
  if (p.needsYou) return "Needs your review";
  return ["Kickoff", "On set", "In editing", "In review"][p.phase] || "In progress";
}

function ProjectCard({ p, onOpen, narrow }) {
  return (
    <div style={{ position: "relative", padding: narrow ? "16px 16px 14px" : "24px 24px 22px", borderRadius: 16, border: "1px solid var(--line)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: narrow ? 12 : 18, overflow: "hidden", boxShadow: "0 1px 0 rgba(15,18,26,0.02)" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: p.needsYou ? "var(--warn)" : "var(--accent)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ClientMark name={p.orgName} size="sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Label color="var(--text-3)" style={{ fontSize: 10 }}>{p.orgName}</Label>
          <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 8, fontWeight: 600 }}>{p.productLine || ""}</span>
        </div>
        <Pill tone={p.needsYou ? "amber" : STATUS_TONE[p.status] || "muted"}>{statusLabel(p)}</Pill>
      </div>

      <h3 style={{ margin: 0, fontSize: narrow ? 18 : 22, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--heading)", lineHeight: 1.25 }}>
        {p.projectName}
      </h3>

      <div style={{ padding: "2px 2px 26px" }}>
        <PhaseTrack current={p.phase} compact={narrow} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "1fr 1fr 1fr", borderTop: "1px solid var(--line)", paddingTop: 16, gap: 10 }}>
        <div>
          <Label style={{ fontSize: 10 }}>Deliveries</Label>
          <div style={{ fontSize: narrow ? 16 : 22, fontWeight: 700, marginTop: 6, letterSpacing: "-0.01em", color: "var(--text)" }}>
            {p.counts.ready}<span style={{ color: "var(--text-3)" }}>/{p.counts.total}</span>
          </div>
        </div>
        <div>
          <Label style={{ fontSize: 10 }}>Approved</Label>
          <div style={{ fontSize: narrow ? 16 : 22, fontWeight: 700, marginTop: 6, letterSpacing: "-0.01em", color: "var(--text)" }}>
            {p.counts.approved}<span style={{ color: "var(--text-3)" }}>/{p.counts.total}</span>
          </div>
        </div>
        {!narrow && (
          <div>
            <Label style={{ fontSize: 10 }}>Posted</Label>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6, letterSpacing: "-0.01em", color: "var(--text)" }}>
              {p.counts.posted}<span style={{ color: "var(--text-3)" }}>/{p.counts.total}</span>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AmAvatar am={p.accountManager} size={narrow ? 26 : 32} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <Label style={{ fontSize: 9 }}>Account manager</Label>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginTop: 1 }}>{p.accountManager?.name || "Viewix team"}</span>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {p.needsYou
          ? <BtnPrimary style={{ height: 38, fontSize: 13 }} onClick={onOpen}><Icon.spark /> Review</BtnPrimary>
          : <BtnGhost style={{ height: 38, fontSize: 13 }} onClick={onOpen}><Icon.film /> Open</BtnGhost>}
      </div>
    </div>
  );
}

function AccountManagerCard({ am }) {
  const name = am?.name || "Your Viewix team";
  return (
    <div style={{ position: "relative", padding: 24, borderRadius: 16, border: "1px solid var(--line)", background: "var(--surface)", boxShadow: "0 1px 0 rgba(15,18,26,0.02)", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--orange) 0%, var(--accent) 100%)" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <Label style={{ fontSize: 10 }}>Your account manager</Label>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ok)" }}>
          <span className="vx-dot live-pulse" /><span className="mono" style={{ letterSpacing: "0.05em", textTransform: "uppercase" }}>Here for you</span>
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {am?.photo
          ? <img src={am.photo} alt={name} style={{ width: 72, height: 72, borderRadius: 16, objectFit: "cover" }} />
          : <ManagerPhoto size={72} initials={(name.match(/\b\w/g) || ["V"]).slice(0, 2).join("").toUpperCase()} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--text)" }}>{name}</div>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 2 }}>Viewix Studio</div>
        </div>
      </div>
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {am?.phone && (
          <a href={`tel:${String(am.phone).replace(/\s/g, "")}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)", textDecoration: "none" }}>
            <span style={{ color: "var(--accent)" }}><Icon.phone /></span>
            <div style={{ flex: 1, minWidth: 0 }}><Label style={{ fontSize: 10 }}>Phone</Label><div className="mono" style={{ fontSize: 14, color: "var(--text)", marginTop: 2 }}>{am.phone}</div></div>
            <Icon.arrow style={{ color: "var(--text-3)" }} />
          </a>
        )}
        <a href={`mailto:${am?.email || "hello@viewix.com.au"}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)", textDecoration: "none" }}>
          <span style={{ color: "var(--accent)" }}><Icon.mail /></span>
          <div style={{ flex: 1, minWidth: 0 }}><Label style={{ fontSize: 10 }}>Email</Label><div className="mono" style={{ fontSize: 14, color: "var(--text)", marginTop: 2 }}>{am?.email || "hello@viewix.com.au"}</div></div>
          <Icon.arrow style={{ color: "var(--text-3)" }} />
        </a>
      </div>
      {am?.bookingUrl && (
        <a href={am.bookingUrl} target="_blank" rel="noopener" style={{ textDecoration: "none", display: "block", marginTop: 14 }}>
          <BtnPrimary style={{ width: "100%", height: 48 }}>
            <Icon.cal /> Book a call with {String(name).split(" ")[0]}
            <span style={{ marginLeft: "auto", opacity: 0.85 }}><Icon.external /></span>
          </BtnPrimary>
        </a>
      )}
    </div>
  );
}

function DashboardBody({ data, narrow, onOpenProject }) {
  const projects = data?.projects || [];
  const active = projects.filter(p => p.status !== "archived");
  const archived = projects.filter(p => p.status === "archived");
  const waiting = active.filter(p => p.needsYou).length;
  const am =
    active.find(p => p.accountManager?.name)?.accountManager ||
    projects.find(p => p.accountManager?.name)?.accountManager || null;
  const first = (data?.displayName || "there").split(/[ @]/)[0];
  const first0 = first.charAt(0).toUpperCase() + first.slice(1);

  const stats = [
    { lbl: "Waiting on you", val: String(waiting), sub: waiting ? "Cuts to review" : "All caught up", tone: waiting ? "amber" : null },
    { lbl: "In progress", val: String(active.length), sub: "Active projects" },
    { lbl: "Delivered", val: String(archived.length), sub: "Wrapped" },
    { lbl: "Total videos", val: String(projects.reduce((n, p) => n + (p.counts?.total || 0), 0)), sub: "Across all projects" },
  ];

  if (projects.length === 0) {
    return (
      <div style={{ padding: narrow ? "28px 20px" : "48px 40px" }}>
        <Label>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</Label>
        <h1 style={{ margin: "8px 0 0", fontSize: narrow ? 26 : 42, fontWeight: 600, letterSpacing: "-0.025em", color: "var(--heading)" }}>Welcome, {first0}.</h1>
        <p style={{ margin: "12px 0 28px", fontSize: 16, color: "var(--text-2)", maxWidth: 620, lineHeight: 1.55 }}>
          Your projects will land here as soon as we kick them off. Your account manager has you - we'll be working together before you know it.
        </p>
        <div style={{ maxWidth: 420 }}><AccountManagerCard am={am} /></div>
      </div>
    );
  }

  return (
    <>
      <div style={{ padding: narrow ? "20px 20px 12px" : "40px 40px 28px", borderBottom: "1px solid var(--line)" }}>
        <Label>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</Label>
        <h1 style={{ margin: "8px 0 0", fontSize: narrow ? 24 : 42, fontWeight: 600, letterSpacing: "-0.025em", color: "var(--heading)" }}>
          Hi {first0} - <span style={{ color: "var(--text-3)" }}>{waiting ? `${waiting} ${waiting === 1 ? "cut" : "cuts"} waiting on you.` : "you're all caught up."}</span>
        </h1>
      </div>

      <div style={{ padding: narrow ? "16px 20px 8px" : "36px 40px 24px", display: narrow ? "block" : "grid", gridTemplateColumns: "1fr 360px", gap: 32, alignItems: "flex-start" }}>
        <div>
          <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "repeat(4, 1fr)", marginBottom: narrow ? 20 : 36, border: "1px solid var(--line)", borderRadius: 14, background: "var(--surface)", overflow: "hidden" }}>
            {stats.map((s, i) => (
              <div key={i} style={{ padding: "20px 22px", borderLeft: !narrow && i ? "1px solid var(--line)" : "none", borderTop: narrow && i >= 2 ? "1px solid var(--line)" : "none" }}>
                <Label style={{ fontSize: 10 }}>{s.lbl}</Label>
                <div className="mono" style={{ fontSize: 30, fontWeight: 500, marginTop: 8, letterSpacing: "-0.02em", color: s.tone === "amber" ? "var(--warn)" : "var(--text)" }}>{s.val}</div>
                <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          {narrow && <div style={{ marginBottom: 20 }}><AccountManagerCard am={am} /></div>}

          {active.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <SectionTag n="01">In progress</SectionTag>
                <Label style={{ fontSize: 11 }}>{active.length} {active.length === 1 ? "project" : "projects"}</Label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 18, marginBottom: 36 }}>
                {active.map(p => <ProjectCard key={p.projectId} p={p} narrow={narrow} onOpen={() => onOpenProject(p.projectId)} />)}
              </div>
            </>
          )}

          {archived.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <SectionTag n="02">Delivered & archived</SectionTag>
                <Label style={{ fontSize: 11 }}>{archived.length} wrapped</Label>
              </div>
              <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--surface)", marginBottom: 40 }}>
                {archived.map((p, i) => (
                  <div key={p.projectId} onClick={() => onOpenProject(p.projectId)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderTop: i ? "1px solid var(--line)" : "none", cursor: "pointer" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{p.projectName}</div>
                      <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{p.orgName} · {p.counts.total} videos</div>
                    </div>
                    <Icon.arrow style={{ color: "var(--text-3)" }} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {!narrow && (
          <aside style={{ display: "flex", flexDirection: "column", gap: 18, position: "sticky", top: 24, zIndex: 1 }}>
            <AccountManagerCard am={am} />
          </aside>
        )}
      </div>
    </>
  );
}

export function Dashboard({ user, theme, onTheme, onSignOut, onOpenProject, authFetch }) {
  const narrow = useIsNarrow();
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", data: null });
    (async () => {
      try {
        const r = await authFetch("/api/client/projects");
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setState({ loading: false, error: j.error || `Error ${r.status}`, data: null }); return; }
        setState({ loading: false, error: "", data: j });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message || "Network error", data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch, user]);

  const noAccess = !state.loading && !state.error && state.data && (state.data.projects || []).length === 0 && !state.data.displayName;

  let inner;
  if (state.loading) {
    inner = <div style={{ padding: 80, textAlign: "center", color: "var(--text-3)" }}><ViewixLogo size={24} style={{ margin: "0 auto 14px" }} />Loading your projects...</div>;
  } else if (state.error) {
    inner = <div style={{ padding: 80, textAlign: "center", color: "var(--text-2)" }}>We couldn't load your projects.<div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>{state.error}</div></div>;
  } else if (noAccess) {
    inner = (
      <div style={{ padding: narrow ? "48px 24px" : "80px 40px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", color: "var(--accent)" }}><Icon.shield /></div>
        <h2 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 600, color: "var(--heading)" }}>No projects linked yet</h2>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
          Your email isn't linked to a project yet. If you're expecting access, reach out to your Viewix account manager or message{" "}
          <span style={{ color: "var(--accent)" }}>hello@viewix.com.au</span> and we'll sort it straight away.
        </p>
      </div>
    );
  } else {
    inner = <DashboardBody data={state.data} narrow={narrow} onOpenProject={onOpenProject} />;
  }

  if (narrow) {
    return (
      <MobileShell user={user} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut}>
        {inner}
      </MobileShell>
    );
  }
  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <PortalNav active="Projects" user={user} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut} />
      <div className="vx-scroll" style={{ flex: 1, overflow: "auto" }}>{inner}</div>
    </div>
  );
}
