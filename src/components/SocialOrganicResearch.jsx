// Social Media Organic — Competitor Intelligence Research + Producer Workflow
// Producers research overperforming Instagram content in a client's niche,
// then walk the project through five stages: Scrape → Review → Shortlist →
// Select → Script. The final Script stage produces a Picup-Media-style
// pre-production doc with per-cell AI rewrite affordances.
//
// Lives inside the Pre-Production tab's "Social Media Organic" sub-tab.
// Data shape at /preproduction/socialOrganic/{projectId}. The legacy
// `synthesis` field on old projects is preserved but unused.

import { useState, useEffect, useRef, memo } from "react";
import { authFetch, fbSet, fbSetAsync, fbUpdate, fbListenSafe, getCurrentRole } from "../firebase";
import { logoBg, makeShortId, matchSherpaClientRecord, preproductionShareUrl } from "../utils";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { SocialOrganicSelect } from "./SocialOrganicSelect";
import { CellRewriteModal, Clickable, EditableField } from "./shared/CellRewriteModal";
import { DescriptionField } from "./shared/DescriptionField";
import { ReelPreview } from "./shared/ReelPreview";
import { SherpaStatusRow } from "./shared/SherpaStatusRow";

// Read a fetch Response as JSON, but fall back gracefully when the
// body isn't actually JSON. Vercel timeout pages, gateway 502/504
// errors, and unhandled exceptions all return plain text or HTML
// starting with "An error occurred…" — calling r.json() on that
// throws "Unexpected token 'A' is not valid JSON" which is useless
// to producers. This helper surfaces the actual response so they
// see "HTTP 504 — An error occurred with this application…" and
// know to retry / report.
async function readJsonResponse(r) {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const preview = text.slice(0, 240).replace(/\s+/g, " ").trim();
    throw new Error(r.ok
      ? `Server returned non-JSON response: ${preview}`
      : `HTTP ${r.status} — ${preview || "request failed"}`);
  }
}

// ─── Constants ───
const STATUS_COLORS = {
  draft:        { bg: "rgba(90,107,133,0.15)",  fg: "#5A6B85" },
  scraping:     { bg: "rgba(59,130,246,0.15)",  fg: "#3B82F6" },
  classifying:  { bg: "rgba(139,92,246,0.15)",  fg: "#8B5CF6" },
  review:       { bg: "rgba(34,197,94,0.15)",   fg: "#22C55E" },
  archived:     { bg: "rgba(90,107,133,0.15)",  fg: "#5A6B85" },
};
const STATUS_LABELS = {
  draft: "Draft", scraping: "Scraping", classifying: "Classifying",
  review: "Review", archived: "Archived",
};

const FORMAT_LABELS = {
  talking_head:    "Talking Head",
  skit:            "Skit",
  tutorial:        "Tutorial",
  vo_broll:        "VO + B-roll",
  transformation:  "Transformation",
  ugc_testimonial: "UGC / Testimonial",
  listicle:        "Listicle",
  trend:           "Trend",
  product_demo:    "Product Demo",
  other:           "Other",
};

// Default scrape knobs — deliberately conservative. Hard-capped server-side.
const DEFAULTS = {
  postsPerHandle: 30,  // max 50
  maxHandles: 5,
  dateRangeDays: 180,
};

// ─── Shared styles ───
const inputSt = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "inherit", width: "100%",
};
const btnPrimary = {
  padding: "8px 18px", borderRadius: 8, border: "none", background: "var(--accent)",
  color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary = {
  padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)",
  background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600,
  cursor: "pointer", fontFamily: "inherit",
};

function Badge({ text, colors }) {
  return (
    <span style={{
      padding: "2px 10px", borderRadius: 10, fontSize: 11, fontWeight: 700,
      background: colors?.bg || "#333", color: colors?.fg || "#999",
    }}>{text}</span>
  );
}

// Normalise whatever the user typed into a clean @handle
function normaliseHandle(raw) {
  if (!raw) return "";
  let s = raw.trim();
  // Strip full URLs
  const urlMatch = s.match(/instagram\.com\/([^/?#]+)/i);
  if (urlMatch) s = urlMatch[1];
  s = s.replace(/^@+/, "").replace(/\/$/, "");
  return s ? `@${s.toLowerCase()}` : "";
}

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

// Default ISO date range from today - days → today
function defaultRange(days = DEFAULTS.dateRangeDays) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

// ═══════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════
// `creating` + `onCreatingChange` are optional — when Preproduction.jsx
// provides them, the parent owns the "new project" modal so the trigger
// button can live in the top header (matching the Meta Ads layout).
// When they're omitted the component falls back to local state so this
// file stays standalone-usable.
export function SocialOrganicResearch({ accounts, clients, sherpaCacheMeta, creating: creatingProp, onCreatingChange, deepLinkProjectId }) {
  const [projects, setProjects] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [creatingLocal, setCreatingLocal] = useState(false);
  const creating = creatingProp !== undefined ? creatingProp : creatingLocal;
  const setCreating = onCreatingChange || setCreatingLocal;

  // Deep-link from the Projects tab "Pre-Prod" linked-record pill.
  // Auto-opens the specified project once it appears in the listener
  // payload. Re-fires whenever the deepLinkProjectId prop changes, so
  // the producer can click another pill and land on a different project
  // without an intermediate Back-to-list step.
  useEffect(() => {
    if (!deepLinkProjectId) return;
    if (projects[deepLinkProjectId]) setActiveProjectId(deepLinkProjectId);
  }, [deepLinkProjectId, projects]);

  // fbListenSafe: waits for auth + suppresses transient nulls after the
  // first real load. Fixes the "competitor research blank even though it's
  // full" bug — which was Firebase firing null mid-session on token
  // refresh, which the previous listener cached as "empty projects".
  useEffect(() => fbListenSafe("/preproduction/socialOrganic", (data) => {
    // Filter internal keys (_costLog, _handleDirectory) out of the project list
    const filtered = {};
    Object.entries(data || {}).forEach(([k, v]) => {
      if (!k.startsWith("_") && v && v.id) filtered[k] = v;
    });
    setProjects(filtered);
  }), []);

  const projectList = Object.values(projects)
    .filter(p => p && p.status !== "archived")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const activeProject = activeProjectId ? projects[activeProjectId] : null;

  // Account lookup — same pattern as Preproduction/Runsheets for consistency
  const findAccount = (companyName, attioCompanyId) => {
    if (!companyName && !attioCompanyId) return null;
    const acctList = Object.values(accounts || {}).filter(Boolean);
    return acctList.find(a =>
      (attioCompanyId && a.attioId === attioCompanyId) ||
      (companyName && (a.companyName || "").trim().toLowerCase() === companyName.trim().toLowerCase())
    ) || null;
  };
  const getAccountLogo = (companyName, attioCompanyId) =>
    findAccount(companyName, attioCompanyId)?.logoUrl || null;
  const getAccountLogoBg = (companyName, attioCompanyId) =>
    findAccount(companyName, attioCompanyId)?.logoBg;

  // Detail-view helpers. Uses fbUpdate (patch semantics) rather than fbSet
  // so partial writes only touch the given keys — sub-fields like
  // visitedTabs don't get clobbered by stale `current` snapshots.
  const patchProject = (projectId, patch) => {
    fbUpdate(`/preproduction/socialOrganic/${projectId}`, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  // ═══════════════════════════════════════════
  // DETAIL VIEW
  // ═══════════════════════════════════════════
  if (activeProject) {
    return (
      <ResearchDetail
        project={activeProject}
        accounts={accounts}
        clients={clients}
        sherpaCacheMeta={sherpaCacheMeta}
        findAccount={findAccount}
        getAccountLogo={getAccountLogo}
        getAccountLogoBg={getAccountLogoBg}
        onBack={() => setActiveProjectId(null)}
        onPatch={(patch) => patchProject(activeProject.id, patch)}
        onDelete={() => {
          if (!window.confirm(`Delete "${activeProject.companyName}" research project?`)) return;
          // Optimistic local removal so the producer doesn't see the
          // project flicker back if any in-flight Apify webhook lands
          // milliseconds before the listener confirms the delete. The
          // server-side processApifyRun also has a tombstone guard so
          // late-arriving webhooks can't resurrect the record either.
          const idToDelete = activeProject.id;
          setProjects(prev => {
            const next = { ...prev };
            delete next[idToDelete];
            return next;
          });
          fbSet(`/preproduction/socialOrganic/${idToDelete}`, null);
          setActiveProjectId(null);
        }}
      />
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  return (
    <div>
      {/* Create modal */}
      {creating && (
        <CreateProjectModal
          accounts={accounts}
          onCancel={() => setCreating(false)}
          onCreate={(newProject) => {
            fbSet(`/preproduction/socialOrganic/${newProject.id}`, newProject);
            setCreating(false);
            setActiveProjectId(newProject.id);
          }}
        />
      )}

      {/* Header + "+ New" trigger hoisted to the parent Preproduction
          header so it sits next to the sub-tabs (matching Meta Ads). */}

      {projectList.length === 0 && !creating && (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No research projects yet</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Create one to start pulling competitor Instagram content for a client.</div>
        </div>
      )}

      {/* Card grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
        {projectList.map(p => {
          const logo = getAccountLogo(p.companyName, p.attioCompanyId);
          const lbg = logoBg(getAccountLogoBg(p.companyName, p.attioCompanyId));
          const postCount = Array.isArray(p.posts) ? p.posts.length : 0;
          const handleCount = p.inputs?.competitors?.length || 0;
          return (
            <div key={p.id}
              onClick={() => setActiveProjectId(p.id)}
              style={{
                background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10,
                padding: 16, cursor: "pointer", transition: "border-color 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                {logo && <img key={logo + lbg} src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 28, borderRadius: 4, objectFit: "contain", background: lbg, padding: 3 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.companyName}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{p.createdAt ? formatDate(p.createdAt) : ""}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                <Badge text={STATUS_LABELS[p.status] || p.status} colors={STATUS_COLORS[p.status]} />
                {handleCount > 0 && <Badge text={`${handleCount} handle${handleCount === 1 ? "" : "s"}`} colors={{ bg: "rgba(59,130,246,0.12)", fg: "#3B82F6" }} />}
                {postCount > 0 && <Badge text={`${postCount} posts`} colors={{ bg: "rgba(139,92,246,0.12)", fg: "#8B5CF6" }} />}
                {(() => {
                  const t = p.tab || (p.stage ? "legacy" : null);
                  if (!t || t === "brandTruth" || t === "legacy") return null;
                  const label = { research: "Researching", clientResearch: "Client research", videoReview: "Reviewing", shortlist: "Shortlisting", select: "Selecting", script: "Scripting", done: "Delivered" }[t] || t;
                  return <Badge text={label} colors={{ bg: "rgba(34,197,94,0.12)", fg: "#22C55E" }} />;
                })()}
              </div>
              {p.inputs?.competitors?.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.inputs.competitors.slice(0, 4).map(c => c.handle).join(" · ")}
                  {p.inputs.competitors.length > 4 && ` · +${p.inputs.competitors.length - 4}`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// CREATE PROJECT MODAL
// ═══════════════════════════════════════════
function CreateProjectModal({ accounts, onCancel, onCreate }) {
  const [companyName, setCompanyName] = useState("");
  const [attioCompanyId, setAttioCompanyId] = useState(null);

  const accountList = Object.values(accounts || {})
    .filter(a => a && a.companyName)
    .sort((a, b) => (a.companyName || "").localeCompare(b.companyName || ""));

  const pickAccount = (acct) => {
    setCompanyName(acct.companyName);
    setAttioCompanyId(acct.attioId || null);
  };

  const handleCreate = () => {
    if (!companyName.trim()) return;
    const id = `so_${Date.now()}`;
    const account = accountList.find(a => a.attioId === attioCompanyId || (a.companyName || "").toLowerCase() === companyName.trim().toLowerCase());
    // Seed competitors from the account's saved list if one exists
    const seededCompetitors = (account?.competitors || []).map(c => ({
      handle: normaliseHandle(c.handle),
      displayName: c.displayName || c.handle,
      source: "account",
    })).filter(c => c.handle);

    const project = {
      id,
      shortId: makeShortId(),
      companyName: companyName.trim(),
      attioCompanyId: attioCompanyId || null,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputs: {
        competitors: seededCompetitors,
        keywords: [],
        hashtags: [],
        dateRange: defaultRange(),
        postsPerHandle: DEFAULTS.postsPerHandle,
        platforms: ["instagram"],
        transcript: null,
      },
      // Producer-driven 7-tab workflow. Tab router keys off `project.tab`;
      // approvals[key] timestamps advance gates. `videoReview` is a typed
      // record (ticked/crossed/extraLinks arrays) — the old `videoReviews`
      // map schema is gone.
      tab: "brandTruth",
      approvals: {},
      videoReview: { ticked: [], crossed: [], extraLinks: [] },
      shortlistedFormats: {},
      selectedFormats: [],
    };
    onCreate(project);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onCancel}>
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 24, maxWidth: 560, width: "90%", border: "1px solid var(--border)", maxHeight: "80vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg)" }}>New Social Media Organic Pre Production</div>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
          Pick an existing client to seed their saved competitors, or type a new name manually.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>Client</label>
          <input
            type="text"
            value={companyName}
            onChange={e => { setCompanyName(e.target.value); setAttioCompanyId(null); }}
            placeholder="Type a client name..."
            style={inputSt}
          />
        </div>

        {accountList.length > 0 && (
          <div style={{ marginBottom: 16, maxHeight: 240, overflowY: "auto", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", padding: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6, padding: "0 4px" }}>Or pick from accounts</div>
            {accountList.map(acct => (
              <div key={acct.id}
                onClick={() => pickAccount(acct)}
                style={{
                  padding: "8px 10px", cursor: "pointer", borderRadius: 6, fontSize: 12,
                  background: acct.companyName === companyName ? "var(--accent-soft)" : "transparent",
                  color: acct.companyName === companyName ? "var(--accent)" : "var(--fg)",
                  fontWeight: acct.companyName === companyName ? 700 : 500,
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                {acct.logoUrl && <img src={acct.logoUrl} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 18, width: 18, borderRadius: 3, objectFit: "contain", background: logoBg(acct.logoBg), padding: 1 }} />}
                <span style={{ flex: 1 }}>{acct.companyName}</span>
                {(acct.competitors?.length || 0) > 0 && (
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>{acct.competitors.length} saved competitor{acct.competitors.length === 1 ? "" : "s"}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={btnSecondary}>Cancel</button>
          <button onClick={handleCreate} disabled={!companyName.trim()} style={{ ...btnPrimary, opacity: companyName.trim() ? 1 : 0.5 }}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// DETAIL VIEW
// ═══════════════════════════════════════════
function ResearchDetail({ project, accounts, clients, sherpaCacheMeta, findAccount, getAccountLogo, getAccountLogoBg, onBack, onPatch, onDelete }) {
  const logo = getAccountLogo(project.companyName, project.attioCompanyId);
  const lbg = logoBg(getAccountLogoBg(project.companyName, project.attioCompanyId));
  const linkedAccount = findAccount(project.companyName, project.attioCompanyId);
  // Resolve the /clients record that owns this project's Sherpa Google Doc.
  // Mirrors api/_sherpa.js matchSherpaClient (attioId exact match → fuzzy
  // name fallback) so the status row reflects the same client record the
  // AI handlers will read from. Name-only matching here would diverge when
  // a project's attioCompanyId pins one record but the company name fuzzy-
  // matches another.
  const linkedClient = matchSherpaClientRecord({
    companyName: project.companyName,
    attioCompanyId: project.attioCompanyId,
    clients,
  });
  const sherpaMeta = linkedClient ? (sherpaCacheMeta?.[linkedClient.id] || null) : null;
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState(null);

  const patchInputs = (patch) => onPatch({ inputs: { ...(project.inputs || {}), ...patch } });

  const runScrape = async () => {
    const handles = (project.inputs?.competitors || []).map(c => c.handle).filter(Boolean);
    if (!handles.length) { alert("Add at least one competitor handle before scraping."); return; }
    setScraping(true);
    setScrapeError(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scrape", projectId: project.id, inputs: project.inputs }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      // Firebase listener will rehydrate the project with posts + handleStats automatically.
      if (d.errors?.length) {
        setScrapeError(`Scraped ${d.postsCollected} posts but ${d.errors.length} handle(s) failed: ` + d.errors.map(e => `${e.handle}: ${e.error}`).join(", "));
      }
    } catch (e) {
      setScrapeError(e.message);
    } finally {
      setScraping(false);
    }
  };

  // One-shot migration: legacy projects (5-stage flow) have no `tab` field.
  // Per the approved plan, we keep the project card but wipe all stage-
  // specific data and land the producer on Tab 1 (Brand Truth) to restart.
  // Fires once per legacy project the first time it's opened in the new UI.
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    if (project.tab) return;  // already on new schema
    migrated.current = true;
    const preserved = {
      id: project.id,
      shortId: project.shortId,
      companyName: project.companyName,
      attioCompanyId: project.attioCompanyId || null,
      packageTier: project.packageTier || null,
      videoType: project.videoType || null,
      numberOfVideos: project.numberOfVideos || null,
      dealValue: project.dealValue || null,
      createdAt: project.createdAt,
      // Fresh 7-tab state:
      tab: "brandTruth",
      approvals: {},
      status: "draft",
      updatedAt: new Date().toISOString(),
    };
    fbSet(`/preproduction/socialOrganic/${project.id}`, preserved);
  }, [project.id, project.tab]);  // eslint-disable-line react-hooks/exhaustive-deps

  const tab = effectiveTab(project);

  // Track every tab the producer has landed on. Any visited tab stays
  // clickable in the TabBar forever — so jumping back to check Tab 2's
  // scrape status or Tab 3's key takeaways doesn't require bouncing
  // through the "→ Next" buttons at the bottom of each step.
  useEffect(() => {
    if (!tab) return;
    const visited = Array.isArray(project.visitedTabs) ? project.visitedTabs : [];
    if (visited.includes(tab)) return;
    fbSet(`/preproduction/socialOrganic/${project.id}/visitedTabs`, [...visited, tab]);
  }, [tab, project.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Project-wide scrape auto-poll. Runs at the ResearchDetail level (NOT
  // inside the StatusPill) so it keeps firing when the producer navigates
  // to Tab 3+ while a scrape is still running. Silent — the backend flips
  // status to "done" via Firebase when any run finishes, UI rerenders.
  const clientScrapeStatus = project.clientScrape?.status;
  const competitorScrapeStatus = project.competitorScrape?.status;
  const anyScrapeRunning = clientScrapeStatus === "running" || competitorScrapeStatus === "running";
  useEffect(() => {
    if (!anyScrapeRunning) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        await authFetch("/api/social-organic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refreshScrapes", projectId: project.id }),
        });
      } catch { /* silent */ }
    };
    const initial = setTimeout(poll, 15000);  // first check 15s in
    const interval = setInterval(poll, 15000); // every 15s thereafter
    return () => { cancelled = true; clearTimeout(initial); clearInterval(interval); };
  }, [project.id, anyScrapeRunning]);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ ...btnSecondary, padding: "5px 10px" }}>&larr; Back</button>
          {logo && <img key={logo + lbg} src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 30, borderRadius: 4, objectFit: "contain", background: lbg, padding: 3 }} />}
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>{project.companyName}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              Social Organic preproduction · {project.createdAt ? formatDate(project.createdAt) : ""}
              {project.numberOfVideos ? ` · ${project.numberOfVideos} videos` : ""}
            </div>
          </div>
          <Badge text={STATUS_LABELS[project.status] || project.status} colors={STATUS_COLORS[project.status]} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onPatch({ status: "archived" })}
            style={{ ...btnSecondary }}
            title="Archive — hides this project from the list but preserves it">
            Archive
          </button>
          <button onClick={onDelete} style={{ ...btnSecondary, color: "#EF4444", borderColor: "rgba(239,68,68,0.3)" }}>Delete</button>
        </div>
      </div>

      {/* 7-tab producer workflow. Each tab unlocks only once the previous
          one has an approval timestamp in `project.approvals`. */}
      <TabBar project={project} onChange={(nextTab) => onPatch({ tab: nextTab })} />

      {tab === "brandTruth" && (
        <BrandTruthStep
          project={project}
          linkedAccount={linkedAccount}
          linkedClient={linkedClient}
          sherpaMeta={sherpaMeta}
          onPatch={onPatch}
        />
      )}
      {tab === "research" && (
        <ResearchStep project={project} linkedAccount={linkedAccount} onPatch={onPatch} />
      )}
      {tab === "clientResearch" && (
        <ClientResearchStep project={project} onPatch={onPatch} />
      )}
      {tab === "videoReview" && (
        <VideoReviewStep project={project} onPatch={onPatch} />
      )}
      {tab === "shortlist" && (
        <ShortlistStep project={project} onPatch={onPatch} />
      )}
      {tab === "select" && (
        <SocialOrganicSelect project={project} onPatch={onPatch} />
      )}
      {tab === "ideaSelect" && (
        <IdeaSelectionStep project={project} onPatch={onPatch} />
      )}
      {tab === "script" && (
        <ScriptStep project={project} onPatch={onPatch} />
      )}
      {tab === "done" && (
        <TabPlaceholder tabNum={8} title="Done"
          hint="Project pushed to Deliveries." />
      )}
    </div>
  );
}

function TabPlaceholder({ tabNum, title, hint }) {
  return (
    <div style={{ padding: 40, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.08em", marginBottom: 8 }}>TAB {tabNum}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg)", marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 560, margin: "0 auto", lineHeight: 1.6 }}>{hint}</div>
    </div>
  );
}

// Project's current tab. Projects that haven't been migrated yet (legacy
// 5-stage `stage` field but no `tab`) trigger the migration in ResearchDetail
// and land on brandTruth; before the migration fires we default to brandTruth
// so the first render doesn't crash.
function effectiveTab(project) {
  return project?.tab || "brandTruth";
}

// `prev` is the approval key that must be set to unlock this tab. Tab 2
// (Format Research) has two sub-approvals — `research_a` (client handle
// approved → client scrape kicked off) and `research_b` (competitors
// approved → 120-video scrape kicked off). Tab 3 requires research_b so
// both scrapes are running before the producer moves on; the 120-video
// scrape then happens in parallel to Tab 3's client review, which is the
// whole point of the async model.
export const TABS = [
  { key: "brandTruth",     label: "Brand Truth",      num: 1, prev: null },
  { key: "research",       label: "Format Research",  num: 2, prev: "brandTruth" },
  { key: "clientResearch", label: "Client Research",  num: 3, prev: "research_b" },
  { key: "videoReview",    label: "Video Review",     num: 4, prev: "research_b" },
  { key: "shortlist",      label: "Shortlist",        num: 5, prev: "videoReview" },
  { key: "select",         label: "Format Selection", num: 6, prev: "shortlist" },
  // New tab: "Idea Selection". 10 ideas per selected format, producer
  // ticks the ones they want to progress. Cap = project.numberOfVideos.
  // Replaces the old per-format videoCount split on the Selection tab;
  // counts are now a derived sum of ticked ideas per format.
  { key: "ideaSelect",     label: "Idea Selection",   num: 7, prev: "select" },
  { key: "script",         label: "Scripting",        num: 8, prev: "ideaSelect" },
];

// Legacy helper — kept because it's exported from this module and may be
// referenced elsewhere. Always returns true now: the tab bar is purely a
// navigation aid; forward approval gates are enforced by each tab's
// Approve button, not by hiding tabs.
export function isTabReachable() {
  return true;
}

function TabBar({ project, onChange }) {
  const current = effectiveTab(project);
  const currentIdx = TABS.findIndex(s => s.key === current);
  const approvals = project?.approvals || {};

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, overflowX: "auto" }}>
      {TABS.map((s, idx) => {
        const isActive = idx === currentIdx;
        // Tab 2 has two sub-approvals (research_a + research_b) — mark it
        // done when both are set. Everything else maps 1:1 to its approvals
        // key.
        const isDone = s.key === "research"
          ? (!!approvals.research_a && !!approvals.research_b)
          : !!approvals[s.key];
        return (
          <button
            key={s.key}
            onClick={() => onChange(s.key)}
            title={`Go to ${s.label}`}
            style={{
              flex: 1, minWidth: 100, padding: "8px 12px", borderRadius: 6,
              border: "none",
              background: isActive ? "var(--accent)" : "transparent",
              color: isActive ? "#fff" : isDone ? "#22C55E" : "var(--fg)",
              fontSize: 12, fontWeight: 700, cursor: "pointer",
              fontFamily: "inherit", opacity: 1,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              whiteSpace: "nowrap",
            }}>
            <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", opacity: 0.7 }}>
              {isDone ? "✓" : s.num}
            </span>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// Scrape + Classify buttons + status
function ActionBar({ project, scraping, onScrape, scrapeError }) {
  const posts = Array.isArray(project.posts) ? project.posts : [];
  const classified = posts.filter(p => p.format).length;
  const unclassified = posts.length - classified;

  const [classifying, setClassifying] = useState(false);
  const [fastClassify, setFastClassify] = useState(false);
  const [classifyError, setClassifyError] = useState(null);
  const [classifyInfo, setClassifyInfo] = useState(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineError, setPipelineError] = useState(null);
  const [pipelineInfo, setPipelineInfo] = useState(null);

  const runPipeline = async () => {
    const handles = (project.inputs?.competitors || []).map(c => c.handle).filter(Boolean);
    if (!handles.length) { alert("Add at least one competitor handle first."); return; }
    setPipelineRunning(true);
    setPipelineError(null);
    setPipelineInfo(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "runPipeline", projectId: project.id, fast: fastClassify }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${JSON.stringify(d.detail).slice(0, 200)}` : ""));
      const bits = [];
      if (d.scrape?.postsCollected != null) bits.push(`${d.scrape.postsCollected} posts scraped`);
      else if (d.scrape?.skipped) bits.push(`${d.scrape.postCount || 0} posts reused`);
      if (d.classify?.classified != null) bits.push(`${d.classify.classified} classified`);
      else if (d.classify?.skipped) bits.push("classify skipped");
      // Synthesis step removed — producer drives review → shortlist → select → script.
      setPipelineInfo(`Pipeline done — ${bits.join(" · ")}`);
    } catch (e) {
      setPipelineError(e.message);
    } finally {
      setPipelineRunning(false);
    }
  };

  const runClassify = async () => {
    if (!posts.length) return;
    setClassifying(true);
    setClassifyError(null);
    setClassifyInfo(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "classify", projectId: project.id, fast: fastClassify }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      let msg = `Classified ${d.classified} post${d.classified === 1 ? "" : "s"}`;
      if (d.batchErrors?.length) {
        // Show the first batch error's actual message + preview so it's actionable
        const firstErr = d.batchErrors[0];
        msg += ` · ${d.batchErrors.length} batch error(s). First: "${firstErr.error}"`;
        if (firstErr.rawPreview) msg += ` — raw: ${firstErr.rawPreview.slice(0, 120)}`;
      }
      setClassifyInfo(msg);
    } catch (e) {
      setClassifyError(e.message);
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {posts.length > 0 ? (
            <>
              {posts.length} post{posts.length === 1 ? "" : "s"} on file.
              {classified > 0 && <span style={{ marginLeft: 6, color: "var(--fg)" }}>{classified} classified</span>}
              {unclassified > 0 && <span style={{ marginLeft: 6, color: "#F59E0B" }}>{unclassified} unclassified</span>}
              {project.scrape?.hitCache && <span style={{ marginLeft: 8, color: "var(--accent)" }}>♻️ cache-served</span>}
            </>
          ) : "No posts scraped yet."}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {posts.length > 0 && unclassified > 0 && (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)", cursor: "pointer" }}>
                <input type="checkbox" checked={fastClassify} onChange={e => setFastClassify(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
                Fast (caption-only)
              </label>
              <button onClick={runClassify} disabled={classifying} style={{ ...btnSecondary, background: "var(--accent-soft)", color: "var(--accent)", borderColor: "transparent", opacity: classifying ? 0.6 : 1 }}>
                {classifying ? "Classifying…" : `Classify ${unclassified} post${unclassified === 1 ? "" : "s"}`}
              </button>
            </>
          )}
          <button onClick={onScrape} disabled={scraping || pipelineRunning} style={{ ...btnSecondary, opacity: (scraping || pipelineRunning) ? 0.6 : 1 }}>
            {scraping ? "Scraping…" : posts.length > 0 ? "Re-scrape" : "Run scrape"}
          </button>
          <button onClick={runPipeline} disabled={pipelineRunning || scraping || classifying}
            style={{ ...btnPrimary, opacity: (pipelineRunning || scraping || classifying) ? 0.6 : 1 }}>
            {pipelineRunning ? "Running pipeline…" : "Run full pipeline"}
          </button>
        </div>
      </div>
      {scrapeError && (
        <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
          {scrapeError}
        </div>
      )}
      {classifyError && (
        <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
          Classification failed: {classifyError}
        </div>
      )}
      {classifyInfo && !classifyError && (
        <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(34,197,94,0.08)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.3)", fontSize: 12, color: "#22C55E" }}>
          {classifyInfo}
        </div>
      )}
      {pipelineError && (
        <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
          Pipeline failed: {pipelineError}
        </div>
      )}
      {pipelineInfo && !pipelineError && (
        <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(34,197,94,0.08)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.3)", fontSize: 12, color: "#22C55E" }}>
          {pipelineInfo}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// POSTS GRID — Slice 3 + Slice 4 format buckets
// ═══════════════════════════════════════════
function PostsGrid({ posts, handleStats, projectId }) {
  const [sortBy, setSortBy] = useState("overperformance");
  const [filterHandle, setFilterHandle] = useState("all");
  const [filterFormat, setFilterFormat] = useState("all");

  const handles = Array.from(new Set(posts.map(p => p.handle)));

  // Count + avg overperformance per format bucket, for tab labels
  const formatBuckets = {};
  posts.forEach(p => {
    const k = p.format || "_unclassified";
    if (!formatBuckets[k]) formatBuckets[k] = { count: 0, overSum: 0, overCount: 0 };
    formatBuckets[k].count++;
    if (p.overperformanceScore != null) {
      formatBuckets[k].overSum += p.overperformanceScore;
      formatBuckets[k].overCount++;
    }
  });
  const tabs = Object.keys(formatBuckets)
    .sort((a, b) => formatBuckets[b].count - formatBuckets[a].count);

  let filtered = filterHandle === "all" ? posts : posts.filter(p => p.handle === filterHandle);
  if (filterFormat !== "all") {
    filtered = filtered.filter(p => (p.format || "_unclassified") === filterFormat);
  }
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "views":          return (b.views || 0) - (a.views || 0);
      case "engagement":     return (b.engagementRate || 0) - (a.engagementRate || 0);
      case "recent":         return (b.timestamp || "").localeCompare(a.timestamp || "");
      case "overperformance":
      default:               return (b.overperformanceScore || 0) - (a.overperformanceScore || 0);
    }
  });

  return (
    <div style={{ marginTop: 20 }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>
          Scraped posts ({sorted.length}{sorted.length !== posts.length ? ` of ${posts.length}` : ""})
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={filterHandle} onChange={e => setFilterHandle(e.target.value)} style={{ ...inputSt, width: "auto", fontSize: 11, padding: "5px 8px" }}>
            <option value="all">All handles</option>
            {handles.map(h => {
              // handleStats keys are Firebase-safe (dots replaced with _) to
              // accommodate handles like @mannix.squiers. Match by both the
              // sanitised key and the original handle field.
              const stats = handleStats[h] || Object.values(handleStats).find(s => s?.handle === h);
              return (
                <option key={h} value={h}>
                  {h}{stats ? ` — ${stats.postCount} posts, avg ${formatBig(stats.avgViews)}` : ""}
                </option>
              );
            })}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inputSt, width: "auto", fontSize: 11, padding: "5px 8px" }}>
            <option value="overperformance">Overperformance</option>
            <option value="views">Views</option>
            <option value="engagement">Engagement rate</option>
            <option value="recent">Most recent</option>
          </select>
        </div>
      </div>

      {/* Format bucket tabs */}
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 14, padding: "4px 0", overflowX: "auto" }}>
          <FormatTab label="All" count={posts.length} active={filterFormat === "all"} onClick={() => setFilterFormat("all")} />
          {tabs.map(key => {
            const bucket = formatBuckets[key];
            const label = key === "_unclassified" ? "Unclassified" : (FORMAT_LABELS[key] || key);
            const avgOver = bucket.overCount > 0 ? bucket.overSum / bucket.overCount : null;
            return (
              <FormatTab
                key={key}
                label={label}
                count={bucket.count}
                avgOver={avgOver}
                active={filterFormat === key}
                unclassified={key === "_unclassified"}
                onClick={() => setFilterFormat(key)}
              />
            );
          })}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {sorted.map(p => <PostCard key={p.id} post={p} projectId={projectId} />)}
      </div>
    </div>
  );
}

function FormatTab({ label, count, avgOver, active, unclassified, onClick }) {
  const bg = active
    ? "var(--accent)"
    : unclassified
      ? "rgba(245,158,11,0.15)"
      : "var(--bg)";
  const color = active ? "#fff" : unclassified ? "#F59E0B" : "var(--muted)";
  return (
    <button onClick={onClick} style={{
      padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)",
      background: bg, color, fontSize: 11, fontWeight: 700, cursor: "pointer",
      fontFamily: "inherit", whiteSpace: "nowrap",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      {label}
      <span style={{ fontSize: 10, opacity: 0.75, fontFamily: "'JetBrains Mono',monospace" }}>{count}</span>
      {avgOver != null && (
        <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: active ? "rgba(255,255,255,0.8)" : avgOver >= 2 ? "#22C55E" : avgOver >= 1 ? "#3B82F6" : "var(--muted)" }}>
          {avgOver.toFixed(1)}×
        </span>
      )}
    </button>
  );
}

function PostCard({ post, projectId }) {
  const over = post.overperformanceScore;
  const overBadge = over != null ? (over >= 2 ? { bg: "rgba(34,197,94,0.15)", fg: "#22C55E" } : over >= 1 ? { bg: "rgba(59,130,246,0.12)", fg: "#3B82F6" } : { bg: "var(--bg)", fg: "var(--muted)" }) : null;
  const [editing, setEditing] = useState(false);

  const reclassify = async (newFormat) => {
    try {
      await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reclassify", projectId, postId: post.id, format: newFormat }),
      });
      setEditing(false);
    } catch (e) {
      console.error("Reclassify failed:", e);
    }
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", transition: "border-color 0.15s", position: "relative" }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
      <div style={{ position: "relative" }}>
        <ReelPreview shortCode={post.shortCode} url={post.url} thumbnail={post.thumbnail} aspectRatio="9 / 16" />
        {overBadge && over != null && (
          <div style={{ position: "absolute", bottom: 6, left: 6, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", background: overBadge.bg, color: overBadge.fg, zIndex: 2 }}>
            {over >= 1 ? `${over.toFixed(1)}× avg` : `${(over * 100).toFixed(0)}% avg`}
          </div>
        )}
      </div>
      <a href={post.url} target="_blank" rel="noopener noreferrer"
        style={{ display: "block", textDecoration: "none" }}>
        <div style={{ display: "none" }}>
        </div>
        <div style={{ padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 3 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>{post.handle}</div>
            {post.hookType && <div style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>{post.hookType}</div>}
          </div>
          <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", marginBottom: 6 }}>
            {post.views != null && <span>👁 {formatBig(post.views)}</span>}
            <span>❤ {formatBig(post.likes)}</span>
            <span>💬 {formatBig(post.comments)}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg)", lineHeight: 1.4, maxHeight: 44, overflow: "hidden", textOverflow: "ellipsis" }}>
            {(post.caption || "").slice(0, 140)}{(post.caption || "").length > 140 ? "…" : ""}
          </div>
          {post.timestamp && (
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6 }}>{formatDate(post.timestamp)}</div>
          )}
        </div>
      </a>
      {/* Format badge + reclassify — outside the <a> so clicking doesn't open the IG link */}
      <div style={{ padding: "0 10px 10px" }}>
        {editing ? (
          <select autoFocus onChange={e => reclassify(e.target.value)} onBlur={() => setEditing(false)}
            style={{ ...inputSt, fontSize: 11, padding: "4px 6px" }}>
            <option value="">— pick format —</option>
            {Object.entries(FORMAT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        ) : post.format ? (
          <button onClick={() => setEditing(true)} title={post.formatEvidence || ""}
            style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%" }}>
            {FORMAT_LABELS[post.format] || post.format}
            {post.formatConfidence != null && post.formatConfidence < 1 && (
              <span style={{ marginLeft: 6, opacity: 0.6, fontFamily: "'JetBrains Mono',monospace" }}>{Math.round(post.formatConfidence * 100)}%</span>
            )}
          </button>
        ) : (
          <button onClick={() => setEditing(true)}
            style={{ padding: "3px 8px", borderRadius: 4, border: "1px dashed var(--border)", background: "transparent", color: "var(--muted)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%" }}>
            + classify
          </button>
        )}
      </div>
    </div>
  );
}

// 1.2M, 54k, 812 — compact number formatting
function formatBig(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

// ═══════════════════════════════════════════
// INPUTS SECTION (Slice 1 — static, no AI yet)
// ═══════════════════════════════════════════
function InputsSection({ project, linkedAccount, onPatchInputs }) {
  const inputs = project.inputs || {};
  const competitors = inputs.competitors || [];
  const [newHandle, setNewHandle] = useState("");
  const [newKeyword, setNewKeyword] = useState("");
  const [editingAccount, setEditingAccount] = useState(false);
  const [accountNewHandle, setAccountNewHandle] = useState("");

  // Write back to /accounts/{id}/competitors when editing the saved list
  const updateAccountCompetitors = (next) => {
    if (!linkedAccount?.id) return;
    fbSet(`/accounts/${linkedAccount.id}/competitors`, next);
  };
  const accountSavedCompetitors = linkedAccount?.competitors || [];
  const addToAccount = () => {
    const norm = normaliseHandle(accountNewHandle);
    if (!norm) return;
    if (accountSavedCompetitors.some(c => normaliseHandle(c.handle) === norm)) return;
    updateAccountCompetitors([
      ...accountSavedCompetitors,
      { handle: norm, displayName: norm, notes: "", addedAt: new Date().toISOString() },
    ]);
    setAccountNewHandle("");
  };
  const removeFromAccount = (handle) => {
    updateAccountCompetitors(accountSavedCompetitors.filter(c => normaliseHandle(c.handle) !== normaliseHandle(handle)));
  };

  const addCompetitor = (handle, source = "manual", displayName = null) => {
    const norm = normaliseHandle(handle);
    if (!norm) return;
    if (competitors.some(c => c.handle.toLowerCase() === norm.toLowerCase())) return;  // dedup
    onPatchInputs({ competitors: [...competitors, { handle: norm, displayName: displayName || norm, source }] });
  };
  const removeCompetitor = (handle) => {
    onPatchInputs({ competitors: competitors.filter(c => c.handle !== handle) });
  };

  const keywords = inputs.keywords || [];
  const addKeyword = () => {
    const k = newKeyword.trim();
    if (!k || keywords.includes(k)) return;
    onPatchInputs({ keywords: [...keywords, k] });
    setNewKeyword("");
  };
  const removeKeyword = (k) => onPatchInputs({ keywords: keywords.filter(x => x !== k) });

  const handleSubmitNew = (e) => {
    if (e.key === "Enter" && newHandle.trim()) {
      e.preventDefault();
      addCompetitor(newHandle.trim(), "manual");
      setNewHandle("");
    }
  };

  // Show saved-but-not-yet-added competitors from the linked account
  const accountCompetitors = (linkedAccount?.competitors || [])
    .map(c => ({ handle: normaliseHandle(c.handle), displayName: c.displayName || c.handle }))
    .filter(c => c.handle && !competitors.some(x => x.handle.toLowerCase() === c.handle.toLowerCase()));

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Research Inputs</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
        Competitor handles, keywords, date range, and post-per-handle budget.
        {linkedAccount?.companyName && ` Linked to account: ${linkedAccount.companyName}.`}
      </div>

      {/* Competitors */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>
          Competitor handles ({competitors.length}/{DEFAULTS.maxHandles})
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {competitors.map(c => {
            const sourceColor = {
              account:    { bg: "rgba(34,197,94,0.12)",  fg: "#22C55E", label: "account" },
              manual:     { bg: "rgba(59,130,246,0.12)", fg: "#3B82F6", label: "manual"  },
              transcript: { bg: "rgba(245,158,11,0.12)", fg: "#F59E0B", label: "transcript" },
              keyword:    { bg: "rgba(139,92,246,0.12)", fg: "#8B5CF6", label: "keyword" },
            }[c.source] || { bg: "var(--bg)", fg: "var(--muted)", label: c.source };
            return (
              <span key={c.handle} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                {c.handle}
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: sourceColor.bg, color: sourceColor.fg, textTransform: "uppercase" }}>{sourceColor.label}</span>
                <button onClick={() => removeCompetitor(c.handle)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
              </span>
            );
          })}
          {competitors.length === 0 && (
            <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>No competitors yet — add some below or from the account's saved list.</span>
          )}
        </div>
        {competitors.length < DEFAULTS.maxHandles && (
          <input
            type="text"
            value={newHandle}
            onChange={e => setNewHandle(e.target.value)}
            onKeyDown={handleSubmitNew}
            placeholder="Add handle — @brand or instagram.com/brand — press Enter"
            style={{ ...inputSt, fontSize: 12 }}
          />
        )}
        {competitors.length >= DEFAULTS.maxHandles && (
          <div style={{ fontSize: 11, color: "#F59E0B", padding: "8px 12px", background: "rgba(245,158,11,0.08)", borderRadius: 6 }}>
            Max {DEFAULTS.maxHandles} handles per scrape. Remove one to add another.
          </div>
        )}
        {linkedAccount && (
          <div style={{ marginTop: 10, padding: 10, background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Saved on {linkedAccount.companyName || "account"} {accountCompetitors.length > 0 && "— click to add"}
              </div>
              <button onClick={() => setEditingAccount(v => !v)}
                style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {editingAccount ? "Done" : "Edit saved list"}
              </button>
            </div>
            {!editingAccount && accountCompetitors.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {accountCompetitors.map(c => (
                  <button key={c.handle}
                    onClick={() => addCompetitor(c.handle, "account", c.displayName)}
                    disabled={competitors.length >= DEFAULTS.maxHandles}
                    style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "transparent", border: "1px dashed var(--border)", color: "var(--accent)", cursor: competitors.length >= DEFAULTS.maxHandles ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: competitors.length >= DEFAULTS.maxHandles ? 0.4 : 1 }}>
                    + {c.handle}
                  </button>
                ))}
              </div>
            )}
            {!editingAccount && accountCompetitors.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
                No competitors saved on this account yet. Click "Edit saved list" to add some — they'll auto-populate for every future research project on this client.
              </div>
            )}
            {editingAccount && (
              <div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  {accountSavedCompetitors.map(c => (
                    <span key={c.handle} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--card)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {normaliseHandle(c.handle)}
                      <button onClick={() => removeFromAccount(c.handle)} style={{ background: "none", border: "none", color: "#EF4444", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                    </span>
                  ))}
                  {accountSavedCompetitors.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>Empty — add below</span>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input type="text" value={accountNewHandle} onChange={e => setAccountNewHandle(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addToAccount(); } }}
                    placeholder="@handle — saved to this account permanently"
                    style={{ ...inputSt, fontSize: 12, flex: 1 }} />
                  <button onClick={addToAccount} disabled={!accountNewHandle.trim()} style={{ ...btnSecondary, padding: "6px 14px", opacity: accountNewHandle.trim() ? 1 : 0.5 }}>Add</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Keywords / hashtags */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>
          Keywords / niches ({keywords.length})
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {keywords.map(k => (
            <span key={k} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {k}
              <button onClick={() => removeKeyword(k)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
          {keywords.length === 0 && (
            <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>No keywords yet. Used to bias hashtag-based exploration later.</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
            placeholder="e.g. men's suiting, pilates studio, fine jewellery"
            style={{ ...inputSt, fontSize: 12, flex: 1 }}
          />
          <button onClick={addKeyword} disabled={!newKeyword.trim()} style={{ ...btnSecondary, padding: "6px 14px", opacity: newKeyword.trim() ? 1 : 0.5 }}>Add</button>
        </div>
      </div>

      {/* Date range + posts per handle */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>From</label>
          <input type="date" value={inputs.dateRange?.from || ""} onChange={e => onPatchInputs({ dateRange: { ...(inputs.dateRange || {}), from: e.target.value } })} style={{ ...inputSt, colorScheme: "dark" }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>To</label>
          <input type="date" value={inputs.dateRange?.to || ""} onChange={e => onPatchInputs({ dateRange: { ...(inputs.dateRange || {}), to: e.target.value } })} style={{ ...inputSt, colorScheme: "dark" }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>
            Posts per handle ({inputs.postsPerHandle ?? DEFAULTS.postsPerHandle})
          </label>
          <input type="range" min={5} max={50} step={5}
            value={inputs.postsPerHandle ?? DEFAULTS.postsPerHandle}
            onChange={e => onPatchInputs({ postsPerHandle: parseInt(e.target.value, 10) || DEFAULTS.postsPerHandle })}
            style={{ width: "100%", accentColor: "var(--accent)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
            <span>5</span><span>50 (max)</span>
          </div>
        </div>
      </div>

      <TranscriptSection project={project} addCompetitor={addCompetitor} addKeyword={(term) => {
        if (!term || keywords.includes(term)) return;
        onPatchInputs({ keywords: [...keywords, term] });
      }} />

      <CostEstimateBar
        handles={competitors.map(c => c.handle)}
        postsPerHandle={inputs.postsPerHandle ?? DEFAULTS.postsPerHandle}
      />
    </div>
  );
}

// ═══════════════════════════════════════════
// TRANSCRIPT SECTION — Slice 6
// Paste a meeting transcript (or Google Doc URL), run Claude extraction,
// show competitor + keyword suggestions as accept/reject chips.
// ═══════════════════════════════════════════
function TranscriptSection({ project, addCompetitor, addKeyword }) {
  const storedTranscript = project.inputs?.transcript?.text || "";
  const storedSource = project.inputs?.transcript?.source || null;
  const [transcriptText, setTranscriptText] = useState(storedTranscript);
  const [docUrl, setDocUrl] = useState("");
  const [expanded, setExpanded] = useState(!storedTranscript);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState(null);

  const suggestions = project.transcriptSuggestions;

  // Keep the textarea in sync if the stored transcript changes
  useEffect(() => {
    setTranscriptText(project.inputs?.transcript?.text || "");
  }, [project.inputs?.transcript?.text]);

  const runExtract = async ({ useGoogleDoc }) => {
    if (useGoogleDoc && !docUrl.trim()) { setError("Paste a Google Doc URL first"); return; }
    if (!useGoogleDoc && !transcriptText.trim()) { setError("Paste a transcript first"); return; }
    setExtracting(true);
    setError(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extractFromTranscript",
          projectId: project.id,
          transcript: useGoogleDoc ? undefined : transcriptText,
          googleDocUrl: useGoogleDoc ? docUrl.trim() : undefined,
        }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDocUrl("");
    } catch (e) {
      setError(e.message);
    } finally {
      setExtracting(false);
    }
  };

  const acceptCompetitor = (s, idx) => {
    const handle = s.handle || normaliseHandle(s.displayName);
    if (!handle) {
      alert(`No handle for "${s.displayName}". Add it manually above.`);
      return;
    }
    addCompetitor(handle, "transcript", s.displayName);
    // Mark accepted so the chip visually updates
    const updated = suggestions.competitors.map((x, i) => i === idx ? { ...x, accepted: true } : x);
    fbSet(`/preproduction/socialOrganic/${project.id}/transcriptSuggestions/competitors`, updated);
  };
  const dismissCompetitor = (idx) => {
    const updated = suggestions.competitors.filter((_, i) => i !== idx);
    fbSet(`/preproduction/socialOrganic/${project.id}/transcriptSuggestions/competitors`, updated);
  };
  const acceptKeyword = (s, idx) => {
    addKeyword(s.term);
    const updated = suggestions.keywords.map((x, i) => i === idx ? { ...x, accepted: true } : x);
    fbSet(`/preproduction/socialOrganic/${project.id}/transcriptSuggestions/keywords`, updated);
  };
  const dismissKeyword = (idx) => {
    const updated = suggestions.keywords.filter((_, i) => i !== idx);
    fbSet(`/preproduction/socialOrganic/${project.id}/transcriptSuggestions/keywords`, updated);
  };

  const pendingCompetitors = (suggestions?.competitors || []).filter(c => !c.accepted);
  const pendingKeywords = (suggestions?.keywords || []).filter(k => !k.accepted);

  return (
    <div style={{ marginTop: 16, padding: 14, background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>
            Pre-production meeting transcript {storedTranscript && <span style={{ fontSize: 10, color: "var(--accent)", marginLeft: 6 }}>✓ saved</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            {storedTranscript
              ? `Claude will extract competitor + keyword suggestions from this transcript. ${storedSource === "googledoc" ? "Pulled from Google Doc." : "Pasted manually."}`
              : "Paste a transcript or Google Doc URL so Claude can suggest competitors to research."}
          </div>
        </div>
        <button onClick={() => setExpanded(v => !v)} style={{ ...btnSecondary, padding: "5px 10px" }}>
          {expanded ? "Collapse" : storedTranscript ? "Edit" : "Add"}
        </button>
      </div>

      {expanded && (
        <div>
          <textarea
            value={transcriptText}
            onChange={e => setTranscriptText(e.target.value)}
            placeholder="Paste the full meeting transcript here…"
            rows={5}
            style={{ ...inputSt, resize: "vertical", fontSize: 12, fontFamily: "inherit", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
            <button onClick={() => runExtract({ useGoogleDoc: false })} disabled={extracting || !transcriptText.trim()}
              style={{ ...btnPrimary, padding: "7px 14px", fontSize: 12, opacity: (extracting || !transcriptText.trim()) ? 0.6 : 1 }}>
              {extracting ? "Extracting…" : "Extract suggestions"}
            </button>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>or</span>
            <input type="text" value={docUrl} onChange={e => setDocUrl(e.target.value)}
              placeholder="Google Doc URL — make sure 'Anyone with the link can view'"
              style={{ ...inputSt, fontSize: 12, flex: 1, minWidth: 200 }} />
            <button onClick={() => runExtract({ useGoogleDoc: true })} disabled={extracting || !docUrl.trim()}
              style={{ ...btnSecondary, padding: "7px 14px", opacity: (extracting || !docUrl.trim()) ? 0.6 : 1 }}>
              {extracting ? "Fetching…" : "Extract from Doc"}
            </button>
          </div>
          {error && (
            <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444", marginBottom: 8 }}>
              {error}
            </div>
          )}
        </div>
      )}

      {/* Suggestions chips — visible regardless of expanded state */}
      {suggestions && (pendingCompetitors.length > 0 || pendingKeywords.length > 0) && (
        <div style={{ marginTop: expanded ? 8 : 0, padding: 10, background: "var(--card)", borderRadius: 6, border: "1px dashed var(--accent)" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
            Suggestions from transcript {suggestions.generatedAt && (
              <span style={{ color: "var(--muted)", fontWeight: 500, marginLeft: 6 }}>
                {new Date(suggestions.generatedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>

          {pendingCompetitors.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase" }}>Competitors</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {pendingCompetitors.map((c, i) => {
                  const origIdx = suggestions.competitors.findIndex(x => x === c);
                  return (
                    <div key={i} title={c.reason || ""}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 4px 4px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", fontSize: 11, color: "var(--fg)" }}>
                      <span style={{ fontWeight: 600 }}>{c.handle || c.displayName}</span>
                      {c.handle && c.displayName && c.displayName !== c.handle && (
                        <span style={{ color: "var(--muted)", fontWeight: 400 }}>({c.displayName})</span>
                      )}
                      <button onClick={() => acceptCompetitor(c, origIdx)}
                        style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "none", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                        ✓ Add
                      </button>
                      <button onClick={() => dismissCompetitor(origIdx)}
                        style={{ background: "none", color: "var(--muted)", border: "none", padding: "2px 6px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {pendingKeywords.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase" }}>Keywords</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {pendingKeywords.map((k, i) => {
                  const origIdx = suggestions.keywords.findIndex(x => x === k);
                  return (
                    <div key={i} title={k.reason || ""}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 4px 4px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", fontSize: 11, color: "var(--fg)" }}>
                      <span style={{ fontWeight: 600 }}>{k.term}</span>
                      <button onClick={() => acceptKeyword(k, origIdx)}
                        style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "none", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                        ✓ Add
                      </button>
                      <button onClick={() => dismissKeyword(origIdx)}
                        style={{ background: "none", color: "var(--muted)", border: "none", padding: "2px 6px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {suggestions.formatsOfInterest?.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
              Formats of interest: <span style={{ color: "var(--fg)" }}>{suggestions.formatsOfInterest.map(f => FORMAT_LABELS[f] || f).join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// COST ESTIMATE BAR — Slice 2
// Reacts to handle/postsPerHandle changes, calls /api/social-organic?action=estimate.
// Debounced by 400ms so we don't hammer the endpoint on every input keystroke.
// ═══════════════════════════════════════════
function CostEstimateBar({ handles, postsPerHandle }) {
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Skip the request if nothing meaningful to estimate
    if (!handles.length) { setEstimate(null); setError(null); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await authFetch("/api/social-organic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "estimate", handles, postsPerHandle }),
        });
        const d = await readJsonResponse(r);
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setEstimate(d);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [JSON.stringify(handles), postsPerHandle]);

  if (!handles.length) {
    return (
      <div style={{ padding: "12px 14px", background: "var(--bg)", borderRadius: 8, border: "1px dashed var(--border)", fontSize: 11, color: "var(--muted)" }}>
        Add at least one competitor handle to see the scrape estimate.
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "12px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
        Estimate failed: {error}
      </div>
    );
  }
  if (loading && !estimate) {
    return (
      <div style={{ padding: "12px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", fontSize: 11, color: "var(--muted)" }}>
        Calculating estimate…
      </div>
    );
  }
  if (!estimate) return null;

  const overBudget = estimate.budget && (estimate.budget.spentToday + estimate.estApifyCost) > estimate.budget.budget;
  const expensive = estimate.estTotalCost > 2;
  const borderColor = overBudget ? "rgba(239,68,68,0.3)" : expensive ? "rgba(245,158,11,0.3)" : "var(--border)";
  const bgColor = overBudget ? "rgba(239,68,68,0.06)" : expensive ? "rgba(245,158,11,0.06)" : "var(--bg)";

  return (
    <div style={{ padding: "14px 16px", background: bgColor, borderRadius: 8, border: `1px solid ${borderColor}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <MetricChip label="Posts" value={estimate.estPosts} />
          <MetricChip label="Scrape" value={`$${estimate.estApifyCost.toFixed(2)}`} />
          <MetricChip label="Classify" value={`$${estimate.estClassifyCost.toFixed(2)}`} muted />
          <MetricChip label="Total" value={`$${estimate.estTotalCost.toFixed(2)}`} accent />
          <MetricChip label="Runtime" value={`~${estimate.estRuntimeSec}s`} muted />
        </div>
        {estimate.budget && (
          <div style={{ fontSize: 10, color: overBudget ? "#EF4444" : "var(--muted)", fontWeight: 600 }}>
            Today: ${estimate.budget.spentToday.toFixed(2)} / ${estimate.budget.budget.toFixed(2)}
          </div>
        )}
      </div>
      {overBudget && (
        <div style={{ fontSize: 11, color: "#EF4444", marginTop: 8, fontWeight: 600 }}>
          This scrape would exceed today's research budget. Remove handles, reduce posts per handle, or wait until tomorrow.
        </div>
      )}
      {expensive && !overBudget && (
        <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 8, fontWeight: 500 }}>
          Heads up — this is a larger-than-usual run. Scrape + classify will process every post.
        </div>
      )}
    </div>
  );
}

function MetricChip({ label, value, accent, muted }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      <span style={{ fontSize: accent ? 15 : 13, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: accent ? "var(--accent)" : muted ? "var(--muted)" : "var(--fg)" }}>{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════
// REVIEW STEP — producer ticks/crosses outperforming videos
// Phase 1 of the new workflow. Only videos are surfaced (images are out of
// scope for reels). The multiplier slider defines "outperforming" live — the
// default is 2× the handle's baseline. The current scrape uses handle-level
// baselines only (keyword/hashtag baselines flagged as out of scope).
// ═══════════════════════════════════════════
// Phase E: Tab 4 Video Format Review. Pulls from competitorScrape.posts
// (populated by /api/apify-webhook on Stage B completion). Displays the
// top 25 by overperformanceScore. Producer ticks/crosses each, optionally
// adds their own video URLs, approves → writes approvals.videoReview and
// advances to Shortlist.
function VideoReviewStep({ project, onPatch }) {
  const competitorScrape = project.competitorScrape || {};
  const posts = Array.isArray(competitorScrape.posts) ? competitorScrape.posts : [];
  const topIds = Array.isArray(competitorScrape.topOverperformers) ? competitorScrape.topOverperformers : [];
  const review = project.videoReview || {};
  const ticked = new Set(review.ticked || []);
  const crossed = new Set(review.crossed || []);
  const extraLinks = Array.isArray(review.extraLinks) ? review.extraLinks : [];
  const approvals = project.approvals || {};
  const isDone = !!approvals.videoReview;

  const [filter, setFilter] = useState("all");
  // Per-handle filter — null shows everything, otherwise only posts from
  // the matching handle. Lets producers scan one competitor at a time
  // when the pool is large.
  const [handleFilter, setHandleFilter] = useState(null);
  const [newLink, setNewLink] = useState("");
  // Sort metric + "View More" page size. Default: overperformance (the
  // score the server computed against each handle's baseline). The rest
  // sort by raw engagement counts from the scrape, so producers can find
  // the best video on the signal they care about in that moment.
  const [sortBy, setSortBy] = useState("overperformance");
  const [visibleCount, setVisibleCount] = useState(50);
  // Per-handle cap prevents one viral account (Huberman, Shaan Puri, etc.)
  // from dominating the review pool. Default 8 — keeps the top few videos
  // from every handle while reserving space for diversity. 0 = unlimited.
  const [maxPerHandle, setMaxPerHandle] = useState(
    typeof project.maxPerHandle === "number" ? project.maxPerHandle : 8
  );

  const SORT_METRICS = [
    { key: "overperformance", label: "Overperformance", pick: p => p.overperformanceScore || 0 },
    { key: "views",           label: "Views",           pick: p => p.views || 0 },
    { key: "likes",           label: "Likes",           pick: p => p.likes || 0 },
    { key: "comments",        label: "Comments",        pick: p => p.comments || 0 },
    { key: "shares",          label: "Shares",          pick: p => p.shares || p.reshares || 0 },
    { key: "engagement",      label: "Engagement",      pick: p => (p.likes || 0) + (p.comments || 0) + (p.shares || p.reshares || 0) },
  ];
  const sortMetric = SORT_METRICS.find(s => s.key === sortBy) || SORT_METRICS[0];

  // The raw posts array, sorted by the current metric. The server
  // pre-computes topOverperformers for the default "overperformance"
  // sort — we fall back to that ordering when available to keep the
  // top tiles identical to what producers saw before. Every other
  // metric sorts the whole posts array client-side.
  const sortedPosts = (() => {
    if (sortBy === "overperformance" && topIds.length > 0) {
      const byId = new Map(posts.map(p => [p.id, p]));
      const ordered = topIds.map(id => byId.get(id)).filter(Boolean);
      const rest = posts.filter(p => !topIds.includes(p.id))
        .sort((a, b) => sortMetric.pick(b) - sortMetric.pick(a));
      return [...ordered, ...rest];
    }
    return [...posts].sort((a, b) => sortMetric.pick(b) - sortMetric.pick(a));
  })();

  // Per-handle cap pass — walk the sorted list keeping the first N from
  // each handle. Zero means unlimited (the old behaviour). Applied before
  // the visibleCount slice so "show more" always reveals additional
  // diverse content, not just more of the same handle's tail.
  const cappedPosts = (() => {
    if (!maxPerHandle || maxPerHandle <= 0) return sortedPosts;
    const counts = new Map();
    const out = [];
    for (const p of sortedPosts) {
      const h = (p.handle || "unknown").toLowerCase();
      const n = counts.get(h) || 0;
      if (n >= maxPerHandle) continue;
      counts.set(h, n + 1);
      out.push(p);
    }
    return out;
  })();
  const droppedByCap = sortedPosts.length - cappedPosts.length;

  const topPosts = cappedPosts.slice(0, visibleCount);
  const hasMore = cappedPosts.length > visibleCount;

  const setStatus = (postId, status) => {
    const nextTicked = new Set(ticked);
    const nextCrossed = new Set(crossed);
    nextTicked.delete(postId);
    nextCrossed.delete(postId);
    if (status === "ticked") nextTicked.add(postId);
    else if (status === "crossed") nextCrossed.add(postId);
    fbSet(`/preproduction/socialOrganic/${project.id}/videoReview/ticked`, [...nextTicked]);
    fbSet(`/preproduction/socialOrganic/${project.id}/videoReview/crossed`, [...nextCrossed]);
  };

  const addLink = () => {
    const u = newLink.trim();
    if (!u) return;
    if (extraLinks.includes(u)) return;
    const next = [...extraLinks, u];
    fbSet(`/preproduction/socialOrganic/${project.id}/videoReview/extraLinks`, next);
    setNewLink("");
  };

  // ─── + Add competitor + ↻ Refresh widens ────────────────────────
  // Both kick off Apify runs in append mode via the appendCompetitorScrape
  // action so producers can extend the candidate pool without restarting
  // the project. Refresh widens by re-scraping ALL existing handles with
  // a bigger limit + adding a hashtag-search run on the project's
  // keywords list. Add Competitor only scrapes the new handles.
  const [addCompetitorOpen, setAddCompetitorOpen] = useState(false);
  const [addCompetitorHandles, setAddCompetitorHandles] = useState("");
  const [addCompetitorTag, setAddCompetitorTag] = useState("direct");
  const [appendBusy, setAppendBusy] = useState(false);
  const [appendError, setAppendError] = useState(null);

  const lastRefreshAt = competitorScrape.lastRefreshAt || null;
  // Posts scraped after the last refresh — drives the "X new" pill
  // each card shows when source !== initial. Pre-existing posts (from
  // the original scrape, before append-mode existed) don't have a
  // firstSeenAt and so are never counted as "new".
  const newPostIdsSet = lastRefreshAt
    ? new Set(posts.filter(p => p.firstSeenAt && p.firstSeenAt >= lastRefreshAt).map(p => p.id))
    : new Set();

  const submitAddCompetitor = async () => {
    setAppendError(null);
    const handles = addCompetitorHandles
      .split(/[,\n]/)
      .map(h => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (handles.length === 0) { setAppendError("Add at least one handle."); return; }
    setAppendBusy(true);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "addCompetitorAndScrape",
          projectId: project.id,
          handles, tag: addCompetitorTag,
          resultsLimit: 50,
        }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      setAddCompetitorOpen(false);
      setAddCompetitorHandles("");
    } catch (e) {
      setAppendError(e.message);
    } finally {
      setAppendBusy(false);
    }
  };

  const submitWiden = async () => {
    setAppendError(null);
    setAppendBusy(true);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "widenCompetitorScrape",
          projectId: project.id,
          // 60 per existing handle ≈ +20 over the initial 30-40 cut so
          // we surface the "next page" of older content without going
          // truly exhaustive. Hashtag search piggybacks on the project's
          // keywords list set during Tab 2.
          resultsLimit: 60,
          includeHashtags: true,
        }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
    } catch (e) {
      setAppendError(e.message);
    } finally {
      setAppendBusy(false);
    }
  };
  const removeLink = (u) => {
    fbSet(`/preproduction/socialOrganic/${project.id}/videoReview/extraLinks`, extraLinks.filter(x => x !== u));
  };

  const approve = () => {
    fbSet(`/preproduction/socialOrganic/${project.id}/approvals/videoReview`, new Date().toISOString());
    onPatch({ tab: "shortlist" });
  };

  // Counts per handle for the chip row. Computed against the capped
  // pool (not topPosts) so the count reflects what's available beyond
  // the current visibleCount slice — clicking a handle chip widens the
  // pool to show all of that handle's posts.
  const handleCounts = (() => {
    const counts = new Map();
    for (const p of cappedPosts) {
      const h = p.handle || "@unknown";
      counts.set(h, (counts.get(h) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();

  let filtered = topPosts;
  if (handleFilter) filtered = cappedPosts.filter(p => p.handle === handleFilter);
  if (filter === "ticked")     filtered = filtered.filter(p => ticked.has(p.id));
  else if (filter === "crossed")   filtered = filtered.filter(p => crossed.has(p.id));
  else if (filter === "unreviewed") filtered = filtered.filter(p => !ticked.has(p.id) && !crossed.has(p.id));

  const scrapeStatus = competitorScrape.status;
  const scrapeRunning = scrapeStatus === "running" && posts.length === 0;
  const scrapeErrored = scrapeStatus === "error";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Video Format Review</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Top {topPosts.length} over-performing competitor videos from the Stage B scrape ({posts.length} total scraped). Tick the ones worth shortlisting, cross the rest, optionally add your own picks at the bottom.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            ✓ {ticked.size} · ✗ {crossed.size} · {topPosts.length + extraLinks.length - ticked.size - crossed.size} unreviewed
          </span>
          {/* Append-mode actions — extend the candidate pool without
              restarting. + Add competitor scrapes one or more new handles;
              ↻ Refresh widens re-runs the existing handles deeper plus a
              hashtag search on the project keywords. Both append, never
              replace. */}
          <button onClick={() => setAddCompetitorOpen(o => !o)} disabled={appendBusy}
            style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11, opacity: appendBusy ? 0.6 : 1 }}>
            + Add competitor
          </button>
          <button onClick={submitWiden} disabled={appendBusy}
            title="Re-runs the scrape on existing handles (deeper) plus a hashtag search using your keywords. Results append to the pool."
            style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11, opacity: appendBusy ? 0.6 : 1 }}>
            {appendBusy ? "Working…" : "↻ Refresh widens"}
          </button>
        </div>
      </div>

      {/* Inline + Add competitor form. Slides in below the header so it
          doesn't take over the page; submitting kicks off an Apify run
          in append mode. Producers can paste multiple handles
          comma- or newline-separated. */}
      {addCompetitorOpen && (
        <div style={{ marginBottom: 14, padding: 14, background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Add new competitor handle(s)</div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 10 }}>
            One or more Instagram handles, separated by commas or newlines. Apify scrapes them and the results append to the existing pool.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 0, background: "var(--bg)", borderRadius: 6, padding: 2, border: "1px solid var(--border)" }}>
              <button onClick={() => setAddCompetitorTag("direct")}
                style={{ padding: "4px 10px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: addCompetitorTag === "direct" ? "rgba(34,197,94,0.2)" : "transparent", color: addCompetitorTag === "direct" ? "#22C55E" : "var(--muted)" }}>
                Direct
              </button>
              <button onClick={() => setAddCompetitorTag("inspiration")}
                style={{ padding: "4px 10px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: addCompetitorTag === "inspiration" ? "rgba(168,85,247,0.2)" : "transparent", color: addCompetitorTag === "inspiration" ? "#A855F7" : "var(--muted)" }}>
                Inspiration
              </button>
            </div>
            <textarea value={addCompetitorHandles} onChange={e => setAddCompetitorHandles(e.target.value)}
              placeholder="@brandone, @brandtwo&#10;@brandthree"
              rows={2}
              style={{ ...inputSt, flex: 1, fontSize: 12, fontFamily: "'JetBrains Mono',monospace", resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={submitAddCompetitor} disabled={appendBusy || !addCompetitorHandles.trim()}
              style={{ ...btnPrimary, opacity: (appendBusy || !addCompetitorHandles.trim()) ? 0.5 : 1 }}>
              {appendBusy ? "Scraping…" : "Add and scrape"}
            </button>
            <button onClick={() => { setAddCompetitorOpen(false); setAddCompetitorHandles(""); setAppendError(null); }} style={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {appendError && (
        <div style={{ marginBottom: 14, padding: "8px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, fontSize: 11, color: "#EF4444" }}>
          {appendError}
        </div>
      )}

      {/* Refresh-status banner — shows when an append-mode run is
          mid-flight, AND a recap of "N new posts since last refresh"
          afterwards so producers can spot what changed. */}
      {newPostIdsSet.size > 0 && (
        <div style={{ marginBottom: 12, padding: "6px 12px", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.3)", borderRadius: 6, fontSize: 11, color: "#3B82F6", display: "inline-block" }}>
          {newPostIdsSet.size} new post{newPostIdsSet.size === 1 ? "" : "s"} since last refresh
        </div>
      )}

      {scrapeRunning && (
        <div style={{ padding: 14, marginBottom: 14, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.3)", borderRadius: 8, fontSize: 12, color: "#3B82F6" }}>
          Competitor scrape still running… the top 50 will appear here once Apify finishes.
        </div>
      )}
      {scrapeErrored && (
        <div style={{ padding: 14, marginBottom: 14, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: "#EF4444" }}>
          Competitor scrape errored: {competitorScrape.error || "(no detail)"}. Go back to Tab 2 and retry Stage B.
        </div>
      )}

      {/* Per-handle filter chips — one chip per competitor handle in the
          pool, sorted by post count. Click to isolate that handle. */}
      {topPosts.length > 0 && handleCounts.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          <FilterChip label={`All handles (${cappedPosts.length})`} active={!handleFilter} onClick={() => setHandleFilter(null)} />
          {handleCounts.map(([h, n]) => (
            <FilterChip
              key={h}
              label={`${h} (${n})`}
              active={handleFilter === h}
              onClick={() => setHandleFilter(handleFilter === h ? null : h)}
            />
          ))}
        </div>
      )}

      {/* Status filter chips + sort selector */}
      {topPosts.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <FilterChip label={`All (${filtered.length})`} active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterChip label={`✓ Ticked (${ticked.size})`} active={filter === "ticked"} colour="#22C55E" onClick={() => setFilter("ticked")} />
            <FilterChip label={`✗ Crossed (${crossed.size})`} active={filter === "crossed"} colour="#EF4444" onClick={() => setFilter("crossed")} />
            <FilterChip label={`Unreviewed`} active={filter === "unreviewed"} onClick={() => setFilter("unreviewed")} />
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {/* Per-handle cap — prevents one viral account from dominating. */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }} title="Max videos to show from any single handle. Prevents a viral account from dominating the pool.">
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Max / handle</label>
              <select value={maxPerHandle} onChange={e => { const v = parseInt(e.target.value, 10); setMaxPerHandle(v); onPatch({ maxPerHandle: v }); setVisibleCount(50); }}
                style={{ ...inputSt, width: "auto", fontSize: 12, padding: "5px 8px" }}>
                <option value={0}>Unlimited</option>
                <option value={3}>3</option>
                <option value={5}>5</option>
                <option value={6}>6</option>
                <option value={8}>8</option>
                <option value={10}>10</option>
                <option value={15}>15</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Sort</label>
              <select value={sortBy} onChange={e => { setSortBy(e.target.value); setVisibleCount(50); }}
                style={{ ...inputSt, width: "auto", fontSize: 12, padding: "5px 8px" }}>
                {SORT_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}
      {droppedByCap > 0 && (
        <div style={{ marginBottom: 10, fontSize: 11, color: "var(--muted)" }}>
          {droppedByCap} video{droppedByCap === 1 ? "" : "s"} hidden by per-handle cap — raise it above if you want to see more from the dominant accounts.
        </div>
      )}

      {/* Top-N grid — visibleCount starts at 25, "View more" bumps to show more. */}
      {topPosts.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 14 }}>
            {filtered.map(p => {
              const status = ticked.has(p.id) ? "ticked" : crossed.has(p.id) ? "crossed" : null;
              return (
                <ReviewCard key={p.id} post={p}
                  status={status}
                  onTick={() => setStatus(p.id, "ticked")}
                  onCross={() => setStatus(p.id, "crossed")}
                  isNew={newPostIdsSet.has(p.id)}
                />
              );
            })}
            {filtered.length === 0 && (
              <div style={{ gridColumn: "1 / -1", padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                No videos match this filter.
              </div>
            )}
          </div>
          {/* View more — stepping 25 videos at a time so the DOM doesn't
              choke on hundreds of IG embed iframes at once. */}
          {hasMore && filter === "all" && (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
              <button onClick={() => setVisibleCount(v => v + 25)} style={btnSecondary}>
                View more ({sortedPosts.length - visibleCount} remaining)
              </button>
            </div>
          )}
        </>
      )}

      {/* Extra links — producer can paste their own picks */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Extra video links ({extraLinks.length})</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
          Already have a reel in mind that the scrape didn't surface? Paste the Instagram / TikTok / YouTube URL and it carries through to Shortlist.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {extraLinks.map(u => (
            <span key={u} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 360 }}>
              <a href={u} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {u.replace(/^https?:\/\//, "").slice(0, 40)}{u.length > 50 ? "…" : ""}
              </a>
              {!isDone && <button onClick={() => removeLink(u)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>}
            </span>
          ))}
          {extraLinks.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>None yet.</span>}
        </div>
        {!isDone && (
          <div style={{ display: "flex", gap: 6 }}>
            <input type="url" value={newLink} onChange={e => setNewLink(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
              placeholder="https://www.instagram.com/reel/..."
              style={{ ...inputSt, fontSize: 12, flex: 1 }} />
            <button onClick={addLink} disabled={!newLink.trim()}
              style={{ ...btnSecondary, padding: "6px 14px", opacity: newLink.trim() ? 1 : 0.5 }}>Add</button>
          </div>
        )}
      </div>

      {!isDone && (
        <button onClick={approve}
          disabled={ticked.size === 0 && extraLinks.length === 0}
          title={ticked.size === 0 && extraLinks.length === 0 ? "Tick at least one video (or add an extra link)" : "Approve and move to Shortlist"}
          style={{ ...btnPrimary, opacity: (ticked.size === 0 && extraLinks.length === 0) ? 0.5 : 1 }}>
          Approve → Shortlist ({ticked.size + extraLinks.length})
        </button>
      )}
      {isDone && (
        <div style={{ padding: 14, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, fontSize: 12, color: "#22C55E", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <span>✓ Approved {new Date(approvals.videoReview).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
          <button onClick={() => onPatch({ tab: "shortlist" })} style={btnPrimary}>→ Shortlist</button>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, colour, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)",
      background: active ? (colour || "var(--accent)") : "var(--bg)",
      color: active ? "#fff" : colour || "var(--muted)",
      fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
    }}>{label}</button>
  );
}

// Ticked → green border. Crossed → dimmed + strikethrough. Unreviewed → neutral.
// memo'd because the parent re-renders on every tick/cross/sort change
// but only the affected card actually needs to update — without memo
// every IG embed iframe re-renders, dropping frame rate to a crawl.
const ReviewCard = memo(function ReviewCard({ post, status, onTick, onCross, isNew }) {
  const isTicked = status === "ticked";
  const isCrossed = status === "crossed";
  // Highlight new-since-last-refresh cards with a subtle blue ring so
  // producers can spot what changed after hitting "↻ Refresh widens".
  const border = isTicked ? "2px solid #22C55E"
                : isNew ? "2px solid rgba(59,130,246,0.6)"
                : "1px solid var(--border)";
  const opacity = isCrossed ? 0.45 : 1;
  const textDeco = isCrossed ? "line-through" : "none";

  // Source pill — distinguishes "came from a tracked competitor handle"
  // from "came from a hashtag search". Only shown on cards that have a
  // source value (older posts pre-date the field and stay unmarked).
  const sourcePill = post.source === "hashtag"
    ? { bg: "rgba(168,85,247,0.85)", label: "#hashtag" }
    : post.source === "handle"
    ? { bg: "rgba(59,130,246,0.85)", label: "@handle" }
    : null;

  return (
    <div style={{ background: "var(--card)", border, borderRadius: 10, overflow: "hidden", opacity, transition: "opacity 0.15s, border 0.15s", position: "relative" }}>
      <div style={{ position: "relative" }}>
        <ReelPreview shortCode={post.shortCode} url={post.url} thumbnail={post.thumbnail} aspectRatio="9 / 16" />
        {post.overperformanceScore != null && (
          <div style={{ position: "absolute", bottom: 6, left: 6, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", background: "rgba(34,197,94,0.85)", color: "#fff", zIndex: 2 }}>
            {post.overperformanceScore.toFixed(1)}× avg
          </div>
        )}
        {sourcePill && (
          <div style={{ position: "absolute", top: 6, left: 6, padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", background: sourcePill.bg, color: "#fff", zIndex: 2 }}>
            {sourcePill.label}
          </div>
        )}
        {isNew && (
          <div style={{ position: "absolute", top: 6, right: 6, padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 800, background: "rgba(59,130,246,0.85)", color: "#fff", zIndex: 2 }}>
            NEW
          </div>
        )}
      </div>
      <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", textDecoration: "none" }}>
        <div style={{ padding: 10, textDecoration: textDeco }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 3 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>{post.handle}</div>
            {post.format && <div style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>{FORMAT_LABELS[post.format] || post.format}</div>}
          </div>
          <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", marginBottom: 6 }}>
            {post.views != null && <span>👁 {formatBig(post.views)}</span>}
            <span>❤ {formatBig(post.likes)}</span>
            <span>💬 {formatBig(post.comments)}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg)", lineHeight: 1.4, maxHeight: 44, overflow: "hidden", textOverflow: "ellipsis" }}>
            {(post.caption || "").slice(0, 140)}{(post.caption || "").length > 140 ? "…" : ""}
          </div>
        </div>
      </a>
      {/* Tick/cross bar — outside the <a> so clicks don't open the IG link */}
      <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--border)" }}>
        <button onClick={onTick} title="Tick — keep for shortlist"
          style={{
            flex: 1, padding: "8px 0", border: "none", borderRight: "1px solid var(--border)",
            background: isTicked ? "rgba(34,197,94,0.15)" : "transparent",
            color: isTicked ? "#22C55E" : "var(--muted)",
            fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>✓</button>
        <button onClick={onCross} title="Cross — not a fit"
          style={{
            flex: 1, padding: "8px 0", border: "none",
            background: isCrossed ? "rgba(239,68,68,0.15)" : "transparent",
            color: isCrossed ? "#EF4444" : "var(--muted)",
            fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>✗</button>
      </div>
    </div>
  );
});

// ═══════════════════════════════════════════
// SHORTLIST STEP — per-video form writes to the global Format Library
// Two-column layout: left = ticked videos (click to select), right = the
// edit form. Saving creates /formatLibrary/{id} (new) or appends a new
// example to an existing library entry. The project's
// shortlistedFormats/{sl_<videoId>} record links the two together so re-
// opening the project restores edits.
// ═══════════════════════════════════════════
function ShortlistStep({ project, onPatch }) {
  // Schema: competitor videos come from competitorScrape.posts + the producer
  // may have added extra links that aren't in any scrape. We unify into a
  // single "candidates" list — extra links get stub post objects so the UI
  // can render them with the same card shape.
  const competitorPosts = Array.isArray(project.competitorScrape?.posts) ? project.competitorScrape.posts : [];
  const review = project.videoReview || {};
  const tickedIds = new Set(review.ticked || []);
  const extraLinks = Array.isArray(review.extraLinks) ? review.extraLinks : [];
  const shortlisted = project.shortlistedFormats || {};

  const tickedPosts = competitorPosts.filter(p => p.isVideo && tickedIds.has(p.id));
  const extraAsPosts = extraLinks.map(url => ({
    id: `ext_${url.replace(/[^a-zA-Z0-9]/g, "").slice(-16)}`,
    url, handle: "(extra)", caption: "", isVideo: true, thumbnail: null,
    views: null, overperformanceScore: null,
    _isExtraLink: true,
  }));
  const tickedVideos = [...tickedPosts, ...extraAsPosts];

  // Global format library — listened to live so the "Add as example"
  // picker sees new library entries from other projects in real time.
  const [library, setLibrary] = useState({});
  useEffect(() => fbListenSafe("/formatLibrary", (d) => setLibrary(d || {})), []);

  // Which video is active in the right-hand form. Default to the first
  // ticked video that hasn't been shortlisted yet.
  const [activeId, setActiveId] = useState(null);
  useEffect(() => {
    if (activeId) return;
    const unshortlisted = tickedVideos.find(v => !shortlisted[`sl_${v.id}`]);
    setActiveId((unshortlisted || tickedVideos[0])?.id || null);
  }, [activeId, tickedVideos, shortlisted]);

  const activeVideo = tickedVideos.find(v => v.id === activeId) || null;
  const existingShortlist = activeVideo ? shortlisted[`sl_${activeVideo.id}`] || null : null;

  // Filter shortlist entries to only those whose source video is still
  // in the ticked / extra-links set. When a producer goes back to Tab 4
  // and unticks, we don't delete the shortlist entry (producer may want
  // to re-tick and recover their description), but we DO stop counting
  // it so the Shortlist progress counter reflects reality.
  const validVideoIds = new Set(tickedVideos.map(v => v.id));
  const allShortlisted = Object.values(shortlisted || {})
    .filter(s => s && s.videoId && validVideoIds.has(s.videoId));
  const canAdvance = allShortlisted.length > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Back-to-Tab-4 signpost — producers asked for an obvious path
              back when they realise mid-shortlist they want to add more
              competitor reels to the candidate pool. Tabs aren't gated;
              this is just a clearer way back. */}
          <button onClick={() => onPatch({ tab: "videoReview" })} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11 }}>
            ← Back to Video Review
          </button>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Shortlist</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              Each ticked video becomes an entry in the global Format Library — or gets added as a new example to an existing format.
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {allShortlisted.length}/{tickedVideos.length} shortlisted
          {canAdvance && (
            <button onClick={() => {
              fbSet(`/preproduction/socialOrganic/${project.id}/approvals/shortlist`, new Date().toISOString());
              onPatch({ tab: "select" });
            }} style={{ ...btnPrimary, marginLeft: 10, padding: "6px 14px" }}>
              → Select ({allShortlisted.length})
            </button>
          )}
        </div>
      </div>

      {tickedVideos.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>No ticked videos yet</div>
          <div style={{ fontSize: 11 }}>Go back to Review and tick the videos worth shortlisting.</div>
          <button onClick={() => onPatch({ tab: "videoReview" })} style={{ ...btnSecondary, marginTop: 12 }}>← Back to Video Review</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 16 }}>
          {/* Left: ticked videos list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "70vh", overflowY: "auto" }}>
            {tickedVideos.map(v => {
              const hasEntry = !!shortlisted[`sl_${v.id}`];
              const isActive = activeId === v.id;
              return (
                <button key={v.id}
                  onClick={() => setActiveId(v.id)}
                  style={{
                    textAlign: "left", padding: 8, borderRadius: 8,
                    border: isActive ? "2px solid var(--accent)" : "1px solid var(--border)",
                    background: "var(--card)", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", gap: 10, alignItems: "center",
                  }}>
                  <div style={{ width: 56, height: 56, flexShrink: 0, borderRadius: 4, overflow: "hidden" }}>
                    <ReelPreview shortCode={v.shortCode} url={v.url} thumbnail={v.thumbnail} aspectRatio="1 / 1" compact />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginBottom: 2 }}>{v.handle}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {(v.caption || "").slice(0, 50) || "(no caption)"}
                    </div>
                    {hasEntry && <div style={{ fontSize: 9, color: "#22C55E", fontWeight: 700, marginTop: 3 }}>✓ Saved</div>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: edit form */}
          <div>
            {activeVideo ? (
              <ShortlistForm
                key={activeVideo.id}
                video={activeVideo}
                project={project}
                library={library}
                existing={existingShortlist}
                onSaved={() => {
                  // Auto-advance to the next unshortlisted video on save.
                  const next = tickedVideos.find(v => !shortlisted[`sl_${v.id}`] && v.id !== activeVideo.id);
                  if (next) setActiveId(next.id);
                }}
              />
            ) : (
              <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                Pick a video on the left to start describing it.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The actual form. Split out so that choosing a new video fully remounts it
// via key={activeVideo.id} (no stale field state when switching).
function ShortlistForm({ video, project, library, existing, onSaved }) {
  const mode = existing?.addedAsExampleTo ? "example" : existing?.formatLibraryId ? "new" : "new";
  const [saveMode, setSaveMode] = useState(mode);  // "new" | "example"
  const [formatName, setFormatName] = useState(existing?.formatName || "");
  const [tags, setTags] = useState(existing?.tags || []);
  const [tagInput, setTagInput] = useState("");
  // Old records had three textareas: description (videoAnalysis), filming
  // instructions, and structure. We collapsed those into a single
  // Video Analysis box. On open of any record that has the legacy fields
  // populated, merge them in once so producers see all the captured
  // context — they can edit it down on save.
  const [description, setDescription] = useState(() => {
    const d = (existing?.description || "").trim();
    const f = (existing?.filmingInstructions || "").trim();
    const s = (existing?.structureInstructions || "").trim();
    if (!f && !s) return d;
    const parts = [d];
    if (f) parts.push(`\nFilming: ${f}`);
    if (s) parts.push(`\nStructure: ${s}`);
    return parts.filter(Boolean).join("\n");
  });
  const [addTargetId, setAddTargetId] = useState(existing?.addedAsExampleTo || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const libraryList = Object.values(library || {})
    .filter(f => f && f.id && !f.archived)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const addTag = (raw) => {
    const t = (raw || "").trim().replace(/^#/, "");
    if (!t) return;
    if (tags.includes(t)) return;
    setTags([...tags, t]);
    setTagInput("");
  };

  const save = async () => {
    setSaveError(null);
    try {
      if (saveMode === "example") {
        if (!addTargetId) { setSaveError("Pick a format to add this example to."); return; }
      } else {
        if (!formatName.trim()) { setSaveError("Give the format a name."); return; }
      }
      setSaving(true);

      const now = new Date().toISOString();
      const createdBy = getCurrentRole() || "unknown";

      let libraryId;
      if (saveMode === "example") {
        // Append to existing format's examples[] (read-modify-write — accept
        // the mild race window; worst case is a duplicate example entry).
        libraryId = addTargetId;
        const existingFmt = library[libraryId] || null;
        if (!existingFmt) { setSaveError("Target format not found (it may have been archived)."); setSaving(false); return; }
        const examples = Array.isArray(existingFmt.examples) ? existingFmt.examples : [];
        const alreadyIn = examples.some(e => e.videoId === video.id || e.url === video.url);
        if (!alreadyIn) {
          const newExamples = [
            ...examples,
            {
              videoId: video.id,
              url: video.url,
              thumbnail: video.thumbnail || null,
              viewCount: video.views || null,
              sourceAccount: video.handle,
              sourceProjectId: project.id,
              sourceClient: project.companyName,
              addedAt: now,
              addedBy: createdBy,
            },
          ];
          fbSet(`/formatLibrary/${libraryId}/examples`, newExamples);
          // Bump usageCount best-effort (read-modify-write; fine for cosmetic counter).
          fbSet(`/formatLibrary/${libraryId}/usageCount`, (existingFmt.usageCount || 0) + 1);
        }
      } else {
        // Create or update a library entry scoped to this shortlist. If the
        // user saves twice on the same video, we reuse the same libraryId so
        // we never orphan entries.
        libraryId = existing?.formatLibraryId || `fmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const libEntry = {
          id: libraryId,
          // Partition tag — Social Organic shortlists always land in
          // the "organic" half of the Format Library. Meta Ads pre-prod
          // will tag its own shortlists "metaAds" when that flow ships.
          formatType: "organic",
          name: formatName.trim(),
          videoAnalysis: description,
          // Legacy: filmingInstructions + structureInstructions used to be
          // two extra textareas on this form. Producers asked for one
          // unified Video Analysis box, so the merge happens at form-open
          // time (see useState initializer above) and we just blank the
          // old fields here so they fade out of the schema over time.
          filmingInstructions: "",
          structureInstructions: "",
          tags,
          examples: [
            {
              videoId: video.id,
              url: video.url,
              thumbnail: video.thumbnail || null,
              viewCount: video.views || null,
              sourceAccount: video.handle,
              sourceProjectId: project.id,
              sourceClient: project.companyName,
              addedAt: now,
              addedBy: createdBy,
            },
          ],
          sourceProjectId: project.id,
          sourceClient: project.companyName,
          createdAt: existing?.libraryCreatedAt || now,
          createdBy,
          usageCount: library[libraryId]?.usageCount || 0,
          archived: false,
        };
        fbSet(`/formatLibrary/${libraryId}`, libEntry);
      }

      // Write the project-side shortlist record. We copy the video's own
      // thumbnail / URL / shortCode onto this record so the downstream Tab 6
      // Select step can render a reliable preview even when the library
      // example's scraped thumbnail URL has expired (Apify IG CDN URLs die
      // after ~24h; embedding the shortCode always works).
      const shortlistId = `sl_${video.id}`;
      fbSet(`/preproduction/socialOrganic/${project.id}/shortlistedFormats/${shortlistId}`, {
        videoId: video.id,
        videoUrl: video.url || null,
        videoShortCode: video.shortCode || null,
        thumbnail: video.thumbnail || null,
        formatName: saveMode === "new" ? formatName.trim() : (library[libraryId]?.name || ""),
        description,
        // Legacy fields kept blank in fresh writes — merged into description
        // at form-open time (see useState initializer above).
        filmingInstructions: "",
        structureInstructions: "",
        tags,
        formatLibraryId: libraryId,
        addedAsExampleTo: saveMode === "example" ? libraryId : null,
        libraryCreatedAt: existing?.libraryCreatedAt || now,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        createdBy,
      });

      setSaving(false);
      onSaved?.();
    } catch (e) {
      console.error(e);
      setSaveError(e.message || "Save failed");
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 16, alignItems: "start" }}>
      {/* Left column — full reel embed pinned to the top of the visible area
          so the producer can scrub through it while writing analysis on
          the right. Sticky lets it stay in view as the form scrolls.
          Click-through to IG kept as a small footer link. */}
      <div style={{ position: "sticky", top: 12, alignSelf: "start" }}>
        <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
          <ReelPreview shortCode={video.shortCode} url={video.url} thumbnail={video.thumbnail} aspectRatio="9 / 16" />
        </div>
        <div style={{ padding: "8px 4px 0", fontSize: 11, color: "var(--muted)" }}>
          <div style={{ color: "var(--accent)", fontWeight: 700, marginBottom: 3 }}>{video.handle}</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace" }}>
            {video.views != null && `👁 ${formatBig(video.views)}`}
            {video.overperformanceScore != null && ` · ${video.overperformanceScore.toFixed(1)}× baseline`}
          </div>
          {video.caption && (
            <div style={{ fontSize: 10, marginTop: 6, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {video.caption}
            </div>
          )}
          <a href={video.url} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", marginTop: 6, fontSize: 10, color: "var(--accent)", textDecoration: "none", fontWeight: 700 }}>
            Open on Instagram ↗
          </a>
        </div>
      </div>

      {/* Right column — form fields. Wrap so the existing fields below
          this header just flow into the right grid cell. */}
      <div>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, padding: 4, background: "var(--bg)", borderRadius: 6 }}>
        <ModeToggle label="New format" active={saveMode === "new"} onClick={() => setSaveMode("new")} />
        <ModeToggle label="Add as example" active={saveMode === "example"} onClick={() => setSaveMode("example")} disabled={libraryList.length === 0} />
      </div>

      {saveMode === "example" ? (
        <div>
          <Label>Add as example to</Label>
          <select value={addTargetId} onChange={e => setAddTargetId(e.target.value)} style={inputSt}>
            <option value="">— pick a format —</option>
            {libraryList.map(f => (
              <option key={f.id} value={f.id}>
                {f.name}
                {Array.isArray(f.examples) && f.examples.length > 0 && ` (${f.examples.length} example${f.examples.length === 1 ? "" : "s"})`}
              </option>
            ))}
          </select>
          {addTargetId && library[addTargetId] && (
            <div style={{ marginTop: 10, padding: 10, background: "var(--bg)", borderRadius: 6, fontSize: 11, color: "var(--muted)" }}>
              <div style={{ fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>{library[addTargetId].name}</div>
              <div style={{ lineHeight: 1.5 }}>{(library[addTargetId].videoAnalysis || "").slice(0, 200)}{(library[addTargetId].videoAnalysis || "").length > 200 ? "…" : ""}</div>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: 10 }}>
            <Label>Format name</Label>
            <input type="text" value={formatName} onChange={e => setFormatName(e.target.value)}
              placeholder="e.g. Subject Matter Expert Ranks X"
              style={inputSt} />
          </div>

          {/* Category field removed per workflow spec — the Format Library
              categorisation in Tab 6 (Suggested / Recently Added / Over
              Performers) doesn't depend on a per-format category, so there's
              no reason to make producers pick one here. */}
          <div style={{ marginBottom: 10 }}>
            <Label>Tags</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4, minHeight: 24 }}>
              {tags.map(t => (
                <span key={t} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {t}
                  <button onClick={() => setTags(tags.filter(x => x !== t))} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
            <input type="text" value={tagInput} onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagInput); } }}
              onBlur={() => tagInput.trim() && addTag(tagInput)}
              placeholder="Press enter to add"
              style={{ ...inputSt, fontSize: 11 }} />
          </div>

          <DescriptionField
            label="Video analysis"
            hint="What's happening in the video? Why does it work? Note the structure (hook → beats → close), how it's filmed, and any production cues you'd want to replicate. Dictation supported — click the mic."
            value={description}
            onChange={setDescription}
            rows={8}
          />
        </div>
      )}

      {saveError && (
        <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
          {saveError}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : existing ? "Update" : saveMode === "example" ? "Add example" : "Save to library"}
        </button>
      </div>
      </div>{/* /right column */}
    </div>
  );
}

function Label({ children }) {
  return (
    <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 5 }}>
      {children}
    </label>
  );
}

function ModeToggle({ label, active, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        flex: 1, padding: "6px 10px", borderRadius: 4, border: "none",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : disabled ? "var(--muted)" : "var(--fg)",
        fontSize: 11, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit", opacity: disabled ? 0.5 : 1,
      }}>
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════
// SCRIPT BUILDER STEP (Phase 5)
// Claude generates a structured preproduction doc from the selected formats;
// every cell opens the AI / manual rewrite modal. Mirrors the Meta Ads
// per-cell UX exactly (src/components/Preproduction.jsx:413-480).
// ═══════════════════════════════════════════
const SCRIPT_COLUMNS = [
  { key: "formatName",   label: "Format",        width: 140, editable: false },
  { key: "contentStyle", label: "Content Style", width: 180 },
  { key: "hook",         label: "Hook (spoken)", width: 200 },
  { key: "textHook",     label: "Text Hook",     width: 140 },
  { key: "visualHook",   label: "Visual Hook",   width: 160 },
  { key: "scriptNotes",  label: "Script / Notes",width: 260 },
  { key: "props",        label: "Props",         width: 100 },
];

// ═══════════════════════════════════════════════════════════════════
// TAB 7 — IDEA SELECTION (between Format Selection and Scripting)
//
// Producers used to split "how many videos per format" manually on
// the Format Selection tab. That was noisy and usually wrong. The
// new flow:
//   1. Click Generate → Claude produces 10 idea concepts per selected
//      format (hook angle + premise, one-liner each). Stored at
//      /preproduction/socialOrganic/{id}/formatIdeas[{formatLibraryId}].ideas
//   2. Producer ticks the ideas they want to progress. Cap = round's
//      numberOfVideos. Tick counter colours red when over the cap.
//   3. Approve → moves to Scripting. ScriptStep reads the ticked
//      ideas and writes one script row per idea, using the idea text
//      as the "scriptNotes" seed that Claude expands into the full
//      7-column blueprint.
// ═══════════════════════════════════════════════════════════════════
function IdeaSelectionStep({ project, onPatch }) {
  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  const formatIdeas = project.formatIdeas || {};
  const numberOfVideos = project.numberOfVideos || 0;
  const [genError, setGenError] = useState(null);
  const approvals = project.approvals || {};
  const isApproved = !!approvals.ideaSelect;

  // `generating` is derived from Firebase so it survives tab-switching
  // during the ~15-30s Claude run. Server sets formatIdeasProcessingAt
  // on start, clears on completion. Stale flag (>5min old) is ignored
  // client-side so a crashed run doesn't pin the spinner forever.
  const processingAt = project.formatIdeasProcessingAt || null;
  const generating = !!processingAt && (Date.now() - new Date(processingAt).getTime() < 5 * 60 * 1000);

  // Library lookup for format names. Listen so new formats appear
  // immediately after being added in a sibling tab.
  const [library, setLibrary] = useState({});
  useEffect(() => fbListenSafe("/formatLibrary", d => setLibrary(d || {})), []);

  // Every selected format's idea count (tot ideas + tot ticked) +
  // the grand totals for the cap counter.
  const formatSummaries = selected.map(s => {
    const ideas = formatIdeas[s.formatLibraryId]?.ideas || [];
    const ticked = ideas.filter(i => i && i.selected).length;
    return {
      formatLibraryId: s.formatLibraryId,
      name: library[s.formatLibraryId]?.name || s.formatLibraryId,
      ideas,
      ticked,
    };
  });
  const totalTicked = formatSummaries.reduce((sum, f) => sum + f.ticked, 0);
  const capReached = numberOfVideos > 0 && totalTicked >= numberOfVideos;
  const capExceeded = numberOfVideos > 0 && totalTicked > numberOfVideos;

  const allGenerated = selected.length > 0 && selected.every(s => (formatIdeas[s.formatLibraryId]?.ideas || []).length > 0);
  const hasAnyGenerated = selected.some(s => (formatIdeas[s.formatLibraryId]?.ideas || []).length > 0);

  const generate = async () => {
    setGenError(null);
    try {
      // Set the processing flag client-side too so the spinner snaps
      // on immediately (don't wait for the server to write it).
      fbSet(`/preproduction/socialOrganic/${project.id}/formatIdeasProcessingAt`, new Date().toISOString());
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generateFormatIdeas", projectId: project.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) {
        fbSet(`/preproduction/socialOrganic/${project.id}/formatIdeasProcessingAt`, null);
        throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      }
      // Firebase listener rehydrates formatIdeas + clears flag.
    } catch (e) {
      setGenError(e.message);
    }
  };

  const toggleIdea = (formatLibraryId, ideaIdx) => {
    const ideas = formatIdeas[formatLibraryId]?.ideas || [];
    if (!ideas[ideaIdx]) return;
    // Block ticking if we'd exceed the cap. Un-ticking always allowed.
    const currentlySelected = !!ideas[ideaIdx].selected;
    if (!currentlySelected && capReached) return;
    const next = ideas.map((idea, i) => i === ideaIdx ? { ...idea, selected: !currentlySelected } : idea);
    fbSet(`/preproduction/socialOrganic/${project.id}/formatIdeas/${formatLibraryId}/ideas`, next);
  };

  const approve = () => {
    fbSet(`/preproduction/socialOrganic/${project.id}/approvals/ideaSelect`, new Date().toISOString());
    onPatch({ tab: "script" });
  };

  const canApprove = totalTicked > 0 && !capExceeded;

  return (
    <div>
      {/* Header card — generate button + cap counter */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Idea Selection</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, maxWidth: 560 }}>
              Claude generates 10 ideas per selected format from the approved Brand Truth + format structure. Tick the ones worth shooting. The total must not exceed your round's video count.
              {numberOfVideos > 0 && ` This round: ${numberOfVideos} videos.`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {numberOfVideos > 0 && (
              <div style={{ padding: "6px 12px", borderRadius: 6, background: capExceeded ? "rgba(239,68,68,0.12)" : capReached ? "rgba(16,185,129,0.12)" : "var(--bg)", border: `1px solid ${capExceeded ? "rgba(239,68,68,0.4)" : capReached ? "rgba(16,185,129,0.4)" : "var(--border)"}`, fontSize: 12, fontWeight: 700, color: capExceeded ? "#EF4444" : capReached ? "#10B981" : "var(--fg)", fontFamily: "'JetBrains Mono', monospace" }}>
                {totalTicked} / {numberOfVideos} ticked {capExceeded ? "(over cap)" : capReached ? "✓" : ""}
              </div>
            )}
            <button onClick={generate} disabled={generating || selected.length === 0}
              style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: generating ? "#4B5563" : selected.length === 0 ? "#374151" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: (generating || selected.length === 0) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (generating || selected.length === 0) ? 0.6 : 1 }}>
              {generating ? "Generating…" : hasAnyGenerated ? "Regenerate ideas" : "Generate 10 ideas per format"}
            </button>
          </div>
        </div>
        {genError && (
          <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: "#EF4444" }}>
            {genError}
          </div>
        )}
      </div>

      {/* Per-format idea grid */}
      {selected.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12, color: "var(--muted)", fontSize: 12 }}>
          No formats selected yet. Go back to Format Selection and drag a few formats into the selected pool first.
        </div>
      ) : !hasAnyGenerated ? (
        <div style={{ padding: 30, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12, color: "var(--muted)", fontSize: 12 }}>
          Click <strong>Generate 10 ideas per format</strong> to get started. Claude uses the approved Brand Truth to write concept ideas specific to each format's structure.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14, marginBottom: 16 }}>
          {formatSummaries.map(f => (
            <div key={f.formatLibraryId} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{f.name}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                  {f.ticked} / {f.ideas.length} selected
                </div>
              </div>
              {f.ideas.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic", padding: "8px 0" }}>
                  No ideas generated for this format yet. Click Regenerate to fill.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {f.ideas.map((idea, i) => {
                    const checked = !!idea?.selected;
                    const disabled = !checked && capReached;
                    return (
                      <label key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 8, border: `1px solid ${checked ? "rgba(0,130,250,0.35)" : "var(--border)"}`, background: checked ? "rgba(0,130,250,0.06)" : "var(--bg)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, transition: "background 0.1s, border 0.1s" }}>
                        <input type="checkbox" checked={checked} disabled={disabled}
                          onChange={() => toggleIdea(f.formatLibraryId, i)}
                          style={{ marginTop: 3, accentColor: "var(--accent)", cursor: disabled ? "not-allowed" : "pointer" }} />
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5, color: "var(--fg)" }}>
                          {idea?.title && (
                            <div style={{ fontWeight: 700, marginBottom: 3 }}>{idea.title}</div>
                          )}
                          <div style={{ color: idea?.title ? "var(--muted)" : "var(--fg)" }}>{idea?.text || "(empty idea)"}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Approve bar */}
      <div style={{ padding: "14px 18px", background: "var(--card)", border: `1px solid ${isApproved ? "rgba(34,197,94,0.4)" : "var(--border)"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {isApproved
            ? <>Ideas approved {approvals.ideaSelect ? `on ${new Date(approvals.ideaSelect).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}. Scripting will build these out in detail.</>
            : capExceeded ? <>You've ticked more ideas than this round's video count. Untick some before approving.</>
            : totalTicked === 0 ? <>Tick the ideas you want to progress. Then approve to move to Scripting.</>
            : <>{totalTicked} idea{totalTicked === 1 ? "" : "s"} ticked. Click Approve to build the scripts.</>
          }
        </div>
        <button onClick={approve} disabled={!canApprove}
          title={canApprove ? "Approve and move to Scripting" : capExceeded ? "Over cap — untick some ideas first" : "Tick at least one idea"}
          style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: !canApprove ? "#374151" : isApproved ? "#22C55E" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: canApprove ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: canApprove ? 1 : 0.6 }}>
          {isApproved ? "→ Scripting" : "Approve → Scripting"}
        </button>
      </div>
    </div>
  );
}

function ScriptStep({ project, onPatch }) {
  const doc = project.preproductionDoc || null;
  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const [rewriteTarget, setRewriteTarget] = useState(null);
  // {path: "clientContext.brandTruths" | "scriptTable.0.hook", label, currentValue}

  // Detect "selected formats changed since last generation" — we don't auto-
  // regenerate (that would clobber producer edits) but we do banner it so
  // the producer knows their edits are stale.
  const lastGenFormatIds = (doc?.formats || []).map(f => f.formatLibraryId).join("|");
  const currentFormatIds = selected.map(s => s.formatLibraryId).join("|");
  const formatsChanged = doc && lastGenFormatIds !== currentFormatIds;

  const generate = async () => {
    setGenError(null);
    setGenerating(true);
    try {
      // Pass the CURRENT project state inline so the server doesn't
      // depend on a fresh Firebase read. fbUpdate from the Select tab
      // is fire-and-forget and can be in-flight when Generate is
      // clicked — the server would then see stale selectedFormats and
      // fall back to equal distribution (the "only 12 videos instead
      // of 28" bug). Inline override wins; server falls back to
      // /preproduction if override is missing.
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generateScript",
          projectId: project.id,
          selectedFormats: project.selectedFormats || [],
          numberOfVideos: project.numberOfVideos ?? null,
        }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      // Firebase listener rehydrates preproductionDoc automatically.
    } catch (e) {
      setGenError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  if (!doc && !generating) {
    return (
      <div>
        <div style={{ padding: 40, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>📝</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Generate preproduction brief</div>
          <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 520, margin: "0 auto 16px", lineHeight: 1.5 }}>
            Claude Opus reads the selected formats, your classified research, and any meeting transcript, then produces a structured brief. Every field is editable afterwards — click any cell to rewrite it with AI or manually.
          </div>
          <button onClick={generate} style={btnPrimary}>Generate brief</button>
          {genError && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
              {genError}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (generating) {
    return (
      <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Generating brief…</div>
        <div style={{ fontSize: 12 }}>This usually takes 30-60s on Opus.</div>
      </div>
    );
  }

  const openRewrite = (path, label, currentValue) => {
    setRewriteTarget({ path, label, currentValue: currentValue || "" });
  };

  return (
    <div>
      {/* Header + toolbar */}
      <ScriptToolbar project={project} onRegenerate={generate} onPatch={onPatch} />

      {/* Feedback summary banner — if the client has left comments since the
          last time the producer was in here, flag it. */}
      <ClientFeedbackSummary project={project} />

      {formatsChanged && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(245,158,11,0.08)", borderRadius: 8, border: "1px solid rgba(245,158,11,0.3)", fontSize: 12, color: "#F59E0B" }}>
          Selected formats have changed since this brief was generated. Regenerate to pick up the new selection (your per-cell edits will be replaced).
        </div>
      )}

      {genError && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
          {genError}
        </div>
      )}

      {/* Brand Truth sections moved to Tab 1 (project.brandTruth) in the
          7-tab restructure. Tab 7 is now script-focused only. */}

      <SectionCard title="Formats">
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, fontStyle: "italic" }}>
          Rendered directly from the Select step (not AI-generated) to prevent hallucinated format descriptions.
        </div>
        {(doc.formats || []).length === 0 ? (
          <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>No formats attached.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {(doc.formats || []).map((f, i) => (
              <div key={f.formatLibraryId || i} style={{ padding: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>
                  {i + 1}. {f.name}
                </div>
                {/* Combined view — old records may still have legacy
                    Filming / Structure fields populated; show them inline
                    appended to the analysis so producers see all context
                    until they re-save (which collapses them into one). */}
                {(f.videoAnalysis || f.filmingInstructions || f.structureInstructions) && (
                  <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.5, marginBottom: 6, whiteSpace: "pre-wrap" }}>
                    {[f.videoAnalysis, f.filmingInstructions && `\nFilming: ${f.filmingInstructions}`, f.structureInstructions && `\nStructure: ${f.structureInstructions}`].filter(Boolean).join("\n")}
                  </div>
                )}
                {Array.isArray(f.examples) && f.examples.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                    {f.examples.map((ex, j) => (
                      <a key={j} href={ex.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 10, padding: "2px 8px", background: "var(--card)", color: "var(--accent)", borderRadius: 4, textDecoration: "none", border: "1px solid var(--border)" }}>
                        {ex.sourceAccount || "example"} ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Script table">
        {(doc.scriptTable || []).length === 0 ? (
          <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>No script rows generated.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg)" }}>
                  <th style={{ ...thStyle, width: 32 }}>#</th>
                  {SCRIPT_COLUMNS.map(c => (
                    <th key={c.key} style={{ ...thStyle, minWidth: c.width }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(doc.scriptTable || []).map((row, i) => {
                  const feedback = doc.clientFeedback || {};
                  // Alternating row tint — every other row gets a slight
                  // lift above the dark card background so producers can
                  // scan across a wide table without losing their row.
                  const rowBg = i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.025)";
                  // Row-level producer note lives at
                  // preproductionDoc.scriptTable[i].producerNote. Clicking
                  // the # cell opens a row-scoped modal with a note editor
                  // + "Rewrite whole row with AI" action. Note indicator
                  // (amber dot) shows when a note exists.
                  const hasRowNote = (row.producerNote || "").trim().length > 0;
                  return (
                    <tr key={i} style={{ borderTop: "1px solid var(--border)", background: rowBg }}>
                      <td
                        style={{ ...tdStyle, color: "var(--muted)", fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", cursor: "pointer", position: "relative" }}
                        title={hasRowNote ? `Note: ${row.producerNote.slice(0, 80)}…` : "Click to add a note or rewrite the whole video idea with AI"}
                        onClick={() => openRewrite(`scriptTable.${i}._row`, `Video ${row.videoNumber || i + 1} — Whole Idea`, row)}
                      >
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          {row.videoNumber || i + 1}
                          {hasRowNote && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "#F59E0B" }} />}
                        </div>
                      </td>
                      {SCRIPT_COLUMNS.map(c => {
                        // Client-feedback cell key: matches what the public
                        // view writes — `scriptTable.{i}.{c.key}`.
                        const cellKey = `scriptTable.${i}.${c.key}`;
                        const cellFeedback = feedback[cellKey] || null;
                        return (
                          <td key={c.key} style={tdStyle}>
                            {c.editable === false ? (
                              <div style={{ padding: "4px 6px", color: "var(--fg)", fontWeight: 600 }}>{row[c.key] || "—"}</div>
                            ) : (
                              <Clickable
                                value={row[c.key]}
                                feedback={cellFeedback}
                                onClick={() => openRewrite(cellKey, c.label, row[c.key])}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Section verdicts + per-script reactions/comments — written by
          the redesigned client review page (preproductionDoc.sectionFeedback
          and preproductionDoc.scriptFeedback). Comments expose a resolve
          toggle so the producer can work through them the same way they
          work through the legacy per-cell list below. */}
      <ClientReviewFeedback project={project} />

      {/* Legacy per-cell feedback queue — kept readable for projects
          reviewed under the old layout. New reviews use the section /
          script feedback shapes above; this block stays so historical
          comments still surface. */}
      {doc.clientFeedback && Object.keys(doc.clientFeedback).length > 0 && (
        <SectionCard title={`Client Feedback (${Object.values(doc.clientFeedback).filter(f => f && !f.resolved).length} outstanding)`}>
          <div style={{ display: "grid", gap: 6 }}>
            {Object.entries(doc.clientFeedback)
              .sort(([, a], [, b]) => (a?.resolved ? 1 : 0) - (b?.resolved ? 1 : 0))
              .map(([key, fb]) => {
                if (!fb || !fb.text) return null;
                // cellKey stored with "." replaced by "_"; decode for display.
                const displayPath = key.replace(/_/g, ".");
                // Map the field key back to a human label where we can.
                const scriptCol = SCRIPT_COLUMNS.find(c => displayPath.endsWith(`.${c.key}`));
                const brandTruthField = BRAND_TRUTH_FIELDS.find(f => displayPath.endsWith(`.${f.key}`));
                const colLabel = scriptCol?.label
                  || brandTruthField?.label
                  || (displayPath.includes("clientResearch") ? "Key takeaways" : displayPath);
                const basePath = `/preproduction/socialOrganic/${project.id}/preproductionDoc/clientFeedback/${key}`;
                return (
                  <div key={key} style={{
                    padding: "10px 14px",
                    background: fb.resolved ? "var(--bg)" : "var(--card)",
                    border: `1px solid ${fb.resolved ? "var(--border)" : "rgba(245,158,11,0.35)"}`,
                    borderRadius: 8, display: "flex", alignItems: "flex-start", gap: 10,
                    opacity: fb.resolved ? 0.6 : 1,
                  }}>
                    <input type="checkbox" checked={!!fb.resolved}
                      onChange={e => {
                        fbSet(`${basePath}/resolved`, e.target.checked);
                        fbSet(`${basePath}/resolvedAt`, e.target.checked ? new Date().toISOString() : null);
                      }}
                      style={{ marginTop: 3, cursor: "pointer", accentColor: "var(--accent)" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "var(--fg)", marginBottom: 3, lineHeight: 1.5, textDecoration: fb.resolved ? "line-through" : "none" }}>
                        {fb.text}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--muted)" }}>
                        {colLabel}
                        {fb.submittedAt && ` · ${new Date(fb.submittedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`}
                      </div>
                    </div>
                    {fb.resolved && <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>Resolved</span>}
                  </div>
                );
              })}
          </div>
        </SectionCard>
      )}

      {rewriteTarget && !rewriteTarget.path.endsWith("._row") && (
        <CellRewriteModal
          target={rewriteTarget}
          fbPathPrefix={`/preproduction/socialOrganic/${project.id}/preproductionDoc`}
          apiAction="rewriteScriptSection"
          extraPayload={{ projectId: project.id }}
          updatedAtPath={`/preproduction/socialOrganic/${project.id}/updatedAt`}
          onClose={() => setRewriteTarget(null)}
        />
      )}
      {rewriteTarget && rewriteTarget.path.endsWith("._row") && (
        <RowFeedbackModal
          target={rewriteTarget}
          project={project}
          onClose={() => setRewriteTarget(null)}
        />
      )}
    </div>
  );
}

// Row-level feedback modal for the scripting table. Opened from the
// first (#) cell of any scriptTable row. Gives the producer two
// actions for the WHOLE video idea:
//   - Save note: writes a free-text producer note to
//     preproductionDoc.scriptTable[i].producerNote. Doesn't modify
//     the script cells; just attaches a sticky note.
//   - Rewrite whole video with AI: takes the note as instruction +
//     the existing row data + project brand truth, asks Claude to
//     produce a fresh row (all cells) replacing the existing row.
//
// We use the _row path convention: `scriptTable.{i}._row` -> the
// parent (ScriptStep) opens this modal instead of the normal
// CellRewriteModal. rowIndex parsed from the path.
function RowFeedbackModal({ target, project, onClose }) {
  const rowIdx = Number((target.path.match(/^scriptTable\.(\d+)\._row$/) || [])[1]);
  const row = Number.isInteger(rowIdx) ? (project.preproductionDoc?.scriptTable || [])[rowIdx] || {} : {};
  const [note, setNote] = useState(row.producerNote || "");
  const [mode, setMode] = useState("note");  // "note" | "rewrite"
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const saveNote = async () => {
    setWorking(true);
    setError(null);
    try {
      await fbSetAsync(`/preproduction/socialOrganic/${project.id}/preproductionDoc/scriptTable/${rowIdx}/producerNote`, note);
      await fbSetAsync(`/preproduction/socialOrganic/${project.id}/updatedAt`, new Date().toISOString());
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const rewriteRow = async () => {
    if (!note.trim()) {
      setError("Add a note first — Claude needs an instruction.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rewriteScriptRow",
          projectId: project.id,
          rowIndex: rowIdx,
          instruction: note.trim(),
        }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const tabBtn = (k, label) => ({
    padding: "7px 14px", borderRadius: 6, border: "1px solid var(--border)",
    background: mode === k ? "var(--accent)" : "var(--card)",
    color: mode === k ? "#fff" : "var(--muted)",
    fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 22, maxWidth: 720, width: "92%", maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--border)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{target.label}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {/* Row snapshot — what Claude / the producer is commenting on. */}
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", marginBottom: 14, fontSize: 12, display: "grid", gap: 4 }}>
          <div><span style={{ color: "var(--muted)" }}>Format:</span> <strong style={{ color: "var(--fg)" }}>{row.formatName || "—"}</strong></div>
          {row.hook && <div><span style={{ color: "var(--muted)" }}>Hook:</span> {row.hook}</div>}
          {row.textHook && <div><span style={{ color: "var(--muted)" }}>Text Hook:</span> {row.textHook}</div>}
          {row.scriptNotes && <div><span style={{ color: "var(--muted)" }}>Script / Notes:</span> {row.scriptNotes.slice(0, 200)}{row.scriptNotes.length > 200 ? "…" : ""}</div>}
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button onClick={() => setMode("note")} style={tabBtn("note", "📝 Save note")}>Save note</button>
          <button onClick={() => setMode("rewrite")} style={tabBtn("rewrite", "✨ Rewrite with AI")}>Rewrite with AI</button>
        </div>

        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={mode === "note"
            ? "Producer note — visible to the team working on this video. E.g. 'Client wants to emphasise speed over price here.'"
            : "Tell Claude what to change about this whole video idea. E.g. 'Make this more confrontational. The hook is too soft and the script should push harder on the pain point.'"}
          rows={6}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 12 }}
        />

        {error && (
          <div style={{ padding: "10px 14px", marginBottom: 12, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: "#EF4444" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={working}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: working ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: working ? 0.5 : 1 }}>
            Cancel
          </button>
          {mode === "note" ? (
            <button onClick={saveNote} disabled={working}
              style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: working ? "wait" : "pointer", fontFamily: "inherit", opacity: working ? 0.7 : 1 }}>
              {working ? "Saving…" : "Save Note"}
            </button>
          ) : (
            <button onClick={rewriteRow} disabled={working || !note.trim()}
              style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: working || !note.trim() ? "#374151" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: (working || !note.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (working || !note.trim()) ? 0.6 : 1 }}>
              {working ? "Rewriting…" : "Rewrite Whole Video"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "8px 10px",
  fontSize: 10,
  fontWeight: 700,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

const tdStyle = {
  verticalAlign: "top",
  padding: "4px 4px",
  fontSize: 12,
  color: "var(--fg)",
};

function SectionCard({ title, children }) {
  return (
    <div style={{ marginBottom: 14, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}


// ═══════════════════════════════════════════
// TAB 1 — BRAND TRUTH (Phase B)
// Producer pastes the preproduction meeting transcript + optional notes,
// Claude Opus generates 7 fields, each field opens the shared
// CellRewriteModal on click. Approval writes approvals.brandTruth.
// ═══════════════════════════════════════════
const BRAND_TRUTH_FIELDS = [
  { key: "brandTruths",             label: "Brand Truths",             multi: true },
  { key: "brandAmbitions",          label: "Brand Ambitions",          multi: true },
  { key: "clientGoals",             label: "Overall Client Goals",     multi: true },
  { key: "keyConsiderations",       label: "Key Considerations",       multi: true },
  { key: "targetViewerDemographic", label: "Target Viewer Demographic",multi: true },
  { key: "painPoints",              label: "Pain Points",              multi: true },
  { key: "language",                label: "Language",                 multi: true },
];

function BrandTruthStep({ project, linkedAccount, linkedClient, sherpaMeta, onPatch }) {
  const bt = project.brandTruth || {};
  const fields = bt.fields || {};
  const [transcript, setTranscript] = useState(bt.transcript || "");
  const [producerNotes, setProducerNotes] = useState(bt.producerNotes || "");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const [rewriteTarget, setRewriteTarget] = useState(null);
  const [refreshingSherpa, setRefreshingSherpa] = useState(false);
  const [sherpaRefreshError, setSherpaRefreshError] = useState(null);

  const refreshSherpa = async () => {
    setSherpaRefreshError(null);
    setRefreshingSherpa(true);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refreshSherpa", projectId: project.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      if (d.ok === false && d.error) {
        throw new Error(d.error.message || d.error.code || "Sherpa fetch failed");
      }
      // Firebase listener on /sherpaCacheMeta rehydrates the status row.
    } catch (e) {
      setSherpaRefreshError(e.message);
    } finally {
      setRefreshingSherpa(false);
    }
  };

  // Debounced writes for transcript + notes so the producer can leave and
  // return. 500ms is comfortable — no perceptible typing lag.
  useEffect(() => {
    if (transcript === (bt.transcript || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/socialOrganic/${project.id}/brandTruth/transcript`, transcript);
    }, 500);
    return () => clearTimeout(t);
  }, [transcript]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (producerNotes === (bt.producerNotes || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/socialOrganic/${project.id}/brandTruth/producerNotes`, producerNotes);
    }, 500);
    return () => clearTimeout(t);
  }, [producerNotes]);  // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setGenError(null);
    setGenerating(true);
    try {
      // Make sure the latest transcript + notes are on disk before generating.
      await Promise.all([
        new Promise(res => { fbSet(`/preproduction/socialOrganic/${project.id}/brandTruth/transcript`, transcript); setTimeout(res, 50); }),
        new Promise(res => { fbSet(`/preproduction/socialOrganic/${project.id}/brandTruth/producerNotes`, producerNotes); setTimeout(res, 50); }),
      ]);
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generateBrandTruth", projectId: project.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      // Firebase listener rehydrates fields automatically.
    } catch (e) {
      setGenError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const approve = () => {
    fbSet(`/preproduction/socialOrganic/${project.id}/approvals/brandTruth`, new Date().toISOString());
    // Fire-and-forget Claude calls to pre-fill Tab 2 so it opens with
    // everything already populated. Producers edit if the suggestions miss.
    //  - suggestClientHandle → Stage A's @handle input
    //  - suggestCompetitors  → Stage B's competitor + keyword chips
    // Log failures so we can spot silent misses in Vercel logs — producer
    // still moves forward and can manually fill if auto-suggest drops.
    authFetch("/api/social-organic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "suggestClientHandle", projectId: project.id }),
    }).catch(err => console.warn("suggestClientHandle fire-and-forget failed:", err));
    authFetch("/api/social-organic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "suggestCompetitors", projectId: project.id }),
    }).catch(err => console.warn("suggestCompetitors fire-and-forget failed:", err));
    onPatch({ tab: "research" });
  };

  const openRewrite = (path, label, currentValue) => {
    setRewriteTarget({ path, label, currentValue: currentValue || "" });
  };

  const allFieldsFilled = BRAND_TRUTH_FIELDS.every(f => (fields[f.key] || "").trim());

  return (
    <div>
      {/* Input card: transcript + notes + generate */}
      <div style={{ marginBottom: 14, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Inputs</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              Paste the preproduction meeting transcript. Add notes on anything the client emphasised. Claude reads both plus the Client Sherpa Google Doc.
              {linkedAccount && ` Sherpa linked to "${linkedAccount.companyName}".`}
            </div>
          </div>
          <button onClick={generate}
            disabled={generating || (!transcript.trim() && !producerNotes.trim())}
            style={{ ...btnPrimary, opacity: (generating || (!transcript.trim() && !producerNotes.trim())) ? 0.5 : 1 }}>
            {generating ? "Generating…" : bt.generatedAt ? "Regenerate" : "Generate Brand Truth"}
          </button>
        </div>

        <SherpaStatusRow
          linkedClient={linkedClient}
          meta={sherpaMeta}
          refreshing={refreshingSherpa}
          refreshError={sherpaRefreshError}
          onRefresh={refreshSherpa}
        />

        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 5 }}>
          Preproduction meeting transcript
        </label>
        <textarea value={transcript} onChange={e => setTranscript(e.target.value)}
          placeholder="Paste the full meeting transcript here…"
          rows={6}
          style={{ ...inputSt, resize: "vertical", fontSize: 12, fontFamily: "inherit", marginBottom: 10 }} />

        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 5 }}>
          Producer notes <span style={{ fontWeight: 400, textTransform: "none", fontStyle: "italic", color: "var(--muted)" }}>(optional — anything extra you want Claude to weight)</span>
        </label>
        <textarea value={producerNotes} onChange={e => setProducerNotes(e.target.value)}
          placeholder="e.g. Client specifically wants female-demo only. No humour."
          rows={3}
          style={{ ...inputSt, resize: "vertical", fontSize: 12, fontFamily: "inherit" }} />

        {genError && (
          <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
            {genError}
          </div>
        )}
      </div>

      {/* Generated fields */}
      {bt.generatedAt ? (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Brand Truth</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                Generated {new Date(bt.generatedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · {bt.modelUsed || "claude-opus-4-6"}. Click any cell to edit.
              </div>
            </div>
            <button onClick={approve}
              disabled={!allFieldsFilled}
              title={allFieldsFilled ? "Approve and move to Format Research" : "Fill every field before approving"}
              style={{ ...btnPrimary, opacity: allFieldsFilled ? 1 : 0.5 }}>
              Approve → Format Research
            </button>
          </div>

          {BRAND_TRUTH_FIELDS.map(f => {
            // Client feedback is stored under preproductionDoc.clientFeedback
            // by the public view. Key convention matches: dot-path flattened
            // to underscores, so `brandTruth.fields.brandTruths` lands at
            // `brandTruth_fields_brandTruths`.
            const feedbackKey = `brandTruth_fields_${f.key}`;
            const cellFeedback = project.preproductionDoc?.clientFeedback?.[feedbackKey] || null;
            return (
              <EditableField
                key={f.key}
                label={f.label}
                path={f.key}
                value={fields[f.key]}
                onEdit={openRewrite}
                multi={f.multi}
                feedback={cellFeedback}
              />
            );
          })}
        </div>
      ) : !generating && (
        <div style={{ padding: 30, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12, color: "var(--muted)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>No brand truth yet</div>
          <div style={{ fontSize: 12 }}>Paste a transcript (or just producer notes) above and hit "Generate Brand Truth".</div>
        </div>
      )}

      {rewriteTarget && (
        <CellRewriteModal
          target={rewriteTarget}
          fbPathPrefix={`/preproduction/socialOrganic/${project.id}/brandTruth/fields`}
          apiAction="rewriteBrandTruthField"
          extraPayload={{ projectId: project.id }}
          updatedAtPath={`/preproduction/socialOrganic/${project.id}/updatedAt`}
          onClose={() => setRewriteTarget(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// TAB 2 — FORMAT RESEARCH (Phase C)
// Two sequential approval gates:
//   Stage A: client IG handle → kicks off client posts + IG profile scrape
//   Stage B: competitors + keywords → kicks off 120-video scrape
// Scrapes are async via Apify → /api/apify-webhook → Firebase; UI listens
// to scrape status fields and shows pills.
// ═══════════════════════════════════════════
function ResearchStep({ project, linkedAccount, onPatch }) {
  const research = project.research || {};
  const clientScrape = project.clientScrape || {};
  const competitorScrape = project.competitorScrape || {};
  const approvals = project.approvals || {};

  // Stage A: client handle. Claude pre-fills this when Brand Truth is
  // approved (via suggestClientHandle). Fall back to the linked account's
  // saved handle or a manual prompt if Claude didn't land.
  const defaultHandle = research.clientHandle
    || linkedAccount?.instagramHandle
    || (linkedAccount?.competitors || []).find(c => c.isClient)?.handle
    || "";
  const [clientHandle, setClientHandle] = useState(defaultHandle);
  const [starting, setStarting] = useState({ a: false, b: false });
  const [err, setErr] = useState({ a: null, b: null });
  const [suggestingHandle, setSuggestingHandle] = useState(false);
  const handleSuggestion = research.handleSuggestion || null;
  // On-blur verification of the client handle. Producer types or
  // pastes a handle, tabs away, the field hits the IG profile API
  // and shows ✓ / ⚠ with follower count / posts / private /
  // fullName so they can spot a wrong handle BEFORE clicking
  // Approve & Start Scrape (which would otherwise fire Apify
  // against an unrelated personal account).
  const [handleVerifyState, setHandleVerifyState] = useState({ status: "idle", result: null, handle: "" });
  const verifyAbortRef = useRef(null);
  const verifyHandleNow = async (raw) => {
    const cleaned = String(raw || "").trim().replace(/^@+/, "").toLowerCase();
    if (!cleaned) return;
    if (handleVerifyState.handle === cleaned && handleVerifyState.status === "done") return;
    // Abort any in-flight verify for a previous edit so a fast
    // type / blur / type / blur sequence ends up showing the LATEST
    // handle's result, not the first one's.
    if (verifyAbortRef.current) {
      try { verifyAbortRef.current.abort(); } catch { /* noop */ }
    }
    const ctrl = new AbortController();
    verifyAbortRef.current = ctrl;
    setHandleVerifyState({ status: "verifying", result: null, handle: cleaned });
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verifyClientHandle", handle: cleaned }),
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || "Verify failed");
      setHandleVerifyState({ status: "done", result: { verified: !!d.verified, verifyMeta: d.verifyMeta || {} }, handle: cleaned });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      // Network / verifier failure — show neutral state, don't block
      // the producer. They can still hit Approve & Start Scrape.
      setHandleVerifyState({ status: "done", result: { verified: false, verifyMeta: { reason: "verifier_unavailable" } }, handle: cleaned });
    }
  };

  // Keep local handle in sync when the background suggestClientHandle
  // call lands after Tab 2 is open. Also fire the IG profile check
  // here so the AI-suggested handle gets a ✓ / ⚠ chip without the
  // producer having to focus + blur the field manually — Claude's
  // suggestions need verification just as much as a typed handle.
  useEffect(() => {
    if (research.clientHandle && research.clientHandle !== clientHandle) {
      setClientHandle(research.clientHandle);
      verifyHandleNow(research.clientHandle);
    }
  }, [research.clientHandle]);  // eslint-disable-line react-hooks/exhaustive-deps

  // First-mount verify: if Stage A opens with a pre-existing handle
  // (saved on the project, pulled from the linked account, etc.) and
  // we haven't verified it yet this session, kick off a check now.
  // Producer doesn't have to interact with the field to see the
  // ✓ / ⚠ signal.
  const didMountVerifyRef = useRef(false);
  useEffect(() => {
    if (didMountVerifyRef.current) return;
    if (!clientHandle) return;
    didMountVerifyRef.current = true;
    verifyHandleNow(clientHandle);
  }, [clientHandle]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback: if we arrive at Tab 2 with no handle and no prior suggestion
  // attempt, run one now. Covers producers who opened Tab 2 before the
  // Tab 1-approve fire-and-forget landed, or whose network dropped it.
  useEffect(() => {
    if (clientHandle) return;
    if (handleSuggestion) return;
    if (suggestingHandle) return;
    setSuggestingHandle(true);
    authFetch("/api/social-organic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "suggestClientHandle", projectId: project.id }),
    }).finally(() => setSuggestingHandle(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-suggest fallback for Stage B: if no AI competitor suggestion has
  // run yet and the producer hasn't already added entries manually, fire
  // one through runSuggest() (declared below) — that path commits the
  // results to research.competitors, drives the spinner state, and
  // auto-populates the chips. Without going through runSuggest the
  // suggestions used to land in research.aiSuggestions only and never
  // visibly appear, which is why producers had to click Re-suggest
  // manually every time.
  const ranSuggestOnMount = useRef(false);
  useEffect(() => {
    if (ranSuggestOnMount.current) return;
    if (research.aiSuggestedAt) return;
    if ((research.competitors || []).length > 0) return;
    if ((research.keywords || []).length > 0) return;
    ranSuggestOnMount.current = true;
    runSuggest();   // eslint-disable-line @typescript-eslint/no-use-before-define
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const resuggest = () => {
    setSuggestingHandle(true);
    authFetch("/api/social-organic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "suggestClientHandle", projectId: project.id }),
    }).finally(() => setSuggestingHandle(false));
  };

  useEffect(() => {
    if (clientHandle === (research.clientHandle || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/socialOrganic/${project.id}/research/clientHandle`, clientHandle);
    }, 500);
    return () => clearTimeout(t);
  }, [clientHandle]);  // eslint-disable-line react-hooks/exhaustive-deps

  const approveStageA = async () => {
    if (!clientHandle.trim()) { setErr(e => ({ ...e, a: "Add a handle first" })); return; }
    setStarting(s => ({ ...s, a: true }));
    setErr(e => ({ ...e, a: null }));
    try {
      fbSet(`/preproduction/socialOrganic/${project.id}/research/clientHandle`, clientHandle);
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "startClientScrape", projectId: project.id, handle: clientHandle }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      fbSet(`/preproduction/socialOrganic/${project.id}/approvals/research_a`, new Date().toISOString());
    } catch (e) {
      setErr(err => ({ ...err, a: e.message }));
    } finally {
      setStarting(s => ({ ...s, a: false }));
    }
  };

  // Stage B state — AI-suggested competitors + keywords.
  const [competitors, setCompetitors] = useState(research.competitors || []);
  const [keywords, setKeywords] = useState(research.keywords || []);
  const [newHandle, setNewHandle] = useState("");
  const [newKeyword, setNewKeyword] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  useEffect(() => { setCompetitors(research.competitors || []); }, [JSON.stringify(research.competitors)]);  // eslint-disable-line
  useEffect(() => { setKeywords(research.keywords || []); }, [JSON.stringify(research.keywords)]);  // eslint-disable-line

  const suggestedCompetitorMap = new Map((research.aiSuggestions?.competitors || []).map(c => [c.handle.toLowerCase(), c.reason]));

  // Manual-add tag — producer toggles "direct" / "inspiration" before
  // typing the handle. Defaults to direct because that's the more common
  // case (producer adds someone they know is a competitor).
  const [newTag, setNewTag] = useState("direct");

  const addCompetitor = (handle, opts = {}) => {
    const norm = handle.trim().startsWith("@") ? handle.trim() : `@${handle.trim().replace(/^@+/, "")}`;
    if (!norm || norm === "@") return;
    if (competitors.some(c => c.handle.toLowerCase() === norm.toLowerCase())) return;
    const entry = {
      handle: norm,
      source: opts.source || "manual",
      tag: opts.tag === "inspiration" ? "inspiration" : "direct",
      verified: opts.verified ?? null,
    };
    const next = [...competitors, entry];
    setCompetitors(next);
    fbSet(`/preproduction/socialOrganic/${project.id}/research/competitors`, next);
  };
  const removeCompetitor = (handle) => {
    const next = competitors.filter(c => c.handle !== handle);
    setCompetitors(next);
    fbSet(`/preproduction/socialOrganic/${project.id}/research/competitors`, next);
  };
  const addKeyword = (k) => {
    const v = k.trim().replace(/^#/, "");
    if (!v || keywords.includes(v)) return;
    const next = [...keywords, v];
    setKeywords(next);
    fbSet(`/preproduction/socialOrganic/${project.id}/research/keywords`, next);
  };
  const removeKeyword = (k) => {
    const next = keywords.filter(x => x !== k);
    setKeywords(next);
    fbSet(`/preproduction/socialOrganic/${project.id}/research/keywords`, next);
  };

  const runSuggest = async () => {
    setSuggesting(true);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggestCompetitors", projectId: project.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      // Auto-add suggested competitors + keywords if empty; otherwise just
      // leave the suggestions in research.aiSuggestions for manual accept.
      // Preserves the tag (direct / inspiration) Claude assigned to each
      // entry so the chip in the UI reads the right colour.
      if (competitors.length === 0 && Array.isArray(d.competitors)) {
        const next = d.competitors.map(c => ({
          handle: c.handle,
          source: "ai",
          tag: c.tag === "inspiration" ? "inspiration" : "direct",
          verified: c.verified ?? null,
        }));
        setCompetitors(next);
        fbSet(`/preproduction/socialOrganic/${project.id}/research/competitors`, next);
      }
      if (keywords.length === 0 && Array.isArray(d.keywords)) {
        setKeywords(d.keywords);
        fbSet(`/preproduction/socialOrganic/${project.id}/research/keywords`, d.keywords);
      }
    } catch (e) {
      setErr(err => ({ ...err, b: e.message }));
    } finally {
      setSuggesting(false);
    }
  };

  const approveStageB = async () => {
    if (competitors.length === 0) { setErr(e => ({ ...e, b: "Add at least one competitor" })); return; }
    setStarting(s => ({ ...s, b: true }));
    setErr(e => ({ ...e, b: null }));
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "startCompetitorScrape", projectId: project.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      fbSet(`/preproduction/socialOrganic/${project.id}/approvals/research_b`, new Date().toISOString());
    } catch (e) {
      setErr(err => ({ ...err, b: e.message }));
    } finally {
      setStarting(s => ({ ...s, b: false }));
    }
  };

  const stageADone = !!approvals.research_a;
  const stageBDone = !!approvals.research_b;

  return (
    <div>
      {/* Stage A: client Instagram handle */}
      <StageCard
        stageLabel="Stage A"
        title="Client Instagram"
        hint="Claude pre-fills the client's handle from the transcript + Brand Truth. Update if it got it wrong. Approving kicks off an async scrape of their reels + Instagram follower count."
        done={stageADone}
        doneText={`Approved ${stageADone ? new Date(approvals.research_a).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""}`}
        error={err.a}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="text" value={clientHandle} onChange={e => setClientHandle(e.target.value)}
            disabled={stageADone}
            placeholder={suggestingHandle ? "Claude is finding the handle…" : "@client_handle"}
            // Verify on blur — fires the IG profile check whenever the
            // producer leaves the field after edit. No fire on every
            // keystroke, no surprise calls during typing.
            onBlur={() => verifyHandleNow(clientHandle)}
            style={{ ...inputSt, maxWidth: 280, fontSize: 13, opacity: stageADone ? 0.6 : 1 }} />
          {!stageADone && !clientHandle && suggestingHandle && (
            <span style={{ fontSize: 11, color: "var(--accent)", fontStyle: "italic" }}>Finding handle…</span>
          )}
          {/* Verify chip — ✓ green when followers≥200 + posts>0 + public,
              ⚠ amber with the specific reason otherwise (low followers /
              no posts / private / not found). Producer sees the signal
              before clicking Approve & Start Scrape. */}
          {!stageADone && handleVerifyState.handle && handleVerifyState.handle === clientHandle.replace(/^@+/, "").toLowerCase() && (() => {
            if (handleVerifyState.status === "verifying") {
              return <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>Verifying handle…</span>;
            }
            const r = handleVerifyState.result;
            if (!r) return null;
            const vm = r.verifyMeta || {};
            if (r.verified) {
              return (
                <span title={`Verified · ${vm.followers != null ? vm.followers.toLocaleString() : "?"} followers · ${vm.posts || 0} posts${vm.fullName ? ` · ${vm.fullName}` : ""}`}
                  style={{ fontSize: 11, color: "#22C55E", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  ✓ Verified
                  {vm.followers != null && (
                    <span style={{ color: "var(--muted)", fontWeight: 500 }}>· {vm.followers.toLocaleString()} followers</span>
                  )}
                </span>
              );
            }
            const msg = vm.reason === "low_followers" ? `Only ${vm.followers || 0} followers — likely wrong handle`
              : vm.reason === "no_posts" ? "Profile exists but has 0 posts — likely wrong handle"
              : vm.reason === "account_private" ? "Account is private — can't research it"
              : vm.reason === "profile_not_found" ? "Couldn't find this handle on Instagram"
              : vm.reason === "verifier_unavailable" ? "Couldn't reach Instagram verifier"
              : "Couldn't verify this handle";
            return (
              <span title={msg}
                style={{ fontSize: 11, color: "#F59E0B", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                ⚠ {msg}
              </span>
            );
          })()}
          {!stageADone && !suggestingHandle && (
            <button onClick={resuggest} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 11 }}
              title="Ask Claude to re-guess the handle">
              {handleSuggestion ? "↻ Re-suggest" : "Suggest with AI"}
            </button>
          )}
          {!stageADone && (
            <button onClick={approveStageA} disabled={starting.a || !clientHandle.trim()}
              style={{ ...btnPrimary, opacity: (starting.a || !clientHandle.trim()) ? 0.5 : 1 }}>
              {starting.a ? "Starting…" : "Approve & Start Scrape"}
            </button>
          )}
        </div>
        {!stageADone && handleSuggestion?.handle && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
            <span style={{
              display: "inline-block", padding: "1px 6px", borderRadius: 3, marginRight: 6,
              background: handleSuggestion.confidence === "high" ? "rgba(34,197,94,0.15)"
                : handleSuggestion.confidence === "medium" ? "rgba(245,158,11,0.15)"
                : "rgba(90,107,133,0.15)",
              color: handleSuggestion.confidence === "high" ? "#22C55E"
                : handleSuggestion.confidence === "medium" ? "#F59E0B"
                : "#5A6B85",
              fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em",
            }}>{handleSuggestion.confidence || "low"} confidence</span>
            {handleSuggestion.reason}
          </div>
        )}
        {stageADone && <ScrapeStatusPill scrape={clientScrape} label="Client scrape" projectId={project.id} />}
      </StageCard>

      {/* Stage B: competitors + keywords (only unlocks once Stage A approved,
          matching the "two sequential gates" in the spec). */}
      <div style={{ marginTop: 14, opacity: stageADone ? 1 : 0.55, pointerEvents: stageADone ? "auto" : "none" }}>
        <StageCard
          stageLabel="Stage B"
          title="Competitors & Keywords"
          hint="Pre-filled from the approved Brand Truth + transcript + Sherpa. Edit freely before approving — add or remove handles and keywords as needed."
          done={stageBDone}
          doneText={`Approved ${stageBDone ? new Date(approvals.research_b).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""}`}
          error={err.b}>

          {!stageBDone && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, fontSize: 11, color: "var(--muted)" }}>
              {research.aiSuggestedAt && (
                <span>Suggested {new Date(research.aiSuggestedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
              )}
              {!research.aiSuggestedAt && suggesting && <span style={{ color: "var(--accent)" }}>Suggesting…</span>}
              <button onClick={runSuggest} disabled={suggesting}
                title="Ask Claude to re-suggest competitors and keywords"
                style={{ ...btnSecondary, padding: "4px 10px", fontSize: 10, marginLeft: "auto", opacity: suggesting ? 0.5 : 1 }}>
                {suggesting ? "…" : "↻ Re-suggest"}
              </button>
            </div>
          )}

          <Label>Competitor handles</Label>
          <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 6 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E" }} /> direct
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#A855F7" }} /> inspiration
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {competitors.map(c => {
              const reason = suggestedCompetitorMap.get(c.handle.toLowerCase());
              const tag = c.tag === "inspiration" ? "inspiration" : "direct";
              const tagChip = tag === "inspiration"
                ? { bg: "rgba(168,85,247,0.15)", fg: "#A855F7", label: "INSPIRATION" }
                : { bg: "rgba(34,197,94,0.15)", fg: "#22C55E", label: "DIRECT" };
              // Verify status: true = Apify confirmed the profile is a
              // plausible competitor (exists, public, followers >= 200,
              // has posts). false = either the handle didn't resolve OR
              // it resolved to a likely-wrong account (private / dead /
              // tiny). null = still verifying.
              // Manual-add chips skip verification (producer is authoritative).
              const vm = c.verifyMeta || {};
              const verifyTitle = (() => {
                if (c.verified === true) {
                  if (vm.followers != null) {
                    return `Verified · ${vm.followers.toLocaleString()} followers · ${vm.posts || 0} posts${vm.fullName ? ` · ${vm.fullName}` : ""}`;
                  }
                  return "Verified — IG profile exists";
                }
                if (c.verified === false) {
                  switch (vm.reason) {
                    case "low_followers":
                      return `Probably wrong handle — only ${vm.followers || 0} followers. Click ↗ to check on Instagram.`;
                    case "no_posts":
                      return "Profile exists but has 0 posts. Likely wrong handle. Click ↗ to verify.";
                    case "account_private":
                      return "Profile is private — can't research against it. Click ↗ to check / edit.";
                    case "profile_not_found":
                      return "Couldn't find this handle on Instagram. Click ↗ to check / edit.";
                    default:
                      return "Could not verify this handle. Click ↗ to check / edit.";
                  }
                }
                if (c.source === "ai") return "Verifying handle…";
                return null;
              })();
              return (
                <span key={c.handle} title={reason ? `${reason}${verifyTitle ? ` · ${verifyTitle}` : ""}` : (verifyTitle || "")}
                  style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg)", border: `1px solid ${tagChip.fg}33`, color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {/* Tag chip — direct (green) or inspiration (purple) — set
                      either by Claude on auto-suggest or by the producer
                      when manually adding. Tags don't flip after creation;
                      to change one, remove the chip and re-add. */}
                  <span style={{ fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 3, background: tagChip.bg, color: tagChip.fg, letterSpacing: 0.4 }}>{tagChip.label}</span>
                  {c.handle}
                  {/* Verify indicator: ✓ verified, ⚠ unverified, ⋯ pending. */}
                  {c.verified === true && (
                    <span style={{ color: "#22C55E", fontSize: 11, fontWeight: 800 }} aria-label="Verified">✓</span>
                  )}
                  {c.verified === false && (
                    <span style={{ color: "#F59E0B", fontSize: 11, fontWeight: 800 }} aria-label="Unverified">⚠</span>
                  )}
                  {c.verified == null && c.source === "ai" && (
                    <span style={{ color: "var(--muted)", fontSize: 10, fontStyle: "italic" }} aria-label="Verifying">…</span>
                  )}
                  {/* Open IG profile in a new tab — manual verify path. */}
                  <a href={`https://www.instagram.com/${c.handle.replace(/^@/, "")}/`} target="_blank" rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    title="Open on Instagram to verify"
                    style={{ color: "var(--muted)", fontSize: 10, textDecoration: "none", marginLeft: 2 }}>↗</a>
                  {!stageBDone && <button onClick={() => removeCompetitor(c.handle)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>}
                </span>
              );
            })}
            {competitors.length === 0 && (
              suggesting
                ? <span style={{ fontSize: 11, color: "var(--accent)", fontStyle: "italic" }}>Generating competitor suggestions… (~10–15 seconds)</span>
                : <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>None yet — hit "↻ Re-suggest" or add manually.</span>
            )}
          </div>
          {!stageBDone && (
            <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center" }}>
              {/* Tag toggle for the manual-add input — producer picks
                  direct / inspiration before pressing Enter. */}
              <div style={{ display: "flex", gap: 0, background: "var(--bg)", borderRadius: 6, padding: 2, border: "1px solid var(--border)" }}>
                <button onClick={() => setNewTag("direct")}
                  style={{ padding: "4px 8px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: newTag === "direct" ? "rgba(34,197,94,0.2)" : "transparent", color: newTag === "direct" ? "#22C55E" : "var(--muted)" }}>
                  Direct
                </button>
                <button onClick={() => setNewTag("inspiration")}
                  style={{ padding: "4px 8px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: newTag === "inspiration" ? "rgba(168,85,247,0.2)" : "transparent", color: newTag === "inspiration" ? "#A855F7" : "var(--muted)" }}>
                  Inspiration
                </button>
              </div>
              <input type="text" value={newHandle} onChange={e => setNewHandle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCompetitor(newHandle, { tag: newTag }); setNewHandle(""); } }}
                placeholder="@handle — press Enter"
                style={{ ...inputSt, fontSize: 12, flex: 1 }} />
              <button onClick={() => { addCompetitor(newHandle, { tag: newTag }); setNewHandle(""); }} disabled={!newHandle.trim()}
                style={{ ...btnSecondary, padding: "6px 14px", opacity: newHandle.trim() ? 1 : 0.5 }}>Add</button>
            </div>
          )}

          <Label>Keywords / hashtags</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {keywords.map(k => (
              <span key={k} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                #{k}
                {!stageBDone && <button onClick={() => removeKeyword(k)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>}
              </span>
            ))}
            {keywords.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>None yet.</span>}
          </div>
          {!stageBDone && (
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <input type="text" value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addKeyword(newKeyword); setNewKeyword(""); } }}
                placeholder="e.g. mens suiting, pilates studio"
                style={{ ...inputSt, fontSize: 12, flex: 1 }} />
              <button onClick={() => { addKeyword(newKeyword); setNewKeyword(""); }} disabled={!newKeyword.trim()}
                style={{ ...btnSecondary, padding: "6px 14px", opacity: newKeyword.trim() ? 1 : 0.5 }}>Add</button>
            </div>
          )}

          {!stageBDone && (
            <button onClick={approveStageB}
              disabled={starting.b || competitors.length === 0}
              style={{ ...btnPrimary, opacity: (starting.b || competitors.length === 0) ? 0.5 : 1 }}>
              {starting.b ? "Starting…" : `Approve & Scrape ~120 Videos`}
            </button>
          )}
          {stageBDone && <ScrapeStatusPill scrape={competitorScrape} label="Competitor scrape" projectId={project.id} />}
        </StageCard>
      </div>

      {/* Forward button: only appears once BOTH stages are approved. The 120-
          video Stage B scrape runs in the background while the producer works
          through Tab 3 — that's the reason we require Stage B first, not last. */}
      {stageADone && stageBDone && (
        <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--accent-soft)", borderRadius: 8, border: "1px solid var(--accent)", fontSize: 12, color: "var(--fg)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>Both scrapes running. Move to Client Research — the 120-video scrape will keep running in the background.</span>
          <button onClick={() => onPatch({ tab: "clientResearch" })} style={btnPrimary}>→ Client Research</button>
        </div>
      )}
    </div>
  );
}

function StageCard({ stageLabel, title, hint, done, doneText, error, children }) {
  return (
    <div style={{ background: "var(--card)", border: `1px solid ${done ? "#22C55E" : "var(--border)"}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.08em" }}>{stageLabel}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginTop: 2 }}>{title}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, lineHeight: 1.5, maxWidth: 620 }}>{hint}</div>
        </div>
        {done && (
          <span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "rgba(34,197,94,0.15)", color: "#22C55E" }}>
            ✓ {doneText || "Approved"}
          </span>
        )}
      </div>
      {children}
      {error && (
        <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function ScrapeStatusPill({ scrape, label, projectId }) {
  const status = scrape?.status || "queued";
  const colour = {
    queued:  { bg: "rgba(90,107,133,0.15)",  fg: "#5A6B85", text: "Queued" },
    running: { bg: "rgba(59,130,246,0.15)",  fg: "#3B82F6", text: "Scraping…" },
    done:    { bg: "rgba(34,197,94,0.15)",   fg: "#22C55E", text: "Complete" },
    error:   { bg: "rgba(239,68,68,0.15)",   fg: "#EF4444", text: scrape?.error || "Error" },
  }[status] || { bg: "var(--bg)", fg: "var(--muted)", text: status };

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null);

  // Background poll — fires `refreshScrapes` every 20 seconds while status
  // is "running". This is the core failsafe: if Apify's webhook drops (cold
  // start, network, secret rotation, anything), the UI still catches the
  // finished run and flips status to "done" without the producer touching
  // anything. Completely silent — no spinner, no message.
  useEffect(() => {
    if (!projectId) return;
    if (status !== "running") return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        await authFetch("/api/social-organic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refreshScrapes", projectId }),
        });
      } catch { /* silent — it retries next tick */ }
    };
    // First poll at 30s (typical Apify run time), then every 20s.
    const initialDelay = setTimeout(poll, 30000);
    const interval = setInterval(poll, 20000);
    return () => { cancelled = true; clearTimeout(initialDelay); clearInterval(interval); };
  }, [projectId, status]);

  // Manual refresh — kept for the rare case the producer wants to force
  // a check immediately rather than wait for the next auto-poll tick.
  // We surface the RAW Apify reported status + console link so the producer
  // can see what Apify is actually doing (genuinely slow, rate-limited,
  // actor crash, etc.) without spelunking through Vercel logs.
  const [refreshResults, setRefreshResults] = useState(null);
  const doRefresh = async () => {
    if (!projectId) return;
    setRefreshing(true); setRefreshMsg(null); setRefreshResults(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refreshScrapes", projectId }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const replayed = (d.results || []).filter(x => x.outcome === "replayed").length;
      const stillRunning = (d.results || []).filter(x => x.outcome === "still_running").length;
      if (replayed > 0) setRefreshMsg(`Pulled ${replayed} completed run${replayed === 1 ? "" : "s"}.`);
      else if (stillRunning > 0) setRefreshMsg(`Still running at Apify (${stillRunning} run${stillRunning === 1 ? "" : "s"}).`);
      else if (d.recovered?.length) setRefreshMsg(`Rolled back — retry Approve.`);
      else setRefreshMsg("No in-flight runs to refresh.");
      setRefreshResults(d.results || []);
    } catch (e) {
      setRefreshMsg(`Refresh failed: ${e.message}`);
    } finally {
      setRefreshing(false);
    }
  };

  // "Taking a while" is a softer nudge — after 120s, not 90s.
  const startedMs = scrape?.startedAt ? new Date(scrape.startedAt).getTime() : 0;
  const stalled = status === "running" && startedMs && (Date.now() - startedMs) > 120 * 1000;

  return (
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ padding: "3px 10px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: colour.bg, color: colour.fg }}>
        {label}: {colour.text}
      </span>
      {scrape?.startedAt && (
        <span style={{ fontSize: 10, color: "var(--muted)" }}>
          Started {new Date(scrape.startedAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
      {scrape?.finishedAt && (
        <span style={{ fontSize: 10, color: "var(--muted)" }}>
          · Finished {new Date(scrape.finishedAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
      {(status === "running" || status === "error") && projectId && (
        <button onClick={doRefresh} disabled={refreshing}
          title="Poll Apify directly for this scrape's status and pull the results if finished"
          style={{ padding: "3px 10px", borderRadius: 10, fontSize: 10, fontWeight: 700, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", cursor: "pointer", fontFamily: "inherit", opacity: refreshing ? 0.5 : 1 }}>
          {refreshing ? "Checking…" : "↻ Refresh"}
        </button>
      )}
      {refreshMsg && (
        <span style={{ fontSize: 10, color: "var(--accent)" }}>{refreshMsg}</span>
      )}
      {stalled && !refreshMsg && (
        <span style={{ fontSize: 10, color: "#F59E0B" }}>
          Taking longer than usual — still auto-checking in the background.
        </span>
      )}
      {refreshResults && refreshResults.length > 0 && (
        <div style={{ width: "100%", marginTop: 6, padding: 10, background: "var(--bg)", borderRadius: 6, border: "1px solid var(--border)", fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>
          {refreshResults.map((r, i) => (
            <div key={i} style={{ marginTop: i ? 6 : 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: "var(--muted)" }}>{r.purpose}:</span>
                <span style={{
                  color: r.apifyStatus === "RUNNING" ? "#3B82F6"
                    : r.apifyStatus === "SUCCEEDED" ? "#22C55E"
                    : r.apifyStatus === "FAILED" || r.apifyStatus === "ABORTED" || r.apifyStatus?.startsWith("TIMED") ? "#EF4444"
                    : "var(--fg)",
                  fontWeight: 700,
                }}>Apify: {r.apifyStatus || "?"}</span>
                {/* OUR replay outcome — this is the key signal for debugging
                    stuck scrapes. "replayed" = we wrote to Firebase.
                    "replay_failed" = webhook endpoint rejected our call. */}
                <span style={{
                  color: r.outcome === "replayed" ? "#22C55E"
                    : r.outcome === "replay_failed" ? "#EF4444"
                    : r.outcome === "still_running" ? "#3B82F6"
                    : "var(--muted)",
                  fontWeight: 700,
                }}>Replay: {r.outcome}</span>
                {r.runningForSec != null && <span style={{ color: "var(--muted)" }}>{r.runningForSec}s elapsed</span>}
                {r.durationMs != null && <span style={{ color: "var(--muted)" }}>ran {Math.round(r.durationMs / 1000)}s</span>}
                {r.exitCode != null && r.exitCode !== 0 && <span style={{ color: "#EF4444" }}>exit {r.exitCode}</span>}
                {r.consoleUrl && <a href={r.consoleUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}>Apify console ↗</a>}
              </div>
              {r.replayDetail && (
                <div style={{ marginTop: 4, padding: "4px 8px", background: "rgba(239,68,68,0.08)", borderRadius: 4, color: "#EF4444", fontSize: 10, whiteSpace: "pre-wrap" }}>
                  Replay error: {r.replayDetail}
                </div>
              )}
              {r.detail && (
                <div style={{ marginTop: 4, padding: "4px 8px", background: "rgba(239,68,68,0.08)", borderRadius: 4, color: "#EF4444", fontSize: 10, whiteSpace: "pre-wrap" }}>
                  Apify error: {r.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// TAB 3 — CLIENT RESEARCH (Phase D)
// Populates from the Stage A scrape. Shows top 5 reels by views, follower
// counts (IG auto, TT/YT producer-supplied), avg views. Producer writes a
// mandatory key-takeaways text — approval is gated on it being filled.
// ═══════════════════════════════════════════
function ClientResearchStep({ project, onPatch }) {
  const clientScrape = project.clientScrape || {};
  const profile = clientScrape.profile || {};
  const followers = profile.followers || {};
  // Live ref onto the latest followers object so async loops can observe
  // Firebase updates without re-registering on every render.
  const followersRef = useRef(followers);
  useEffect(() => { followersRef.current = followers; }, [followers]);
  const posts = Array.isArray(clientScrape.posts) ? clientScrape.posts : [];
  const topIds = Array.isArray(clientScrape.topByViews) ? clientScrape.topByViews : [];
  // Primary path: posts resolved by the ids the webhook pre-sorted. Fallback:
  // if topByViews didn't write for some reason (race, or an older project
  // where the Apify processor didn't emit it), sort posts by views inline so
  // the UI still shows something instead of "no reels yet". Protects against
  // the "scrape says complete but tab 3 is empty" bug.
  const topPostsPrimary = topIds.map(id => posts.find(p => p.id === id)).filter(Boolean).slice(0, 5);
  const topPosts = topPostsPrimary.length > 0
    ? topPostsPrimary
    : [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5);
  const handles = clientScrape.handles || {};
  const approvals = project.approvals || {};
  const isDone = !!approvals.clientResearch;

  const [takeaways, setTakeaways] = useState(project.clientResearch?.keyTakeaways || "");
  const [ttHandle, setTtHandle] = useState(handles.tiktok || "");
  const [ytHandle, setYtHandle] = useState(handles.youtube || "");
  const [busy, setBusy] = useState({ tt: false, yt: false });
  const [err, setErr] = useState({ tt: null, yt: null });

  // Inline Stage-A retry — producers can fix a typo / try a different
  // handle without bouncing back to Tab 2. Defaults to whatever handle
  // was used for the original run; common case is the producer
  // realising after the scrape returned 0 that they typed the wrong
  // handle (businesses often run their socials from a personal @ or
  // a secondary account).
  const [retryHandle, setRetryHandle] = useState(
    clientScrape.handles?.instagram || project.research?.clientHandle || ""
  );
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const retryClientScrape = async () => {
    const clean = retryHandle.trim().replace(/^@+/, "");
    if (!clean) { setRetryError("Type an Instagram handle first."); return; }
    setRetrying(true);
    setRetryError(null);
    try {
      // Persist the new handle to /research so Tab 2 shows the corrected
      // value + so the prompt blocks that read clientHandle pick it up.
      fbSet(`/preproduction/socialOrganic/${project.id}/research/clientHandle`, `@${clean}`);
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "startClientScrape", projectId: project.id, handle: clean }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      // Firebase listener rehydrates clientScrape.status → "running"
      // and the rest of the tab's UI responds accordingly.
    } catch (e) {
      setRetryError(e.message);
    } finally {
      setRetrying(false);
    }
  };
  // Is the scrape in a "retry-me" state? Either finished empty, or errored.
  const scrapeEmpty = clientScrape.status === "done" && posts.length === 0;
  const scrapeErroredState = clientScrape.status === "error";
  const showRetry = scrapeEmpty || scrapeErroredState;

  // Sync local input state when Claude's suggestClientHandle call lands
  // new handles in Firebase. Without this, the inputs stay on their initial
  // empty value even after the backend writes a pre-filled handle.
  useEffect(() => {
    if (handles.tiktok && handles.tiktok !== ttHandle) setTtHandle(handles.tiktok);
  }, [handles.tiktok]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (handles.youtube && handles.youtube !== ytHandle) setYtHandle(handles.youtube);
  }, [handles.youtube]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced takeaways write.
  useEffect(() => {
    if (takeaways === (project.clientResearch?.keyTakeaways || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/socialOrganic/${project.id}/clientResearch/keyTakeaways`, takeaways);
    }, 500);
    return () => clearTimeout(t);
  }, [takeaways]);  // eslint-disable-line react-hooks/exhaustive-deps

  const startProfileScrape = async (platform, handle) => {
    const clean = handle.trim().replace(/^@/, "");
    if (!clean) { setErr(e => ({ ...e, [platform === "tiktok" ? "tt" : "yt"]: "Add a handle first" })); return; }
    const key = platform === "tiktok" ? "tt" : "yt";
    setBusy(s => ({ ...s, [key]: true }));
    setErr(e => ({ ...e, [key]: null }));
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "startProfileScrape", projectId: project.id, platform, handle: clean }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));

      // TT/YT profile scrapes don't flip clientScrape.status to "running"
      // (that's reserved for the main reels scrape), so the project-level
      // auto-poll doesn't catch them. Poll locally — every 5s, up to 90s
      // — and exit early once Firebase reflects the follower count we're
      // waiting on.
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          await authFetch("/api/social-organic", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "refreshScrapes", projectId: project.id }),
          });
        } catch { /* silent — try again next tick */ }
        // Bail early the moment the scrape has landed.
        if (followersRef.current?.[platform] != null) break;
      }
      if (followersRef.current?.[platform] == null) {
        setErr(err => ({ ...err, [key]: "Timed out waiting for Apify — handle may not exist or be private" }));
      }
    } catch (e) {
      setErr(err => ({ ...err, [key]: e.message }));
    } finally {
      setBusy(s => ({ ...s, [key]: false }));
    }
  };

  const approve = () => {
    if (!takeaways.trim()) return;
    fbSet(`/preproduction/socialOrganic/${project.id}/clientResearch/keyTakeaways`, takeaways);
    fbSet(`/preproduction/socialOrganic/${project.id}/approvals/clientResearch`, new Date().toISOString());
    onPatch({ tab: "videoReview" });
  };

  // Auto-fetch follower counts as soon as Claude's pre-filled handle
  // lands in Firebase — saves the producer from manually clicking Fetch
  // for TikTok + YouTube. Skips if the follower count is already set,
  // if the fetch is already in flight, or if there's no handle yet.
  // One-shot per platform: triggered by a ref-backed guard so the
  // effect doesn't retrigger after the scrape completes.
  const autoFetchedRef = useRef({ tiktok: false, youtube: false });
  useEffect(() => {
    if (isDone) return;  // already approved — don't kick off fresh scrapes
    if (handles.tiktok && !autoFetchedRef.current.tiktok && followers.tiktok == null && !busy.tt) {
      autoFetchedRef.current.tiktok = true;
      startProfileScrape("tiktok", handles.tiktok);
    }
    if (handles.youtube && !autoFetchedRef.current.youtube && followers.youtube == null && !busy.yt) {
      autoFetchedRef.current.youtube = true;
      startProfileScrape("youtube", handles.youtube);
    }
  }, [handles.tiktok, handles.youtube]);  // eslint-disable-line react-hooks/exhaustive-deps

  const scrapeRunning = clientScrape.status === "running" && posts.length === 0;
  const scrapeErrored = clientScrape.status === "error";

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Client Research</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          From the Stage A scrape. The key-takeaways text below is mandatory — it captures your read on the client's current content for Tab 7.
        </div>
      </div>

      {/* Scrape-status banners */}
      {scrapeRunning && (
        <div style={{ padding: 14, marginBottom: 14, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.3)", borderRadius: 8, fontSize: 12, color: "#3B82F6" }}>
          Client scrape running… the reels + follower count will appear here once Apify finishes (usually 30-90s).
        </div>
      )}
      {scrapeErrored && (
        <div style={{ padding: 14, marginBottom: 14, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: "#EF4444" }}>
          Client scrape errored: {clientScrape.error || "(no detail)"}. Retry below with a corrected handle.
        </div>
      )}

      {/* Inline Stage-A retry card — appears when the scrape finished
          empty OR errored. Producer can fix a typo + retry without
          bouncing back to Tab 2. */}
      {showRetry && !isDone && (
        <div style={{ padding: 14, marginBottom: 14, background: "var(--card)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>
            {scrapeEmpty ? "Retry with a corrected Instagram handle" : "Retry the client scrape"}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
            {scrapeEmpty
              ? "The previous scrape finished but found no videos. Often this is a typo in the handle, a private account, or the business running their socials from a different @."
              : "Something went wrong last time — try again, or adjust the handle if it was off."}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>@</span>
            <input
              type="text"
              value={retryHandle.replace(/^@+/, "")}
              onChange={e => setRetryHandle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !retrying) retryClientScrape(); }}
              placeholder="handle-goes-here"
              disabled={retrying}
              style={{ ...inputSt, flex: 1, maxWidth: 260, opacity: retrying ? 0.5 : 1 }}
            />
            <button onClick={retryClientScrape} disabled={retrying || !retryHandle.trim()}
              style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: retrying ? "#4B5563" : !retryHandle.trim() ? "#374151" : "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: (retrying || !retryHandle.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (retrying || !retryHandle.trim()) ? 0.6 : 1 }}>
              {retrying ? "Starting…" : "Retry scrape"}
            </button>
          </div>
          {retryError && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#EF4444" }}>{retryError}</div>
          )}
        </div>
      )}

      {/* Follower-count cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 14 }}>
        <FollowerCard platform="Instagram" handle={clientScrape.handles?.instagram || project.research?.clientHandle}
          count={followers.instagram} autoScraped />
        <FollowerCard platform="TikTok" handle={ttHandle} onHandleChange={setTtHandle}
          onScrape={() => startProfileScrape("tiktok", ttHandle)}
          count={followers.tiktok} busy={busy.tt} error={err.tt} disabled={isDone} />
        <FollowerCard platform="YouTube" handle={ytHandle} onHandleChange={setYtHandle}
          onScrape={() => startProfileScrape("youtube", ytHandle)}
          count={followers.youtube} busy={busy.yt} error={err.yt} disabled={isDone} />
      </div>

      {/* Average / median stats */}
      {(profile.avgViews || profile.medianViews) && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <StatChip label="Avg views" value={formatBig(profile.avgViews)} />
          <StatChip label="Median views" value={formatBig(profile.medianViews)} />
          <StatChip label="Total reels scraped" value={posts.length} />
        </div>
      )}

      {/* Top 5 reels */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 10 }}>Top 5 client reels by views</div>
        {topPosts.length === 0 ? (
          clientScrape.status === "done" && posts.length === 0 ? (
            // Amber notification card — visually distinct so producers
            // don't miss it. Makes the "this is fine, just move on"
            // action obvious at a glance.
            <div style={{ padding: "14px 16px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 10, display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }} aria-hidden="true">⚠️</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#F59E0B", marginBottom: 4 }}>
                  0 reels found for this Instagram handle
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.55, marginBottom: 6 }}>
                  Could be a typo, a private account, or the client just doesn't post video content on Instagram (common for B2B).
                </div>
                <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.55 }}>
                  <strong>Reels aren't required to continue.</strong> Write the Key Takeaways below using TikTok / YouTube / what you know from the pre-production meeting, then approve.
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
              {scrapeRunning
                ? "Waiting on scrape…"
                : !clientScrape.status
                  ? "No scrape has been run yet — approve Stage A on Tab 2 to kick it off."
                  : "No reels yet — waiting on the client scrape."}
            </div>
          )
        ) : (
          // Wider tiles + taller aspect ratio so the Instagram embed has
          // room to render the full reel frame without cropping the chrome.
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {topPosts.map(p => (
              <div key={p.id} style={{ background: "var(--bg)", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                <ReelPreview shortCode={p.shortCode} url={p.url} thumbnail={p.thumbnail} aspectRatio="9 / 16" />
                <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", textDecoration: "none", padding: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", fontFamily: "'JetBrains Mono',monospace" }}>
                    👁 {formatBig(p.views)}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(p.caption || "").slice(0, 60)}
                  </div>
                </a>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Key takeaways — mandatory */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>
          Key takeaways <span style={{ color: "#EF4444", marginLeft: 4 }}>*</span>
        </label>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
          What are the strengths of the client's current content? Where are the gaps? Use your eyes on the reels above. With the client will see this.
        </div>
        <textarea value={takeaways} onChange={e => setTakeaways(e.target.value)}
          placeholder="e.g. Strong on-camera presence but formats are inconsistent. Best-performing reels are the 'day in the life' ones. No hook formula — we should standardise."
          rows={5}
          disabled={isDone}
          style={{ ...inputSt, resize: "vertical", fontSize: 12, fontFamily: "inherit", opacity: isDone ? 0.7 : 1 }} />
      </div>

      {!isDone && (
        <button onClick={approve}
          disabled={!takeaways.trim()}
          title={!takeaways.trim() ? "Fill the key takeaways first" : "Approve and move to Video Review"}
          style={{ ...btnPrimary, opacity: takeaways.trim() ? 1 : 0.5 }}>
          Approve → Video Review
        </button>
      )}
      {isDone && (
        <div style={{ padding: 14, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, fontSize: 12, color: "#22C55E", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <span>✓ Approved {new Date(approvals.clientResearch).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
          <button onClick={() => onPatch({ tab: "videoReview" })} style={btnPrimary}>→ Video Review</button>
        </div>
      )}
    </div>
  );
}

function FollowerCard({ platform, handle, onHandleChange, onScrape, count, busy, error, disabled, autoScraped }) {
  const countStr = count == null ? "—" : formatBig(count);
  const platformIcon = { Instagram: "📷", TikTok: "🎵", YouTube: "📺" }[platform] || "";
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>{platformIcon}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{platform}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg)", fontFamily: "'JetBrains Mono',monospace", marginBottom: 6 }}>
        {countStr} <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>followers</span>
      </div>
      {autoScraped ? (
        <div style={{ fontSize: 10, color: "var(--muted)" }}>
          @{(handle || "").replace(/^@/, "")} · from Stage A scrape
        </div>
      ) : (
        <div style={{ display: "flex", gap: 4 }}>
          <input type="text" value={handle || ""} onChange={e => onHandleChange(e.target.value)}
            disabled={disabled || busy}
            placeholder="@handle"
            style={{ ...inputSt, fontSize: 11, padding: "5px 8px" }} />
          <button onClick={onScrape} disabled={disabled || busy || !handle?.trim()}
            style={{ ...btnSecondary, padding: "5px 10px", fontSize: 11, opacity: (disabled || busy || !handle?.trim()) ? 0.5 : 1 }}>
            {busy ? "…" : count == null ? "Fetch" : "Refresh"}
          </button>
        </div>
      )}
      {error && <div style={{ fontSize: 10, color: "#EF4444", marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function StatChip({ label, value }) {
  return (
    <div style={{ padding: "10px 14px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, minWidth: 140 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)", fontFamily: "'JetBrains Mono',monospace", marginTop: 3 }}>{value}</div>
    </div>
  );
}

// ScriptStep toolbar: regenerate, copy share URL, push to Runsheets.
// Social Organic projects feed into the Runsheets tab (shoot scheduling),
// NOT the Deliveries tab (post-production handover).
function ScriptToolbar({ project, onRegenerate, onPatch }) {
  const doc = project.preproductionDoc || {};
  // Legacy projects may still have deliveryHandoff from the old push path.
  // Treat either as "already pushed".
  const runsheetHandoff = project.runsheetHandoff || null;
  const legacyDelivery = project.deliveryHandoff || null;
  const pushed = !!(runsheetHandoff?.runsheetId || legacyDelivery?.deliveryId);
  const shareUrl = preproductionShareUrl(project);
  const [copied, setCopied] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState(null);

  const copyShare = () => {
    try {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. http in dev) — fall back to selecting.
      window.prompt("Copy this URL:", shareUrl);
    }
  };

  const pushToRunsheet = async () => {
    if (pushed) return;
    if (!window.confirm("Push this project to the Runsheets tab? Creates a new runsheet with one video row per script table entry.")) return;
    setPushing(true);
    setPushError(null);
    try {
      const r = await authFetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pushToRunsheet", projectId: project.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
    } catch (e) {
      setPushError(e.message);
    } finally {
      setPushing(false);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Preproduction brief</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {doc.generatedAt
            ? `Generated ${new Date(doc.generatedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${doc.modelUsed || "claude-opus-4-6"}`
            : "No brief yet."} Click any cell to rewrite it.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {doc.generatedAt && project.shortId && (
          <button onClick={copyShare} style={btnSecondary}>
            {copied ? "✓ Copied" : "📎 Copy share URL"}
          </button>
        )}
        {doc.generatedAt && <button onClick={onRegenerate} style={btnSecondary}>Regenerate</button>}
        {doc.scriptTable?.length > 0 && !pushed && (
          <button onClick={pushToRunsheet} disabled={pushing}
            style={{ ...btnPrimary, opacity: pushing ? 0.6 : 1 }}>
            {pushing ? "Pushing…" : "→ Push to Runsheets"}
          </button>
        )}
        {pushed && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "6px 12px", background: "rgba(34,197,94,0.12)", color: "#22C55E", borderRadius: 8, fontSize: 11, fontWeight: 700 }}>
            <span>✓ Pushed {new Date((runsheetHandoff || legacyDelivery).pushedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
            <span style={{ color: "#5A6B85", fontSize: 10, fontWeight: 500 }}>
              Find it in <span style={{ color: "#22C55E", fontWeight: 700 }}>Pre-Prod → Runsheets</span>
            </span>
          </div>
        )}
      </div>
      {pushError && (
        <div style={{ width: "100%", padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
          {pushError}
        </div>
      )}
    </div>
  );
}

// Banner that summarises client-left feedback on the current scriptTable.
// Producers should be able to tell at a glance "has the client replied yet?"
// without spelunking through each cell.
function ClientFeedbackSummary({ project }) {
  const doc = project.preproductionDoc || {};
  // Legacy per-cell shape (still readable for older projects)
  const cellEntries = Object.entries(doc.clientFeedback || {}).filter(([, v]) => v && v.text);
  // New shapes from the redesigned public review page
  const sectionEntries = Object.values(doc.sectionFeedback || {}).filter(Boolean);
  const scriptEntries = Object.values(doc.scriptFeedback || {}).filter(Boolean);
  const reactionCount = scriptEntries.filter(s => s.reaction).length;
  const commentCount  = scriptEntries.reduce((n, s) => n + Object.keys(s.comments || {}).length, 0);
  const submittedAt = doc.reviewSubmittedAt || null;
  if (cellEntries.length === 0 && sectionEntries.length === 0 && reactionCount === 0 && commentCount === 0 && !submittedAt) return null;

  // Newest activity across all shapes — drives the "latest" timestamp.
  const allStamps = [
    ...cellEntries.map(([, v]) => v.submittedAt || ""),
    ...sectionEntries.map(s => s.submittedAt || ""),
    ...scriptEntries.map(s => s.updatedAt || ""),
  ].filter(Boolean);
  const newest = allStamps.sort().pop();

  const parts = [];
  if (sectionEntries.length > 0) parts.push(`${sectionEntries.length} section${sectionEntries.length === 1 ? "" : "s"}`);
  if (reactionCount > 0)         parts.push(`${reactionCount} reaction${reactionCount === 1 ? "" : "s"}`);
  if (commentCount > 0)          parts.push(`${commentCount} comment${commentCount === 1 ? "" : "s"}`);
  if (cellEntries.length > 0)    parts.push(`${cellEntries.length} cell note${cellEntries.length === 1 ? "" : "s"}`);

  const isSubmitted = !!submittedAt;
  const bg = isSubmitted ? "rgba(34,197,94,0.08)" : "rgba(245,158,11,0.08)";
  const border = isSubmitted ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)";
  const color = isSubmitted ? "#22C55E" : "#F59E0B";

  return (
    <div style={{ padding: 14, marginBottom: 14, background: bg, border: `1px solid ${border}`, borderRadius: 8, fontSize: 12, color }}>
      <strong>{isSubmitted ? "Client submitted their review" : "Client has left feedback"}</strong>
      {parts.length > 0 && ` · ${parts.join(" · ")}`}
      {submittedAt && ` · submitted ${new Date(submittedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`}
      {!submittedAt && newest && ` · latest ${new Date(newest).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`}
    </div>
  );
}

// Producer-side renderer for the new feedback shapes (section verdicts
// + per-script reactions + threaded comments) written by the redesigned
// client review page. Comments expose a resolve toggle so the producer
// works through them the same way the legacy per-cell list works.
function ClientReviewFeedback({ project }) {
  const doc = project.preproductionDoc || {};
  const sections = doc.sectionFeedback || {};
  const scripts = doc.scriptFeedback || {};
  const scriptRows = doc.scriptTable || [];
  const sectionIds = Object.keys(sections);
  const scriptIds  = Object.keys(scripts);
  if (sectionIds.length === 0 && scriptIds.length === 0) return null;

  const SECTION_LABELS = { brand: "Brand truth", formats: "Formats", scripts: "Scripts overall" };
  const REACTION_META = {
    love:  { label: "Love",  color: "#22C55E", bg: "rgba(34,197,94,0.1)" },
    tweak: { label: "Tweak", color: "#F59E0B", bg: "rgba(245,158,11,0.1)" },
    cut:   { label: "Cut",   color: "#EF4444", bg: "rgba(239,68,68,0.1)" },
  };

  // reviewId → human row number; falls back to "row_<i>" if the
  // public view wrote feedback under that key (legacy rows without a
  // reviewId stamp).
  const rowLabelFor = (key) => {
    const byId = scriptRows.findIndex(r => r && r.reviewId === key);
    if (byId !== -1) return `Video ${scriptRows[byId].videoNumber || byId + 1}`;
    const idx = key.startsWith("row_") ? Number(key.slice(4)) : NaN;
    if (Number.isInteger(idx) && scriptRows[idx]) return `Video ${scriptRows[idx].videoNumber || idx + 1}`;
    return `Video ${key.slice(-4)}`;
  };

  const unresolvedComments = scriptIds.reduce((n, key) => {
    const cs = scripts[key]?.comments || {};
    return n + Object.values(cs).filter(c => c && !c.resolved).length;
  }, 0);
  const sectionsWithChanges = sectionIds.filter(id => sections[id]?.verdict === "changes").length;

  return (
    <SectionCard title={`Client review (${sectionsWithChanges + unresolvedComments} to action)`}>
      {sectionIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Section verdicts</div>
          <div style={{ display: "grid", gap: 8 }}>
            {sectionIds.map(id => {
              const s = sections[id];
              if (!s) return null;
              const isApprove = s.verdict === "approve";
              const isChanges = s.verdict === "changes";
              return (
                <div key={id} style={{ padding: "10px 14px", background: "var(--card)", border: `1px solid ${isChanges ? "rgba(245,158,11,0.4)" : isApprove ? "rgba(34,197,94,0.3)" : "var(--border)"}`, borderRadius: 8, display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 14, alignItems: "start" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ padding: "4px 9px", borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", background: isApprove ? "rgba(34,197,94,0.15)" : isChanges ? "rgba(245,158,11,0.15)" : "var(--bg)", color: isApprove ? "#22C55E" : isChanges ? "#F59E0B" : "var(--muted)" }}>
                      {isApprove ? "Approved" : isChanges ? "Changes" : "Saved"}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>{SECTION_LABELS[id] || id}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                    {s.text || <span style={{ color: "var(--muted)", fontStyle: "italic" }}>No note left.</span>}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {s.submittedAt ? new Date(s.submittedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {scriptIds.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Per-script feedback {unresolvedComments > 0 && <span style={{ marginLeft: 6, color: "#F59E0B" }}>· {unresolvedComments} unresolved</span>}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {scriptIds.map(key => {
              const s = scripts[key];
              if (!s) return null;
              const rMeta = s.reaction ? REACTION_META[s.reaction] : null;
              const comments = Object.entries(s.comments || {})
                .map(([cid, c]) => ({ cid, ...c }))
                .sort((a, b) => (a.at || 0) - (b.at || 0));
              if (!rMeta && comments.length === 0) return null;
              return (
                <div key={key} style={{ padding: "12px 14px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: comments.length > 0 ? 10 : 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", fontFamily: "'JetBrains Mono',monospace" }}>{rowLabelFor(key)}</span>
                    {rMeta && (
                      <span style={{ padding: "3px 9px", borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", background: rMeta.bg, color: rMeta.color }}>
                        {rMeta.label} it
                      </span>
                    )}
                    {s.updatedAt && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>{new Date(s.updatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>}
                  </div>
                  {comments.length > 0 && (
                    <div style={{ display: "grid", gap: 6 }}>
                      {comments.map(c => {
                        const basePath = `/preproduction/socialOrganic/${project.id}/preproductionDoc/scriptFeedback/${key}/comments/${c.cid}`;
                        return (
                          <div key={c.cid} style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", gap: 8, alignItems: "start", padding: "8px 10px", background: c.resolved ? "var(--bg)" : "transparent", border: `1px solid ${c.resolved ? "var(--border)" : "rgba(245,158,11,0.25)"}`, borderRadius: 6, opacity: c.resolved ? 0.6 : 1 }}>
                            <input
                              type="checkbox"
                              checked={!!c.resolved}
                              onChange={(e) => {
                                fbSet(`${basePath}/resolved`, e.target.checked);
                                fbSet(`${basePath}/resolvedAt`, e.target.checked ? new Date().toISOString() : null);
                              }}
                              style={{ marginTop: 3, cursor: "pointer", accentColor: "var(--accent)" }}
                            />
                            <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.5, textDecoration: c.resolved ? "line-through" : "none", whiteSpace: "pre-wrap" }}>{c.text}</div>
                            <div style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                              {c.at ? new Date(c.at).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
