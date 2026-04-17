// Social Organic — Select step (Phase 4)
// Three zones:
//   1. Left panel: formats shortlisted inside the current project.
//   2. Right panel: the global Format Library (filtered).
//   3. Bottom drop zone: the ordered list of formats the producer has chosen.
//
// Target count = max(1, round(numberOfVideos / 5)).  numberOfVideos comes
// from the webhook payload (new field after Phase 4); legacy projects fall
// back to an in-app override prompt.
//
// Library drops increment /formatLibrary/{id}/usageCount via a read-modify-
// write. The firebase compat SDK in this codebase doesn't expose a direct
// transaction helper, so we accept a small cosmetic double-count race
// window — it's a counter for browsing, not an auth-critical number.

import { useEffect, useState } from "react";
import { onFB, fbSet, fbListen } from "../firebase";
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FormatFilterBar } from "./FormatLibrary";

const inputSt = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "inherit", width: "100%", boxSizing: "border-box",
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

export function SocialOrganicSelect({ project, onPatch }) {
  const shortlisted = project.shortlistedFormats || {};
  const selectedInit = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  const [selected, setSelected] = useState(selectedInit);
  // Keep local state in sync when Firebase updates land (e.g. multi-tab edits).
  useEffect(() => {
    const firebaseIds = selectedInit.map(s => s.formatLibraryId).join("|");
    const localIds = selected.map(s => s.formatLibraryId).join("|");
    if (firebaseIds !== localIds) setSelected(selectedInit);
  }, [JSON.stringify(selectedInit)]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Library listener (pure read; writes go through the existing hooks).
  const [library, setLibrary] = useState({});
  const [categories, setCategories] = useState({});
  useEffect(() => {
    let u1 = () => {}, u2 = () => {};
    onFB(() => {
      u1 = fbListen("/formatLibrary", d => setLibrary(d || {}));
      u2 = fbListen("/formatCategories", d => setCategories(d || {}));
    });
    return () => { u1(); u2(); };
  }, []);

  // Target count — numberOfVideos / 5 rounded, override wins.
  const numberOfVideos = project.numberOfVideos || null;
  const override = project.videoCountOverride || null;
  const targetFromDeal = numberOfVideos ? Math.max(1, Math.round(numberOfVideos / 5)) : null;
  const targetCount = override || targetFromDeal || null;

  // Filter state for the library panel.
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState([]);

  const sensors = useSensors(useSensor(PointerSensor, {
    // 6px buffer stops accidental picks when the producer is just clicking to read.
    activationConstraint: { distance: 6 },
  }));

  // Shortlisted items (source A). Dedup against already-selected entries.
  const shortlistCards = Object.values(shortlisted).filter(Boolean).map(s => ({
    dragId: `sl:${s.formatLibraryId}`,
    source: "project",
    formatLibraryId: s.formatLibraryId,
    name: s.formatName || library[s.formatLibraryId]?.name || "Unnamed",
    description: s.description || library[s.formatLibraryId]?.videoAnalysis || "",
    category: s.category || library[s.formatLibraryId]?.category || null,
    thumbnail: library[s.formatLibraryId]?.examples?.[0]?.thumbnail || null,
  })).filter(c => !selected.some(s => s.formatLibraryId === c.formatLibraryId));

  // Library items (source B), filtered.
  const libraryCards = Object.values(library || {})
    .filter(f => f && f.id && !f.archived)
    .filter(f => categoryFilter === "all" ? true : f.category === categoryFilter)
    .filter(f => tagFilter.length === 0 ? true : tagFilter.every(t => (f.tags || []).includes(t)))
    .filter(f => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (f.name || "").toLowerCase().includes(q) || (f.videoAnalysis || "").toLowerCase().includes(q);
    })
    .filter(f => !selected.some(s => s.formatLibraryId === f.id))
    .map(f => ({
      dragId: `lib:${f.id}`,
      source: "library",
      formatLibraryId: f.id,
      name: f.name,
      description: f.videoAnalysis || "",
      category: f.category || null,
      thumbnail: f.examples?.[0]?.thumbnail || null,
    }))
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0) || a.name.localeCompare(b.name));

  const allTags = Array.from(new Set(
    Object.values(library || {}).flatMap(f => f?.archived ? [] : (f?.tags || []))
  )).sort();

  const writeSelected = (next) => {
    setSelected(next);
    onPatch({ selectedFormats: next });
  };

  const addFormat = ({ source, formatLibraryId }) => {
    if (selected.some(s => s.formatLibraryId === formatLibraryId)) return;
    const entry = {
      formatLibraryId,
      source,
      order: selected.length,
      addedAt: new Date().toISOString(),
    };
    writeSelected([...selected, entry]);
    // Best-effort usageCount bump when we pull from the global library.
    if (source === "library") {
      const fmt = library[formatLibraryId];
      if (fmt) {
        fbSet(`/formatLibrary/${formatLibraryId}/usageCount`, (fmt.usageCount || 0) + 1);
      }
    }
  };

  const removeFormat = (formatLibraryId) => {
    writeSelected(selected.filter(s => s.formatLibraryId !== formatLibraryId));
  };

  const onDragEnd = (ev) => {
    const { active, over } = ev;
    if (!over) return;

    // Reorder inside the dropzone.
    if (active.id.startsWith("drop:") && over.id.startsWith("drop:")) {
      const oldIdx = selected.findIndex(s => `drop:${s.formatLibraryId}` === active.id);
      const newIdx = selected.findIndex(s => `drop:${s.formatLibraryId}` === over.id);
      if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) return;
      writeSelected(arrayMove(selected, oldIdx, newIdx).map((s, i) => ({ ...s, order: i })));
      return;
    }

    // Drop from a source panel → add to selected.
    if (over.id === "selected-dropzone" || over.id.startsWith("drop:")) {
      if (active.id.startsWith("sl:")) {
        addFormat({ source: "project", formatLibraryId: active.id.slice(3) });
      } else if (active.id.startsWith("lib:")) {
        addFormat({ source: "library", formatLibraryId: active.id.slice(4) });
      }
    }
  };

  const canAdvance = targetCount ? selected.length >= targetCount : selected.length > 0;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>Select formats</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Drag from the project shortlist or the global library into the selected queue at the bottom. Reorder by dragging within the queue.
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {selected.length}{targetCount != null ? ` / ${targetCount}` : ""} selected
          {canAdvance && (
            <button onClick={() => onPatch({ stage: "script" })} style={{ ...btnPrimary, marginLeft: 10, padding: "6px 14px" }}>
              → Script
            </button>
          )}
        </div>
      </div>

      {/* Target count prompt for legacy projects without numberOfVideos. */}
      {!targetCount && (
        <div style={{ marginBottom: 14, padding: 14, background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>How many videos is this retainer for?</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
            Legacy project without a webhook-set numberOfVideos. The target count of formats = videos ÷ 5, rounded.
          </div>
          <VideoCountOverride onSet={(v) => onPatch({ videoCountOverride: Math.max(1, Math.round(v / 5)) })} />
        </div>
      )}

      {/* Two-column source panel */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        {/* Project shortlist */}
        <Panel title="This project's shortlist" count={shortlistCards.length}>
          {shortlistCards.length === 0 ? (
            <EmptyPanel msg="No shortlisted formats left — either nothing was shortlisted or everything has already been selected." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {shortlistCards.map(c => (
                <DraggableFormatCard key={c.dragId} card={c} onClick={() => addFormat(c)} />
              ))}
            </div>
          )}
        </Panel>

        {/* Global library */}
        <Panel title="Global library" count={libraryCards.length}>
          <FormatFilterBar
            search={search} setSearch={setSearch}
            categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter}
            categories={categories}
            tagFilter={tagFilter} setTagFilter={setTagFilter}
            allTags={allTags}
          />
          {libraryCards.length === 0 ? (
            <EmptyPanel msg="No library formats match — clear filters or shortlist more videos." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "45vh", overflowY: "auto", paddingRight: 4 }}>
              {libraryCards.map(c => (
                <DraggableFormatCard key={c.dragId} card={c} onClick={() => addFormat(c)} />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* Drop zone */}
      <SelectedDropzone
        selected={selected}
        library={library}
        shortlisted={shortlisted}
        onRemove={removeFormat}
        targetCount={targetCount}
      />
    </DndContext>
  );
}

function VideoCountOverride({ onSet }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <input type="number" value={val} onChange={e => setVal(e.target.value)} min={1} max={100}
        placeholder="Total videos (e.g. 20)"
        style={{ ...inputSt, width: 220, fontSize: 12 }} />
      <button onClick={() => { const n = parseInt(val); if (n >= 1) onSet(n); }}
        disabled={!val || isNaN(parseInt(val))}
        style={{ ...btnSecondary, opacity: !val || isNaN(parseInt(val)) ? 0.5 : 1 }}>
        Set target
      </button>
    </div>
  );
}

function Panel({ title, count, children }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
        <span>{title}</span>
        <span style={{ color: "var(--muted)", fontWeight: 500, fontFamily: "'JetBrains Mono',monospace" }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

function EmptyPanel({ msg }) {
  return (
    <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 11, background: "var(--bg)", borderRadius: 6 }}>
      {msg}
    </div>
  );
}

function DraggableFormatCard({ card, onClick }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.dragId });
  return (
    <div ref={setNodeRef}
      {...listeners} {...attributes}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        padding: 10, background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 8, cursor: "grab", fontFamily: "inherit", display: "flex", gap: 10,
        userSelect: "none",
      }}
      onDoubleClick={onClick}
      title="Drag into the selected queue, or double-click to add">
      <div style={{ width: 40, height: 40, background: "#000", borderRadius: 4, flexShrink: 0, overflow: "hidden" }}>
        {card.thumbnail && <img src={card.thumbnail} alt="" onError={e => { e.target.style.display = "none"; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.name}</div>
        <div style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {card.source === "project" ? "📁 project" : "📚 library"}{card.category ? ` · ${card.category}` : ""}
        </div>
      </div>
    </div>
  );
}

function SelectedDropzone({ selected, library, shortlisted, onRemove, targetCount }) {
  const { setNodeRef, isOver } = useDroppable({ id: "selected-dropzone" });
  return (
    <div ref={setNodeRef}
      style={{
        padding: 14, background: isOver ? "var(--accent-soft)" : "var(--card)",
        border: `2px dashed ${isOver ? "var(--accent)" : "var(--border)"}`, borderRadius: 10,
        minHeight: 140, transition: "background 0.15s, border 0.15s",
      }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
        <span>Selected for this brief{targetCount != null ? ` — target ${targetCount}` : ""}</span>
        <span style={{ color: "var(--muted)", fontWeight: 500, fontFamily: "'JetBrains Mono',monospace" }}>{selected.length}</span>
      </div>
      {selected.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
          Drag formats here, or double-click in either panel above.
        </div>
      ) : (
        <SortableContext items={selected.map(s => `drop:${s.formatLibraryId}`)} strategy={verticalListSortingStrategy}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {selected.map((s, i) => {
              const fmt = library[s.formatLibraryId] || null;
              const name = shortlisted[`sl_${s.formatLibraryId}`]?.formatName || fmt?.name || s.formatLibraryId;
              const thumb = fmt?.examples?.[0]?.thumbnail || null;
              return (
                <SortableSelectedRow key={s.formatLibraryId}
                  id={`drop:${s.formatLibraryId}`}
                  index={i}
                  name={name}
                  source={s.source}
                  thumbnail={thumb}
                  onRemove={() => onRemove(s.formatLibraryId)}
                />
              );
            })}
          </div>
        </SortableContext>
      )}
    </div>
  );
}

function SortableSelectedRow({ id, index, name, source, thumbnail, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        display: "flex", gap: 10, alignItems: "center",
        padding: 8, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
      }}>
      <span {...listeners} {...attributes}
        style={{ cursor: "grab", color: "var(--muted)", fontSize: 14, userSelect: "none" }}>⋮⋮</span>
      <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", minWidth: 18 }}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <div style={{ width: 32, height: 32, background: "#000", borderRadius: 4, flexShrink: 0, overflow: "hidden" }}>
        {thumbnail && <img src={thumbnail} alt="" onError={e => { e.target.style.display = "none"; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        <div style={{ fontSize: 10, color: "var(--muted)" }}>{source === "project" ? "📁 project" : "📚 library"}</div>
      </div>
      <button onClick={onRemove} title="Remove"
        style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: "2px 6px" }}>×</button>
    </div>
  );
}
