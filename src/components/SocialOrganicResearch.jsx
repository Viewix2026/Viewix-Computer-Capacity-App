// Social Media Organic — Competitor Intelligence Research
// Producers research overperforming Instagram content in a client's niche
// before (or after) a pre-production meeting. Scrapes via Apify, classifies
// by format via Claude vision, synthesises patterns into a markdown brief
// that Stage 2 (full pre-prod builder) will consume.
//
// Lives inside the Pre-Production tab's "Social Media Organic" sub-tab.
// Mirrors the Meta Ads list → detail pattern but with its own data shape
// at /preproduction/socialOrganic/{projectId}.

import { useState, useEffect } from "react";
import { onFB, fbSet, fbListen } from "../firebase";
import { logoBg, makeShortId } from "../utils";

// ─── Constants ───
const STATUS_COLORS = {
  draft:        { bg: "rgba(90,107,133,0.15)",  fg: "#5A6B85" },
  scraping:     { bg: "rgba(59,130,246,0.15)",  fg: "#3B82F6" },
  classifying:  { bg: "rgba(139,92,246,0.15)",  fg: "#8B5CF6" },
  synthesising: { bg: "rgba(251,191,36,0.15)",  fg: "#F59E0B" },
  review:       { bg: "rgba(34,197,94,0.15)",   fg: "#22C55E" },
  archived:     { bg: "rgba(90,107,133,0.15)",  fg: "#5A6B85" },
};
const STATUS_LABELS = {
  draft: "Draft", scraping: "Scraping", classifying: "Classifying",
  synthesising: "Synthesising", review: "Review", archived: "Archived",
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
              Research overperforming social content in a client's niche, then synthesise patterns for the pre-production brief.
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
                {p.synthesis?.markdown && <Badge text="✓ synthesised" colors={{ bg: "rgba(34,197,94,0.12)", fg: "#22C55E" }} />}
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
      synthesis: null,
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

  const patchInputs = (patch) => onPatch({ inputs: { ...(project.inputs || {}), ...patch } });

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
          <button onClick={onDelete} style={{ ...btnSecondary, color: "#EF4444", borderColor: "rgba(239,68,68,0.3)" }}>Delete</button>
        </div>
      </div>

      <InputsSection
        project={project}
        linkedAccount={linkedAccount}
        onPatchInputs={patchInputs}
      />

      {/* Results + Synthesis sections will be added in later slices */}
      {Array.isArray(project.posts) && project.posts.length > 0 && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Results</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {project.posts.length} posts scraped. Format classification + synthesis coming in next slices.
          </div>
        </div>
      )}
    </div>
  );
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

      <CostEstimateBar
        handles={competitors.map(c => c.handle)}
        postsPerHandle={inputs.postsPerHandle ?? DEFAULTS.postsPerHandle}
      />
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
          <MetricChip label="Synthesis" value={`$${estimate.estSynthesisCost.toFixed(2)}`} muted />
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
          Heads up — this is a larger-than-usual run. Scrape + classify + synthesise actions land in the next slices.
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
