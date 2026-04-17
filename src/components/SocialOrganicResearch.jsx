// Social Media Organic — Competitor Intelligence Research + Producer Workflow
// Producers research overperforming Instagram content in a client's niche,
// then walk the project through five stages: Scrape → Review → Shortlist →
// Select → Script. The final Script stage produces a Picup-Media-style
// pre-production doc with per-cell AI rewrite affordances.
//
// Lives inside the Pre-Production tab's "Social Media Organic" sub-tab.
// Data shape at /preproduction/socialOrganic/{projectId}. The legacy
// `synthesis` field on old projects is preserved but unused.

import { useState, useEffect, useRef } from "react";
import { onFB, fbSet, fbListen, getCurrentRole } from "../firebase";
import { logoBg, makeShortId } from "../utils";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { SocialOrganicSelect } from "./SocialOrganicSelect";

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
export function SocialOrganicResearch({ accounts }) {
  const [projects, setProjects] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [creating, setCreating] = useState(false);

  // Firebase listener
  useEffect(() => {
    let unsub = () => {};
    onFB(() => {
      unsub = fbListen("/preproduction/socialOrganic", (data) => {
        // Filter internal keys (_costLog, _handleDirectory) out of the project list
        const filtered = {};
        Object.entries(data || {}).forEach(([k, v]) => {
          if (!k.startsWith("_") && v && v.id) filtered[k] = v;
        });
        setProjects(filtered);
      });
    });
    return () => unsub();
  }, []);

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

  // Detail-view helpers
  const patchProject = (projectId, patch) => {
    const current = projects[projectId];
    if (!current) return;
    fbSet(`/preproduction/socialOrganic/${projectId}`, {
      ...current,
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
        findAccount={findAccount}
        getAccountLogo={getAccountLogo}
        getAccountLogoBg={getAccountLogoBg}
        onBack={() => setActiveProjectId(null)}
        onPatch={(patch) => patchProject(activeProject.id, patch)}
        onDelete={() => {
          if (!window.confirm(`Delete "${activeProject.companyName}" research project?`)) return;
          fbSet(`/preproduction/socialOrganic/${activeProject.id}`, null);
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

      {!creating && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Competitor Research</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
              Research overperforming social content in a client's niche, review the winners, then build the pre-production brief.
            </div>
          </div>
          <button onClick={() => setCreating(true)} style={btnPrimary}>+ New Research Project</button>
        </div>
      )}

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
                  const s = effectiveStage(p);
                  if (s === "scrape") return null;
                  const stageLabel = { review: "In review", shortlist: "Shortlisting", select: "Selecting", script: "Script" }[s] || s;
                  return <Badge text={stageLabel} colors={{ bg: "rgba(34,197,94,0.12)", fg: "#22C55E" }} />;
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
      transcriptSuggestions: null,
      scrape: null,
      posts: [],
      handleStats: {},
      // Producer-driven 5-stage workflow (Phase 1+). Legacy projects without
      // `stage` fall back to effectiveStage() derived from posts state.
      stage: "scrape",
      performanceMultiplier: 2,
      videoReviews: {},
    };
    onCreate(project);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onCancel}>
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 24, maxWidth: 560, width: "90%", border: "1px solid var(--border)", maxHeight: "80vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg)" }}>New Research Project</div>
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
function ResearchDetail({ project, accounts, findAccount, getAccountLogo, getAccountLogoBg, onBack, onPatch, onDelete }) {
  const logo = getAccountLogo(project.companyName, project.attioCompanyId);
  const lbg = logoBg(getAccountLogoBg(project.companyName, project.attioCompanyId));
  const linkedAccount = findAccount(project.companyName, project.attioCompanyId);
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState(null);

  const patchInputs = (patch) => onPatch({ inputs: { ...(project.inputs || {}), ...patch } });

  const runScrape = async () => {
    const handles = (project.inputs?.competitors || []).map(c => c.handle).filter(Boolean);
    if (!handles.length) { alert("Add at least one competitor handle before scraping."); return; }
    setScraping(true);
    setScrapeError(null);
    try {
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scrape", projectId: project.id, inputs: project.inputs }),
      });
      const d = await r.json();
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

  const posts = Array.isArray(project.posts) ? project.posts : [];
  const stage = effectiveStage(project);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ ...btnSecondary, padding: "5px 10px" }}>&larr; Back</button>
          {logo && <img key={logo + lbg} src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 30, borderRadius: 4, objectFit: "contain", background: lbg, padding: 3 }} />}
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>{project.companyName}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Competitor research · {project.createdAt ? formatDate(project.createdAt) : ""}</div>
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

      {/* Five-stage stepper (Phase 1 of the producer-driven workflow).
          For legacy projects with no `stage` field we infer it from posts length. */}
      <StepperBar project={project} onChange={(stage) => onPatch({ stage })} />

      {stage === "scrape" && (
        <>
          <InputsSection
            project={project}
            linkedAccount={linkedAccount}
            onPatchInputs={patchInputs}
          />
          <ActionBar
            project={project}
            scraping={scraping}
            onScrape={runScrape}
            scrapeError={scrapeError}
          />
          {posts.length > 0 && <PostsGrid posts={posts} handleStats={project.handleStats || {}} projectId={project.id} />}
          {posts.length > 0 && posts.some(p => p.format) && (
            <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--accent-soft)", borderRadius: 8, border: "1px solid var(--accent)", fontSize: 12, color: "var(--fg)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>Scrape + classify complete. Move to Review to tick the videos worth shortlisting.</span>
              <button onClick={() => onPatch({ stage: "review" })} style={btnPrimary}>Go to Review →</button>
            </div>
          )}
        </>
      )}

      {stage === "review" && (
        <ReviewStep project={project} onPatch={onPatch} />
      )}

      {stage === "shortlist" && (
        <ShortlistStep project={project} onPatch={onPatch} />
      )}

      {stage === "select" && (
        <SocialOrganicSelect project={project} onPatch={onPatch} />
      )}

      {stage === "script" && (
        <ScriptBuilderStep project={project} onPatch={onPatch} />
      )}
    </div>
  );
}

// Stage is stored on the project. Legacy projects have no `stage` field —
// derive one from the posts state so the UI doesn't strand them on a blank page.
function effectiveStage(project) {
  if (project?.stage) return project.stage;
  const posts = Array.isArray(project?.posts) ? project.posts : [];
  if (posts.length > 0 && posts.some(p => p.format)) return "review";
  return "scrape";
}

const STAGES = [
  { key: "scrape",    label: "Scrape",    num: 1 },
  { key: "review",    label: "Review",    num: 2 },
  { key: "shortlist", label: "Shortlist", num: 3 },
  { key: "select",    label: "Select",    num: 4 },
  { key: "script",    label: "Script",    num: 5 },
];

function StepperBar({ project, onChange }) {
  const current = effectiveStage(project);
  const currentIdx = STAGES.findIndex(s => s.key === current);
  const posts = Array.isArray(project?.posts) ? project.posts : [];
  const hasClassified = posts.some(p => p.format);
  const reviewCount = Object.values(project?.videoReviews || {}).filter(r => r?.status === "ticked").length;
  const shortlistCount = Object.values(project?.shortlistedFormats || {}).filter(Boolean).length;
  const selectedCount = Array.isArray(project?.selectedFormats) ? project.selectedFormats.length : 0;

  // A stage is reachable iff the user has cleared the prerequisite.
  // Prevents jumping to "Select" before anything is shortlisted.
  const reachable = (idx) => {
    if (idx === 0) return true;  // always can go back to scrape
    if (idx === 1) return hasClassified;
    if (idx === 2) return hasClassified && reviewCount > 0;
    if (idx === 3) return shortlistCount > 0;
    if (idx === 4) return selectedCount > 0 || !!project?.preproductionDoc;
    return false;
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, overflowX: "auto" }}>
      {STAGES.map((s, idx) => {
        const isActive = idx === currentIdx;
        const isDone = idx < currentIdx;
        const canReach = reachable(idx);
        return (
          <button
            key={s.key}
            onClick={() => canReach && onChange(s.key)}
            disabled={!canReach}
            title={!canReach ? "Complete the previous stage first" : `Go to ${s.label}`}
            style={{
              flex: 1, minWidth: 100, padding: "8px 12px", borderRadius: 6,
              border: "none", background: isActive ? "var(--accent)" : "transparent",
              color: isActive ? "#fff" : isDone ? "var(--accent)" : canReach ? "var(--fg)" : "var(--muted)",
              fontSize: 12, fontWeight: 700, cursor: canReach ? "pointer" : "not-allowed",
              fontFamily: "inherit", opacity: canReach ? 1 : 0.5,
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

function ComingSoonStep({ title, hint, onBack }) {
  return (
    <div style={{ padding: 40, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 28, marginBottom: 10 }}>🚧</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>{title} — coming soon</div>
      <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 520, margin: "0 auto 16px", lineHeight: 1.5 }}>{hint}</div>
      <button onClick={onBack} style={btnSecondary}>← Back</button>
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
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "runPipeline", projectId: project.id, fast: fastClassify }),
      });
      const d = await r.json();
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
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "classify", projectId: project.id, fast: fastClassify }),
      });
      const d = await r.json();
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
      await fetch("/api/social-organic", {
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
      <a href={post.url} target="_blank" rel="noopener noreferrer"
        style={{ display: "block", textDecoration: "none" }}>
        <div style={{ aspectRatio: "1 / 1", background: "#000", position: "relative", overflow: "hidden" }}>
          {post.thumbnail ? (
            <img src={post.thumbnail} alt="" loading="lazy" onError={e => { e.target.style.display = "none"; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", color: "var(--muted)", fontSize: 11 }}>No thumbnail</div>
          )}
          {post.isVideo && (
            <div style={{ position: "absolute", top: 6, right: 6, padding: "2px 6px", background: "rgba(0,0,0,0.6)", borderRadius: 4, fontSize: 9, fontWeight: 700, color: "#fff" }}>▶ video</div>
          )}
          {overBadge && over != null && (
            <div style={{ position: "absolute", bottom: 6, left: 6, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", background: overBadge.bg, color: overBadge.fg }}>
              {over >= 1 ? `${over.toFixed(1)}× avg` : `${(over * 100).toFixed(0)}% avg`}
            </div>
          )}
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
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extractFromTranscript",
          projectId: project.id,
          transcript: useGoogleDoc ? undefined : transcriptText,
          googleDocUrl: useGoogleDoc ? docUrl.trim() : undefined,
        }),
      });
      const d = await r.json();
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
        const r = await fetch("/api/social-organic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "estimate", handles, postsPerHandle }),
        });
        const d = await r.json();
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
function ReviewStep({ project, onPatch }) {
  const posts = Array.isArray(project.posts) ? project.posts : [];
  const reviews = project.videoReviews || {};

  // Slider value lives locally for responsiveness; debounced 300ms write to Firebase.
  const storedMultiplier = typeof project.performanceMultiplier === "number" ? project.performanceMultiplier : 2;
  const [mult, setMult] = useState(storedMultiplier);
  useEffect(() => { setMult(storedMultiplier); }, [storedMultiplier]);
  useEffect(() => {
    if (mult === storedMultiplier) return;
    const t = setTimeout(() => {
      onPatch({ performanceMultiplier: mult });
    }, 300);
    return () => clearTimeout(t);
  }, [mult]);  // eslint-disable-line react-hooks/exhaustive-deps

  const [filter, setFilter] = useState("all");  // all | ticked | crossed | unreviewed

  // Videos only, classified, above the multiplier.
  const videos = posts.filter(p => p.isVideo);
  const qualifying = videos.filter(p =>
    p.format && p.overperformanceScore != null && p.overperformanceScore >= mult
  );

  const tickedIds = Object.entries(reviews).filter(([, r]) => r?.status === "ticked").map(([k]) => k);
  const crossedIds = Object.entries(reviews).filter(([, r]) => r?.status === "crossed").map(([k]) => k);

  let filtered = qualifying;
  if (filter === "ticked")     filtered = qualifying.filter(p => reviews[p.id]?.status === "ticked");
  else if (filter === "crossed")   filtered = qualifying.filter(p => reviews[p.id]?.status === "crossed");
  else if (filter === "unreviewed") filtered = qualifying.filter(p => !reviews[p.id]);

  const setStatus = (postId, status) => {
    const current = reviews[postId]?.status;
    const next = current === status ? null : status;  // toggle off if clicking the same button
    const updated = { ...reviews };
    if (next === null) {
      delete updated[postId];
    } else {
      updated[postId] = { status: next, reviewedAt: new Date().toISOString() };
    }
    onPatch({ videoReviews: updated });
  };

  const reviewedCount = tickedIds.length + crossedIds.length;
  const canAdvance = tickedIds.length > 0;

  return (
    <div>
      {/* Multiplier slider */}
      <div style={{ marginBottom: 14, padding: 14, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Outperforming filter</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              Only show videos that outperform their handle's median by at least this multiplier.
            </div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--accent)" }}>{mult.toFixed(2)}×</div>
        </div>
        <input type="range" min={1} max={5} step={0.25} value={mult}
          onChange={e => setMult(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
          <span>1.00×</span><span>2.00× (default)</span><span>5.00×</span>
        </div>
      </div>

      {/* Filter chips + progress counter */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <FilterChip label={`All (${qualifying.length})`} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterChip label={`✓ Ticked (${tickedIds.length})`} active={filter === "ticked"} colour="#22C55E" onClick={() => setFilter("ticked")} />
          <FilterChip label={`✗ Crossed (${crossedIds.length})`} active={filter === "crossed"} colour="#EF4444" onClick={() => setFilter("crossed")} />
          <FilterChip label={`Unreviewed (${qualifying.length - reviewedCount})`} active={filter === "unreviewed"} onClick={() => setFilter("unreviewed")} />
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {reviewedCount}/{qualifying.length} reviewed
          {canAdvance && (
            <button onClick={() => onPatch({ stage: "shortlist" })} style={{ ...btnPrimary, marginLeft: 10, padding: "6px 14px" }}>
              → Shortlist ({tickedIds.length})
            </button>
          )}
        </div>
      </div>

      {qualifying.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>
            {videos.length === 0 ? "No video posts in this scrape" : `No videos above ${mult.toFixed(2)}× baseline`}
          </div>
          <div style={{ fontSize: 11 }}>
            {videos.length === 0
              ? "Only classified videos appear here — images are skipped for reels."
              : "Drop the multiplier slider above to surface more videos."}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {filtered.map(p => (
            <ReviewCard key={p.id} post={p}
              status={reviews[p.id]?.status || null}
              onTick={() => setStatus(p.id, "ticked")}
              onCross={() => setStatus(p.id, "crossed")}
            />
          ))}
          {filtered.length === 0 && (
            <div style={{ gridColumn: "1 / -1", padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
              No videos match this filter.
            </div>
          )}
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
function ReviewCard({ post, status, onTick, onCross }) {
  const isTicked = status === "ticked";
  const isCrossed = status === "crossed";
  const border = isTicked ? "2px solid #22C55E" : isCrossed ? "1px solid var(--border)" : "1px solid var(--border)";
  const opacity = isCrossed ? 0.45 : 1;
  const textDeco = isCrossed ? "line-through" : "none";

  return (
    <div style={{ background: "var(--card)", border, borderRadius: 10, overflow: "hidden", opacity, transition: "opacity 0.15s, border 0.15s", position: "relative" }}>
      <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", textDecoration: "none" }}>
        <div style={{ aspectRatio: "1 / 1", background: "#000", position: "relative", overflow: "hidden" }}>
          {post.thumbnail ? (
            <img src={post.thumbnail} alt="" loading="lazy" onError={e => { e.target.style.display = "none"; }}
              style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", color: "var(--muted)", fontSize: 11 }}>No thumbnail</div>
          )}
          <div style={{ position: "absolute", top: 6, right: 6, padding: "2px 6px", background: "rgba(0,0,0,0.6)", borderRadius: 4, fontSize: 9, fontWeight: 700, color: "#fff" }}>▶ video</div>
          {post.overperformanceScore != null && (
            <div style={{ position: "absolute", bottom: 6, left: 6, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", background: "rgba(34,197,94,0.85)", color: "#fff" }}>
              {post.overperformanceScore.toFixed(1)}× avg
            </div>
          )}
        </div>
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
}

// ═══════════════════════════════════════════
// SHORTLIST STEP — per-video form writes to the global Format Library
// Two-column layout: left = ticked videos (click to select), right = the
// edit form. Saving creates /formatLibrary/{id} (new) or appends a new
// example to an existing library entry. The project's
// shortlistedFormats/{sl_<videoId>} record links the two together so re-
// opening the project restores edits.
// ═══════════════════════════════════════════
function ShortlistStep({ project, onPatch }) {
  const posts = Array.isArray(project.posts) ? project.posts : [];
  const reviews = project.videoReviews || {};
  const shortlisted = project.shortlistedFormats || {};

  // Only ticked videos are candidates for shortlisting.
  const tickedVideos = posts.filter(p => p.isVideo && reviews[p.id]?.status === "ticked");

  // Global format library + categories — both listened to live so the
  // form's category dropdown and "Add as example to" search stay in sync
  // with what other projects have contributed.
  const [library, setLibrary] = useState({});
  const [categories, setCategories] = useState({});
  useEffect(() => {
    let unsubL = () => {}, unsubC = () => {};
    onFB(() => {
      unsubL = fbListen("/formatLibrary", (d) => setLibrary(d || {}));
      unsubC = fbListen("/formatCategories", (d) => setCategories(d || {}));
    });
    return () => { unsubL(); unsubC(); };
  }, []);

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

  const allShortlisted = Object.values(shortlisted || {}).filter(Boolean);
  const canAdvance = allShortlisted.length > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Shortlist</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Each ticked video becomes an entry in the global Format Library — or gets added as a new example to an existing format.
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {allShortlisted.length}/{tickedVideos.length} shortlisted
          {canAdvance && (
            <button onClick={() => onPatch({ stage: "select" })} style={{ ...btnPrimary, marginLeft: 10, padding: "6px 14px" }}>
              → Select ({allShortlisted.length})
            </button>
          )}
        </div>
      </div>

      {tickedVideos.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>No ticked videos yet</div>
          <div style={{ fontSize: 11 }}>Go back to Review and tick the videos worth shortlisting.</div>
          <button onClick={() => onPatch({ stage: "review" })} style={{ ...btnSecondary, marginTop: 12 }}>← Back to Review</button>
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
                  <div style={{ width: 56, height: 56, flexShrink: 0, background: "#000", borderRadius: 4, overflow: "hidden" }}>
                    {v.thumbnail && <img src={v.thumbnail} alt="" onError={e => { e.target.style.display = "none"; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
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
                categories={categories}
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
function ShortlistForm({ video, project, library, categories, existing, onSaved }) {
  const mode = existing?.addedAsExampleTo ? "example" : existing?.formatLibraryId ? "new" : "new";
  const [saveMode, setSaveMode] = useState(mode);  // "new" | "example"
  const [formatName, setFormatName] = useState(existing?.formatName || "");
  const [category, setCategory] = useState(existing?.category || "");
  const [newCategory, setNewCategory] = useState("");
  const [tags, setTags] = useState(existing?.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [description, setDescription] = useState(existing?.description || "");
  const [filming, setFilming] = useState(existing?.filmingInstructions || "");
  const [structure, setStructure] = useState(existing?.structureInstructions || "");
  const [addTargetId, setAddTargetId] = useState(existing?.addedAsExampleTo || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const categoryList = Object.entries(categories || {})
    .map(([k, v]) => ({ key: k, label: v?.label || k }))
    .sort((a, b) => a.label.localeCompare(b.label));

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

  const effectiveCategory = newCategory.trim() || category;

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
          name: formatName.trim(),
          videoAnalysis: description,
          filmingInstructions: filming,
          structureInstructions: structure,
          category: effectiveCategory || null,
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

        // Register new category if user created one inline.
        if (newCategory.trim()) {
          const catKey = newCategory.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
          if (catKey) {
            fbSet(`/formatCategories/${catKey}`, { label: newCategory.trim(), createdAt: now });
          }
        }
      }

      // Write the project-side shortlist record.
      const shortlistId = `sl_${video.id}`;
      fbSet(`/preproduction/socialOrganic/${project.id}/shortlistedFormats/${shortlistId}`, {
        videoId: video.id,
        formatName: saveMode === "new" ? formatName.trim() : (library[libraryId]?.name || ""),
        description,
        filmingInstructions: filming,
        structureInstructions: structure,
        category: effectiveCategory || null,
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
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
      {/* Header: video preview */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
        <a href={video.url} target="_blank" rel="noopener noreferrer" style={{ flexShrink: 0 }}>
          <div style={{ width: 80, height: 80, background: "#000", borderRadius: 6, overflow: "hidden" }}>
            {video.thumbnail && <img src={video.thumbnail} alt="" onError={e => { e.target.style.display = "none"; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
        </a>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>{video.handle}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
            {video.views != null && `${formatBig(video.views)} views · `}
            {video.overperformanceScore != null && `${video.overperformanceScore.toFixed(1)}× baseline`}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg)", lineHeight: 1.4, marginTop: 4, maxHeight: 36, overflow: "hidden" }}>
            {(video.caption || "").slice(0, 200)}
          </div>
        </div>
      </div>

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
                {f.name}{f.category ? ` · ${categories[f.category]?.label || f.category}` : ""}
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <Label>Category</Label>
              <select value={category} onChange={e => { setCategory(e.target.value); setNewCategory(""); }} style={inputSt}>
                <option value="">— pick or create below —</option>
                {categoryList.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <input type="text" value={newCategory} onChange={e => setNewCategory(e.target.value)}
                placeholder="+ or type a new category"
                style={{ ...inputSt, fontSize: 11, marginTop: 4 }} />
            </div>
            <div>
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
          </div>

          <DescriptionField
            label="Video analysis"
            hint="What's happening in the video? Why does it work? (Dictation supported — click the mic.)"
            value={description}
            onChange={setDescription}
          />

          <DescriptionField
            label="Filming instructions"
            hint="How would you shoot this? Lighting, camera set-up, wardrobe, location cues."
            value={filming}
            onChange={setFilming}
          />

          <DescriptionField
            label="Structure"
            hint="Hook → beats → close. What happens in what order?"
            value={structure}
            onChange={setStructure}
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

// Textarea with a mic button that hits /api/whisper for voice-to-text.
// Separate component so Video analysis / Filming / Structure each have
// their own recorder state.
function DescriptionField({ label, hint, value, onChange }) {
  const { status, elapsed, blob, error, start, stop, reset, softCapSeconds } = useAudioRecorder();
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState(null);

  // Auto-transcribe as soon as the recorder finishes — the producer's
  // mental model is "hit mic, speak, hit mic again, see text appear".
  // We deliberately don't auto-fire if the blob is < 500B (usually means
  // they tapped mic twice by accident).
  const handledBlobRef = useRef(null);
  useEffect(() => {
    if (!blob || blob === handledBlobRef.current) return;
    if (blob.size < 500) { reset(); return; }
    handledBlobRef.current = blob;
    (async () => {
      setTranscribing(true);
      setTranscribeError(null);
      try {
        const form = new FormData();
        // OpenAI requires a filename — .webm is what MediaRecorder gives us.
        form.append("file", blob, "audio.webm");
        form.append("model", "whisper-1");
        const r = await fetch("/api/whisper", { method: "POST", body: form });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
        if (d.text) {
          // Append to existing text rather than replace — supports "record a
          // follow-up thought" UX.
          const join = value && !value.endsWith(" ") ? " " : "";
          onChange(`${value}${join}${d.text}`.trim());
        }
      } catch (e) {
        setTranscribeError(e.message);
      } finally {
        setTranscribing(false);
        reset();
      }
    })();
  }, [blob]);  // eslint-disable-line react-hooks/exhaustive-deps

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <Label>{label}</Label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {transcribing && <span style={{ fontSize: 10, color: "var(--accent)" }}>Transcribing…</span>}
          {status === "recording" && (
            <span style={{ fontSize: 10, color: "#EF4444", fontFamily: "'JetBrains Mono',monospace" }}>
              ● REC {mm}:{ss} / {Math.floor(softCapSeconds / 60)}:00
            </span>
          )}
          <button
            onClick={() => status === "recording" ? stop() : start()}
            disabled={transcribing}
            title={status === "recording" ? "Stop recording" : "Record voice memo"}
            style={{
              width: 28, height: 28, borderRadius: "50%",
              border: "1px solid var(--border)",
              background: status === "recording" ? "#EF4444" : "var(--bg)",
              color: status === "recording" ? "#fff" : "var(--fg)",
              fontSize: 13, cursor: transcribing ? "wait" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
            {status === "recording" ? "■" : "🎤"}
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={hint}
        rows={3}
        style={{ ...inputSt, resize: "vertical", fontFamily: "inherit", fontSize: 12 }} />
      {error && (
        <div style={{ fontSize: 10, color: "#EF4444", marginTop: 3 }}>Mic error: {error}</div>
      )}
      {transcribeError && (
        <div style={{ fontSize: 10, color: "#EF4444", marginTop: 3 }}>Whisper error: {transcribeError}</div>
      )}
    </div>
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

function ScriptBuilderStep({ project, onPatch }) {
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
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generateScript", projectId: project.id }),
      });
      const d = await r.json();
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
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Preproduction brief</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Generated {doc.generatedAt ? new Date(doc.generatedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—"} · {doc.modelUsed || "claude-opus-4-6"}. Click any cell to edit.
          </div>
        </div>
        <button onClick={generate} style={btnSecondary}>Regenerate</button>
      </div>

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

      {/* Sections */}
      <SectionCard title="Client context">
        <EditableField label="Brand truths" path="clientContext.brandTruths" value={doc.clientContext?.brandTruths} onEdit={openRewrite} />
        <EditableField label="Brand ambitions" path="clientContext.brandAmbitions" value={doc.clientContext?.brandAmbitions} onEdit={openRewrite} />
        <EditableField label="Overall client goals" path="clientContext.clientGoals" value={doc.clientContext?.clientGoals} onEdit={openRewrite} multi />
        <EditableField label="Key considerations" path="clientContext.keyConsiderations" value={doc.clientContext?.keyConsiderations} onEdit={openRewrite} multi />
      </SectionCard>

      <SectionCard title="Social snapshot">
        <EditableField label="Average performance" path="socialSnapshot.averagePerformance" value={doc.socialSnapshot?.averagePerformance} onEdit={openRewrite} />
        <EditableField label="Highest performing" path="socialSnapshot.highestPerforming" value={doc.socialSnapshot?.highestPerforming} onEdit={openRewrite} />
        <EditableField label="Key takeaways" path="socialSnapshot.takeaways" value={doc.socialSnapshot?.takeaways} onEdit={openRewrite} multi />
      </SectionCard>

      <SectionCard title="Target viewer">
        <EditableField label="Demographic" path="targetViewer.demographic" value={doc.targetViewer?.demographic} onEdit={openRewrite} />
        <EditableField label="Pain points & language" path="targetViewer.painPoints" value={doc.targetViewer?.painPoints} onEdit={openRewrite} multi />
      </SectionCard>

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
                {f.videoAnalysis && <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.5, marginBottom: 6 }}>{f.videoAnalysis}</div>}
                {f.filmingInstructions && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 3 }}><strong>Filming:</strong> {f.filmingInstructions}</div>}
                {f.structureInstructions && <div style={{ fontSize: 11, color: "var(--muted)" }}><strong>Structure:</strong> {f.structureInstructions}</div>}
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
                {(doc.scriptTable || []).map((row, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={tdStyle}>{row.videoNumber || i + 1}</td>
                    {SCRIPT_COLUMNS.map(c => (
                      <td key={c.key} style={tdStyle}>
                        {c.editable === false ? (
                          <div style={{ padding: "4px 6px", color: "var(--fg)", fontWeight: 600 }}>{row[c.key] || "—"}</div>
                        ) : (
                          <Clickable
                            value={row[c.key]}
                            onClick={() => openRewrite(`scriptTable.${i}.${c.key}`, c.label, row[c.key])}
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {rewriteTarget && (
        <RewriteModal
          target={rewriteTarget}
          projectId={project.id}
          onClose={() => setRewriteTarget(null)}
        />
      )}
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

function EditableField({ label, path, value, onEdit, multi }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
        {label}
      </div>
      <Clickable value={value} onClick={() => onEdit(path, label, value)} multi={multi} />
    </div>
  );
}

// A "cell" that looks like static text but opens the rewrite modal on click.
// Deliberately no border so the doc reads like a brief, not a form. Hover
// adds a subtle outline as the affordance.
function Clickable({ value, onClick, multi }) {
  const [hover, setHover] = useState(false);
  const empty = !value || !value.toString().trim();
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "6px 8px", borderRadius: 4,
        background: hover ? "var(--bg)" : "transparent",
        outline: hover ? "1px solid var(--accent)" : "1px solid transparent",
        cursor: "pointer",
        fontSize: 12, color: empty ? "var(--muted)" : "var(--fg)",
        lineHeight: 1.5,
        whiteSpace: multi ? "pre-wrap" : "normal",
        minHeight: 20,
        fontStyle: empty ? "italic" : "normal",
        transition: "outline 0.1s, background 0.1s",
      }}>
      {empty ? "(empty — click to fill)" : value}
    </div>
  );
}

// Two-mode modal: AI rewrite with an instruction, or manual edit. Mirrors
// Preproduction.jsx:413-480 verbatim so the producer muscle-memory from
// Meta Ads transfers straight across.
function RewriteModal({ target, projectId, onClose }) {
  const [mode, setMode] = useState("ai");  // "ai" | "manual"
  const [instruction, setInstruction] = useState("");
  const [manualValue, setManualValue] = useState(Array.isArray(target.currentValue) ? target.currentValue.join("\n") : (target.currentValue || ""));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const aiSubmit = async () => {
    if (!instruction.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rewriteScriptSection",
          projectId,
          path: target.path,
          instruction,
          currentValue: Array.isArray(target.currentValue) ? target.currentValue.join("\n") : (target.currentValue || ""),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const manualSubmit = () => {
    // Write the same path directly. We reuse the same rewriteHistory entry
    // shape so the audit trail is consistent with AI rewrites.
    const fbPath = `/preproduction/socialOrganic/${projectId}/preproductionDoc/${target.path.replace(/\./g, "/")}`;
    fbSet(fbPath, manualValue);
    fbSet(`/preproduction/socialOrganic/${projectId}/updatedAt`, new Date().toISOString());
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 22, maxWidth: 720, width: "92%", maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--border)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{target.label}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {/* Current value preview */}
        <div style={{ marginBottom: 12, padding: "10px 14px", background: "var(--bg)", borderRadius: 6, fontSize: 12, color: "var(--muted)", maxHeight: 120, overflow: "auto" }}>
          <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: "uppercase" }}>Current</div>
          {target.currentValue ? (Array.isArray(target.currentValue) ? target.currentValue.join("\n") : target.currentValue) : "(empty)"}
        </div>

        <div style={{ display: "flex", gap: 2, marginBottom: 12, background: "var(--bg)", borderRadius: 6, padding: 3, width: "fit-content" }}>
          <button onClick={() => setMode("ai")} style={{ padding: "6px 14px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: mode === "ai" ? "var(--accent)" : "transparent", color: mode === "ai" ? "#fff" : "var(--muted)" }}>AI rewrite</button>
          <button onClick={() => setMode("manual")} style={{ padding: "6px 14px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: mode === "manual" ? "var(--accent)" : "transparent", color: mode === "manual" ? "#fff" : "var(--muted)" }}>Manual edit</button>
        </div>

        {mode === "ai" ? (
          <>
            <textarea value={instruction} onChange={e => setInstruction(e.target.value)}
              placeholder={`e.g. "Make this more direct, no fluff" or "Tie this back to the client's subject-matter expertise"`}
              rows={3} autoFocus
              style={{ ...inputSt, fontSize: 13, marginBottom: 10, resize: "vertical" }} />
            {error && (
              <div style={{ marginBottom: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={aiSubmit} disabled={working || !instruction.trim()}
                style={{ ...btnPrimary, opacity: (working || !instruction.trim()) ? 0.6 : 1 }}>
                {working ? "Rewriting…" : "Rewrite"}
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea value={manualValue} onChange={e => setManualValue(e.target.value)}
              rows={6} autoFocus
              style={{ ...inputSt, fontSize: 13, marginBottom: 10, resize: "vertical", minHeight: 140, fontFamily: "inherit" }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={manualSubmit} style={btnPrimary}>Save</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
