// Deliveries — founder-only tool for tracking video deliverables per project.
// Imports projects from Monday.com, tracks per-video Viewix status + client
// revision rounds, and generates shareable client review links.

import { useState } from "react";
import { BTN, TH, NB, VIEWIX_STATUSES, VIEWIX_STATUS_COLORS, CLIENT_REVISION_OPTIONS, CLIENT_REVISION_COLORS } from "../config";
import { newDelivery, newVideo, logoBg, deliveryShareUrl } from "../utils";
import { fetchInProgressParents } from "../monday";
import { StatusSelect } from "./UIComponents";

export function Deliveries({ deliveries, setDeliveries, accounts }) {
  const [activeDeliveryId, setActiveDeliveryId] = useState(null);
  const [importMode, setImportMode] = useState(false);
  const [importProjects, setImportProjects] = useState([]);
  const [importLoading, setImportLoading] = useState(false);

  const activeDelivery = deliveries.find(d => d.id === activeDeliveryId);

  // Account lookup for logos — trim + partial match handles e.g. "Woolcott St"
  // vs "Woolcott Street Tailors" where the delivery clientName and account
  // companyName don't match exactly.
  const findAcct = (clientName) => {
    if (!clientName) return null;
    const nameLC = clientName.trim().toLowerCase();
    const acctList = Object.values(accounts).filter(Boolean);
    const exact = acctList.find(a => (a.companyName || "").trim().toLowerCase() === nameLC);
    if (exact) return exact;
    const partial = acctList.find(a => {
      const acn = (a.companyName || "").trim().toLowerCase();
      return acn && (acn.includes(nameLC) || nameLC.includes(acn));
    });
    return partial || null;
  };
  const getAcctLogo = (clientName) => findAcct(clientName)?.logoUrl || null;
  const getAcctLogoBg = (clientName) => findAcct(clientName)?.logoBg;

  // ─── Actions ───
  const startImport = () => {
    setImportMode(true);
    setImportLoading(true);
    fetchInProgressParents()
      .then(items => { setImportProjects(items); setImportLoading(false); })
      .catch(() => setImportLoading(false));
  };
  const importProject = (proj) => {
    // Monday.com parent items are typically named "Client: Project Name"
    const nameParts = proj.name.split(":");
    const clientName = nameParts.length > 1 ? nameParts[0].trim() : proj.name;
    const projectName = nameParts.length > 1 ? nameParts.slice(1).join(":").trim() : proj.name;
    const videos = (proj.subitems || []).map(sub => ({ id: `v-${sub.id}`, name: sub.name, link: "", viewixStatus: "In Development", revision1: "", revision2: "", notes: "" }));
    const d = { ...newDelivery(clientName, projectName), videos, mondayItemId: proj.id };
    setDeliveries(p => [...p, d]);
    setActiveDeliveryId(d.id);
    setImportMode(false);
  };
  const createBlank = () => {
    const d = newDelivery("New Client", "New Project");
    setDeliveries(p => [...p, d]);
    setActiveDeliveryId(d.id);
    setImportMode(false);
  };
  const updateDelivery = (updated) => setDeliveries(p => p.map(d => d.id === updated.id ? updated : d));
  const deleteDelivery = (id) => {
    setDeliveries(p => p.filter(d => d.id !== id));
    if (activeDeliveryId === id) setActiveDeliveryId(null);
  };
  const shareUrl = (id) => {
    const d = deliveries.find(x => x.id === id);
    return d ? deliveryShareUrl(d) : `${window.location.origin}?d=${id}`;
  };
  const copyLink = (id) => { navigator.clipboard?.writeText(shareUrl(id)); };

  // ═══════════════════════════════════════════
  // DETAIL VIEW
  // ═══════════════════════════════════════════
  if (activeDelivery) {
    const d = activeDelivery;
    const setD = (patch) => updateDelivery({ ...d, ...patch });
    const addVideo = () => setD({ videos: [...d.videos, newVideo()] });
    const updateVideo = (vid, patch) => setD({ videos: d.videos.map(v => v.id === vid ? { ...v, ...patch } : v) });
    const removeVideo = (vid) => setD({ videos: d.videos.filter(v => v.id !== vid) });
    const inputSt = { padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", width: "100%" };

    return (
      <>
        <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setActiveDeliveryId(null)} style={{ ...NB, fontSize: 12 }}>&larr; Back</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{d.clientName}: {d.projectName}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => copyLink(d.id)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Copy Share Link</button>
            <button onClick={() => deleteDelivery(d.id)} style={{ ...BTN, background: "#374151", color: "#EF4444" }}>Delete</button>
          </div>
        </div>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px" }}>
          {/* Project details */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>Client Name</label><input value={d.clientName} onChange={e => setD({ clientName: e.target.value })} style={inputSt} /></div>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>Project Name</label><input value={d.projectName} onChange={e => setD({ projectName: e.target.value })} style={inputSt} /></div>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>Client Logo URL</label><input value={d.logoUrl || ""} onChange={e => setD({ logoUrl: e.target.value })} placeholder="https://..." style={inputSt} /></div>
          </div>

          {/* Share link */}
          <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div><span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Client Share Link</span><div style={{ fontSize: 12, color: "var(--accent)", marginTop: 2, fontFamily: "'JetBrains Mono',monospace" }}>{shareUrl(d.id)}</div></div>
            <button onClick={() => copyLink(d.id)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Copy</button>
          </div>

          {/* Videos table */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Videos ({d.videos.length})</span>
            <button onClick={addVideo} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ Add Video</button>
          </div>
          {d.videos.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 13 }}>No videos yet. Click "+ Add Video" to start.</div>
            </div>
          ) : (
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  <th style={{ ...TH, textAlign: "left", padding: "8px 12px" }}>Video Name</th>
                  <th style={{ ...TH, textAlign: "left", padding: "8px 12px", width: 200 }}>Link</th>
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 140 }}>Viewix Status</th>
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 120 }}>Rev Round 1</th>
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 120 }}>Rev Round 2</th>
                  <th style={{ ...TH, textAlign: "left", padding: "8px 12px", width: 180 }}>Notes</th>
                  <th style={{ ...TH, width: 40 }}></th>
                </tr></thead>
                <tbody>{d.videos.map(v => (
                  <tr key={v.id}>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)" }}><input value={v.name} onChange={e => updateVideo(v.id, { name: e.target.value })} placeholder="Video name..." style={{ ...inputSt, fontWeight: 600 }} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)" }}><input value={v.link} onChange={e => updateVideo(v.id, { link: e.target.value })} placeholder="https://..." style={inputSt} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><StatusSelect value={v.viewixStatus} options={VIEWIX_STATUSES} colors={VIEWIX_STATUS_COLORS} onChange={val => updateVideo(v.id, { viewixStatus: val })} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><StatusSelect value={v.revision1} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val => updateVideo(v.id, { revision1: val })} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><StatusSelect value={v.revision2} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val => updateVideo(v.id, { revision2: val })} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)" }}><input value={v.notes || ""} onChange={e => updateVideo(v.id, { notes: e.target.value })} placeholder="Notes..." style={inputSt} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><button onClick={() => removeVideo(v.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 16 }}>x</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </>
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Deliveries</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={startImport} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ Import from Monday.com</button>
          <button onClick={createBlank} style={{ ...BTN, background: "#374151", color: "var(--fg)" }}>+ Blank Delivery</button>
        </div>
      </div>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px" }}>

        {/* Import picker */}
        {importMode && (
          <div style={{ marginBottom: 24, background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Select a project to import</div>
              <button onClick={() => setImportMode(false)} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Cancel</button>
            </div>
            {importLoading ? (
              <div style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>Loading projects from Monday.com...</div>
            ) : importProjects.length === 0 ? (
              <div style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>No "In Progress" projects found</div>
            ) : (
              <div style={{ display: "grid", gap: 8, maxHeight: 400, overflowY: "auto" }}>
                {importProjects.map(proj => (
                  <div key={proj.id} onClick={() => importProject(proj)} style={{ padding: "12px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", transition: "all 0.15s" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{proj.name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{(proj.subitems || []).length} sub-task{(proj.subitems || []).length !== 1 ? "s" : ""}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {deliveries.length === 0 && !importMode ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No deliveries yet</div>
            <div style={{ fontSize: 13 }}>Import from Monday.com or create a blank delivery</div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {deliveries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(d => {
              const ready = d.videos.filter(v => v.viewixStatus === "Completed" || v.viewixStatus === "Ready for Review").length;
              const approved = d.videos.filter(v => v.revision1 === "Approved").length;
              const logoSrc = getAcctLogo(d.clientName) || d.logoUrl;
              const bg = logoBg(getAcctLogoBg(d.clientName));
              return (
                <div key={d.id} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px", cursor: "pointer", transition: "all 0.15s" }} onClick={() => setActiveDeliveryId(d.id)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      {logoSrc && <img key={logoSrc + bg} src={logoSrc} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 28, borderRadius: 4, objectFit: "contain", background: bg, padding: 3 }} />}
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{d.clientName}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>{d.projectName} · {d.videos.length} video{d.videos.length !== 1 ? "s" : ""}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{ready}/{d.videos.length} ready · {approved}/{d.videos.length} approved</div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); copyLink(d.id); }} style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)" }}>Copy Link</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
