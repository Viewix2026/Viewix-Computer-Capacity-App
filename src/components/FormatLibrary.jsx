// Format Library — global, cross-project library of social video formats.
// Producers drop entries in here during Phase 2 (Shortlist); this tab lets
// anyone browse, edit, archive, and (founders only) seed-import from a
// pasted tabular document or run prompt-template overrides for the Script
// Builder (Phase 5).
//
// Data at /formatLibrary/{id}, categories at /formatCategories/{key},
// prompt overrides at /preproductionTemplates/.
//
// Lives inside the Pre-Production tab as its own sub-tab. Meant to grow
// into Viewix's institutional knowledge of what filming styles work.

import { useEffect, useState } from "react";
import { onFB, fbSet, fbListen } from "../firebase";
import { ReelPreview } from "./shared/ReelPreview";

// Shared with other preproduction surfaces so the look-and-feel matches.
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

export function FormatLibrary({ role, isFounder }) {
  const [library, setLibrary] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);

  useEffect(() => {
    let u = () => {};
    onFB(() => {
      u = fbListen("/formatLibrary", d => setLibrary(d || {}));
    });
    return () => { u(); };
  }, []);

  // Defensive — entries should all have id + name; belt-and-braces because
  // seed imports and legacy records have been through a few schema tweaks.
  const list = Object.values(library || {}).filter(f => f && f.id);

  // Derive the tag cloud from all non-archived formats.
  const allTags = Array.from(new Set(
    list.flatMap(f => f.archived ? [] : (f.tags || []))
  )).sort();

  const filtered = list
    .filter(f => (showArchived ? true : !f.archived))
    .filter(f => tagFilter.length === 0 ? true : tagFilter.every(t => (f.tags || []).includes(t)))
    .filter(f => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (f.name || "").toLowerCase().includes(q)
        || (f.videoAnalysis || "").toLowerCase().includes(q)
        || (f.filmingInstructions || "").toLowerCase().includes(q)
        || (f.structureInstructions || "").toLowerCase().includes(q)
        || (f.tags || []).some(t => t.toLowerCase().includes(q));
    })
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0) || (a.name || "").localeCompare(b.name || ""));

  const active = activeId ? library[activeId] : null;

  if (active) {
    return (
      <FormatDetail
        format={active}
        onBack={() => setActiveId(null)}
        onSave={(patch) => {
          fbSet(`/formatLibrary/${active.id}`, { ...active, ...patch, updatedAt: new Date().toISOString() });
        }}
        onArchiveToggle={() => {
          fbSet(`/formatLibrary/${active.id}`, { ...active, archived: !active.archived, updatedAt: new Date().toISOString() });
        }}
        onDelete={isFounder ? () => {
          if (!window.confirm(`Delete "${active.name}" from the library permanently?`)) return;
          fbSet(`/formatLibrary/${active.id}`, null);
          setActiveId(null);
        } : null}
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Format Library</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            Cross-project library of social video formats. Producers add entries from the Shortlist step; anyone can browse and reuse them.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isFounder && (
            <button onClick={() => setPromptEditorOpen(true)} style={btnSecondary}>Edit Script prompts</button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <FormatFilterBar
        search={search} setSearch={setSearch}
        tagFilter={tagFilter} setTagFilter={setTagFilter}
        allTags={allTags}
        showArchived={showArchived} setShowArchived={setShowArchived}
      />

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📚</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {list.length === 0 ? "Empty library" : `No matches (${list.length} hidden by filters)`}
          </div>
          <div style={{ fontSize: 12, marginTop: 6 }}>
            {list.length === 0
              ? "Shortlist a video in any Social Media Organic project to add the first entry."
              : "Clear the search / tags / archive toggle to see everything."}
          </div>
          {list.length > 0 && (
            <button
              onClick={() => { setSearch(""); setTagFilter([]); setShowArchived(false); }}
              style={{ ...btnSecondary, marginTop: 14 }}>
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Count + filtered-by hint — surfaces the real list size so an
              empty-looking library is obvious when it's a filter issue. */}
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
            {filtered.length === list.length
              ? `${list.length} format${list.length === 1 ? "" : "s"}`
              : `Showing ${filtered.length} of ${list.length}`}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {filtered.map(f => (
              <FormatCard key={f.id} format={f} onClick={() => setActiveId(f.id)} />
            ))}
          </div>
        </>
      )}

      {promptEditorOpen && (
        <PromptEditor onClose={() => setPromptEditorOpen(false)} />
      )}
    </div>
  );
}

// Filter bar is exported so the Phase 4 Select UI can reuse it verbatim.
export function FormatFilterBar({ search, setSearch, tagFilter, setTagFilter, allTags, showArchived, setShowArchived }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
      <input type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search name, analysis, tags…"
        style={{ ...inputSt, width: 240, fontSize: 12, padding: "6px 10px" }} />
      {allTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {allTags.slice(0, 12).map(t => {
            const active = tagFilter.includes(t);
            return (
              <button key={t}
                onClick={() => setTagFilter(active ? tagFilter.filter(x => x !== t) : [...tagFilter, t])}
                style={{
                  padding: "3px 9px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                  border: "1px solid var(--border)",
                  background: active ? "var(--accent)" : "var(--bg)",
                  color: active ? "#fff" : "var(--muted)",
                  cursor: "pointer", fontFamily: "inherit",
                }}>{t}</button>
            );
          })}
        </div>
      )}
      {setShowArchived && (
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)", cursor: "pointer", marginLeft: "auto" }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          Show archived
        </label>
      )}
    </div>
  );
}

function FormatCard({ format, onClick }) {
  const examples = Array.isArray(format.examples) ? format.examples : [];
  const firstExample = examples.find(e => e.url || e.thumbnail) || null;
  const topTag = (format.tags || [])[0] || null;

  return (
    <button onClick={onClick} style={{
      textAlign: "left", background: "var(--card)", border: "1px solid var(--border)",
      borderRadius: 10, padding: 0, cursor: "pointer", fontFamily: "inherit",
      overflow: "hidden", opacity: format.archived ? 0.6 : 1, display: "flex", flexDirection: "column",
    }}>
      {/* Portrait 9:16 — Instagram reels are vertical, so a landscape 16:9
          window letterboxes the embed with huge black bars. Matches the
          ratio used on the video-review and shortlist surfaces. */}
      <div style={{ position: "relative" }}>
        {firstExample ? (
          <ReelPreview url={firstExample.url} thumbnail={firstExample.thumbnail} aspectRatio="9 / 16" />
        ) : (
          <div style={{ aspectRatio: "9 / 16", background: "#1E2A3A", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 32 }}>📼</div>
        )}
        {topTag && (
          <div style={{ position: "absolute", top: 6, left: 6, padding: "3px 8px", background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            #{topTag}
          </div>
        )}
        {format.archived && (
          <div style={{ position: "absolute", top: 6, right: 6, padding: "3px 8px", background: "rgba(90,107,133,0.85)", color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 3 }}>ARCHIVED</div>
        )}
        {examples.length > 0 && (
          <div style={{ position: "absolute", bottom: 6, right: 6, padding: "2px 8px", background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 3 }}>
            {examples.length} example{examples.length === 1 ? "" : "s"}
          </div>
        )}
        {(format.usageCount || 0) > 0 && (
          <div style={{ position: "absolute", bottom: 6, left: 6, padding: "2px 8px", background: "rgba(99,102,241,0.85)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 3 }}>
            used {format.usageCount}×
          </div>
        )}
      </div>
      <div style={{ padding: 12, flex: 1, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", lineHeight: 1.3 }}>{format.name}</div>
        <div style={{
          fontSize: 11, color: "var(--muted)", lineHeight: 1.4,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {format.videoAnalysis || ""}
        </div>
        {(format.tags || []).length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: "auto" }}>
            {(format.tags || []).slice(0, 3).map(t => (
              <span key={t} style={{ fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 3, background: "var(--bg)", color: "var(--muted)" }}>{t}</span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function FormatDetail({ format, onBack, onSave, onArchiveToggle, onDelete }) {
  const [name, setName] = useState(format.name || "");
  const [videoAnalysis, setVideoAnalysis] = useState(format.videoAnalysis || "");
  const [filming, setFilming] = useState(format.filmingInstructions || "");
  const [structure, setStructure] = useState(format.structureInstructions || "");
  const [tags, setTags] = useState(Array.isArray(format.tags) ? format.tags : []);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    setName(format.name || "");
    setVideoAnalysis(format.videoAnalysis || "");
    setFilming(format.filmingInstructions || "");
    setStructure(format.structureInstructions || "");
    setTags(Array.isArray(format.tags) ? format.tags : []);
  }, [format.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    name !== (format.name || "") ||
    videoAnalysis !== (format.videoAnalysis || "") ||
    filming !== (format.filmingInstructions || "") ||
    structure !== (format.structureInstructions || "") ||
    JSON.stringify(tags) !== JSON.stringify(Array.isArray(format.tags) ? format.tags : []);

  const save = () => {
    onSave({
      name: name.trim() || format.name,
      videoAnalysis, filmingInstructions: filming, structureInstructions: structure,
      tags,
    });
  };

  const examples = Array.isArray(format.examples) ? format.examples : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ ...btnSecondary, padding: "5px 10px" }}>&larr; Back</button>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>{format.name}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              {format.sourceClient && `Originally from ${format.sourceClient}`}
              {(format.usageCount || 0) > 0 && ` · Used ${format.usageCount}× in briefs`}
              {format.archived && " · Archived"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {dirty && <button onClick={save} style={btnPrimary}>Save</button>}
          <button onClick={onArchiveToggle} style={btnSecondary}>{format.archived ? "Unarchive" : "Archive"}</button>
          {onDelete && <button onClick={onDelete} style={{ ...btnSecondary, color: "#EF4444", borderColor: "rgba(239,68,68,0.3)" }}>Delete</button>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
          <FieldRow label="Name">
            <input value={name} onChange={e => setName(e.target.value)} style={inputSt} />
          </FieldRow>

          <FieldRow label="Tags">
            <div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                {tags.map(t => (
                  <span key={t} style={{ padding: "3px 9px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {t}
                    <button onClick={() => setTags(tags.filter(x => x !== t))} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                ))}
                {tags.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>No tags</span>}
              </div>
              <input type="text" value={tagInput} onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const t = tagInput.trim().replace(/^#/, ""); if (t && !tags.includes(t)) { setTags([...tags, t]); setTagInput(""); } } }}
                placeholder="Add tag + Enter"
                style={{ ...inputSt, fontSize: 11 }} />
            </div>
          </FieldRow>

          <FieldRow label="Video analysis" hint="The 'why it works' breakdown.">
            <textarea value={videoAnalysis} onChange={e => setVideoAnalysis(e.target.value)} rows={5}
              style={{ ...inputSt, resize: "vertical", fontFamily: "inherit" }} />
          </FieldRow>

          <FieldRow label="Filming instructions" hint="How the crew should shoot it.">
            <textarea value={filming} onChange={e => setFilming(e.target.value)} rows={3}
              style={{ ...inputSt, resize: "vertical", fontFamily: "inherit" }} />
          </FieldRow>

          <FieldRow label="Structure" hint="Hook → beats → close.">
            <textarea value={structure} onChange={e => setStructure(e.target.value)} rows={3}
              style={{ ...inputSt, resize: "vertical", fontFamily: "inherit" }} />
          </FieldRow>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>Examples ({examples.length})</div>
          {examples.length === 0 ? (
            <div style={{ padding: 16, background: "var(--bg)", border: "1px dashed var(--border)", borderRadius: 8, fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
              No examples yet. Shortlist a video in a project and pick "Add as example" to append one here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {examples.map((ex, i) => (
                <a key={i} href={ex.url} target="_blank" rel="noopener noreferrer"
                  style={{ display: "flex", gap: 10, padding: 8, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, textDecoration: "none" }}>
                  <div style={{ width: 56, height: 56, borderRadius: 4, flexShrink: 0, overflow: "hidden" }}>
                    <ReelPreview url={ex.url} thumbnail={ex.thumbnail} aspectRatio="1 / 1" compact />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>{ex.sourceAccount}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                      {ex.viewCount != null && `${formatBigLocal(ex.viewCount)} views`}
                      {ex.sourceClient && ` · ${ex.sourceClient}`}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</label>
        {hint && <span style={{ fontSize: 10, color: "var(--muted)", fontStyle: "italic" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function formatBigLocal(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}


// Founders-only editor for the Script Builder prompt + fantastic example.
// We store both under /preproductionTemplates/ so they survive deploys and
// the Phase-5 generator picks them up live without a redeploy.
function PromptEditor({ onClose }) {
  const [prompt, setPrompt] = useState("");
  const [example, setExample] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let u1 = () => {}, u2 = () => {};
    onFB(() => {
      u1 = fbListen("/preproductionTemplates/socialOrganicPrompt", d => setPrompt(typeof d === "string" ? d : ""));
      u2 = fbListen("/preproductionTemplates/fantasticExample", d => setExample(typeof d === "string" ? d : ""));
      setLoading(false);
    });
    return () => { u1(); u2(); };
  }, []);

  const save = () => {
    setSaving(true);
    fbSet("/preproductionTemplates/socialOrganicPrompt", prompt);
    fbSet("/preproductionTemplates/fantasticExample", example);
    setTimeout(() => { setSaving(false); onClose(); }, 200);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 22, maxWidth: 960, width: "92%", maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--border)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Script Builder prompts</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              Overrides the hardcoded default prompt in /api/social-organic.js. Takes effect on the next "Generate brief" without a redeploy.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading…</div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 5 }}>System prompt</label>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={12}
                style={{ ...inputSt, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, resize: "vertical" }}
                placeholder="Leave empty to use the hardcoded default in api/social-organic.js." />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 5 }}>Fantastic example (few-shot)</label>
              <textarea value={example} onChange={e => setExample(e.target.value)} rows={10}
                style={{ ...inputSt, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, resize: "vertical" }}
                placeholder="Paste a known-great past preproduction doc here; it is included as a few-shot example." />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
