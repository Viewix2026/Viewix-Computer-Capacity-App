import { useEffect, useState } from "react";
import {
  PortalNav, MobileShell, SectionTag, Label, Pill, PhaseTrack,
  BtnPrimary, BtnGhost, Icon, ViewixLogo, useIsNarrow,
} from "./ui";
import { AccountManagerCard, AmAvatar } from "./AccountManagerCard";

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

const STATUS_TONE = { active: "blue", archived: "muted" };
function statusLabel(p) {
  if (p.status === "archived") return "Delivered";
  if (cutsWaiting(p)) return "Needs your review";
  return ["Kickoff", "On set", "In editing", "In review"][p.phase] || "In progress";
}

const PHASE_NAMES = ["Kickoff", "Shooting", "Editing", "Review"];

// Cuts actually awaiting the client on a project. The server computes
// counts.waiting per video (delivered AND latest revision response is
// neither Approved nor Need Revisions — see api/_clientRedact.js).
// The subtraction fallback covers a stale API response only; it can
// undercount toggled-back videos, never overcount.
function cutsWaiting(p) {
  const c = p.counts || {};
  if (typeof c.waiting === "number") return c.waiting;
  return p.needsYou ? Math.max((c.ready || 0) - (c.approved || 0), 0) : 0;
}

// Dense desktop row (design v2: one line per project — client mark ·
// name · phase · videos · quick links · CTA; the AM avatar left the
// rows as redundant with the rail card). The whole row opens the
// project, which lands directly on its videos.
//
// Quick-link chip into a project sub-view. Real <a> so middle-click /
// long-press work; SPA-navigated via onGo. stopPropagation: the row
// div also navigates.
function QuickChip({ icon, label, href, onGo, stacked }) {
  return (
    <a
      href={href}
      title={label}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); e.stopPropagation(); onGo(); }}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: stacked ? "5px 9px" : "7px 11px", borderRadius: 8,
        border: "1px solid var(--line)", background: "var(--bg-2)",
        color: "var(--text-2)", fontSize: stacked ? 11.5 : 12, fontWeight: 600,
        textDecoration: "none", whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: "var(--accent)", display: "inline-flex" }}>{icon}</span>
      {label}
    </a>
  );
}

function ProjectRow({ p, onOpen, onOpenView, mid }) {
  const waiting = cutsWaiting(p);
  const chips = (
    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: mid ? "column" : "row", gap: 6, alignItems: mid ? "stretch" : "center" }}>
      <QuickChip icon={<Icon.doc />} label="Pre-prod" href={`/clients/p/${p.projectId}/preprod`} onGo={() => onOpenView("preprod")} stacked={mid} />
      <QuickChip icon={<Icon.cal />} label="Schedule" href={`/clients/p/${p.projectId}/schedule`} onGo={() => onOpenView("schedule")} stacked={mid} />
    </div>
  );
  return (
    <div onClick={onOpen} style={{
      display: "grid",
      gridTemplateColumns: mid ? "48px minmax(160px, 1fr) 180px 70px 90px 150px" : "56px minmax(180px, 1fr) 200px 70px 190px 150px",
      alignItems: "center", gap: mid ? 14 : 16,
      padding: mid ? "16px 18px" : "18px 20px",
      background: waiting ? "rgba(0,130,250,0.025)" : "transparent",
      cursor: "pointer",
    }}>
      <ClientMark name={p.orgName} size="sm" />

      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.projectName}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>{p.orgName}</span>
          {p.productLine && (
            <>
              <span style={{ color: "var(--line-3)" }}>·</span>
              <Label style={{ fontSize: 10 }}>{p.productLine}</Label>
            </>
          )}
        </div>
      </div>

      <div style={{ paddingBottom: 4 }}>
        <PhaseTrack current={p.phase} compact />
        <Label color="var(--text-3)" style={{ fontSize: 9, display: "block", marginTop: 6 }}>
          {PHASE_NAMES[p.phase] || ""}
        </Label>
      </div>

      <div>
        <Label style={{ fontSize: 9 }}>Videos</Label>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginTop: 2, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
          {p.counts?.ready || 0}<span style={{ color: "var(--text-3)" }}>/{p.counts?.total || 0}</span>
        </div>
      </div>

      {chips}

      <div style={{ justifySelf: "end" }}>
        {/* stopPropagation: the row div also navigates — without it a
            CTA click pushes the same history entry twice and Back
            appears dead. The real <button> stays for keyboard users. */}
        {waiting
          ? <BtnPrimary style={{ height: 38, fontSize: 13, whiteSpace: "nowrap" }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>Review {waiting} {waiting === 1 ? "cut" : "cuts"}</BtnPrimary>
          : <BtnGhost style={{ height: 38, fontSize: 13 }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>Open <Icon.arrow /></BtnGhost>}
      </div>
    </div>
  );
}

function ProjectCard({ p, onOpen, narrow }) {
  return (
    <div style={{ position: "relative", padding: narrow ? "16px 16px 14px" : "24px 24px 22px", borderRadius: 16, border: "1px solid var(--line)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: narrow ? 12 : 18, overflow: "hidden", boxShadow: "0 1px 0 rgba(15,18,26,0.02)" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: cutsWaiting(p) ? "var(--warn)" : "var(--accent)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ClientMark name={p.orgName} size="sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Label color="var(--text-3)" style={{ fontSize: 10 }}>{p.orgName}</Label>
          <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 8, fontWeight: 600 }}>{p.productLine || ""}</span>
        </div>
        <Pill tone={cutsWaiting(p) ? "amber" : STATUS_TONE[p.status] || "muted"}>{statusLabel(p)}</Pill>
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
            {p.counts?.ready || 0}<span style={{ color: "var(--text-3)" }}>/{p.counts?.total || 0}</span>
          </div>
        </div>
        <div>
          <Label style={{ fontSize: 10 }}>Approved</Label>
          <div style={{ fontSize: narrow ? 16 : 22, fontWeight: 700, marginTop: 6, letterSpacing: "-0.01em", color: "var(--text)" }}>
            {p.counts?.approved || 0}<span style={{ color: "var(--text-3)" }}>/{p.counts?.total || 0}</span>
          </div>
        </div>
        {!narrow && (
          <div>
            <Label style={{ fontSize: 10 }}>Posted</Label>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6, letterSpacing: "-0.01em", color: "var(--text)" }}>
              {p.counts?.posted || 0}<span style={{ color: "var(--text-3)" }}>/{p.counts?.total || 0}</span>
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
        {cutsWaiting(p)
          ? <BtnPrimary style={{ height: 38, fontSize: 13 }} onClick={onOpen}><Icon.spark /> Review {cutsWaiting(p)} {cutsWaiting(p) === 1 ? "cut" : "cuts"}</BtnPrimary>
          : <BtnGhost style={{ height: 38, fontSize: 13 }} onClick={onOpen}><Icon.film /> Open</BtnGhost>}
      </div>
    </div>
  );
}

function DashboardBody({ data, narrow, onOpenProject }) {
  // 900-1440: single column, tighter rows with stacked chips. The
  // two-col grid (content + 340px rail) only fits the full row grid
  // from 1440 up; the earlier 1280 cutoff left a 1280-1375 overflow
  // band.
  const mid = useIsNarrow(1440);
  const projects = data?.projects || [];
  const active = projects.filter(p => p.status !== "archived");
  const archived = projects.filter(p => p.status === "archived");
  const waiting = active.reduce((n, p) => n + cutsWaiting(p), 0);
  const am =
    active.find(p => p.accountManager?.name)?.accountManager ||
    projects.find(p => p.accountManager?.name)?.accountManager || null;
  const first = (data?.displayName || "there").split(/[ @]/)[0];
  const first0 = first.charAt(0).toUpperCase() + first.slice(1);

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

  const waitingCuts = waiting;
  const waitingProjects = active.filter(p => cutsWaiting(p) > 0).sort((a, b) => cutsWaiting(b) - cutsWaiting(a));
  const topWaiting = waitingProjects[0] || null;
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const archivedList = archived.length > 0 && (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: narrow ? "0 0 12px" : "28px 0 14px" }}>
        <SectionTag n={active.length ? "02" : "01"}>Delivered & archived</SectionTag>
        <Label style={{ fontSize: 10 }}>{archived.length} wrapped</Label>
      </div>
      <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--surface)" }}>
        {archived.map((p, i) => {
          const total = p.counts?.total || 0;
          return (
            <div
              key={p.projectId}
              role="button" tabIndex={0}
              onClick={() => onOpenProject(p.projectId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenProject(p.projectId); } }}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: narrow ? "14px 14px" : "14px 24px", borderTop: i ? "1px solid var(--line)" : "none", cursor: "pointer" }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: narrow ? 13 : 14, fontWeight: 600, color: "var(--text)" }}>{p.projectName}</div>
                <div style={{ fontSize: narrow ? 11 : 12, color: "var(--text-3)", marginTop: 2 }}>{p.orgName} · {total} {total === 1 ? "video" : "videos"}</div>
              </div>
              <Icon.arrow style={{ color: "var(--text-3)" }} />
            </div>
          );
        })}
      </div>
    </>
  );

  // Mobile keeps the design's mobile shape: merged greeting, compact
  // 2x2 stats, AM card high, card stack, delivered list. (Desktop
  // dropped the stat strip for the action banner, so stats are
  // mobile-only.)
  if (narrow) {
    const stats = [
      { lbl: "Waiting on you", val: String(waiting), sub: waiting ? "Cuts to review" : "All caught up", tone: waiting ? "amber" : null },
      { lbl: "In progress", val: String(active.length), sub: "Active projects" },
      { lbl: "Delivered", val: String(archived.length), sub: "Wrapped" },
      { lbl: "Total videos", val: String(projects.reduce((n, p) => n + (p.counts?.total || 0), 0)), sub: "Across all projects" },
    ];
    return (
      <>
        <div style={{ padding: "20px 20px 12px" }}>
          <Label>{dateLine}</Label>
          <h1 style={{ margin: "8px 0 0", fontSize: 24, fontWeight: 600, letterSpacing: "-0.025em", color: "var(--heading)" }}>
            Hi {first0} - <span style={{ color: "var(--text-3)" }}>{waitingCuts ? `${waitingCuts} ${waitingCuts === 1 ? "cut" : "cuts"} waiting on you.` : "you're all caught up."}</span>
          </h1>
        </div>
        <div style={{ padding: "16px 20px 32px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", marginBottom: 20, border: "1px solid var(--line)", borderRadius: 14, background: "var(--surface)", overflow: "hidden" }}>
            {stats.map((s, i) => (
              <div key={i} style={{ padding: "16px 16px", borderLeft: i % 2 ? "1px solid var(--line)" : "none", borderTop: i >= 2 ? "1px solid var(--line)" : "none" }}>
                <Label style={{ fontSize: 9 }}>{s.lbl}</Label>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 4, letterSpacing: "-0.01em", color: s.tone === "amber" ? "var(--warn)" : "var(--heading)" }}>{s.val}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 20 }}><AccountManagerCard am={am} /></div>

          {active.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <SectionTag n="01">In progress</SectionTag>
                <Label style={{ fontSize: 10 }}>{active.length} {active.length === 1 ? "project" : "projects"}</Label>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
                {active.map(p => <ProjectCard key={p.projectId} p={p} narrow onOpen={() => onOpenProject(p.projectId)} />)}
              </div>
            </>
          )}

          {archivedList}
        </div>
      </>
    );
  }

  // Desktop — the design's dense layout: compact greeting, one action
  // banner only when cuts are waiting (no stat strip), project rows in
  // a single bordered list, delivered directly below, AM rail right.
  return (
    <>
      <div style={{ padding: "28px 40px 0" }}>
        <Label>{dateLine}</Label>
        <h1 style={{ margin: "6px 0 0", fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--heading)" }}>
          Hi {first0}
        </h1>

        {topWaiting && (
          <div style={{
            marginTop: 20, padding: "16px 20px", borderRadius: 14,
            border: "1px solid var(--accent-line)",
            background: "linear-gradient(90deg, rgba(0,130,250,0.07), rgba(0,130,250,0.02))",
            display: "flex", alignItems: "center", gap: 16,
          }}>
            <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent)", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}><Icon.film /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--heading)" }}>
                {waitingCuts} {waitingCuts === 1 ? "cut is" : "cuts are"} waiting on your review
              </div>
              <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {topWaiting.orgName} · {topWaiting.projectName}{waitingProjects.length > 1 ? ` and ${waitingProjects.length - 1} more ${waitingProjects.length === 2 ? "project" : "projects"}` : ""}
              </div>
            </div>
            <BtnPrimary style={{ height: 40, whiteSpace: "nowrap" }} onClick={() => onOpenProject(topWaiting.projectId)}>
              Review now <Icon.arrow />
            </BtnPrimary>
          </div>
        )}
      </div>

      <div style={{ padding: "28px 40px 24px", display: "grid", gridTemplateColumns: mid ? "1fr" : "1fr 340px", gap: 28, alignItems: "flex-start" }}>
        <div>
          {active.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <SectionTag n="01">In progress</SectionTag>
                <Label style={{ fontSize: 10 }}>{active.length} {active.length === 1 ? "project" : "projects"}</Label>
              </div>
              <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--surface)", boxShadow: "0 1px 0 rgba(15,18,26,0.02)" }}>
                {active.map((p, i) => (
                  <div key={p.projectId} style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                    <ProjectRow p={p} mid={mid} onOpen={() => onOpenProject(p.projectId)} onOpenView={(v) => onOpenProject(p.projectId, v)} />
                  </div>
                ))}
              </div>
            </>
          )}

          {archivedList}
        </div>

        {mid
          ? <div style={{ maxWidth: 420 }}><AccountManagerCard am={am} /></div>
          : (
            <aside style={{ display: "flex", flexDirection: "column", gap: 18, position: "sticky", top: 24, zIndex: 1 }}>
              <AccountManagerCard am={am} />
            </aside>
          )}
      </div>
      <div style={{ height: 32 }} />
    </>
  );
}

export function Dashboard({ user, theme, onTheme, onSignOut, onOpenProject, onNav, authFetch }) {
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
      <MobileShell user={user} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut} activeTab="Projects" onNav={onNav}>
        {inner}
      </MobileShell>
    );
  }
  return (
    <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <PortalNav active="Projects" user={user} menuOpen={menuOpen} onMenu={() => setMenuOpen(o => !o)} theme={theme} onTheme={onTheme} onSignOut={onSignOut} onNav={onNav} />
      <div className="vx-scroll" style={{ flex: 1, overflow: "auto" }}>{inner}</div>
    </div>
  );
}
