// Transcript Insights Lab — a continually-updated, weighted knowledge
// base of recurring Objections / Pain Points / Content Ideas mined from
// sales-call transcripts. Items are written ONLY server-side (extraction
// pass + self-heal cron); /transcriptInsights is `.write:false` at the
// RTDB rules layer. This component never calls fbSet — every founder
// mutation goes through authFetch("/api/transcript-insights") and the
// list refreshes via the live fbListenSafe subscription.
//
// Rendered in two places:
//   • Founders → Transcript Insights Lab  (full controls)
//   • Training → Transcript Insights Lab  (readOnly mirror for closers)

import { useState, useEffect, useMemo } from "react";
import { fbListenSafe, authFetch } from "../firebase";

const SEVERITY_MULTIPLIER = { low: 1, medium: 3, high: 6 };

const TYPE_META = {
  objection:   { label: "Objection",    color: "#F472B6", bg: "rgba(244,114,182,0.12)" },
  painPoint:   { label: "Pain Point",   color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
  contentIdea: { label: "Content Idea", color: "#10B981", bg: "rgba(16,185,129,0.12)" },
};

const SEV_META = {
  high:   { label: "High",   color: "#EF4444", bg: "rgba(239,68,68,0.14)" },
  medium: { label: "Medium", color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
  low:    { label: "Low",    color: "var(--muted)", bg: "transparent" },
};

function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const score = (it) => (it.weight || 0) * (SEVERITY_MULTIPLIER[it.severity] || 1);

export function TranscriptInsightsLab({ readOnly = false }) {
  const [items, setItems] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [mergeSel, setMergeSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => fbListenSafe("/transcriptInsights/items", d => {
    setItems(d && typeof d === "object" ? d : {});
    setLoaded(true);
  }), []);

  const all = useMemo(() => Object.entries(items)
    .map(([id, v]) => ({ id, ...(v || {}) }))
    .filter(it => it && it.type && it.title), [items]);

  const counts = useMemo(() => {
    const c = { objection: 0, painPoint: 0, contentIdea: 0 };
    all.forEach(it => { if (it.status !== "archived" && c[it.type] != null) c[it.type]++; });
    return c;
  }, [all]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter(it => (showArchived ? it.status === "archived" : it.status !== "archived"))
      .filter(it => typeFilter === "all" || it.type === typeFilter)
      .filter(it => !q ||
        (it.title || "").toLowerCase().includes(q) ||
        (it.description || "").toLowerCase().includes(q))
      .sort((a, b) => (score(b) - score(a)) ||
        String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  }, [all, typeFilter, query, showArchived]);

  const doOp = async (body) => {
    setBusy(true); setErr(null);
    try {
      const r = await authFetch("/api/transcript-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
      return true;
    } catch (e) {
      setErr(e.message || "Operation failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleMerge = (id) => setMergeSel(sel =>
    sel.includes(id) ? sel.filter(x => x !== id) : sel.length < 2 ? [...sel, id] : sel);

  const runMerge = async () => {
    if (mergeSel.length !== 2) return;
    const [a, b] = mergeSel.map(id => all.find(it => it.id === id)).filter(Boolean);
    if (!a || !b) return;
    // Survivor = higher score (weight × severity); the other is archived.
    const survivor = score(a) >= score(b) ? a : b;
    const loser = survivor === a ? b : a;
    if (!window.confirm(`Merge "${loser.title}" into "${survivor.title}"? The first is archived and its weight/sources fold into the second.`)) return;
    const ok = await doOp({ action: "merge", survivorId: survivor.id, loserId: loser.id });
    if (ok) setMergeSel([]);
  };

  // ─── styles ───
  const pill = (active) => ({
    padding: "5px 12px", borderRadius: 999, border: "1px solid var(--border)",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--muted)",
    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  });
  const inputSt = { padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, fontFamily: "inherit", outline: "none" };
  const ctrlBtn = { padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };

  const TYPE_PILLS = [
    { key: "all", label: `All (${counts.objection + counts.painPoint + counts.contentIdea})` },
    { key: "objection", label: `Objections (${counts.objection})` },
    { key: "painPoint", label: `Pain Points (${counts.painPoint})` },
    { key: "contentIdea", label: `Content Ideas (${counts.contentIdea})` },
  ];

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", margin: 0 }}>Transcript Insights Lab</h3>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
          Recurring objections, pain points and content ideas mined from every analysed sales call. Ranked by how often they come up, weighted by how deal-threatening they are.
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "14px 0" }}>
        {TYPE_PILLS.map(p => (
          <button key={p.key} onClick={() => setTypeFilter(p.key)} style={pill(typeFilter === p.key)}>{p.label}</button>
        ))}
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search…"
          style={{ ...inputSt, flex: "1 1 160px", minWidth: 140 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>
          <input type="checkbox" checked={showArchived} onChange={e => { setShowArchived(e.target.checked); setMergeSel([]); }} />
          Archived
        </label>
      </div>

      {err && (
        <div style={{ padding: "8px 12px", marginBottom: 12, borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444", fontSize: 12 }}>
          {err}
        </div>
      )}

      {!readOnly && mergeSel.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 12, borderRadius: 8, background: "var(--card)", border: "1px solid var(--accent)" }}>
          <span style={{ fontSize: 12, color: "var(--fg)" }}>
            {mergeSel.length === 1 ? "Select one more item to merge" : "Merge the two selected items (higher-ranked survives)"}
          </span>
          {mergeSel.length === 2 && (
            <button onClick={runMerge} disabled={busy} style={{ ...ctrlBtn, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", opacity: busy ? 0.5 : 1 }}>Merge</button>
          )}
          <button onClick={() => setMergeSel([])} style={ctrlBtn}>Cancel</button>
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {visible.map(it => {
          const tm = TYPE_META[it.type] || { label: it.type, color: "var(--muted)", bg: "transparent" };
          const sm = SEV_META[it.severity] || SEV_META.medium;
          const open = expandedId === it.id;
          const selected = mergeSel.includes(it.id);
          const sources = Array.isArray(it.sources) ? it.sources : [];
          return (
            <div key={it.id} style={{ background: "var(--card)", border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`, borderRadius: 10, overflow: "hidden", opacity: it.status === "archived" ? 0.6 : 1 }}>
              <div
                onClick={() => setExpandedId(open ? null : it.id)}
                style={{ padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 10 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: tm.bg, color: tm.color }}>{tm.label}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: sm.bg, color: sm.color }}>{sm.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", padding: "2px 7px", borderRadius: 4, background: "var(--bg)" }}>×{it.weight || 1}</span>
                    <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>{relTime(it.lastSeenAt)}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{it.title}</div>
                  {it.description && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{it.description}</div>}
                </div>
              </div>

              {open && (
                <div style={{ borderTop: "1px solid var(--border)", padding: "10px 14px", background: "var(--bg)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", marginBottom: 8 }}>
                    {sources.length} source{sources.length === 1 ? "" : "s"}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {sources.map((s, i) => (
                      <div key={i} style={{ fontSize: 12, color: "var(--fg)", borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
                        <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 2 }}>
                          {s.clientName || "Unknown"}{s.salesperson ? ` · ${s.salesperson}` : ""}{s.at ? ` · ${new Date(s.at).toLocaleDateString("en-AU")}` : ""}
                          {s.recordingUrl && <> · <a href={s.recordingUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>recording</a></>}
                        </div>
                        {s.quote && <div style={{ fontStyle: "italic" }}>“{s.quote}”</div>}
                      </div>
                    ))}
                    {sources.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>No sources recorded.</div>}
                  </div>

                  {!readOnly && (
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      {it.status === "archived" ? (
                        <button onClick={() => doOp({ action: "unarchive", id: it.id })} disabled={busy} style={ctrlBtn}>Unarchive</button>
                      ) : (
                        <>
                          <button onClick={() => doOp({ action: "archive", id: it.id })} disabled={busy} style={ctrlBtn}>Archive</button>
                          <button onClick={() => toggleMerge(it.id)} disabled={busy} style={{ ...ctrlBtn, ...(selected ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}>
                            {selected ? "Selected" : "Select to merge"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {loaded && visible.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            {showArchived
              ? "No archived insights."
              : all.length === 0
                ? "No insights yet — they appear automatically as sales calls are analysed."
                : "No insights match your filters."}
          </div>
        )}
      </div>
    </div>
  );
}
