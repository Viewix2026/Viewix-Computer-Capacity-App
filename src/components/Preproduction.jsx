import { useState, useEffect, useRef } from "react";
import { onFB, fbSet, fbListen } from "../firebase";

// ─── Constants ───
const STATUS_COLORS = {
  draft: { bg: "rgba(90,107,133,0.15)", fg: "#5A6B85" },
  processing: { bg: "rgba(59,130,246,0.15)", fg: "#3B82F6" },
  review: { bg: "rgba(251,191,36,0.15)", fg: "#F59E0B" },
  approved: { bg: "rgba(34,197,94,0.15)", fg: "#22C55E" },
  exported: { bg: "rgba(139,92,246,0.15)", fg: "#8B5CF6" },
};

const STATUS_LABELS = {
  draft: "Draft", processing: "Processing", review: "In Review",
  approved: "Approved", exported: "Exported",
};

const TIER_COLORS = {
  standard: { bg: "rgba(59,130,246,0.12)", fg: "#3B82F6" },
  premium: { bg: "rgba(251,191,36,0.12)", fg: "#F59E0B" },
  deluxe: { bg: "rgba(139,92,246,0.12)", fg: "#8B5CF6" },
};

const MOTIVATOR_COLORS = {
  toward: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.25)", fg: "#22C55E", label: "Toward" },
  awayFrom: { bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.25)", fg: "#EF4444", label: "Away From" },
  triedBefore: { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.25)", fg: "#3B82F6", label: "Tried Before" },
};

const SCRIPT_COLUMNS = [
  { key: "videoName", label: "Video Name", width: 140, editable: false },
  { key: "hook", label: "Hook", width: 200 },
  { key: "explainThePain", label: "Explain the Pain", width: 180 },
  { key: "results", label: "Results", width: 180 },
  { key: "theOffer", label: "The Offer", width: 200 },
  { key: "whyTheOffer", label: "Why the Offer", width: 180 },
  { key: "cta", label: "CTA", width: 150 },
  { key: "metaAdHeadline", label: "Meta Ad Headline", width: 160 },
  { key: "metaAdCopy", label: "Meta Ad Copy", width: 240 },
];

const inputSt = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13,
  fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box",
};

const btnPrimary = {
  padding: "8px 16px", borderRadius: 6, border: "none",
  background: "var(--accent)", color: "#fff", fontSize: 13,
  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
};

const btnSecondary = {
  padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border)",
  background: "transparent", color: "var(--fg)", fontSize: 13,
  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
};

const NB = {
  padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
  background: "transparent", color: "var(--muted)", fontSize: 12,
  cursor: "pointer", fontFamily: "inherit",
};

// ─── Helper: Firebase patch for preproduction ───
function fbPatchProject(projectId, data) {
  fbSet(`/preproduction/metaAds/${projectId}/updatedAt`, new Date().toISOString());
  Object.entries(data).forEach(([k, v]) => {
    fbSet(`/preproduction/metaAds/${projectId}/${k}`, v);
  });
}

// ─── Badge component ───
function PBadge({ text, colors }) {
  return (
    <span style={{
      padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: colors.bg, color: colors.fg, textTransform: "capitalize",
    }}>{text}</span>
  );
}

// ─── Main Component ───
export function Preproduction() {
  const [subTab, setSubTab] = useState("metaAds");
  const [projects, setProjects] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [transcriptText, setTranscriptText] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState(null);
  const [rewriteCell, setRewriteCell] = useState(null); // { cellId, column }
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [editMode, setEditMode] = useState(false); // toggle between rewrite (AI) and edit (manual)
  const [editText, setEditText] = useState("");
  const [sectionEdit, setSectionEdit] = useState(null); // { path, value, label } for brand section editing
  const [sectionInstruction, setSectionInstruction] = useState("");
  const [sectionEditText, setSectionEditText] = useState("");
  const [sectionEditMode, setSectionEditMode] = useState(false);
  const [sectionRewriting, setSectionRewriting] = useState(false);
  const [manualAddOpen, setManualAddOpen] = useState(false);
  const [manualCompany, setManualCompany] = useState("");
  const [manualTier, setManualTier] = useState("standard");
  const [accounts, setAccounts] = useState({});

  // Firebase listeners
  useEffect(() => {
    let unsub1 = () => {}, unsub2 = () => {};
    onFB(() => {
      unsub1 = fbListen("/preproduction/metaAds", (data) => {
        setProjects(data || {});
      });
      unsub2 = fbListen("/accounts", (data) => {
        setAccounts(data || {});
      });
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  const projectList = Object.values(projects)
    .filter(p => p && p.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const filtered = statusFilter === "all"
    ? projectList
    : projectList.filter(p => p.status === statusFilter);

  const activeProject = activeProjectId ? projects[activeProjectId] : null;

  // Find project lead from accounts (match by attioCompanyId or company name)
  const findAccount = (proj) => {
    if (!proj) return null;
    const acctList = Object.values(accounts).filter(Boolean);
    return acctList.find(a => (proj.attioCompanyId && a.attioId === proj.attioCompanyId) || (a.companyName || "").toLowerCase() === (proj.companyName || "").toLowerCase()) || null;
  };
  const getProjectLead = (proj) => findAccount(proj)?.projectLead || null;
  const getAccountLogo = (proj) => findAccount(proj)?.logoUrl || null;

  // ─── Process transcript ───
  async function handleProcess() {
    if (!activeProject) return;
    const text = transcriptText.trim();
    const url = docUrl.trim();
    if (!text && !url) return;

    setProcessing(true);
    setProcessError(null);

    try {
      const body = {
        action: "generate",
        projectId: activeProject.id,
        packageTier: activeProject.packageTier,
        companyName: activeProject.companyName,
      };
      // Prefer pasted transcript; fall back to Google Doc URL
      if (text) {
        body.transcript = text;
      } else {
        body.googleDocUrl = url;
      }

      const resp = await fetch("/api/preproduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const rawResp = await resp.text();
      let data;
      try { data = JSON.parse(rawResp); } catch { throw new Error(rawResp || "Generation failed"); }
      if (!resp.ok) throw new Error(data.error || "Generation failed");

      // Firebase listener will pick up the new data automatically
      setTranscriptText("");
      setDocUrl("");
    } catch (e) {
      setProcessError(e.message);
    } finally {
      setProcessing(false);
    }
  }

  // ─── Rewrite cell ───
  async function handleRewrite() {
    if (!rewriteCell || !rewriteInstruction.trim() || !activeProject) return;

    const row = activeProject.scriptTable?.find(
      r => (r.id || r.videoName) === rewriteCell.cellId
    );
    if (!row) return;

    setRewriting(true);

    try {
      const resp = await fetch("/api/preproduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rewrite",
          projectId: activeProject.id,
          cellId: rewriteCell.cellId,
          column: rewriteCell.column,
          instruction: rewriteInstruction,
          currentValue: row[rewriteCell.column] || "",
        }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Rewrite failed");

      setRewriteCell(null);
      setRewriteInstruction("");
    } catch (e) {
      alert("Rewrite failed: " + e.message);
    } finally {
      setRewriting(false);
    }
  }

  // ─── Manual cell edit (no AI) ───
  function handleManualEdit() {
    if (!rewriteCell || !activeProject) return;
    const p = activeProject;
    const rowIndex = p.scriptTable?.findIndex(r => (r.id || r.videoName) === rewriteCell.cellId);
    if (rowIndex === -1 || rowIndex == null) return;
    const prevValue = p.scriptTable[rowIndex]?.[rewriteCell.column] || "";
    fbSet(`/preproduction/metaAds/${p.id}/scriptTable/${rowIndex}/${rewriteCell.column}`, editText);
    fbSet(`/preproduction/metaAds/${p.id}/updatedAt`, new Date().toISOString());
    // Log to central feedback log
    fbSet(`/preproduction/feedbackLog/me_${Date.now()}`, {
      type: "manualEdit",
      projectId: p.id,
      companyName: p.companyName || "",
      cellId: rewriteCell.cellId,
      column: rewriteCell.column,
      previousValue: prevValue,
      newValue: editText,
      timestamp: new Date().toISOString(),
    });
    setRewriteCell(null);
    setRewriteInstruction("");
    setEditText("");
    setEditMode(false);
  }

  // ─── Section edit (for brand analysis, motivators, visuals, target customer) ───
  function handleSectionSave() {
    if (!sectionEdit || !activeProject) return;
    const val = sectionEditMode ? sectionEditText : null;
    if (sectionEditMode && val != null) {
      // Manual edit: parse as array if it's a list (one item per line)
      const isArray = Array.isArray(sectionEdit.value);
      const parsed = isArray ? val.split("\n").filter(l => l.trim()) : val;
      fbSet(`/preproduction/metaAds/${activeProject.id}/${sectionEdit.path}`, parsed);
      fbSet(`/preproduction/metaAds/${activeProject.id}/updatedAt`, new Date().toISOString());
    }
    setSectionEdit(null);
    setSectionInstruction("");
    setSectionEditText("");
    setSectionEditMode(false);
  }

  async function handleSectionRewrite() {
    if (!sectionEdit || !sectionInstruction.trim() || !activeProject) return;
    setSectionRewriting(true);
    try {
      const resp = await fetch("/api/preproduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rewrite",
          projectId: activeProject.id,
          cellId: sectionEdit.path,
          column: "section",
          instruction: sectionInstruction,
          currentValue: Array.isArray(sectionEdit.value) ? sectionEdit.value.join("\n") : (sectionEdit.value || ""),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Rewrite failed");
      // Parse the response: if original was array, split by newlines or bullet points
      const newVal = data.newValue || "";
      const isArray = Array.isArray(sectionEdit.value);
      const parsed = isArray ? newVal.split(/\n|(?:^|\n)[-•]\s*/).filter(l => l.trim()) : newVal;
      fbSet(`/preproduction/metaAds/${activeProject.id}/${sectionEdit.path}`, parsed);
      fbSet(`/preproduction/metaAds/${activeProject.id}/updatedAt`, new Date().toISOString());
      setSectionEdit(null);
      setSectionInstruction("");
    } catch (e) {
      alert("Rewrite failed: " + e.message);
    } finally {
      setSectionRewriting(false);
    }
  }

  // Helper: open section editor
  function openSectionEdit(path, value, label) {
    setSectionEdit({ path, value, label });
    setSectionInstruction("");
    const textVal = Array.isArray(value) ? value.join("\n") : (value || "");
    setSectionEditText(textVal);
    setSectionEditMode(false);
  }

  // ─── Render section edit panel ───
  function renderSectionPanel() {
    if (!sectionEdit) return null;
    const p = activeProject;
    const clientFb = p?.clientFeedback?.[sectionEdit.path.replace(/\//g, "_")];
    return (
      <div style={{ marginTop: 10, padding: 12, background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>Edit: {sectionEdit.label}</div>
        {clientFb && <div style={{ fontSize: 10, color: "#F59E0B", marginBottom: 8, padding: "4px 8px", background: "rgba(245,158,11,0.1)", borderRadius: 4 }}>Client feedback: {clientFb.text}</div>}
        <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "var(--bg)", borderRadius: 4, padding: 2, width: "fit-content" }}>
          <button onClick={() => setSectionEditMode(false)} style={{ padding: "3px 8px", borderRadius: 3, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: !sectionEditMode ? "var(--accent)" : "transparent", color: !sectionEditMode ? "#fff" : "var(--muted)" }}>AI Rewrite</button>
          <button onClick={() => setSectionEditMode(true)} style={{ padding: "3px 8px", borderRadius: 3, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: sectionEditMode ? "var(--accent)" : "transparent", color: sectionEditMode ? "#fff" : "var(--muted)" }}>Manual Edit</button>
        </div>
        {!sectionEditMode ? (<>
          <input value={sectionInstruction} onChange={e => setSectionInstruction(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleSectionRewrite(); if (e.key === "Escape") setSectionEdit(null); }} placeholder="e.g. Make these more specific to the client's industry" style={{ ...inputSt, fontSize: 12, marginBottom: 6 }} autoFocus />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={handleSectionRewrite} disabled={sectionRewriting || !sectionInstruction.trim()} style={{ ...btnPrimary, fontSize: 11, padding: "4px 10px", opacity: (sectionRewriting || !sectionInstruction.trim()) ? 0.5 : 1 }}>{sectionRewriting ? "Rewriting..." : "Rewrite"}</button>
            <button onClick={() => setSectionEdit(null)} style={{ ...NB, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
          </div>
        </>) : (<>
          <textarea value={sectionEditText} onChange={e => setSectionEditText(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setSectionEdit(null); }} rows={6} style={{ ...inputSt, fontSize: 12, marginBottom: 6, resize: "vertical", minHeight: 80 }} autoFocus />
          <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 6 }}>{Array.isArray(sectionEdit.value) ? "One item per line" : ""}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={handleSectionSave} style={{ ...btnPrimary, fontSize: 11, padding: "4px 10px" }}>Save</button>
            <button onClick={() => setSectionEdit(null)} style={{ ...NB, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
          </div>
        </>)}
      </div>
    );
  }

  // ─── Create manual project ───
  function handleManualAdd() {
    if (!manualCompany.trim()) return;
    const projectId = `meta_${Date.now()}`;
    fbSet(`/preproduction/metaAds/${projectId}`, {
      id: projectId,
      companyName: manualCompany.trim(),
      packageTier: manualTier,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attioCompanyId: null,
      attioDealId: null,
      dealValue: null,
      transcript: null,
      brandAnalysis: null,
      targetCustomer: null,
      motivators: null,
      visuals: null,
      scriptTable: null,
      rewriteHistory: [],
    });
    setManualCompany("");
    setManualTier("standard");
    setManualAddOpen(false);
  }

  // ─── Export xlsx ───
  function handleExport() {
    if (!activeProject?.scriptTable) return;
    const p = activeProject;

    const motColors = {
      toward: { bg: "#dcfce7", fg: "#166534" },
      awayFrom: { bg: "#fee2e2", fg: "#991b1b" },
      triedBefore: { bg: "#dbeafe", fg: "#1e40af" },
    };

    const cols = ["Video Name", "Hook", "Explain the Pain", "Results", "The Offer", "Why the Offer", "CTA", "Meta Ad Headline", "Meta Ad Copy"];
    const colKeys = ["videoName", "hook", "explainThePain", "results", "theOffer", "whyTheOffer", "cta", "metaAdHeadline", "metaAdCopy"];

    let tableRows = "";

    // Visuals row
    const visVals = [p.visuals?.onCameraPresence || "", p.visuals?.location || "", p.visuals?.visualLanguage || "", p.visuals?.motionGraphics || "", "", "", "", ""];
    tableRows += `<tr><td style="font-weight:700;background:#f3f4f6;">VISUALS</td>${visVals.map(v => `<td>${v}</td>`).join("")}</tr>`;

    // Script rows
    for (const row of p.scriptTable) {
      const mc = motColors[row.motivatorType] || motColors.toward;
      tableRows += `<tr>`;
      colKeys.forEach((key, i) => {
        const val = row[key] || "";
        if (i === 0) {
          tableRows += `<td style="font-weight:700;background:${mc.bg};color:${mc.fg};">${val}</td>`;
        } else {
          tableRows += `<td>${val}</td>`;
        }
      });
      tableRows += `</tr>`;
    }

    const html = `<!DOCTYPE html><html><head><title>${p.companyName} - Meta Ads Scripts</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', sans-serif; font-size: 10px; color: #1a1a1a; padding: 40px 48px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #111827; }
  .header img { height: 28px; }
  h1 { font-size: 20px; margin-bottom: 2px; }
  .sub { font-size: 12px; color: #666; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #111827; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #111827; color: #fff; padding: 8px 10px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 10px; border: 1px solid #e5e7eb; vertical-align: top; line-height: 1.5; font-size: 10px; }
  .brand-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
  .brand-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
  .brand-card h3 { font-size: 10px; text-transform: uppercase; color: #666; margin-bottom: 8px; letter-spacing: 0.5px; }
  .brand-card li { margin-bottom: 3px; line-height: 1.5; }
  .brand-card ul { padding-left: 16px; }
  .mot-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 20px; }
  .mot-card { border-radius: 8px; padding: 14px; }
  .mot-card h3 { font-size: 10px; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
  .mot-card li { margin-bottom: 3px; line-height: 1.5; }
  .mot-card ul { padding-left: 16px; }
  .footer { margin-top: 32px; text-align: center; font-size: 9px; color: #999; padding-top: 12px; border-top: 1px solid #e5e7eb; }
  @media print { body { padding: 24px 32px; } @page { size: landscape; margin: 12mm; } }
</style></head><body>
<div class="header">
  <div>
    <h1>${p.companyName}</h1>
    <div class="sub">Meta Ads Scripts \u2014 ${(p.packageTier || "").charAt(0).toUpperCase() + (p.packageTier || "").slice(1)} Package \u2014 ${p.scriptTable.length} ads</div>
  </div>
  <svg width="120" height="28" viewBox="0 0 120 28" xmlns="http://www.w3.org/2000/svg">
    <text x="0" y="22" font-family="DM Sans, sans-serif" font-size="24" font-weight="800">
      <tspan fill="#F97316">V</tspan><tspan fill="#111827">iewix</tspan>
    </text>
  </svg>
</div>

${p.brandAnalysis ? `<div class="section-title">Brand Analysis</div>
<div class="brand-grid">
  <div class="brand-card"><h3>Brand Truths</h3><ul>${(p.brandAnalysis.brandTruths || []).map(t => `<li>${t}</li>`).join("")}</ul></div>
  <div class="brand-card"><h3>Brand Ambitions</h3><ul>${(p.brandAnalysis.brandAmbitions || []).map(t => `<li>${t}</li>`).join("")}</ul></div>
  <div class="brand-card"><h3>Brand Personality</h3><div>${(p.brandAnalysis.brandPersonality?.types || []).join(", ")}</div><div style="margin-top:4px;">${p.brandAnalysis.brandPersonality?.summary || ""}</div></div>
  <div class="brand-card"><h3>Target Customer</h3><ul>${(p.targetCustomer || []).map(t => `<li>${t}</li>`).join("")}</ul></div>
</div>` : ""}

${p.motivators ? `<div class="section-title">Motivators</div>
<div class="mot-grid">
  <div class="mot-card" style="background:#dcfce7;"><h3 style="color:#166534;">Toward Motivators</h3><ul>${(p.motivators.toward || []).map(m => `<li>${m}</li>`).join("")}</ul></div>
  <div class="mot-card" style="background:#fee2e2;"><h3 style="color:#991b1b;">Away From Motivators</h3><ul>${(p.motivators.awayFrom || []).map(m => `<li>${m}</li>`).join("")}</ul></div>
  <div class="mot-card" style="background:#dbeafe;"><h3 style="color:#1e40af;">Tried Before</h3><ul>${(p.motivators.triedBefore || []).map(m => `<li>${m}</li>`).join("")}</ul></div>
</div>` : ""}

<div class="section-title">Script Table</div>
<table>
  <thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
  <tbody>${tableRows}</tbody>
</table>

<div class="footer">Prepared by Viewix Video Production</div>

<script>window.onload = function() { window.print(); }</script>
</body></html>`;

    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();

    // Update status
    fbPatchProject(p.id, { status: "exported" });
  }

  // ─── DETAIL VIEW ───
  if (activeProject) {
    const p = activeProject;
    const hasScripts = p.scriptTable && p.scriptTable.length > 0;
    const hasTranscript = p.transcript?.text;

    return (
      <>
        {/* Header */}
        <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setActiveProjectId(null)} style={NB}>&larr; Back</button>
            {getAccountLogo(p) && <img src={getAccountLogo(p)} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 32, borderRadius: 6, objectFit: "contain", background: "#fff", padding: 3 }} />}
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{p.companyName}</span>
            <PBadge text={p.packageTier} colors={TIER_COLORS[p.packageTier] || TIER_COLORS.standard} />
            <PBadge text={STATUS_LABELS[p.status] || p.status} colors={STATUS_COLORS[p.status] || STATUS_COLORS.draft} />
            {getProjectLead(p) && <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 4 }}>Lead: <span style={{ color: "var(--fg)", fontWeight: 600 }}>{getProjectLead(p)}</span></span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Status selector */}
            <select
              value={p.status}
              onChange={e => {
                const newStatus = e.target.value;
                fbPatchProject(p.id, { status: newStatus });
                // Auto-create delivery when approved
                if (newStatus === "approved" && p.scriptTable?.length > 0) {
                  const delId = `del-${Date.now()}`;
                  const videos = p.scriptTable.map((row, i) => ({
                    id: `vid-${Date.now()}-${i}`,
                    name: row.videoName || `Video ${i + 1}`,
                    link: "",
                    viewixStatus: "In Development",
                    revision1: "",
                    revision2: "",
                  }));
                  const logo = getAccountLogo(p) || "";
                  fbSet(`/deliveries/${delId}`, {
                    id: delId,
                    clientName: p.companyName,
                    projectName: `${p.companyName} Meta Ads`,
                    logoUrl: logo,
                    notes: "",
                    videos,
                    createdAt: new Date().toISOString(),
                  });
                }
              }}
              style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}
            >
              <option value="draft">Draft</option>
              <option value="processing">Processing</option>
              <option value="review">In Review</option>
              <option value="approved">Approved</option>
              <option value="exported">Exported</option>
            </select>
            {hasScripts && (
              <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}?p=${p.id}`); alert("Client link copied to clipboard"); }} style={btnSecondary}>Share with Client</button>
            )}
            {hasScripts && (
              <button onClick={handleExport} style={btnPrimary}>Export PDF</button>
            )}
          </div>
        </div>

        <div style={{ padding: "24px 28px", maxWidth: 1400 }}>

          {/* Section 1: Transcript Input */}
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Transcript</h3>
            {hasTranscript && !processing ? (
              <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                  Transcript added {p.transcript.addedAt ? new Date(p.transcript.addedAt).toLocaleDateString() : ""}
                  {p.transcript.source === "googledoc" ? ` from Google Doc` : ""}
                </div>
                <details>
                  <summary style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer" }}>View transcript</summary>
                  <pre style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto", marginTop: 8 }}>
                    {p.transcript.text?.substring(0, 3000)}{p.transcript.text?.length > 3000 ? "..." : ""}
                  </pre>
                </details>
                <button onClick={() => { setTranscriptText(p.transcript.text || ""); }} style={{ ...NB, marginTop: 8 }}>Re-process</button>
              </div>
            ) : (
              <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                <textarea
                  value={transcriptText}
                  onChange={e => setTranscriptText(e.target.value)}
                  placeholder="Paste the onboarding call transcript here..."
                  style={{ ...inputSt, minHeight: 150, resize: "vertical" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <input
                      value={docUrl}
                      onChange={e => setDocUrl(e.target.value)}
                      placeholder="Or paste Google Doc URL (must be set to 'Anyone with the link can view')"
                      style={{ ...inputSt }}
                    />
                  </div>
                  <button
                    onClick={handleProcess}
                    disabled={processing || (!transcriptText.trim() && !docUrl.trim())}
                    style={{ ...btnPrimary, opacity: (processing || (!transcriptText.trim() && !docUrl.trim())) ? 0.5 : 1 }}
                  >
                    {processing ? "Processing..." : "Process"}
                  </button>
                </div>
                {processError && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, fontSize: 12, color: "#EF4444" }}>
                    {processError}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Section 2: Brand Analysis (editable) */}
          {p.brandAnalysis && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Brand Analysis</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  { path: "brandAnalysis/brandTruths", label: "Brand Truths", value: p.brandAnalysis.brandTruths },
                  { path: "brandAnalysis/brandAmbitions", label: "Brand Ambitions", value: p.brandAnalysis.brandAmbitions },
                  { path: "brandAnalysis/brandPersonality/summary", label: "Brand Personality", value: p.brandAnalysis.brandPersonality?.summary, extra: p.brandAnalysis.brandPersonality?.types },
                  { path: "targetCustomer", label: "Target Customer", value: p.targetCustomer },
                ].map(sec => (
                  <div key={sec.path} onClick={() => openSectionEdit(sec.path, sec.value, sec.label)} style={{ background: "var(--card)", border: `1px solid ${sectionEdit?.path === sec.path ? "var(--accent)" : "var(--border)"}`, borderRadius: 10, padding: 16, cursor: "pointer", transition: "border-color 0.15s" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{sec.label}</div>
                    {sec.extra && <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>{sec.extra.map((t, i) => <span key={i} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "var(--accent-soft)", color: "var(--accent)" }}>{t}</span>)}</div>}
                    {Array.isArray(sec.value) ? (
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>{sec.value.map((t, i) => <li key={i}>{t}</li>)}</ul>
                    ) : (
                      <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>{sec.value || ""}</div>
                    )}
                    {sectionEdit?.path === sec.path && <div onClick={e => e.stopPropagation()}>{renderSectionPanel()}</div>}
                  </div>
                ))}
              </div>

              {/* Motivators (editable) */}
              {p.motivators && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                  {["toward", "awayFrom", "triedBefore"].map(type => {
                    const mc = MOTIVATOR_COLORS[type];
                    const motPath = `motivators/${type}`;
                    const isEditing = sectionEdit?.path === motPath;
                    return (
                      <div key={type} onClick={() => openSectionEdit(motPath, p.motivators[type], mc.label)} style={{ background: mc.bg, border: `1px solid ${isEditing ? "var(--accent)" : mc.border}`, borderRadius: 10, padding: 16, cursor: "pointer", transition: "border-color 0.15s" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: mc.fg, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{mc.label}</div>
                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                          {(p.motivators[type] || []).map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                        {isEditing && <div onClick={e => e.stopPropagation()}>{renderSectionPanel()}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Section 3: Visuals (editable) */}
          {p.visuals && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Visual Direction</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                {[
                  { key: "onCameraPresence", label: "On-Camera Presence" },
                  { key: "location", label: "Location" },
                  { key: "visualLanguage", label: "Visual Language" },
                  { key: "motionGraphics", label: "Motion Graphics" },
                ].map(v => {
                  const visPath = `visuals/${v.key}`;
                  const isEditing = sectionEdit?.path === visPath;
                  return (
                    <div key={v.key} onClick={() => openSectionEdit(visPath, p.visuals[v.key] || "", v.label)} style={{ background: "var(--card)", border: `1px solid ${isEditing ? "var(--accent)" : "var(--border)"}`, borderRadius: 10, padding: 16, cursor: "pointer", transition: "border-color 0.15s" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{v.label}</div>
                      <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>{p.visuals[v.key] || ""}</div>
                      {isEditing && <div onClick={e => e.stopPropagation()}>{renderSectionPanel()}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 4: Script Table */}
          {hasScripts && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>
                Script Table ({p.scriptTable.length} ads)
              </h3>
              <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {SCRIPT_COLUMNS.map(col => (
                        <th key={col.key} style={{
                          padding: "10px 12px", textAlign: "left", fontWeight: 700,
                          color: "var(--muted)", borderBottom: "1px solid var(--border)",
                          background: "var(--card)", whiteSpace: "nowrap",
                          fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px",
                          minWidth: col.width,
                        }}>
                          {col.label}
                        </th>
                      ))}
                      <th style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)", background: "var(--card)", width: 36 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.scriptTable.map((row, rowIdx) => {
                      const mc = MOTIVATOR_COLORS[row.motivatorType] || MOTIVATOR_COLORS.toward;
                      return (
                        <tr key={row.id || rowIdx}>
                          {SCRIPT_COLUMNS.map(col => {
                            const isVideoName = col.key === "videoName";
                            const cellId = row.id || row.videoName;
                            const isActive = rewriteCell?.cellId === cellId && rewriteCell?.column === col.key;
                            const isRowActive = isVideoName && rewriteCell?.cellId === cellId && rewriteCell?.column === "_row";
                            const feedbackKey = `${cellId}_${col.key}`;
                            const rowFbKey = `${cellId}__row`;
                            const clientFb = isVideoName ? p.clientFeedback?.[rowFbKey] : p.clientFeedback?.[feedbackKey];

                            return (
                              <td
                                key={col.key}
                                onClick={() => {
                                  if (isVideoName) {
                                    setRewriteCell({ cellId, column: "_row" });
                                    setRewriteInstruction(clientFb?.text || "");
                                    setEditText("");
                                    setEditMode(false);
                                  } else {
                                    setRewriteCell({ cellId, column: col.key });
                                    setRewriteInstruction(clientFb?.text || "");
                                    setEditText(row[col.key] || "");
                                    setEditMode(false);
                                  }
                                }}
                                style={{
                                  padding: "10px 12px",
                                  borderBottom: "1px solid var(--border-light)",
                                  background: isVideoName ? (isRowActive ? "rgba(59,130,246,0.08)" : mc.bg) : (isActive ? "rgba(59,130,246,0.08)" : (clientFb ? "rgba(245,158,11,0.05)" : "transparent")),
                                  color: isVideoName ? mc.fg : "var(--fg)",
                                  fontWeight: isVideoName ? 700 : 400,
                                  cursor: "pointer",
                                  verticalAlign: "top",
                                  lineHeight: 1.5,
                                  minWidth: col.width,
                                  maxWidth: col.width + 60,
                                  position: "relative",
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
                                  {clientFb && !isVideoName && <span title={`Client: ${clientFb.text}`} style={{ width: 7, height: 7, borderRadius: "50%", background: "#F59E0B", flexShrink: 0, marginTop: 4 }} />}
                                  <span>{row[col.key] || ""}</span>
                                </div>
                                {isVideoName && (
                                  <select value={row.motivatorType || "toward"} onChange={e => { e.stopPropagation(); const updated = [...p.scriptTable]; updated[rowIdx] = { ...updated[rowIdx], motivatorType: e.target.value }; fbSet(`/preproduction/metaAds/${p.id}/scriptTable`, updated); }} onClick={e => e.stopPropagation()} style={{ fontSize: 9, padding: "2px 4px", borderRadius: 3, border: `1px solid ${mc.border}`, background: mc.bg, color: mc.fg, fontWeight: 600, marginTop: 4, cursor: "pointer", display: "block" }}>
                                    <option value="toward">Toward</option>
                                    <option value="awayFrom">Away From</option>
                                    <option value="triedBefore">Tried Before</option>
                                  </select>
                                )}
                                {isActive && (
                                  <div
                                    onClick={e => e.stopPropagation()}
                                    style={{
                                      marginTop: 8, padding: 10, background: "var(--card)",
                                      border: "1px solid var(--accent)", borderRadius: 8,
                                      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                                    }}
                                  >
                                    {/* Mode toggle */}
                                    <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "var(--bg)", borderRadius: 4, padding: 2, width: "fit-content" }}>
                                      <button onClick={() => setEditMode(false)} style={{ padding: "3px 8px", borderRadius: 3, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: !editMode ? "var(--accent)" : "transparent", color: !editMode ? "#fff" : "var(--muted)" }}>AI Rewrite</button>
                                      <button onClick={() => setEditMode(true)} style={{ padding: "3px 8px", borderRadius: 3, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: editMode ? "var(--accent)" : "transparent", color: editMode ? "#fff" : "var(--muted)" }}>Manual Edit</button>
                                    </div>
                                    {!editMode ? (<>
                                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>Rewrite instruction:</div>
                                      <input
                                        autoFocus
                                        value={rewriteInstruction}
                                        onChange={e => setRewriteInstruction(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Enter") handleRewrite(); if (e.key === "Escape") setRewriteCell(null); }}
                                        placeholder="e.g. Make it more confrontational"
                                        style={{ ...inputSt, fontSize: 12, marginBottom: 6 }}
                                      />
                                      <div style={{ display: "flex", gap: 6 }}>
                                        <button onClick={handleRewrite} disabled={rewriting || !rewriteInstruction.trim()} style={{ ...btnPrimary, fontSize: 11, padding: "4px 10px", opacity: (rewriting || !rewriteInstruction.trim()) ? 0.5 : 1 }}>{rewriting ? "Rewriting..." : "Rewrite"}</button>
                                        <button onClick={() => setRewriteCell(null)} style={{ ...NB, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
                                      </div>
                                    </>) : (<>
                                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>Edit text directly:</div>
                                      <textarea
                                        autoFocus
                                        value={editText}
                                        onChange={e => setEditText(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Escape") setRewriteCell(null); }}
                                        rows={4}
                                        style={{ ...inputSt, fontSize: 12, marginBottom: 6, resize: "vertical", minHeight: 60 }}
                                      />
                                      <div style={{ display: "flex", gap: 6 }}>
                                        <button onClick={handleManualEdit} style={{ ...btnPrimary, fontSize: 11, padding: "4px 10px" }}>Save</button>
                                        <button onClick={() => setRewriteCell(null)} style={{ ...NB, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
                                      </div>
                                    </>)}
                                  </div>
                                )}
                                {isRowActive && (
                                  <div onClick={e => e.stopPropagation()} style={{ marginTop: 8, padding: 10, background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
                                    <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Rewrite instruction for entire row:</div>
                                    {clientFb && <div style={{ fontSize: 10, color: "#F59E0B", marginBottom: 6, padding: "4px 8px", background: "rgba(245,158,11,0.1)", borderRadius: 4 }}>Client feedback: {clientFb.text}</div>}
                                    <input
                                      autoFocus
                                      value={rewriteInstruction}
                                      onChange={e => setRewriteInstruction(e.target.value)}
                                      onKeyDown={e => { if (e.key === "Escape") setRewriteCell(null); }}
                                      placeholder="e.g. Rework this entire ad to be more confrontational"
                                      style={{ ...inputSt, fontSize: 12, marginBottom: 6 }}
                                    />
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <button onClick={() => { /* TODO: row-level rewrite via API */ alert("Row rewrite coming soon — use individual cells for now"); }} disabled={!rewriteInstruction.trim()} style={{ ...btnPrimary, fontSize: 11, padding: "4px 10px", opacity: !rewriteInstruction.trim() ? 0.5 : 1 }}>Rewrite Row</button>
                                      <button onClick={() => setRewriteCell(null)} style={{ ...NB, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
                                    </div>
                                  </div>
                                )}
                              </td>
                            );
                          })}
                          <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-light)", textAlign: "center", verticalAlign: "top" }}>
                            <button onClick={e => { e.stopPropagation(); if (!window.confirm(`Delete "${row.videoName || "this video"}"?`)) return; const updated = p.scriptTable.filter((_, i) => i !== rowIdx); fbSet(`/preproduction/metaAds/${p.id}/scriptTable`, updated); fbSet(`/preproduction/metaAds/${p.id}/updatedAt`, new Date().toISOString()); setRewriteCell(null); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 14, padding: "2px 6px" }} title="Delete video">x</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 12 }}>
                <button onClick={() => { const num = (p.scriptTable?.length || 0) + 1; const newRow = { id: `video-${Date.now()}`, videoName: `Video ${num}`, motivatorType: "toward", audienceType: "problemAware", hook: "", explainThePain: "", results: "", theOffer: "", whyTheOffer: "", cta: "", metaAdHeadline: "", metaAdCopy: "" }; fbSet(`/preproduction/metaAds/${p.id}/scriptTable`, [...(p.scriptTable || []), newRow]); fbSet(`/preproduction/metaAds/${p.id}/updatedAt`, new Date().toISOString()); }} style={btnSecondary}>+ Add Video</button>
              </div>
            </div>
          )}

          {/* Processing state */}
          {p.status === "processing" && (
            <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>&#9881;</div>
              <div style={{ fontSize: 14 }}>Generating scripts with Claude...</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>This may take up to 60 seconds.</div>
            </div>
          )}
        </div>
      </>
    );
  }

  // ─── LIST VIEW ───
  return (
    <>
      {/* Header */}
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Preproduction</span>
          {/* Sub-tabs */}
          <div style={{ display: "flex", gap: 2, background: "var(--bg)", borderRadius: 6, padding: 2 }}>
            <button
              onClick={() => setSubTab("metaAds")}
              style={{
                padding: "5px 12px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
                background: subTab === "metaAds" ? "var(--accent)" : "transparent",
                color: subTab === "metaAds" ? "#fff" : "var(--muted)",
              }}
            >Meta Ads</button>
            <button
              onClick={() => setSubTab("socialOrganic")}
              style={{
                padding: "5px 12px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
                background: subTab === "socialOrganic" ? "var(--accent)" : "transparent",
                color: subTab === "socialOrganic" ? "#fff" : "var(--muted)",
              }}
            >Social Media Organic</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ ...inputSt, width: "auto", fontSize: 12, padding: "5px 8px" }}
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="processing">Processing</option>
            <option value="review">In Review</option>
            <option value="approved">Approved</option>
            <option value="exported">Exported</option>
          </select>
          <button onClick={() => setManualAddOpen(!manualAddOpen)} style={btnPrimary}>+ New Project</button>
        </div>
      </div>

      <div style={{ padding: "24px 28px" }}>
        {/* Manual add form */}
        {manualAddOpen && (
          <div style={{ marginBottom: 20, padding: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", gap: 10, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Company Name</label>
              <input
                value={manualCompany}
                onChange={e => setManualCompany(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleManualAdd(); }}
                placeholder="e.g. Ernesto Buono Fine Jewellery"
                style={inputSt}
                autoFocus
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Package Tier</label>
              <select value={manualTier} onChange={e => setManualTier(e.target.value)} style={{ ...inputSt, width: 130 }}>
                <option value="standard">Standard</option>
                <option value="premium">Premium</option>
                <option value="deluxe">Deluxe</option>
              </select>
            </div>
            <button onClick={handleManualAdd} disabled={!manualCompany.trim()} style={{ ...btnPrimary, opacity: !manualCompany.trim() ? 0.5 : 1 }}>Create</button>
            <button onClick={() => setManualAddOpen(false)} style={NB}>Cancel</button>
          </div>
        )}

        {/* Social Organic placeholder */}
        {subTab === "socialOrganic" && (
          <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#128196;</div>
            <div style={{ fontSize: 14 }}>Social Media Organic</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Coming soon</div>
          </div>
        )}


        {/* Meta Ads project cards */}
        {subTab === "metaAds" && (
          filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>&#127916;</div>
              <div style={{ fontSize: 14 }}>No projects yet</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Projects appear here when deals are won, or create one manually.</div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
              {filtered.map(p => (
                <div
                  key={p.id}
                  onClick={() => setActiveProjectId(p.id)}
                  style={{
                    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10,
                    padding: 16, cursor: "pointer", transition: "border-color 0.15s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    {getAccountLogo(p) && <img src={getAccountLogo(p)} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 24, borderRadius: 4, objectFit: "contain", background: "#fff", padding: 2 }} />}
                    <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{p.companyName}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    <PBadge text={p.packageTier} colors={TIER_COLORS[p.packageTier] || TIER_COLORS.standard} />
                    <PBadge text={STATUS_LABELS[p.status] || p.status} colors={STATUS_COLORS[p.status] || STATUS_COLORS.draft} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    {p.createdAt ? new Date(p.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""}
                  </div>
                  {p.scriptTable && (
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                      {p.scriptTable.length} ads generated
                    </div>
                  )}
                  {getProjectLead(p) && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Lead: {getProjectLead(p)}</div>}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </>
  );
}
