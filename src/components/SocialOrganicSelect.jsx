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
import { fbSet, fbListenSafe } from "../firebase";
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FormatFilterBar } from "./FormatLibrary";
import { ReelPreview } from "./shared/ReelPreview";

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
  // fbListenSafe: waits for auth, suppresses transient nulls.
  const [library, setLibrary] = useState({});
  useEffect(() => fbListenSafe("/formatLibrary", d => setLibrary(d || {})), []);

  // Target count — AI-suggested if present, else numberOfVideos / 5, else manual.
  const aiCount = typeof project.suggestedFormatCount === "number" ? project.suggestedFormatCount : null;
  const numberOfVideos = project.numberOfVideos || null;
  const override = project.videoCountOverride || null;
  const targetFromDeal = numberOfVideos ? Math.max(1, Math.round(numberOfVideos / 5)) : null;
  const targetCount = override || aiCount || targetFromDeal || null;

  // Filter state for the library panel.
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState([]);
  // Left-panel category tabs — Suggested (AI) / Recently Added / Over Performers.
  // (These are derived views, not per-format categories — naming kept for
  // backwards-compat with Phase 4 spec.)
  const [categoryMode, setCategoryMode] = useState("all");
  // Modal state for the per-format "Details" drill-in. null = closed.
  const [detailsId, setDetailsId] = useState(null);

  // Suggest action — asks Claude to rank the library against the project.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(null);
  const runSuggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const r = await fetch("/api/social-organic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggestFormats", projectId: project.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      // Re-suggest clears the "autopopulated already" flag so the new
      // suggestion actually takes effect.
      fbSet(`/preproduction/socialOrganic/${project.id}/selectedFormatsInitialized`, null);
    } catch (e) {
      setSuggestError(e.message);
    } finally {
      setSuggesting(false);
    }
  };

  // Auto-populate selected from AI suggestions ONCE per project. We persist
  // a flag (selectedFormatsInitialized) so clearing the queue manually
  // doesn't retrigger the effect — the producer may have intentionally
  // emptied it to start fresh.
  const suggestedIds = Array.isArray(project.suggestedFormatIds) ? project.suggestedFormatIds : [];
  const alreadyInitialized = !!project.selectedFormatsInitialized;
  useEffect(() => {
    if (alreadyInitialized) return;
    if (selected.length > 0) return;
    if (suggestedIds.length === 0) return;
    const next = suggestedIds.map((id, i) => ({
      formatLibraryId: id,
      source: "library",
      order: i,
      addedAt: new Date().toISOString(),
    }));
    setSelected(next);
    onPatch({ selectedFormats: next });
    fbSet(`/preproduction/socialOrganic/${project.id}/selectedFormatsInitialized`, new Date().toISOString());
  }, [JSON.stringify(suggestedIds), alreadyInitialized]);  // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useSensors(useSensor(PointerSensor, {
    // 6px buffer stops accidental picks when the producer is just clicking to read.
    activationConstraint: { distance: 6 },
  }));

  // Shortlisted items (source A). Filter out entries whose source video
  // has been unticked in Tab 4 — they're stale but we don't hard-delete
  // the entry in case the producer re-ticks and wants their description
  // back. Also dedup against already-selected entries.
  const tickedVideoIds = new Set((project.videoReview?.ticked) || []);
  const extraLinkIds = new Set((project.videoReview?.extraLinks || []).map(u => `ext_${u.replace(/[^a-zA-Z0-9]/g, "").slice(-16)}`));
  const shortlistCards = Object.values(shortlisted)
    .filter(s => s && s.videoId && (tickedVideoIds.has(s.videoId) || extraLinkIds.has(s.videoId)))
    .map(s => {
      const lib = library[s.formatLibraryId] || null;
      const firstEx = lib?.examples?.[0] || null;
      return {
        dragId: `sl:${s.formatLibraryId}`,
        source: "project",
        formatLibraryId: s.formatLibraryId,
        name: s.formatName || lib?.name || "Unnamed",
        description: s.description || lib?.videoAnalysis || "",
        tags: s.tags || lib?.tags || [],
        // Prefer the shortlist record's own video (fresh this session) over
        // the library example (whose IG thumbnail URL may have expired).
        thumbnail: s.thumbnail || firstEx?.thumbnail || null,
        exampleUrl: s.videoUrl || firstEx?.url || null,
      };
    })
    .filter(c => !selected.some(s => s.formatLibraryId === c.formatLibraryId));

  // "Recently Added" cutoff — 14 days keeps the list meaningful without
  // flushing every format out after one sprint.
  const recentCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const suggestedIdSet = new Set(suggestedIds);

  // Library items (source B), filtered.
  const libraryCards = Object.values(library || {})
    .filter(f => f && f.id && !f.archived)
    .filter(f => {
      if (categoryMode === "all") return true;
      if (categoryMode === "suggested") return suggestedIdSet.has(f.id);
      if (categoryMode === "recent") return f.createdAt && new Date(f.createdAt).getTime() > recentCutoff;
      if (categoryMode === "over") return false;  // TODO — needs analytics signal
      return true;
    })
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
      tags: f.tags || [],
      thumbnail: f.examples?.[0]?.thumbnail || null,
      exampleUrl: f.examples?.[0]?.url || null,
      isSuggested: suggestedIdSet.has(f.id),
    }))
    // Suggested formats float to the top, then by usage, then name.
    .sort((a, b) => {
      if (a.isSuggested && !b.isSuggested) return -1;
      if (!a.isSuggested && b.isSuggested) return 1;
      return (b.usageCount || 0) - (a.usageCount || 0) || a.name.localeCompare(b.name);
    });

  const allTags = Array.from(new Set(
    Object.values(library || {}).flatMap(f => f?.archived ? [] : (f?.tags || []))
  )).sort();

  const writeSelected = (next) => {
    setSelected(next);
    onPatch({ selectedFormats: next });
  };

  // Per-format video counts. Each selected entry can carry an explicit
  // videoCount — producer sets how many videos of that format to shoot.
  // When unset, we auto-fill with an equal-split default so the generator
  // has a number to go on. Sum across entries should equal
  // numberOfVideos; we surface red/green indicator below.
  const totalTarget = numberOfVideos || 0;
  const totalAssigned = selected.reduce((sum, s) => sum + (s.videoCount || 0), 0);
  const countsBalanced = totalTarget > 0 && totalAssigned === totalTarget;

  // Setter for a single row's videoCount.
  const setFormatCount = (formatLibraryId, value) => {
    const n = Math.max(0, parseInt(value, 10) || 0);
    writeSelected(selected.map(s => s.formatLibraryId === formatLibraryId ? { ...s, videoCount: n } : s));
  };

  // Reset / equal-split action — distributes totalTarget across all
  // selected formats as evenly as possible, remainder added to the first
  // few entries. Used both for the initial auto-fill and the manual
  // "Reset to equal split" button.
  const applyEqualSplit = () => {
    if (selected.length === 0 || !totalTarget) return;
    const base = Math.floor(totalTarget / selected.length);
    const remainder = totalTarget % selected.length;
    writeSelected(selected.map((s, i) => ({ ...s, videoCount: base + (i < remainder ? 1 : 0) })));
  };

  // One-shot auto-fill: when ANY selected entry has no videoCount set,
  // initialise the whole set to equal split. Fires on first mount after
  // formats are selected (e.g. after AI suggest) and whenever a new
  // format is dragged in with no explicit count yet.
  useEffect(() => {
    if (!totalTarget || selected.length === 0) return;
    const hasUnset = selected.some(s => s.videoCount == null);
    if (!hasUnset) return;
    applyEqualSplit();
  }, [selected.length, totalTarget]);  // eslint-disable-line react-hooks/exhaustive-deps

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

  const approvals = project.approvals || {};
  const isApproved = !!approvals.select;
  const canAdvance = targetCount ? selected.length >= targetCount : selected.length > 0;

  const approve = () => {
    fbSet(`/preproduction/socialOrganic/${project.id}/approvals/select`, new Date().toISOString());
    onPatch({ tab: "script" });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      {/* AI suggest banner */}
      <div style={{ marginBottom: 14, padding: 14, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>
              AI-suggested formats
              {aiCount != null && <span style={{ marginLeft: 10, fontSize: 11, color: "var(--accent)", fontFamily: "'JetBrains Mono',monospace" }}>{aiCount} recommended</span>}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {project.suggestedFormatReason || "Claude ranks your library against the Brand Truth, shortlisted videos, and client takeaways."}
              {numberOfVideos && ` Deal has ${numberOfVideos} video${numberOfVideos === 1 ? "" : "s"} — ~${Math.max(1, Math.round(numberOfVideos / 5))} formats is a sensible anchor (3-6 videos each).`}
            </div>
          </div>
          <button onClick={runSuggest} disabled={suggesting}
            style={{ ...btnSecondary, opacity: suggesting ? 0.5 : 1 }}>
            {suggesting ? "Thinking…" : aiCount != null ? "Re-suggest" : "Suggest with AI"}
          </button>
        </div>
        {suggestError && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
            {suggestError}
          </div>
        )}
      </div>

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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
              {shortlistCards.map(c => (
                <DraggableFormatCard key={c.dragId} card={c} onClick={() => addFormat(c)} onOpenDetails={setDetailsId} />
              ))}
            </div>
          )}
        </Panel>

        {/* Global library */}
        <Panel title="Global library" count={libraryCards.length}>
          {/* Category-mode tabs — Suggested / Recently Added / Over Performers.
              Sits above the filter bar so producers reach for AI picks first. */}
          <div style={{ display: "flex", gap: 4, marginBottom: 10, padding: 3, background: "var(--bg)", borderRadius: 6 }}>
            <CatTab label="All" active={categoryMode === "all"} onClick={() => setCategoryMode("all")} />
            <CatTab label={`Suggested${suggestedIds.length ? ` (${suggestedIds.length})` : ""}`} active={categoryMode === "suggested"} onClick={() => setCategoryMode("suggested")} disabled={suggestedIds.length === 0} />
            <CatTab label="Recently Added" active={categoryMode === "recent"} onClick={() => setCategoryMode("recent")} />
            <CatTab label="Over Performers" active={categoryMode === "over"} onClick={() => setCategoryMode("over")} disabled title="Analytics signal pending — coming soon" />
          </div>
          <FormatFilterBar
            search={search} setSearch={setSearch}
            tagFilter={tagFilter} setTagFilter={setTagFilter}
            allTags={allTags}
          />
          {libraryCards.length === 0 ? (
            <EmptyPanel msg={categoryMode === "over" ? "Over Performers needs analytics data — coming later." : "No library formats match — clear filters or shortlist more videos."} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }}>
              {libraryCards.map(c => (
                <DraggableFormatCard key={c.dragId} card={c} onClick={() => addFormat(c)} onOpenDetails={setDetailsId} />
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
        totalTarget={totalTarget}
        totalAssigned={totalAssigned}
        countsBalanced={countsBalanced}
        setFormatCount={setFormatCount}
        applyEqualSplit={applyEqualSplit}
      />

      {/* Approval bar */}
      <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {selected.length}{targetCount != null ? ` / ${targetCount}` : ""} selected
          {canAdvance && !isApproved && " · ready to approve"}
        </div>
        {!isApproved ? (
          <button onClick={approve}
            disabled={!canAdvance}
            title={canAdvance ? "Approve and move to Scripting" : `Pick at least ${targetCount || 1} format${(targetCount || 1) === 1 ? "" : "s"}`}
            style={{ ...btnPrimary, opacity: canAdvance ? 1 : 0.5 }}>
            Approve → Scripting
          </button>
        ) : (
          <button onClick={() => onPatch({ tab: "script" })} style={btnPrimary}>
            → Scripting
          </button>
        )}
      </div>
      {detailsId && library[detailsId] && (
        <FormatDetailsModal format={library[detailsId]} onClose={() => setDetailsId(null)} />
      )}
    </DndContext>
  );
}

// Read-only drill-in modal for the "Details" button on library cards.
// Shows the full format record — all examples (with embeds) + the
// analysis / filming / structure blocks. Producers can audition more
// than just the first example without leaving the Select step.
function FormatDetailsModal({ format, onClose }) {
  const examples = Array.isArray(format.examples) ? format.examples : [];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--card)", borderRadius: 12, padding: 20, maxWidth: 900, width: "100%",
        maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>{format.name}</div>
            {(format.tags || []).length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {format.tags.map(t => (
                  <span key={t} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "var(--bg)", color: "var(--muted)" }}>#{t}</span>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {examples.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
              Examples ({examples.length})
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
              {examples.map((ex, i) => (
                <div key={i} style={{ background: "var(--bg)", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                  <ReelPreview url={ex.url} thumbnail={ex.thumbnail} aspectRatio="9 / 16" />
                  {ex.sourceAccount && (
                    <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--muted)", borderTop: "1px solid var(--border)" }}>
                      {ex.sourceAccount}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {[
          { label: "Video analysis",         key: "videoAnalysis" },
          { label: "Filming instructions",   key: "filmingInstructions" },
          { label: "Structure",              key: "structureInstructions" },
        ].map(s => format[s.key] && (
          <div key={s.key} style={{ marginBottom: 12, padding: 12, background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {format[s.key]}
            </div>
          </div>
        ))}

        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8 }}>
          {format.usageCount ? `Used ${format.usageCount}× in previous briefs.` : "Not yet used in any brief."}
          {format.sourceClient && ` Originally from ${format.sourceClient}.`}
        </div>
      </div>
    </div>
  );
}

function CatTab({ label, active, onClick, disabled, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title || ""}
      style={{
        flex: 1, padding: "5px 10px", borderRadius: 4, border: "none",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : disabled ? "var(--muted)" : "var(--fg)",
        fontSize: 11, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit", opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}>
      {label}
    </button>
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

// Richer card for the Global Library panel: portrait embed at the top so
// the producer can play the example inline, 1-sentence description below,
// small "Details" affordance to open the full Format Library record. The
// drag handle sits on the top-right so the card body stays clickable for
// the details link + the embed plays without kicking off a drag.
function DraggableFormatCard({ card, onClick, onOpenDetails }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.dragId });
  // First sentence of the description (or the whole thing if short) —
  // gives the producer a glanceable "what is this format" line without
  // making them click into details.
  const str = (card.description || "").trim();
  const firstSentence = str ? (str.match(/^[^.!?\n]*[.!?]?/)?.[0] || str).slice(0, 140) : "";
  return (
    <div ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 8, fontFamily: "inherit",
        userSelect: "none", display: "flex", flexDirection: "column", overflow: "hidden",
        position: "relative",
      }}
      onDoubleClick={onClick}
      title="Double-click or drag into the selected queue">
      {/* Drag handle — isolated so the card body doesn't swallow clicks */}
      <div {...listeners} {...attributes}
        style={{ position: "absolute", top: 4, right: 4, zIndex: 2, cursor: "grab",
          padding: "2px 6px", borderRadius: 4, background: "rgba(0,0,0,0.55)",
          color: "#fff", fontSize: 12, fontWeight: 700, lineHeight: 1, userSelect: "none" }}
        title="Drag to selected queue">⋮⋮</div>
      {/* Embed — plays inline so producers can audition formats from this grid */}
      <div style={{ background: "#000" }}>
        <ReelPreview url={card.exampleUrl} thumbnail={card.thumbnail} aspectRatio="9 / 16" />
      </div>
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
          {card.name}
        </div>
        {firstSentence && (
          <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {firstSentence}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: "auto" }}>
          <span style={{ fontSize: 9, color: "var(--muted)", fontWeight: 600 }}>
            {card.source === "project" ? "📁 project" : "📚 library"}{(card.tags && card.tags[0]) ? ` · #${card.tags[0]}` : ""}
          </span>
          {card.source === "library" && onOpenDetails && (
            <button onClick={(e) => { e.stopPropagation(); onOpenDetails(card.formatLibraryId); }}
              style={{ marginLeft: "auto", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border)",
                background: "transparent", color: "var(--accent)", fontSize: 9, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit" }}>
              Details ↗
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onClick?.(); }}
            style={{ padding: "2px 8px", borderRadius: 4, border: "none",
              background: "var(--accent)", color: "#fff", fontSize: 9, fontWeight: 700,
              cursor: "pointer", fontFamily: "inherit" }}>
            + Add
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectedDropzone({ selected, library, shortlisted, onRemove, targetCount, totalTarget, totalAssigned, countsBalanced, setFormatCount, applyEqualSplit }) {
  const { setNodeRef, isOver } = useDroppable({ id: "selected-dropzone" });
  return (
    <div ref={setNodeRef}
      style={{
        padding: 14, background: isOver ? "var(--accent-soft)" : "var(--card)",
        border: `2px dashed ${isOver ? "var(--accent)" : "var(--border)"}`, borderRadius: 10,
        minHeight: 140, transition: "background 0.15s, border 0.15s",
      }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span>Selected for this brief{targetCount != null ? ` — target ${targetCount}` : ""}</span>
        <span style={{ color: "var(--muted)", fontWeight: 500, fontFamily: "'JetBrains Mono',monospace" }}>{selected.length}</span>
      </div>

      {/* Video count allocator: how many of each format should be shot.
          Sum must match numberOfVideos from the deal. Red when off,
          green when balanced. "Reset to equal split" one-clicks back to
          the auto default. */}
      {totalTarget > 0 && selected.length > 0 && (
        <div style={{
          marginBottom: 12, padding: "8px 12px", borderRadius: 6,
          background: countsBalanced ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
          border: `1px solid ${countsBalanced ? "rgba(16,185,129,0.4)" : "rgba(239,68,68,0.4)"}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap",
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: countsBalanced ? "#10B981" : "#EF4444", fontFamily: "'JetBrains Mono',monospace" }}>
            {totalAssigned} / {totalTarget} videos allocated {countsBalanced ? "✓" : `(${totalAssigned - totalTarget > 0 ? "+" : ""}${totalAssigned - totalTarget})`}
          </div>
          <button onClick={applyEqualSplit}
            style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--card)", color: "var(--muted)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            Reset to equal split
          </button>
        </div>
      )}

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
              const exampleUrl = fmt?.examples?.[0]?.url || null;
              return (
                <SortableSelectedRow key={s.formatLibraryId}
                  id={`drop:${s.formatLibraryId}`}
                  index={i}
                  name={name}
                  source={s.source}
                  thumbnail={thumb}
                  exampleUrl={exampleUrl}
                  videoCount={s.videoCount}
                  onChangeCount={v => setFormatCount(s.formatLibraryId, v)}
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

function SortableSelectedRow({ id, index, name, source, thumbnail, exampleUrl, videoCount, onChangeCount, onRemove }) {
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
      <div style={{ width: 32, height: 32, borderRadius: 4, flexShrink: 0, overflow: "hidden" }}>
        <ReelPreview url={exampleUrl} thumbnail={thumbnail} aspectRatio="1 / 1" compact />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        <div style={{ fontSize: 10, color: "var(--muted)" }}>{source === "project" ? "📁 project" : "📚 library"}</div>
      </div>
      {/* Per-format video count — how many videos of this format to shoot.
          Click to edit. Sum must match project.numberOfVideos (indicator
          above the list shows red/green). onChangeCount missing means
          read-only (e.g. legacy usage elsewhere). */}
      {onChangeCount && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }} title="How many videos of this format to shoot">
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>×</span>
          <input type="number" min={0} max={99}
            value={videoCount ?? ""}
            onChange={e => onChangeCount(e.target.value)}
            onClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
            style={{ width: 40, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }} />
        </div>
      )}
      <button onClick={onRemove} title="Remove"
        style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: "2px 6px" }}>×</button>
    </div>
  );
}
