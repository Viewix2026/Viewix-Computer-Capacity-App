import { useState, useEffect, useRef } from "react";
import { fbSet, fbSetAsync, fbListenSafe } from "../firebase";
import { generateRunsheetDocx } from "../runsheetDocx";
import { logoBg } from "../utils";

// ─── Constants ───
const RS_STATUS_COLORS = {
  draft: { bg: "rgba(90,107,133,0.15)", fg: "#5A6B85" },
  final: { bg: "rgba(34,197,94,0.15)", fg: "#22C55E" },
};
const RS_STATUS_LABELS = { draft: "Draft", final: "Final" };

// Meta Ads filmable scene types (in shoot order)
const META_SCENE_TYPES = [
  { key: "hook", label: "Hook" },
  { key: "explainThePain", label: "Explain the Pain" },
  { key: "results", label: "Results" },
  { key: "theOffer", label: "The Offer" },
  { key: "whyTheOffer", label: "Why the Offer" },
  { key: "cta", label: "CTA" },
];

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

// Draggable chip for an organic video. Two lines:
//   1. Video name  — the sequential identifier ("Video 3")
//   2. Format type — the format name as a smaller sub-line
// `expanded` gives it more padding for the unassigned pool (where vertical
// space is free); compact mode is used inside slot cells.
function VideoChip({ v, onClick, onDragStart, draggable, expanded }) {
  const mc = MOTIVATOR_COLORS[v.motivatorType] || {};
  const formatLine = v.formatName || v.contentStyle || "";
  return (
    <div
      draggable={!!draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      title={formatLine ? `${v.videoName} — ${formatLine}` : v.videoName}
      style={{
        padding: expanded ? "8px 12px" : "4px 8px",
        borderRadius: 6,
        cursor: draggable ? "grab" : "pointer",
        background: mc.bg || "var(--card)",
        color: mc.fg || "var(--fg)",
        border: `1px solid ${mc.fg ? `${mc.fg}33` : "var(--border)"}`,
        minWidth: 0,
        display: "flex", flexDirection: "column", gap: 2,
        fontFamily: "inherit",
        userSelect: "none",
      }}>
      <span style={{ fontSize: expanded ? 12 : 11, fontWeight: 700, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {v.videoName || "Video"}
      </span>
      {formatLine && (
        <span style={{ fontSize: expanded ? 10 : 9, fontWeight: 500, opacity: 0.75, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {formatLine}
        </span>
      )}
    </div>
  );
}

function Badge({ text, colors }) {
  return (
    <span style={{
      padding: "2px 10px", borderRadius: 10, fontSize: 11, fontWeight: 700,
      background: colors?.bg || "#333", color: colors?.fg || "#999",
    }}>{text}</span>
  );
}

// ─── Main Component ───
// `creating` + `onCreatingChange` are optional — when Preproduction.jsx
// provides them the parent owns the create-modal state so the "+ Create
// Runsheet" trigger can live in the top header alongside the Meta Ads /
// Social Organic buttons. Falls back to local state so the component
// keeps working standalone.
export function Runsheets({ accounts, projects, creating: creatingProp, onCreatingChange }) {
  const [runsheets, setRunsheets] = useState({});
  const [editors, setEditors] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [creatingLocal, setCreatingLocal] = useState(false);
  const creating = creatingProp !== undefined ? creatingProp : creatingLocal;
  const setCreating = onCreatingChange || setCreatingLocal;
  const [createProjectId, setCreateProjectId] = useState("");
  const [createDays, setCreateDays] = useState(1);
  const [createProducerId, setCreateProducerId] = useState("");
  const [createDirectorId, setCreateDirectorId] = useState("");
  const [activeDayIdx, setActiveDayIdx] = useState(0);
  const [dragItem, setDragItem] = useState(null); // { videoId, sceneType? } — sceneType present for Meta Ads
  const [dragSource, setDragSource] = useState(null); // { dayIdx, slotIdx } or null (from pool)
  const [dragOverSlot, setDragOverSlot] = useState(null);
  const [editingVideo, setEditingVideo] = useState(null);

  // Firebase listeners — fbListenSafe waits for auth + suppresses transient
  // nulls, so the runsheet list doesn't blank itself on token refresh.
  useEffect(() => {
    const u1 = fbListenSafe("/runsheets", d => setRunsheets(d || {}));
    // Firebase deserializes arrays as objects when there are gaps in the
    // numeric keys, so don't rely on Array.isArray — coerce whatever comes
    // back to a clean array of editor records. Without this, the create-
    // runsheet Producer / Shooter dropdowns stay empty even though /editors
    // has data.
    const u2 = fbListenSafe("/editors", d => {
      if (!d) { setEditors([]); return; }
      const arr = Array.isArray(d) ? d : Object.values(d);
      setEditors(arr.filter(e => e && e.id && e.name));
    });
    return () => { u1(); u2(); };
  }, []);

  const rsList = Object.values(runsheets).filter(r => r && r.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const activeRS = activeId ? runsheets[activeId] : null;

  // Approved projects that can have runsheets. Meta Ads: status === "approved" once the
  // producer signs off. Social Organic: status === "exported" once scripts are generated
  // (the Social Organic flow doesn't have an explicit "approved" state — the Push to
  // Runsheets button flips it to "exported"). We also accept a project if it has a
  // non-empty scriptTable, so manually-created drafts can still be used.
  const approvedProjects = Object.values(projects || {})
    .filter(p => {
      if (!p || !p.id) return false;
      if (p.status === "approved" || p.status === "exported") return true;
      // Social Organic scripts live at preproductionDoc.scriptTable; Meta Ads at scriptTable.
      const rows = p._projectType === "socialOrganic"
        ? (p.preproductionDoc?.scriptTable || [])
        : (p.scriptTable || []);
      return rows.length > 0;
    })
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const findAccount = (companyName) => {
    if (!companyName) return null;
    return Object.values(accounts || {}).find(a =>
      a && (a.companyName || "").toLowerCase() === companyName.toLowerCase()
    ) || null;
  };
  const getLogoUrl = (companyName) => findAccount(companyName)?.logoUrl || null;
  const getLogoBgPref = (companyName) => findAccount(companyName)?.logoBg;
  const getEditorById = (id) => editors.find(e => e.id === id) || null;

  // ─── Save helper ───
  const patchRS = (rsId, data) => {
    fbSet(`/runsheets/${rsId}`, { ...runsheets[rsId], ...data, updatedAt: new Date().toISOString() });
  };

  const [createError, setCreateError] = useState(null);
  const [createBusy, setCreateBusy] = useState(false);

  // Helper: Firebase sometimes deserializes arrays as objects with integer
  // keys (when the stored array had any non-sequential writes). `.map()`
  // fails on those. Coerce here so handleCreate doesn't silently throw.
  const toArray = (v) => Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []);

  // ─── Create runsheet ───
  const handleCreate = async () => {
    setCreateError(null);
    setCreateBusy(true);
    try { await doCreate(); }
    catch (e) {
      console.error("Create runsheet failed:", e);
      setCreateError(e.message || String(e));
    } finally {
      setCreateBusy(false);
    }
  };
  const doCreate = async () => {
    if (!createProjectId) { setCreateError("Pick a source project first."); return; }
    const proj = projects[createProjectId];
    if (!proj) { setCreateError(`Project ${createProjectId} not found in the projects map. Refresh and try again.`); return; }
    const id = `rs-${Date.now()}`;

    // Meta Ads scripts live at proj.scriptTable; Social Organic scripts live
    // at proj.preproductionDoc.scriptTable with a different shape (formatName
    // instead of videoName, plus hook/textHook/visualHook/scriptNotes). Use
    // the _projectType tag set by Preproduction.jsx to branch the mapping.
    const isOrganic = proj._projectType === "socialOrganic";
    const scriptRows = toArray(isOrganic ? proj.preproductionDoc?.scriptTable : proj.scriptTable);
    if (scriptRows.length === 0) {
      setCreateError("This project has no script rows yet — generate the scripts first, then come back.");
      return;
    }
    const projectType = isOrganic ? "organic" : "metaAds";

    const videos = scriptRows.map((v, i) => isOrganic ? {
      // Social Organic shape — keep videoName as "Video N" + formatName
      // as the format type, so the Runsheet chip can display both.
      id: v.id || `v-${Date.now()}-${i}`,
      videoName: `Video ${i + 1}`,
      formatName: v.formatName || "",
      contentStyle: v.contentStyle || "",
      hook: v.hook || "",
      textHook: v.textHook || "",
      visualHook: v.visualHook || "",
      scriptNotes: v.scriptNotes || "",
      props: v.props || "",
      people: "",
      // Keep Meta Ads columns empty so the UI's consistent video shape holds.
      explainThePain: "", results: "", theOffer: "", whyTheOffer: "",
      cta: "", metaAdHeadline: "", metaAdCopy: "",
      motivatorType: "", audienceType: "",
    } : {
      // Meta Ads shape (existing)
      id: v.id, videoName: v.videoName || "", hook: v.hook || "",
      explainThePain: v.explainThePain || "", results: v.results || "",
      theOffer: v.theOffer || "", whyTheOffer: v.whyTheOffer || "",
      cta: v.cta || "", metaAdHeadline: v.metaAdHeadline || "",
      metaAdCopy: v.metaAdCopy || "", motivatorType: v.motivatorType || "",
      audienceType: v.audienceType || "", props: "", people: "", contentStyle: "",
    });

    // Default slot template: 5 rows covering a 09:00–16:00 day with a
    // 12:00–13:00 lunch break in the middle. Producers overwrite timings
    // on the day; this just gets past the "what do I put here" blank
    // state new users see on first open.
    const makeDefaultSlots = (sdTs) => [
      { id: `ts-${sdTs}-0`, startTime: "09:00", endTime: "10:30", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      { id: `ts-${sdTs}-1`, startTime: "10:30", endTime: "12:00", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      { id: `ts-${sdTs}-2`, startTime: "12:00", endTime: "13:00", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "Lunch", isBreak: true },
      { id: `ts-${sdTs}-3`, startTime: "13:00", endTime: "14:30", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      { id: `ts-${sdTs}-4`, startTime: "14:30", endTime: "16:00", sceneType: "", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
    ];
    const shootDays = [];
    for (let i = 0; i < Math.max(1, createDays); i++) {
      const sdTs = `${Date.now()}-${i}`;
      shootDays.push({
        id: `sd-${sdTs}`, label: `Shoot ${i + 1}`, date: "",
        location: "", startTime: "09:00", endTime: "16:00",
        timeSlots: makeDefaultSlots(sdTs),
      });
    }
    const rs = {
      id, projectId: createProjectId, projectType, companyName: proj.companyName || "",
      status: "draft", producerId: createProducerId, directorId: createDirectorId,
      clientContacts: [], shootDays, videos, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    // Await the write so we can surface errors (permissions, connectivity)
    // straight back to the producer instead of silently no-opping.
    await fbSetAsync(`/runsheets/${id}`, rs);
    setActiveId(id);
    setActiveDayIdx(0);
    setCreating(false);
    setCreateProjectId("");
    setCreateDays(1);
    setCreateProducerId("");
    setCreateDirectorId("");
  };

  // ─── Assigned tracking ───
  // For organic: track which videoIds are assigned (full video in any slot)
  // For Meta Ads: track which { videoId × sceneType } pairs are assigned
  const rsIsMetaAds = activeRS?.projectType === "metaAds";
  const assignedVideoIds = new Set();
  const assignedSceneElements = new Set(); // keys like "videoId::sceneType"
  if (activeRS) {
    (activeRS.shootDays || []).forEach(day => {
      (day.timeSlots || []).forEach(slot => {
        (slot.videoIds || []).forEach(vid => assignedVideoIds.add(vid));
        (slot.sceneElements || []).forEach(el => assignedSceneElements.add(`${el.videoId}::${el.sceneType}`));
      });
    });
  }
  const unassignedVideos = activeRS ? (activeRS.videos || []).filter(v => !assignedVideoIds.has(v.id)) : [];
  // For Meta Ads: generate all possible scene elements (video × scene type) not yet assigned
  const unassignedSceneElements = [];
  if (activeRS && rsIsMetaAds) {
    (activeRS.videos || []).forEach(v => {
      META_SCENE_TYPES.forEach(scene => {
        const key = `${v.id}::${scene.key}`;
        if (!assignedSceneElements.has(key)) {
          unassignedSceneElements.push({ videoId: v.id, sceneType: scene.key, videoName: v.videoName, motivatorType: v.motivatorType });
        }
      });
    });
  }

  // ─── Drag handlers ───
  const handleDragStart = (item, source) => {
    setDragItem(item);
    setDragSource(source);
  };
  const elementKey = (el) => `${el.videoId}::${el.sceneType || ""}`;
  const matches = (a, b) => rsIsMetaAds
    ? (a.videoId === b.videoId && a.sceneType === b.sceneType)
    : (a.videoId === b.videoId);

  const handleDropOnSlot = (dayIdx, slotIdx) => {
    if (!dragItem || !activeRS) return;
    const days = [...(activeRS.shootDays || [])];

    // Remove from source slot if moving between slots
    if (dragSource) {
      const srcDay = { ...days[dragSource.dayIdx] };
      const srcSlots = [...(srcDay.timeSlots || [])];
      const srcSlot = { ...srcSlots[dragSource.slotIdx] };
      if (rsIsMetaAds) {
        srcSlot.sceneElements = (srcSlot.sceneElements || []).filter(el => !matches(el, dragItem));
      } else {
        srcSlot.videoIds = (srcSlot.videoIds || []).filter(id => id !== dragItem.videoId);
      }
      srcSlots[dragSource.slotIdx] = srcSlot;
      srcDay.timeSlots = srcSlots;
      days[dragSource.dayIdx] = srcDay;
    }

    // Add to target slot
    const tgtDay = { ...days[dayIdx] };
    const tgtSlots = [...(tgtDay.timeSlots || [])];
    const tgtSlot = { ...tgtSlots[slotIdx] };
    if (rsIsMetaAds) {
      const exists = (tgtSlot.sceneElements || []).some(el => matches(el, dragItem));
      if (!exists) {
        tgtSlot.sceneElements = [...(tgtSlot.sceneElements || []), { videoId: dragItem.videoId, sceneType: dragItem.sceneType }];
      }
    } else {
      if (!(tgtSlot.videoIds || []).includes(dragItem.videoId)) {
        tgtSlot.videoIds = [...(tgtSlot.videoIds || []), dragItem.videoId];
      }
    }
    tgtSlots[slotIdx] = tgtSlot;
    tgtDay.timeSlots = tgtSlots;
    days[dayIdx] = tgtDay;

    patchRS(activeRS.id, { shootDays: days });
    setDragItem(null);
    setDragSource(null);
    setDragOverSlot(null);
  };
  const handleDropOnPool = () => {
    if (!dragItem || !activeRS || !dragSource) return;
    const days = [...(activeRS.shootDays || [])];
    const srcDay = { ...days[dragSource.dayIdx] };
    const srcSlots = [...(srcDay.timeSlots || [])];
    const srcSlot = { ...srcSlots[dragSource.slotIdx] };
    if (rsIsMetaAds) {
      srcSlot.sceneElements = (srcSlot.sceneElements || []).filter(el => !matches(el, dragItem));
    } else {
      srcSlot.videoIds = (srcSlot.videoIds || []).filter(id => id !== dragItem.videoId);
    }
    srcSlots[dragSource.slotIdx] = srcSlot;
    srcDay.timeSlots = srcSlots;
    days[dragSource.dayIdx] = srcDay;
    patchRS(activeRS.id, { shootDays: days });
    setDragItem(null);
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
    slots.push({ id: `ts-${Date.now()}`, startTime: nextStart, endTime: nextEnd, videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "Break for Lunch", isBreak: true });
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
  // New days drop in with the same 5-slot 09-16 template as day-one so
  // producers don't get an empty table each time they extend the shoot.
  const addShootDay = () => {
    if (!activeRS) return;
    const days = [...(activeRS.shootDays || [])];
    const idx = days.length;
    const sdTs = `${Date.now()}-${idx}`;
    days.push({
      id: `sd-${sdTs}`, label: `Shoot ${idx + 1}`, date: "",
      location: "", startTime: "09:00", endTime: "16:00",
      timeSlots: [
        { id: `ts-${sdTs}-0`, startTime: "09:00", endTime: "10:30", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
        { id: `ts-${sdTs}-1`, startTime: "10:30", endTime: "12:00", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
        { id: `ts-${sdTs}-2`, startTime: "12:00", endTime: "13:00", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "Lunch", isBreak: true },
        { id: `ts-${sdTs}-3`, startTime: "13:00", endTime: "14:30", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
        { id: `ts-${sdTs}-4`, startTime: "14:30", endTime: "16:00", videoIds: [], sceneElements: [], location: "", props: "", people: "", notes: "" },
      ],
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
    const logoBackground = logoBg(getLogoBgPref(activeRS.companyName));
    const isMetaAds = activeRS.projectType === "metaAds";

    return (
      <div>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => { setActiveId(null); setActiveDayIdx(0); }} style={{ ...btnSecondary, padding: "5px 10px" }}>&larr; Back</button>
            {logo && <img key={logo+logoBackground} src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 28, borderRadius: 4, objectFit: "contain", background: logoBackground, padding: 2 }} />}
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

        {/* Producer / Shooter selectors */}
        <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Producer</label>
            <select value={activeRS.producerId || ""} onChange={e => patchRS(activeRS.id, { producerId: e.target.value })} style={{ ...inputSt }}>
              <option value="">Select producer...</option>
              {editors.map(e => <option key={e.id} value={e.id}>{e.name}{e.phone ? ` — ${e.phone}` : ""}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Shooter</label>
            <select value={activeRS.directorId || ""} onChange={e => patchRS(activeRS.id, { directorId: e.target.value })} style={{ ...inputSt }}>
              <option value="">Select shooter...</option>
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
                    {(isMetaAds
                      ? ["Time", "Scene Elements", "Location", "Props", "People", "Notes", "#", ""]
                      : ["Time", "Videos", "Location", "Props", "People", "Notes", "#", ""]
                    ).map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(day.timeSlots || []).map((slot, si) => {
                    const slotElements = slot.sceneElements || [];
                    const slotVideos = (slot.videoIds || []).map(vid => (activeRS.videos || []).find(v => v.id === vid)).filter(Boolean);
                    // Prefer explicit isBreak flag; fall back to sniffing "Break" in legacy slots
                    const isBreak = slot.isBreak === true || (slot.isBreak === undefined && slot.notes?.includes("Break") && !(slotVideos.length) && !(slotElements.length));
                    const isOver = dragOverSlot?.dayIdx === activeDayIdx && dragOverSlot?.slotIdx === si;
                    const cellCount = isMetaAds ? slotElements.length : slotVideos.length;
                    return (
                      <tr key={slot.id} style={{ background: isBreak ? "rgba(251,191,36,0.06)" : isOver ? "rgba(59,130,246,0.08)" : "transparent" }}>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", width: 130 }}>
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <input type="time" value={slot.startTime || ""} onChange={e => updateSlotField(activeDayIdx, si, "startTime", e.target.value)} style={{ ...inputSt, width: 55, padding: "3px 4px", fontSize: 11, colorScheme: "dark" }} />
                            <span style={{ color: "var(--muted)" }}>-</span>
                            <input type="time" value={slot.endTime || ""} onChange={e => updateSlotField(activeDayIdx, si, "endTime", e.target.value)} style={{ ...inputSt, width: 55, padding: "3px 4px", fontSize: 11, colorScheme: "dark" }} />
                          </div>
                        </td>
                        {isMetaAds ? (
                          /* Meta Ads: scene elements column (or editable note for breaks) */
                          <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", minWidth: 280 }}
                            onDragOver={isBreak ? undefined : e => { e.preventDefault(); setDragOverSlot({ dayIdx: activeDayIdx, slotIdx: si }); }}
                            onDragLeave={isBreak ? undefined : () => setDragOverSlot(null)}
                            onDrop={isBreak ? undefined : e => { e.preventDefault(); handleDropOnSlot(activeDayIdx, si); }}>
                            {isBreak ? (
                              <input
                                value={slot.notes || ""}
                                onChange={e => updateSlotField(activeDayIdx, si, "notes", e.target.value)}
                                placeholder="Break — type a label..."
                                style={{ ...inputSt, padding: "4px 8px", fontSize: 12, fontWeight: 600, fontStyle: "italic", color: "#F59E0B", background: "rgba(251,191,36,0.06)", border: "1px dashed rgba(251,191,36,0.3)" }}
                              />
                            ) : (
                              <div style={{ display: "flex", gap: 3, flexWrap: "wrap", minHeight: 28 }}>
                                {slotElements.map((el, ei) => {
                                  const v = (activeRS.videos || []).find(x => x.id === el.videoId);
                                  if (!v) return null;
                                  const mc = MOTIVATOR_COLORS[v.motivatorType] || {};
                                  const sceneLabel = META_SCENE_TYPES.find(s => s.key === el.sceneType)?.label || el.sceneType;
                                  return (
                                    <span key={`${el.videoId}-${el.sceneType}-${ei}`} draggable
                                      onDragStart={() => handleDragStart({ videoId: el.videoId, sceneType: el.sceneType }, { dayIdx: activeDayIdx, slotIdx: si })}
                                      title={`${v.videoName} — ${sceneLabel}`}
                                      style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "grab", background: mc.bg || "var(--bg)", color: mc.fg || "var(--fg)", border: `1px solid ${mc.fg || "var(--border)"}33`, whiteSpace: "nowrap" }}>
                                      <span style={{ opacity: 0.85 }}>{v.videoName}</span>
                                      <span style={{ opacity: 0.6, margin: "0 4px" }}>·</span>
                                      <span>{sceneLabel}</span>
                                    </span>
                                  );
                                })}
                                {!slotElements.length && <span style={{ color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>Drop scene elements here</span>}
                              </div>
                            )}
                          </td>
                        ) : (
                          /* Organic: Videos column with drag-and-drop */
                          <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", minWidth: 200 }}
                            onDragOver={e => { e.preventDefault(); setDragOverSlot({ dayIdx: activeDayIdx, slotIdx: si }); }}
                            onDragLeave={() => setDragOverSlot(null)}
                            onDrop={e => { e.preventDefault(); handleDropOnSlot(activeDayIdx, si); }}>
                            {/* Organic — each assigned video renders as a two-line box
                                (video name above, format type below) so the producer
                                can glance at the shoot schedule and know what's being
                                filmed without clicking through. Mirrors the info density
                                of the Meta Ads scene chips. */}
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minHeight: 28 }}>
                              {slotVideos.map(v => (
                                <VideoChip key={v.id} v={v}
                                  draggable
                                  onDragStart={() => handleDragStart({ videoId: v.id }, { dayIdx: activeDayIdx, slotIdx: si })}
                                  onClick={() => setEditingVideo(v.id)}
                                />
                              ))}
                              {!slotVideos.length && !isBreak && <span style={{ color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>Drop videos here</span>}
                            </div>
                          </td>
                        )}
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
                          {cellCount || ""}
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

        {/* Unassigned Videos Pool — Organic mode */}
        {!isMetaAds && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleDropOnPool(); }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 10 }}>
              Unassigned Videos ({unassignedVideos.length})
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8, minHeight: 40 }}>
              {unassignedVideos.length === 0 && <span style={{ color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>All videos assigned</span>}
              {unassignedVideos.map(v => (
                <VideoChip key={v.id} v={v} expanded
                  draggable
                  onDragStart={() => handleDragStart({ videoId: v.id }, null)}
                  onClick={() => setEditingVideo(v.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Meta Ads: scene element pool (ad × scene combinations, grouped by scene type) */}
        {isMetaAds && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleDropOnPool(); }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>
                Unassigned Scene Elements ({unassignedSceneElements.length})
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", fontStyle: "italic" }}>
                Drag ad × scene tokens into time slots
              </div>
            </div>
            {unassignedSceneElements.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>All scene elements assigned</div>
            ) : (
              META_SCENE_TYPES.map(scene => {
                const elementsInScene = unassignedSceneElements.filter(el => el.sceneType === scene.key);
                if (elementsInScene.length === 0) return null;
                return (
                  <div key={scene.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                      {scene.label} ({elementsInScene.length})
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {elementsInScene.map(el => {
                        const mc = MOTIVATOR_COLORS[el.motivatorType] || {};
                        return (
                          <span key={`${el.videoId}-${el.sceneType}`} draggable
                            onDragStart={() => handleDragStart({ videoId: el.videoId, sceneType: el.sceneType }, null)}
                            title={`${el.videoName} — ${scene.label}`}
                            style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "grab", background: mc.bg || "var(--bg)", color: mc.fg || "var(--fg)", border: `1px solid ${mc.fg || "var(--border)"}33`, whiteSpace: "nowrap" }}>
                            {el.videoName}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Video Edit Modal */}
        {editingVideo && (() => {
          const v = (activeRS.videos || []).find(x => x.id === editingVideo);
          if (!v) return null;
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setEditingVideo(null)}>
              <div style={{ background: "var(--card)", borderRadius: 12, padding: 24, maxWidth: 500, width: "90%", border: "1px solid var(--border)" }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{v.videoName}</div>
                    {v.formatName && (
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{v.formatName}</div>
                    )}
                  </div>
                  <button onClick={() => setEditingVideo(null)} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
                </div>
                {/* Organic runsheets carry the full script shape — expose every
                    field the producer needs to tweak on the day of the shoot.
                    Meta Ads only gets the three filming-context fields below
                    (hook/CTA stay read-only because they're the Ad's script). */}
                {(isMetaAds
                  ? [
                      { key: "contentStyle", label: "Content Style" },
                      { key: "props",        label: "Props" },
                      { key: "people",       label: "People" },
                    ]
                  : [
                      { key: "contentStyle", label: "Content Style" },
                      { key: "hook",         label: "Hook (spoken)" },
                      { key: "textHook",     label: "Text Hook" },
                      { key: "visualHook",   label: "Visual Hook" },
                      { key: "scriptNotes",  label: "Script / Notes" },
                      { key: "props",        label: "Props" },
                      { key: "people",       label: "People" },
                    ]
                ).map(f => (
                  <div key={f.key} style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>{f.label}</label>
                    <textarea value={v[f.key] || ""} onChange={e => updateVideo(v.id, f.key, e.target.value)}
                      style={{ ...inputSt, minHeight: 50, resize: "vertical" }} />
                  </div>
                ))}
                {isMetaAds && (
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                    <strong>Hook:</strong> {v.hook || "—"}<br />
                    <strong>CTA:</strong> {v.cta || "—"}
                  </div>
                )}
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
                {approvedProjects.map(p => {
                  const isOrganic = p._projectType === "socialOrganic";
                  const rows = isOrganic
                    ? (p.preproductionDoc?.scriptTable?.length || 0)
                    : (p.scriptTable?.length || 0);
                  const typeLabel = isOrganic ? "organic" : (p.packageTier || "meta ads");
                  return <option key={p.id} value={p.id}>{p.companyName} — {typeLabel} ({rows} {isOrganic ? "videos" : "ads"})</option>;
                })}
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
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Shooter</label>
              <select value={createDirectorId} onChange={e => setCreateDirectorId(e.target.value)} style={inputSt}>
                <option value="">Select...</option>
                {editors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={handleCreate} disabled={!createProjectId || createBusy}
              style={{ ...btnPrimary, opacity: (!createProjectId || createBusy) ? 0.5 : 1 }}>
              {createBusy ? "Creating…" : "Create"}
            </button>
            <button onClick={() => { setCreating(false); setCreateError(null); }} style={btnSecondary}>Cancel</button>
          </div>
          {createError && (
            <div style={{ marginTop: 12, padding: "8px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, fontSize: 11, color: "#EF4444" }}>
              {createError}
            </div>
          )}
        </div>
      )}

      {/* The "+ Create Runsheet" trigger lives in the parent Preproduction
          header alongside the Meta Ads + Social Organic "+ New" buttons. */}

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
          const lbg = logoBg(getLogoBgPref(rs.companyName));
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
                {logo && <img key={logo+lbg} src={logo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 24, borderRadius: 4, objectFit: "contain", background: lbg, padding: 2 }} />}
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
