// Training — module library with per-role visibility + Meeting Feedback sub-tab.
//
// Visibility rules:
//   closer            → only "sales"-named categories
//   editor / trial    → everything EXCEPT "sales"-named categories
//                       (so editors don't see Sales Training, and trial
//                       users see Editor Onboarding + any custom
//                       "Trial …" category you've added)
//   founder / founders / lead → everything
//
// Founders + closers also get the Meeting Feedback sub-tab for
// Claude-powered sales call analysis.

import { useState } from "react";
import { BTN, NB } from "../config";
import { MeetingFeedback } from "./MeetingFeedback";

export function Training({
  role, isFounder,
  trainingData, setTrainingData,
  trainingSuggestions, setTrainingSuggestions,
  activeModuleId, setActiveModuleId,
  trainingSubTab, setTrainingSubTab,
}) {
  const isAdmin = role === "founder" || role === "founders";
  const userName = isAdmin ? "Jeremy" : role === "closer" ? "Team" : "Editor";

  // ─── Local UI state ───
  const [trainingEditMode, setTrainingEditMode] = useState(false);
  const [trainingCommentText, setTrainingCommentText] = useState("");
  const [sugOpen, setSugOpen] = useState(false);
  const [sugType, setSugType] = useState("new");
  const [sugTitle, setSugTitle] = useState("");
  const [sugDesc, setSugDesc] = useState("");
  const [editCatId, setEditCatId] = useState(null);
  const [editCatName, setEditCatName] = useState("");
  const [editModId, setEditModId] = useState(null);
  const [editModName, setEditModName] = useState("");
  const [collapsedCats, setCollapsedCats] = useState({});

  // ─── Category + module mutations ───
  const updateCat = (catId, patch) => setTrainingData(p => p.map(c => c.id === catId ? { ...c, ...patch } : c));
  const updateMod = (catId, modId, patch) => setTrainingData(p => p.map(c => c.id === catId ? { ...c, modules: (c.modules || []).map(m => m.id === modId ? { ...m, ...patch } : m) } : c));
  const addCategory = () => setTrainingData(p => [...p, { id: `tc-${Date.now()}`, name: "New Category", order: p.length + 1, modules: [] }]);
  const deleteCat = (catId) => setTrainingData(p => p.filter(c => c.id !== catId));
  const addModule = (catId) => setTrainingData(p => p.map(c => c.id === catId ? { ...c, modules: [...(c.modules || []), { id: `tm-${Date.now()}`, name: "New Module", order: (c.modules || []).length + 1, description: "", videoUrl: "", comments: [], completions: {} }] } : c));
  const deleteMod = (catId, modId) => setTrainingData(p => p.map(c => c.id === catId ? { ...c, modules: (c.modules || []).filter(m => m.id !== modId) } : c));
  const addComment = (catId, modId, text) => {
    if (!text.trim()) return;
    updateMod(catId, modId, { comments: [...(trainingData.find(c => c.id === catId)?.modules?.find(m => m.id === modId)?.comments || []), { id: `cmt-${Date.now()}`, author: userName, text: text.trim(), createdAt: new Date().toISOString() }] });
  };
  const reorderMod = (catId, modId, dir) => setTrainingData(p => p.map(c => {
    if (c.id !== catId) return c;
    const mods = [...(c.modules || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    const idx = mods.findIndex(m => m.id === modId);
    if (idx < 0) return c;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= mods.length) return c;
    const tmp = mods[idx].order;
    mods[idx] = { ...mods[idx], order: mods[swapIdx].order };
    mods[swapIdx] = { ...mods[swapIdx], order: tmp };
    return { ...c, modules: mods };
  }));
  const reorderCat = (catId, dir) => setTrainingData(p => {
    const idx = p.findIndex(c => c.id === catId);
    if (idx < 0) return p;
    const si = idx + dir;
    if (si < 0 || si >= p.length) return p;
    // Swap both array position AND order field (the render sorts by order)
    const n = [...p];
    const tmpOrder = n[idx].order;
    n[idx] = { ...n[idx], order: n[si].order };
    n[si] = { ...n[si], order: tmpOrder };
    [n[idx], n[si]] = [n[si], n[idx]];
    return n;
  });
  const toggleCat = (catId) => setCollapsedCats(p => {
    const cur = p[catId] === undefined ? true : p[catId];
    return { ...p, [catId]: !cur };
  });
  const addSuggestion = (type, title, desc) => setTrainingSuggestions(p => [...p, { id: `sug-${Date.now()}`, type, title, description: desc, author: userName, createdAt: new Date().toISOString(), status: "pending" }]);
  const dismissSuggestion = (id) => setTrainingSuggestions(p => p.filter(s => s.id !== id));

  // Find active module + its category
  let activeMod = null, activeCat = null;
  if (activeModuleId) {
    trainingData.forEach(c => {
      const m = (c.modules || []).find(m2 => m2.id === activeModuleId);
      if (m) { activeMod = m; activeCat = c; }
    });
  }

  // ═══════════════════════════════════════════
  // MODULE DETAIL VIEW
  // ═══════════════════════════════════════════
  if (activeMod && activeCat) {
    const commentText = trainingCommentText;
    const setCommentText = setTrainingCommentText;

    return (
      <>
        <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setActiveModuleId(null)} style={{ ...NB, fontSize: 12 }}>&larr; Back</button>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{activeCat.name}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{activeMod.name}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {isAdmin && !trainingEditMode && <button onClick={() => setTrainingEditMode(true)} style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)" }}>Edit Module</button>}
          </div>
        </div>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 28px 60px" }}>
          {/* Video embed — supports Frame.io, YouTube, Vimeo, Loom */}
          {activeMod.videoUrl && (() => {
            const url = activeMod.videoUrl.trim();
            const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
            const ytPlaylist = url.match(/[?&]list=([\w-]+)/);
            const ytStart = url.match(/[?&]t=(\d+)/);
            let embedUrl = url;
            if (ytMatch) {
              const vid = ytMatch[1];
              const params = [];
              if (ytPlaylist) params.push(`list=${ytPlaylist[1]}`);
              if (ytStart) params.push(`start=${ytStart[1]}`);
              embedUrl = `https://www.youtube.com/embed/${vid}${params.length ? "?" + params.join("&") : ""}`;
            }
            const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
            if (vimeoMatch && !url.includes("player.vimeo.com")) {
              embedUrl = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
            }
            const loomMatch = url.match(/loom\.com\/share\/([\w-]+)/);
            if (loomMatch) {
              embedUrl = `https://www.loom.com/embed/${loomMatch[1]}`;
            }
            return (
              <div style={{ marginBottom: 24, borderRadius: 12, overflow: "hidden", background: "#000", aspectRatio: "16/9" }}>
                <iframe src={embedUrl} style={{ width: "100%", height: "100%", border: "none" }} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen />
              </div>
            );
          })()}
          {!activeMod.videoUrl && isAdmin && (
            <div style={{ marginBottom: 24, padding: "40px 20px", textAlign: "center", background: "var(--card)", borderRadius: 12, border: "1px dashed var(--border)", color: "var(--muted)" }}>
              <div style={{ fontSize: 13 }}>No video added. Edit this module to add a video link (Frame.io, YouTube, Vimeo, or Loom).</div>
            </div>
          )}

          {/* Description */}
          {activeMod.description && (
            <div style={{ marginBottom: 24, padding: "20px", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Description</div>
              <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{activeMod.description}</div>
            </div>
          )}

          {/* Admin edit */}
          {isAdmin && trainingEditMode && (
            <div style={{ marginBottom: 24, padding: "20px", background: "var(--card)", borderRadius: 12, border: "1px solid var(--accent)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Edit Module</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input value={activeMod.name} onChange={e => updateMod(activeCat.id, activeMod.id, { name: e.target.value })} placeholder="Module name..." style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 14, fontWeight: 600, outline: "none" }} />
                <input value={activeMod.videoUrl || ""} onChange={e => updateMod(activeCat.id, activeMod.id, { videoUrl: e.target.value })} placeholder="Video URL — Frame.io, YouTube, Vimeo, or Loom..." style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none" }} />
                <textarea value={activeMod.description || ""} onChange={e => updateMod(activeCat.id, activeMod.id, { description: e.target.value })} placeholder="Module description..." rows={4} style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "'DM Sans',sans-serif" }} />
              </div>
              <button onClick={() => setTrainingEditMode(false)} style={{ ...BTN, background: "#10B981", color: "white", marginTop: 10 }}>Done Editing</button>
            </div>
          )}

          {/* Comments */}
          <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)", padding: "20px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 16 }}>Comments ({(activeMod.comments || []).length})</div>
            {(activeMod.comments || []).length > 0 && (
              <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
                {(activeMod.comments || []).map(c => (
                  <div key={c.id} style={{ padding: "12px", background: "var(--bg)", borderRadius: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>{c.author}</span>
                      <span style={{ fontSize: 10, color: "var(--muted)" }}>{new Date(c.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>{c.text}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <input value={commentText} onChange={e => setCommentText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && commentText.trim()) { addComment(activeCat.id, activeMod.id, commentText); setCommentText(""); } }} placeholder="Add a comment..." style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none" }} />
              <button onClick={() => { if (commentText.trim()) { addComment(activeCat.id, activeMod.id, commentText); setCommentText(""); } }} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Post</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  const visibleTraining = role === "closer"
    ? trainingData.filter(c => (c.name || "").toLowerCase().includes("sales"))
    : (role === "editor" || role === "trial")
    ? trainingData.filter(c => !(c.name || "").toLowerCase().includes("sales"))
    : trainingData;
  const canSeeMeetingFeedback = isFounder || role === "closer";

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Training</span>
          {canSeeMeetingFeedback && (
            <div style={{ display: "flex", gap: 2, background: "var(--bg)", borderRadius: 6, padding: 2 }}>
              <button onClick={() => { setTrainingSubTab("modules"); setActiveModuleId(null); }} style={{ padding: "5px 12px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: trainingSubTab === "modules" ? "var(--accent)" : "transparent", color: trainingSubTab === "modules" ? "#fff" : "var(--muted)" }}>Modules</button>
              <button onClick={() => { setTrainingSubTab("meetingFeedback"); setActiveModuleId(null); }} style={{ padding: "5px 12px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: trainingSubTab === "meetingFeedback" ? "var(--accent)" : "transparent", color: trainingSubTab === "meetingFeedback" ? "#fff" : "var(--muted)" }}>Meeting Feedback</button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {trainingSubTab === "modules" && !isAdmin && <button onClick={() => setSugOpen(!sugOpen)} style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)" }}>{sugOpen ? "Cancel" : "Suggest"}</button>}
          {trainingSubTab === "modules" && isAdmin && <button onClick={addCategory} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ Add Category</button>}
        </div>
      </div>

      {trainingSubTab === "meetingFeedback" && canSeeMeetingFeedback && (
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 28px 60px" }}>
          <MeetingFeedback />
        </div>
      )}

      {trainingSubTab === "modules" && (
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 28px 60px" }}>

          {/* Suggestion form (non-admin) */}
          {sugOpen && (
            <div style={{ marginBottom: 24, padding: "20px", background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Suggest a change</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button onClick={() => setSugType("new")} style={{ ...BTN, background: sugType === "new" ? "var(--accent)" : "var(--bg)", color: sugType === "new" ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>New Module</button>
                <button onClick={() => setSugType("outdated")} style={{ ...BTN, background: sugType === "outdated" ? "#F59E0B" : "var(--bg)", color: sugType === "outdated" ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>Flag Outdated</button>
              </div>
              <input value={sugTitle} onChange={e => setSugTitle(e.target.value)} placeholder={sugType === "new" ? "Module title..." : "Which module needs updating..."} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", marginBottom: 8 }} />
              <textarea value={sugDesc} onChange={e => setSugDesc(e.target.value)} placeholder="Details..." rows={3} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "'DM Sans',sans-serif", marginBottom: 8 }} />
              <button onClick={() => { if (sugTitle.trim()) { addSuggestion(sugType, sugTitle, sugDesc); setSugTitle(""); setSugDesc(""); setSugOpen(false); } }} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Submit</button>
            </div>
          )}

          {/* Pending suggestions (admin only) */}
          {isAdmin && trainingSuggestions.filter(s => s.status === "pending").length > 0 && (
            <div style={{ marginBottom: 24, background: "var(--card)", border: "1px solid #F59E0B", borderRadius: 12, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#F59E0B", marginBottom: 12 }}>Suggestions ({trainingSuggestions.filter(s => s.status === "pending").length})</div>
              <div style={{ display: "grid", gap: 8 }}>
                {trainingSuggestions.filter(s => s.status === "pending").map(s => (
                  <div key={s.id} style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 3, background: s.type === "new" ? "rgba(0,130,250,0.12)" : "rgba(245,158,11,0.12)", color: s.type === "new" ? "#0082FA" : "#F59E0B", textTransform: "uppercase" }}>{s.type === "new" ? "New Module" : "Outdated"}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>{s.title}</span>
                      </div>
                      {s.description && <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.description}</div>}
                      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>by {s.author} · {new Date(s.createdAt).toLocaleDateString("en-AU")}</div>
                    </div>
                    <button onClick={() => dismissSuggestion(s.id)} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Dismiss</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Categories + modules */}
          {visibleTraining.sort((a, b) => (a.order || 0) - (b.order || 0)).map(cat => {
            const isCollapsed = collapsedCats[cat.id] !== false;
            const sortedMods = (cat.modules || []).sort((a, b) => (a.order || 0) - (b.order || 0));
            return (
              <div key={cat.id} style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: isCollapsed ? 10 : "10px 10px 0 0", cursor: "pointer" }} onClick={() => toggleCat(cat.id)}>
                  {editCatId === cat.id ? (
                    <div style={{ display: "flex", gap: 8, flex: 1 }} onClick={e => e.stopPropagation()}>
                      <input value={editCatName} onChange={e => setEditCatName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { updateCat(cat.id, { name: editCatName.trim() || cat.name }); setEditCatId(null); } }} autoFocus style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 14, fontWeight: 700, outline: "none" }} />
                      <button onClick={() => { updateCat(cat.id, { name: editCatName.trim() || cat.name }); setEditCatId(null); }} style={{ ...BTN, background: "#10B981", color: "white" }}>Save</button>
                      <button onClick={() => setEditCatId(null)} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)", transition: "transform 0.2s", transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>▼</span>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>{cat.name}</span>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{sortedMods.length} module{sortedMods.length !== 1 ? "s" : ""}</span>
                    </div>
                  )}
                  {isAdmin && editCatId !== cat.id && (
                    <div style={{ display: "flex", gap: 6 }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => reorderCat(cat.id, -1)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--muted)", cursor: "pointer", fontSize: 11, padding: "4px 8px" }}>▲</button>
                      <button onClick={() => reorderCat(cat.id, 1)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--muted)", cursor: "pointer", fontSize: 11, padding: "4px 8px" }}>▼</button>
                      <button onClick={() => { setEditCatId(cat.id); setEditCatName(cat.name); }} style={{ ...BTN, background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)" }}>Rename</button>
                      <button onClick={() => addModule(cat.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)" }}>+ Module</button>
                      {sortedMods.length === 0 && <button onClick={() => deleteCat(cat.id)} style={{ ...BTN, background: "#374151", color: "#EF4444" }}>Delete</button>}
                    </div>
                  )}
                </div>
                {!isCollapsed && (
                  <div style={{ display: "grid", gap: 1 }}>
                    {sortedMods.map((mod, idx) => {
                      const commentCount = (mod.comments || []).length;
                      return (
                        <div key={mod.id} style={{ background: "var(--card)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderRadius: idx === sortedMods.length - 1 ? "0 0 10px 10px" : "0" }}>
                          {editModId === mod.id ? (
                            <div style={{ display: "flex", gap: 8, flex: 1 }} onClick={e => e.stopPropagation()}>
                              <input value={editModName} onChange={e => setEditModName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { updateMod(cat.id, mod.id, { name: editModName.trim() || mod.name }); setEditModId(null); } }} autoFocus style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, fontWeight: 600, outline: "none" }} />
                              <button onClick={() => { updateMod(cat.id, mod.id, { name: editModName.trim() || mod.name }); setEditModId(null); }} style={{ ...BTN, background: "#10B981", color: "white" }}>Save</button>
                              <button onClick={() => setEditModId(null)} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Cancel</button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", flex: 1 }} onClick={() => setActiveModuleId(mod.id)}>
                              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", width: 24, textAlign: "center" }}>{idx + 1}</span>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{mod.name}</div>
                                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                                  {mod.videoUrl && <span style={{ fontSize: 10, color: "var(--accent)" }}>🎥 Video</span>}
                                  {commentCount > 0 && <span style={{ fontSize: 10, color: "var(--muted)" }}>{commentCount} comment{commentCount !== 1 ? "s" : ""}</span>}
                                </div>
                              </div>
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            {isAdmin && editModId !== mod.id && (
                              <>
                                <button onClick={e => { e.stopPropagation(); reorderMod(cat.id, mod.id, -1); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 10, padding: "2px 4px" }} title="Move up">▲</button>
                                <button onClick={e => { e.stopPropagation(); reorderMod(cat.id, mod.id, 1); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 10, padding: "2px 4px" }} title="Move down">▼</button>
                                <button onClick={e => { e.stopPropagation(); setEditModId(mod.id); setEditModName(mod.name); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 10, padding: "2px 4px" }} title="Rename">✏️</button>
                                <button onClick={e => { e.stopPropagation(); deleteMod(cat.id, mod.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 14, padding: "2px 4px" }}>x</button>
                              </>
                            )}
                            {editModId !== mod.id && <span style={{ color: "var(--muted)", fontSize: 14, cursor: "pointer" }} onClick={() => setActiveModuleId(mod.id)}>→</span>}
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
      )}
    </>
  );
}
