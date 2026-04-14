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
  const [manualAddOpen, setManualAddOpen] = useState(false);
  const [manualCompany, setManualCompany] = useState("");
  const [manualTier, setManualTier] = useState("standard");

  // Firebase listener
  useEffect(() => {
    let unsub = () => {};
    onFB(() => {
      unsub = fbListen("/preproduction/metaAds", (data) => {
        setProjects(data || {});
      });
    });
    return unsub;
  }, []);

  const projectList = Object.values(projects)
    .filter(p => p && p.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const filtered = statusFilter === "all"
    ? projectList
    : projectList.filter(p => p.status === statusFilter);

  const activeProject = activeProjectId ? projects[activeProjectId] : null;

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
  async function handleExport() {
    if (!activeProject?.scriptTable) return;
    const XLSX = await import("xlsx");

    const p = activeProject;
    const rows = [];

    // Visuals row
    rows.push({
      "Video Name": "VISUALS",
      "Hook": p.visuals?.onCameraPresence || "",
      "Explain the Pain": p.visuals?.location || "",
      "Results": p.visuals?.visualLanguage || "",
      "The Offer": p.visuals?.motionGraphics || "",
      "Why the Offer": "",
      "CTA": "",
      "Meta Ad Headline": "",
      "Meta Ad Copy": "",
    });

    // Script rows
    for (const row of p.scriptTable) {
      rows.push({
        "Video Name": row.videoName || "",
        "Hook": row.hook || "",
        "Explain the Pain": row.explainThePain || "",
        "Results": row.results || "",
        "The Offer": row.theOffer || "",
        "Why the Offer": row.whyTheOffer || "",
        "CTA": row.cta || "",
        "Meta Ad Headline": row.metaAdHeadline || "",
        "Meta Ad Copy": row.metaAdCopy || "",
      });
    }

    const ws = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws["!cols"] = [
      { wch: 22 }, { wch: 35 }, { wch: 30 }, { wch: 30 },
      { wch: 35 }, { wch: 30 }, { wch: 25 }, { wch: 25 }, { wch: 40 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Meta Ads");
    XLSX.writeFile(wb, `${p.companyName.replace(/[^a-zA-Z0-9]/g, "_")}_Meta_Ads.xlsx`);

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
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{p.companyName}</span>
            <PBadge text={p.packageTier} colors={TIER_COLORS[p.packageTier] || TIER_COLORS.standard} />
            <PBadge text={STATUS_LABELS[p.status] || p.status} colors={STATUS_COLORS[p.status] || STATUS_COLORS.draft} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {hasScripts && (
              <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}?p=${p.id}`); alert("Client link copied to clipboard"); }} style={btnSecondary}>Share with Client</button>
            )}
            {hasScripts && p.status === "review" && (
              <button onClick={() => fbPatchProject(p.id, { status: "approved" })} style={btnSecondary}>Approve</button>
            )}
            {hasScripts && (
              <button onClick={handleExport} style={btnPrimary}>Export .xlsx</button>
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

          {/* Section 2: Brand Analysis */}
          {p.brandAnalysis && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Brand Analysis</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {/* Brand Truths */}
                <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>Brand Truths</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                    {(p.brandAnalysis.brandTruths || []).map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>

                {/* Brand Ambitions */}
                <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>Brand Ambitions</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                    {(p.brandAnalysis.brandAmbitions || []).map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>

                {/* Brand Personality */}
                <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>Brand Personality</div>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    {(p.brandAnalysis.brandPersonality?.types || []).map((t, i) => (
                      <span key={i} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "var(--accent-soft)", color: "var(--accent)" }}>{t}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>
                    {p.brandAnalysis.brandPersonality?.summary || ""}
                  </div>
                </div>

                {/* Target Customer */}
                <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>Target Customer</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                    {(p.targetCustomer || []).map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              </div>

              {/* Motivators */}
              {p.motivators && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                  {["toward", "awayFrom", "triedBefore"].map(type => {
                    const mc = MOTIVATOR_COLORS[type];
                    return (
                      <div key={type} style={{ background: mc.bg, border: `1px solid ${mc.border}`, borderRadius: 10, padding: 16 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: mc.fg, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{mc.label}</div>
                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                          {(p.motivators[type] || []).map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Section 3: Visuals */}
          {p.visuals && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Visual Direction</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                {[
                  { key: "onCameraPresence", label: "On-Camera Presence" },
                  { key: "location", label: "Location" },
                  { key: "visualLanguage", label: "Visual Language" },
                  { key: "motionGraphics", label: "Motion Graphics" },
                ].map(v => (
                  <div key={v.key} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{v.label}</div>
                    <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>{p.visuals[v.key] || ""}</div>
                  </div>
                ))}
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
                    </tr>
                  </thead>
                  <tbody>
                    {p.scriptTable.map((row, rowIdx) => {
                      const mc = MOTIVATOR_COLORS[row.motivatorType] || MOTIVATOR_COLORS.toward;
                      return (
                        <tr key={row.id || rowIdx}>
                          {SCRIPT_COLUMNS.map(col => {
                            const isVideoName = col.key === "videoName";
                            const isEditable = col.editable !== false && !isVideoName;
                            const cellId = row.id || row.videoName;
                            const isActive = rewriteCell?.cellId === cellId && rewriteCell?.column === col.key;
                            const feedbackKey = `${cellId}_${col.key}`;
                            const clientFb = p.clientFeedback?.[feedbackKey];

                            return (
                              <td
                                key={col.key}
                                onClick={() => {
                                  if (isEditable) {
                                    setRewriteCell({ cellId, column: col.key });
                                    setRewriteInstruction(clientFb?.text || "");
                                  }
                                }}
                                style={{
                                  padding: "10px 12px",
                                  borderBottom: "1px solid var(--border-light)",
                                  background: isVideoName ? mc.bg : (isActive ? "rgba(59,130,246,0.08)" : (clientFb ? "rgba(245,158,11,0.05)" : "transparent")),
                                  color: isVideoName ? mc.fg : "var(--fg)",
                                  fontWeight: isVideoName ? 700 : 400,
                                  cursor: isEditable ? "pointer" : "default",
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
                                {isActive && (
                                  <div
                                    onClick={e => e.stopPropagation()}
                                    style={{
                                      marginTop: 8, padding: 10, background: "var(--card)",
                                      border: "1px solid var(--accent)", borderRadius: 8,
                                      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                                    }}
                                  >
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
                                      <button
                                        onClick={handleRewrite}
                                        disabled={rewriting || !rewriteInstruction.trim()}
                                        style={{ ...btnPrimary, fontSize: 11, padding: "4px 10px", opacity: (rewriting || !rewriteInstruction.trim()) ? 0.5 : 1 }}
                                      >
                                        {rewriting ? "Rewriting..." : "Rewrite"}
                                      </button>
                                      <button onClick={() => setRewriteCell(null)} style={{ ...NB, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
                                    </div>
                                  </div>
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
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>
                    {p.companyName}
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
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </>
  );
}
