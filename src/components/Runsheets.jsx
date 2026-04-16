import { useState, useEffect, useRef } from "react";
import { onFB, fbSet, fbListen } from "../firebase";
import { generateRunsheetDocx } from "../runsheetDocx";

// ─── Constants ───
const RS_STATUS_COLORS = {
  draft: { bg: "rgba(90,107,133,0.15)", fg: "#5A6B85" },
  final: { bg: "rgba(34,197,94,0.15)", fg: "#22C55E" },
};
const RS_STATUS_LABELS = { draft: "Draft", final: "Final" };
const MOTIVATOR_COLORS = {
  toward: { bg: "rgba(34,197,94,0.12)", fg: "#22C55E", label: "Toward" },
  awayFrom: { bg: "rgba(239,68,68,0.12)", fg: "#EF4444", label: "Away From" },
  triedBefore: { bg: "rgba(59,130,246,0.12)", fg: "#3B82F6", label: "Tried Before" },
};

const inputSt = {
  padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "inherit", width: "100%",
};
const btnPrimary = {
  padding: "7px 16px", borderRadius: 8, border: "none", background: "var(--accent)",
  color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary = {
  padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)",
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

// ─── Main Component ───
export function Runsheets({ accounts, projects }) {
  const [runsheets, setRunsheets] = useState({});
  const [editors, setEditors] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createDays, setCreateDays] = useState(1);
  const [createProducerId, setCreateProducerId] = useState("");
  const [createDirectorId, setCreateDirectorId] = useState("");
  const [activeDayIdx, setActiveDayIdx] = useState(0);
  const [dragVideoId, setDragVideoId] = useState(null);
  const [dragSource, setDragSource] = useState(null); // { dayIdx, slotIdx } or null (from pool)
  const [dragOverSlot, setDragOverSlot] = useState(null);
  const [editingVideo, setEditingVideo] = useState(null);

  // Firebase listeners
  useEffect(() => {
    let u1 = () => {}, u2 = () => {};
    onFB(() => {
      u1 = fbListen("/runsheets", d => setRunsheets(d || {}));
      u2 = fbListen("/editors", d => { if (d && Array.isArray(d)) setEditors(d); });
    });
    return () => { u1(); u2(); };
  }, []);

  const rsList = Object.values(runsheets).filter(r => r && r.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const activeRS = activeId ? runsheets[activeId] : null;

  // Approved projects that can have runsheets
  const approvedProjects = Object.values(projects || {})
    .filter(p => p && p.id && (p.status === "approved" || p.status === "exported"))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const findAccount = (companyName) => {
    if (!companyName) return null;
    return Object.values(accounts || {}).find(a =>
      a && (a.companyName || "").toLowerCase() === companyName.toLowerCase()
    ) || null;
  };
  const getLogoUrl = (companyName) => findAccount(companyName)?.logoUrl || null;
  const getEditorById = (id) => editors.find(e => e.id === id) || null;

  // ─── Save helper ───
  const patchRS = (rsId, data) => {
    fbSet(`/runsheets/${rsId}`, { ...runsheets[rsId], ...data, updatedAt: new Date().toISOString() });
  };

  // ─── Create runsheet ───
  const handleCreate = () => {
    if (!createProjectId) return;
    const proj = projects[createProjectId];
    if (!proj) return;
    const id = `rs-${Date.now()}`;
    const videos = (proj.scriptTable || []).map(v => ({
      id: v.id, videoName: v.videoName || "", hook: v.hook || "",
      explainThePain: v.explainThePain || "", results: v.results || "",
      theOffer: v.theOffer || "", whyTheOffer: v.whyTheOffer || "",
      cta: v.cta || "", metaAdHeadline: v.metaAdHeadline || "",
      metaAdCopy: v.metaAdCopy || "", motivatorType: v.motivatorType || "",
      audienceType: v.audienceType || "", props: "", people: "", contentStyle: "",
    }));
    const shootDays = [];
    for (let i = 0; i < Math.max(1, createDays); i++) {
      shootDays.push({
        id: `sd-${Date.now()}-${i}`, label: `Shoot ${i + 1}`, date: "",
        location: "", startTime: "09:00", endTime: "17:00",
        timeSlots: [
          { id: `ts-${Date.now()}-${i}-0`, startTime: "09:00", endTime: "09:30", videoIds: [], location: "", props: "", people: "", notes: "" },
        ],
      });
    }
    const rs = {
      id, projectId: createProjectId, companyName: proj.companyName || "",
      status: "draft", producerId: createProducerId, directorId: createDirectorId,
      clientContacts: [], shootDays, videos, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fbSet(`/runsheets/${id}`, rs);
    setActiveId(id);
    setActiveDayIdx(0);
    setCreating(false);
    setCreateProjectId("");
    setCreateDays(1);
    setCreateProducerId("");
    setCreateDirectorId("");
  };

  // ─── Assigned video IDs (across all days) ───
  const assignedVideoIds = new Set();
  if (activeRS) {
    (activeRS.shootDays || []).forEach(day => {
      (day.timeSlots || []).forEach(slot => {
        (slot.videoIds || []).forEach(vid => assignedVideoIds.add(vid));
      });
    });
  }
  const unassignedVideos = activeRS ? (activeRS.videos || []).filter(v => !assignedVideoIds.has(v.id)) : [];

  // ─── Drag handlers ───
  const handleDragStart = (videoId, source) => {
    setDragVideoId(videoId);
    setDragSource(source);
  };
  const handleDropOnSlot = (dayIdx, slotIdx) => {
    if (!dragVideoId || !activeRS) return;
    const rs = { ...activeRS };
    const days = [...(rs.shootDays || [])];

    // Remove from source slot if moving between slots
    if (dragSource) {
      const srcDay = { ...days[dragSource.dayIdx] };
      const srcSlots = [...(srcDay.timeSlots || [])];
      const srcSlot = { ...srcSlots[dragSource.slotIdx] };
      srcSlot.videoIds = (srcSlot.videoIds || []).filter(id => id !== dragVideoId);
      srcSlots[dragSource.slotIdx] = srcSlot;
      srcDay.timeSlots = srcSlots;
      days[dragSource.dayIdx] = srcDay;
    }

    // Add to target slot
    const tgtDay = { ...days[dayIdx] };
    const tgtSlots = [...(tgtDay.timeSlots || [])];
    const tgtSlot = { ...tgtSlots[slotIdx] };
    if (!(tgtSlot.videoIds || []).includes(dragVideoId)) {
      tgtSlot.videoIds = [...(tgtSlot.videoIds || []), dragVideoId];
    }
    tgtSlots[slotIdx] = tgtSlot;
    tgtDay.timeSlots = tgtSlots;
    days[dayIdx] = tgtDay;

    patchRS(activeRS.id, { shootDays: days });
    setDragVideoId(null);
    setDragSource(null);
    setDragOverSlot(null);
  };
  const handleDropOnPool = () => {
    if (!dragVideoId || !activeRS || !dragSource) return;
    const rs = { ...activeRS };
    const days = [...(rs.shootDays || [])];
    const srcDay = { ...days[dragSource.dayIdx] };
    const srcSlots = [...(srcDay.timeSlots || [])];
    const srcSlot = { ...srcSlots[dragSource.slotIdx] };
    srcSlot.videoIds = (srcSlot.videoIds || []).filter(id => id !== dragVideoId);
    srcSlots[dragSource.slotIdx] = srcSlot;
    srcDay.timeSlots = srcSlots;
    days[dragSource.dayIdx] = srcDay;
    patchRS(activeRS.id, { shootDays: days });
    setDragVideoId(null);
    setDragSource(null);
    setDragOverSlot(null);
  };

  // ─── Time slot management ───
  const addTimeSlot = (dayIdx) => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    const day = { ...days[dayIdx] };
    const slots = [...(day.timeSlots || [])];
    const lastSlot = slots[slots.length - 1];
    const nextStart = lastSlot ? lastSlot.endTime : "09:00";
    const [h, m] = nextStart.split(":").map(Number);
    const endMin = m + 30;
    const nextEnd = `${String(h + Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
    slots.push({ id: `ts-${Date.now()}`, startTime: nextStart, endTime: nextEnd, videoIds: [], location: "", props: "", people: "", notes: "" });
    day.timeSlots = slots;
    days[dayIdx] = day;
    patchRS(activeRS.id, { shootDays: days });
  };
  const addBreak = (dayIdx) => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    const day = { ...days[dayIdx] };
    const slots = [...(day.timeSlots || [])];
    const lastSlot = slots[slots.length - 1];
    const nextStart = lastSlot ? lastSlot.endTime : "12:00";
    const [h, m] = nextStart.split(":").map(Number);
    const endMin = m + 60;
    const nextEnd = `${String(h + Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
    slots.push({ id: `ts-${Date.now()}`, startTime: nextStart, endTime: nextEnd, videoIds: [], location: "", props: "", people: "", notes: "Break for Lunch" });
    day.timeSlots = slots;
    days[dayIdx] = day;
    patchRS(activeRS.id, { shootDays: days });
  };
  const removeTimeSlot = (dayIdx, slotIdx) => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    const day = { ...days[dayIdx] };
    day.timeSlots = (day.timeSlots || []).filter((_, i) => i !== slotIdx);
    days[dayIdx] = day;
    patchRS(activeRS.id, { shootDays: days });
  };
  const updateSlotField = (dayIdx, slotIdx, field, value) => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    const day = { ...days[dayIdx] };
    const slots = [...(day.timeSlots || [])];
    slots[slotIdx] = { ...slots[slotIdx], [field]: value };
    day.timeSlots = slots;
    days[dayIdx] = day;
    patchRS(activeRS.id, { shootDays: days });
  };

  // ─── Shoot day management ───
  const addShootDay = () => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    const idx = days.length;
    days.push({
      id: `sd-${Date.now()}`, label: `Shoot ${idx + 1}`, date: "",
      location: "", startTime: "09:00", endTime: "17:00",
      timeSlots: [{ id: `ts-${Date.now()}`, startTime: "09:00", endTime: "09:30", videoIds: [], location: "", props: "", people: "", notes: "" }],
    });
    patchRS(activeRS.id, { shootDays: days });
    setActiveDayIdx(idx);
  };
  const removeShootDay = (dayIdx) => {
    if (!activeRS) return;
    const days = (activeRS.shootDays || []).filter((_, i) => i !== dayIdx);
    patchRS(activeRS.id, { shootDays: days });
    if (activeDayIdx >= days.length) setActiveDayIdx(Math.max(0, days.length - 1));
  };
  const updateDayField = (dayIdx, field, value) => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    days[dayIdx] = { ...days[dayIdx], [field]: value };
    patchRS(activeRS.id, { shootDays: days });
  };

  // ─── Video detail editing ───
  const updateVideo = (videoId, field, value) => {
    if (!activeRS) return;
    const videos = (activeRS.videos || []).map(v => v.id === videoId ? { ...v, [field]: value } : v);
    patchRS(activeRS.id, { videos });
  };

  // ─── Export ───
  const handleExport = async () => {
    if (!activeRS) return;
    const producer = getEditorById(activeRS.producerId);
    const director = getEditorById(activeRS.directorId);
    const clientLogoUrl = getLogoUrl(activeRS.companyName);
    try {
      await generateRunsheetDocx(activeRS, producer, director, clientLogoUrl);
      patchRS(activeRS.id, { status: "final" });
    } catch (err) {
      console.error("Export failed:", err);
      alert("Export failed: " + err.message);
    }
  };

  // ═══════════════════════════════════════════
  // DETAIL VIEW (Schedule Builder)
  // ═══════════════════════════════════════════
  if (activeRS) {
    const day = (activeRS.shootDays || [])[activeDayIdx];
    const producer = getEditorById(activeRS.producerId);
    const director = getEditorById(activeRS.directorId);
    const logo = getLogoUrl(activeRS.companyName);

    return (
      <div>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => { setActiveId(null); setActiveDayIdx(0); }} style={{ ...btnSecondary, padding: "5px 10px" }}>&larr; Back</button>
            {logo && <img src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 28, borderRadius: 4, objectFit: "contain", background: "#fff", padding: 2 }} />}
            <span style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>{activeRS.companyName}</span>
            <Badge text={RS_STATUS_LABELS[activeRS.status] || activeRS.status} colors={RS_STATUS_COLORS[activeRS.status]} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={activeRS.status} onChange={e => patchRS(activeRS.id, { status: e.target.value })} style={{ ...inputSt, width: "auto", fontSize: 12, padding: "5px 8px" }}>
              <option value="draft">Draft</option>
              <option value="final">Final</option>
            </select>
            <button onClick={handleExport} style={btnPrimary}>Export DOCX</button>
            <button onClick={() => { if (confirm("Delete this runsheet?")) { fbSet(`/runsheets/${activeRS.id}`, null); setActiveId(null); } }}
              style={{ ...btnSecondary, color: "#EF4444", borderColor: "rgba(239,68,68,0.3)" }}>Delete</button>
          </div>
        </div>

        {/* Producer / Director selectors */}
        <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Producer</label>
            <select value={activeRS.producerId || ""} onChange={e => patchRS(activeRS.id, { producerId: e.target.value })} style={{ ...inputSt }}>
              <option value="">Select producer...</option>
              {editors.map(e => <option key={e.id} value={e.id}>{e.name}{e.phone ? ` — ${e.phone}` : ""}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Director</label>
            <select value={activeRS.directorId || ""} onChange={e => patchRS(activeRS.id, { directorId: e.target.value })} style={{ ...inputSt }}>
              <option value="">Select director...</option>
              {editors.map(e => <option key={e.id} value={e.id}>{e.name}{e.phone ? ` — ${e.phone}` : ""}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Client Contacts</label>
            <input type="text" value={(activeRS.clientContacts || []).map(c => `${c.name}${c.phone ? ` (${c.phone})` : ""}`).join(", ")}
              onChange={e => {
                const contacts = e.target.value.split(",").map(s => {
                  const match = s.trim().match(/^(.+?)(?:\s*\((.+?)\))?$/);
                  return match ? { name: match[1].trim(), phone: match[2]?.trim() || "" } : null;
                }).filter(Boolean);
                patchRS(activeRS.id, { clientContacts: contacts });
              }} placeholder="Name (phone), Name (phone)..." style={inputSt} />
          </div>
        </div>

        {/* Shoot Day Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {(activeRS.shootDays || []).map((d, i) => (
            <button key={d.id} onClick={() => setActiveDayIdx(i)}
              style={{
                padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit", position: "relative",
                background: activeDayIdx === i ? "var(--accent)" : "var(--bg)",
                color: activeDayIdx === i ? "#fff" : "var(--muted)",
              }}>
              {d.label || `Day ${i + 1}`}{d.date ? ` — ${new Date(d.date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}
              {(activeRS.shootDays || []).length > 1 && activeDayIdx === i && (
                <span onClick={e => { e.stopPropagation(); removeShootDay(i); }}
                  style={{ marginLeft: 8, fontSize: 14, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>×</span>
              )}
            </button>
          ))}
          <button onClick={addShootDay} style={{ ...btnSecondary, padding: "5px 12px", fontSize: 12 }}>+ Add Day</button>
        </div>

        {/* Active day config */}
        {day && (
          <>
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Label</label>
                <input value={day.label || ""} onChange={e => updateDayField(activeDayIdx, "label", e.target.value)} style={{ ...inputSt, width: 140 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Date</label>
                <input type="date" value={day.date || ""} onChange={e => updateDayField(activeDayIdx, "date", e.target.value)} style={{ ...inputSt, width: 160, colorScheme: "dark" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Location</label>
                <input value={day.location || ""} onChange={e => updateDayField(activeDayIdx, "location", e.target.value)} placeholder="Studio, Address..." style={{ ...inputSt, width: 220 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Start</label>
                <input type="time" value={day.startTime || "09:00"} onChange={e => updateDayField(activeDayIdx, "startTime", e.target.value)} style={{ ...inputSt, width: 110, colorScheme: "dark" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>End</label>
                <input type="time" value={day.endTime || "17:00"} onChange={e => updateDayField(activeDayIdx, "endTime", e.target.value)} style={{ ...inputSt, width: 110, colorScheme: "dark" }} />
              </div>
            </div>

            {/* Schedule Table */}
            <div style={{ overflowX: "auto", marginBottom: 16 }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Time", "Videos", "Location", "Props", "People", "Notes", "#", ""].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(day.timeSlots || []).map((slot, si) => {
                    const isBreak = slot.notes && !slot.videoIds?.length;
                    const slotVideos = (slot.videoIds || []).map(vid => (activeRS.videos || []).find(v => v.id === vid)).filter(Boolean);
                    const isOver = dragOverSlot?.dayIdx === activeDayIdx && dragOverSlot?.slotIdx === si;
                    return (
                      <tr key={slot.id} style={{ background: isBreak ? "rgba(251,191,36,0.06)" : isOver ? "rgba(59,130,246,0.08)" : "transparent" }}>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", width: 130 }}>
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <input type="time" value={slot.startTime || ""} onChange={e => updateSlotField(activeDayIdx, si, "startTime", e.target.value)} style={{ ...inputSt, width: 55, padding: "3px 4px", fontSize: 11, colorScheme: "dark" }} />
                            <span style={{ color: "var(--muted)" }}>-</span>
                            <input type="time" value={slot.endTime || ""} onChange={e => updateSlotField(activeDayIdx, si, "endTime", e.target.value)} style={{ ...inputSt, width: 55, padding: "3px 4px", fontSize: 11, colorScheme: "dark" }} />
                          </div>
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", minWidth: 200 }}
                          onDragOver={e => { e.preventDefault(); setDragOverSlot({ dayIdx: activeDayIdx, slotIdx: si }); }}
                          onDragLeave={() => setDragOverSlot(null)}
                          onDrop={e => { e.preventDefault(); handleDropOnSlot(activeDayIdx, si); }}>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minHeight: 28 }}>
                            {slotVideos.map(v => {
                              const mc = MOTIVATOR_COLORS[v.motivatorType] || {};
                              return (
                                <span key={v.id} draggable onDragStart={() => handleDragStart(v.id, { dayIdx: activeDayIdx, slotIdx: si })}
                                  onClick={() => setEditingVideo(v.id)}
                                  style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "grab", background: mc.bg || "var(--bg)", color: mc.fg || "var(--fg)", border: `1px solid ${mc.fg || "var(--border)"}22` }}>
                                  {v.videoName}
                                </span>
                              );
                            })}
                            {!slotVideos.length && !isBreak && <span style={{ color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>Drop videos here</span>}
                          </div>
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", width: 140 }}>
                          <input value={slot.location || ""} onChange={e => updateSlotField(activeDayIdx, si, "location", e.target.value)} placeholder={day.location || ""} style={{ ...inputSt, padding: "3px 6px", fontSize: 11 }} />
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", width: 140 }}>
                          <input value={slot.props || ""} onChange={e => updateSlotField(activeDayIdx, si, "props", e.target.value)} style={{ ...inputSt, padding: "3px 6px", fontSize: 11 }} />
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", width: 120 }}>
                          <input value={slot.people || ""} onChange={e => updateSlotField(activeDayIdx, si, "people", e.target.value)} style={{ ...inputSt, padding: "3px 6px", fontSize: 11 }} />
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", width: 140 }}>
                          <input value={slot.notes || ""} onChange={e => updateSlotField(activeDayIdx, si, "notes", e.target.value)} placeholder={isBreak ? "" : "Notes..."} style={{ ...inputSt, padding: "3px 6px", fontSize: 11, fontStyle: isBreak ? "italic" : "normal" }} />
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", textAlign: "center", fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", width: 30 }}>
                          {slotVideos.length || ""}
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", width: 30 }}>
                          <button onClick={() => removeTimeSlot(activeDayIdx, si)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 14 }}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
              <button onClick={() => addTimeSlot(activeDayIdx)} style={{ ...btnSecondary, fontSize: 11 }}>+ Add Time Slot</button>
              <button onClick={() => addBreak(activeDayIdx)} style={{ ...btnSecondary, fontSize: 11 }}>+ Add Break</button>
            </div>
          </>
        )}

        {/* Unassigned Videos Pool */}
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleDropOnPool(); }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 10 }}>
            Unassigned Videos ({unassignedVideos.length})
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minHeight: 40 }}>
            {unassignedVideos.length === 0 && <span style={{ color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>All videos assigned</span>}
            {unassignedVideos.map(v => {
              const mc = MOTIVATOR_COLORS[v.motivatorType] || {};
              return (
                <span key={v.id} draggable onDragStart={() => handleDragStart(v.id, null)}
                  onClick={() => setEditingVideo(v.id)}
                  style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "grab", background: mc.bg || "var(--bg)", color: mc.fg || "var(--fg)", border: `1px solid ${mc.fg || "var(--border)"}33` }}>
                  {v.videoName}
                </span>
              );
            })}
          </div>
        </div>

        {/* Video Edit Modal */}
        {editingVideo && (() => {
          const v = (activeRS.videos || []).find(x => x.id === editingVideo);
          if (!v) return null;
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setEditingVideo(null)}>
              <div style={{ background: "var(--card)", borderRadius: 12, padding: 24, maxWidth: 500, width: "90%", border: "1px solid var(--border)" }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{v.videoName}</span>
                  <button onClick={() => setEditingVideo(null)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
                </div>
                {[{ key: "contentStyle", label: "Content Style" }, { key: "props", label: "Props" }, { key: "people", label: "People" }].map(f => (
                  <div key={f.key} style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>{f.label}</label>
                    <textarea value={v[f.key] || ""} onChange={e => updateVideo(v.id, f.key, e.target.value)}
                      style={{ ...inputSt, minHeight: 50, resize: "vertical" }} />
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                  <strong>Hook:</strong> {v.hook || "—"}<br />
                  <strong>CTA:</strong> {v.cta || "—"}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  return (
    <div>
      {/* Create modal */}
      {creating && (
        <div style={{ marginBottom: 20, padding: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Create Runsheet</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: 2, minWidth: 200 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Source Project (Approved)</label>
              <select value={createProjectId} onChange={e => setCreateProjectId(e.target.value)} style={inputSt}>
                <option value="">Select project...</option>
                {approvedProjects.map(p => <option key={p.id} value={p.id}>{p.companyName} — {p.packageTier} ({p.scriptTable?.length || 0} ads)</option>)}
              </select>
            </div>
            <div style={{ minWidth: 80 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Shoot Days</label>
              <input type="number" min={1} max={10} value={createDays} onChange={e => setCreateDays(parseInt(e.target.value) || 1)} style={{ ...inputSt, width: 70 }} />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Producer</label>
              <select value={createProducerId} onChange={e => setCreateProducerId(e.target.value)} style={inputSt}>
                <option value="">Select...</option>
                {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Director</label>
              <select value={createDirectorId} onChange={e => setCreateDirectorId(e.target.value)} style={inputSt}>
                <option value="">Select...</option>
                {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleCreate} disabled={!createProjectId} style={{ ...btnPrimary, opacity: createProjectId ? 1 : 0.5 }}>Create</button>
            <button onClick={() => setCreating(false)} style={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {!creating && <button onClick={() => setCreating(true)} style={{ ...btnPrimary, marginBottom: 20 }}>+ Create Runsheet</button>}

      {/* Runsheet cards */}
      {rsList.length === 0 && !creating && (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>&#128203;</div>
          <div style={{ fontSize: 14 }}>No runsheets yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Create a runsheet from an approved pre-production project</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 14 }}>
        {rsList.map(rs => {
          const logo = getLogoUrl(rs.companyName);
          const producer = getEditorById(rs.producerId);
          const totalVideos = (rs.videos || []).length;
          const shootDates = (rs.shootDays || []).filter(d => d.date).map(d =>
            new Date(d.date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })
          );
          return (
            <div key={rs.id} onClick={() => { setActiveId(rs.id); setActiveDayIdx(0); }}
              style={{
                background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10,
                padding: 16, cursor: "pointer", position: "relative",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                {logo && <img src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 24, borderRadius: 4, objectFit: "contain", background: "#fff", padding: 2 }} />}
                <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{rs.companyName}</span>
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <Badge text={RS_STATUS_LABELS[rs.status] || rs.status} colors={RS_STATUS_COLORS[rs.status]} />
                <Badge text={`${totalVideos} videos`} colors={{ bg: "rgba(59,130,246,0.12)", fg: "#3B82F6" }} />
              </div>
              {shootDates.length > 0 && <div style={{ fontSize: 11, color: "var(--muted)" }}>{shootDates.join(", ")}</div>}
              {producer && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Producer: {producer.name}</div>}
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                {rs.createdAt ? new Date(rs.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
