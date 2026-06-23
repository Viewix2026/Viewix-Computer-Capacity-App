// ════════════════════════════════════════════════════════════════════
// Editors · Motion Graphics — interactive subtab.
// Describe a motion graphic in plain language → Claude (Opus 4.7) returns a
// branded, correctly-sized animated HTML fragment, wrapped server-side in a
// locked-down shell and rendered here in a SANDBOXED iframe. Refine it, present
// it full-bleed on a chroma background to screen-record, and save the keepers
// to a shared library.
//
// Security: the generated HTML is untrusted and ONLY ever renders inside
// <iframe sandbox="allow-scripts"> (no allow-same-origin) carrying a strict CSP
// the server injects. "Pop out" opens a trusted shell that re-embeds the same
// sandboxed iframe — never raw HTML as a top-level document.
//
// Pairs with api/motion-graphics.js (generate / save / archive) and the
// /motionGraphicsLibrary + /aiUsage RTDB nodes.
// ════════════════════════════════════════════════════════════════════
import { useState, useRef, useEffect, useCallback } from "react";
import { Icon } from "./Icon";
import { ViewixLoader } from "./shared/ViewixLoader";
import { authFetch, fbListenSafe, fbGet, getCurrentUserEmail } from "../firebase";

// Tokens mirror the Text Generator subtab / config.js brand hues.
const VX = {
  bg: "#0A0E17", rail: "#0D1220", card: "#141A29", card2: "#19202F", inset: "#0E131F",
  border: "#222D40", borderSoft: "#1A2231", line2: "#283449",
  fg: "#EAEEF6", fg2: "#9DABC2", muted: "#61728C", faint: "#3D4B62",
  accent: "#0082FA", accentBright: "#3DA2FF", accentSoft: "rgba(0,130,250,0.13)",
  amber: "#F5A623", success: "#1EC081", danger: "#F2545B",
  r1: 6, r2: 8, r3: 10, r4: 14, r5: 18,
  sans: "'DM Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  shadow1: "0 1px 2px rgba(0,0,0,0.4)",
};

const DIMENSIONS = [
  { key: "1080x1920", label: "Portrait", sub: "1080×1920", w: 1080, h: 1920 },
  { key: "1920x1080", label: "Landscape", sub: "1920×1080", w: 1920, h: 1080 },
  { key: "1080x1080", label: "Square", sub: "1080×1080", w: 1080, h: 1080 },
];

const CHROMA = [
  { key: "checker", label: "Transparent" },
  { key: "#00B140", label: "Green" },
  { key: "#FF00FF", label: "Magenta" },
  { key: "#000000", label: "Black" },
  { key: "#FFFFFF", label: "White" },
];
const CHECKER = `repeating-conic-gradient(#2a3242 0% 25%, #222a38 0% 50%) 50% / 22px 22px`;

// Non-JSON-safe parse (SocialOrganicResearch pattern) — gateway 502/504 returns HTML.
async function readJsonResponse(r) {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(r.ok ? `Non-JSON response: ${preview}` : `HTTP ${r.status} — ${preview || "request failed"}`);
  }
}

// ── small control primitives ───────────────────────────────────────
function MGGroup({ n, label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 19, height: 19, borderRadius: 6, background: VX.accentSoft, color: VX.accentBright, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: VX.mono, fontSize: 10.5, fontWeight: 700 }}>{n}</span>
        <span style={{ fontFamily: VX.sans, fontSize: 11.5, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", color: VX.fg2 }}>{label}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>{children}</div>
    </div>
  );
}
function MGSeg({ options, value, onChange, render }) {
  return (
    <div style={{ display: "inline-flex", gap: 3, background: VX.inset, borderRadius: VX.r2, padding: 3, border: "1px solid " + VX.borderSoft }}>
      {options.map(o => {
        const on = o.key === value;
        return (
          <button key={o.key} onClick={() => onChange(o.key)} style={{ flex: 1, padding: "7px 6px", borderRadius: VX.r1, border: "none", cursor: "pointer", fontFamily: VX.sans, fontSize: 12, fontWeight: 700,
            background: on ? VX.card2 : "transparent", color: on ? VX.fg : VX.muted, boxShadow: on ? VX.shadow1 : "none", lineHeight: 1.25 }}>{render ? render(o) : o.label}</button>
        );
      })}
    </div>
  );
}
function MGSlider({ label, value, min, max, unit, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 600, color: VX.fg2 }}>{label}</span>
        <span style={{ fontFamily: VX.mono, fontSize: 11.5, fontWeight: 700, color: VX.accentBright }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)} style={{ width: "100%", accentColor: VX.accent, height: 4, cursor: "pointer" }} />
    </div>
  );
}

export function MotionGraphicsGenerator() {
  const [prompt, setPrompt] = useState("Animated lower third: the client name slides in from the left in Viewix blue, with a thin underline that draws across.");
  const [dimension, setDimension] = useState("1080x1920");
  const [duration, setDuration] = useState(5);
  const [chroma, setChroma] = useState("checker");

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { id, html, fragment, dimension, cost, fromLibrary }
  const [refine, setRefine] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [present, setPresent] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [savedId, setSavedId] = useState("");

  const [library, setLibrary] = useState({});
  const [libLoaded, setLibLoaded] = useState(false);

  const abortRef = useRef(null);
  const stageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  // Subscribe to the shared library (metadata only — cheap).
  useEffect(() => {
    const off = fbListenSafe("/motionGraphicsLibrary/meta", d => { setLibLoaded(true); setLibrary(d || {}); });
    return off;
  }, []);

  // Measure the preview stage so we can scale the graphic to fit.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setStageSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dim = DIMENSIONS.find(d => d.key === (result?.dimension || dimension)) || DIMENSIONS[0];
  const fitScale = stageSize.w && stageSize.h ? Math.min((stageSize.w - 48) / dim.w, (stageSize.h - 48) / dim.h, 1) : 0.25;

  const callGenerate = useCallback(async (isRefine) => {
    if (abortRef.current) return;            // synchronous re-entry guard (state is stale in this closure)
    const controller = new AbortController();
    abortRef.current = controller;           // claim the slot before any await
    setError(""); setSavedId(""); setGenerating(true);
    const timer = setTimeout(() => controller.abort(), 115_000);
    try {
      const payload = isRefine
        ? { action: "generate", prompt, dimension: result?.dimension || dimension, durationSec: duration, refineInstruction: refine.trim(), previousFragment: result?.fragment || result?.html }
        : { action: "generate", prompt: prompt.trim(), dimension, durationSec: duration };
      const r = await authFetch("/api/motion-graphics", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal,
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult({ id: d.id, html: d.html, fragment: d.fragment, dimension: d.dimension, cost: d.cost, fromLibrary: false });
      setRefine("");
      setPreviewKey(k => k + 1);
    } catch (e) {
      if (e.name === "AbortError") setError("Generation cancelled or timed out.");
      else setError(e.message || "Generation failed");
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      setGenerating(false);
    }
  }, [prompt, dimension, duration, refine, result]);

  // Abort any in-flight generation if the tab unmounts.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
  }

  async function saveToLibrary() {
    if (!result?.id || result.fromLibrary) return;
    setError("");
    try {
      const r = await authFetch("/api/motion-graphics", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", generationId: result.id, fragment: result.fragment, html: result.html }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSavedId(d.id);
    } catch (e) { setError(e.message || "Save failed"); }
  }

  async function loadFromLibrary(meta) {
    setError("");
    try {
      const html = await fbGet(`/motionGraphicsLibrary/html/${meta.id}`);
      if (!html) { setError("This graphic's content is missing — archive it."); return; }
      setResult({ id: null, html, fragment: html, dimension: meta.dimension, cost: meta.costUsd, fromLibrary: true });
      setPreviewKey(k => k + 1);
    } catch (e) { setError(e.message || "Could not load graphic"); }
  }

  async function archive(id) {
    setError("");
    try {
      const r = await authFetch("/api/motion-graphics", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive", id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // success — the /meta listener removes it from the grid.
    } catch (e) { setError(e.message || "Archive failed"); }
  }

  // Pop out: a trusted same-origin window that re-embeds the SANDBOXED iframe —
  // never the raw HTML as a top-level document (that would escape the sandbox).
  function popOut() {
    if (!result?.html) return;
    const bg = chroma === "checker" ? "#10151f" : chroma;
    const w = window.open("", "_blank");
    if (!w) { setError("Pop-out was blocked — allow popups for a clean capture window."); return; }
    w.document.title = "Motion graphic — recording view";
    const body = w.document.body;
    body.style.margin = "0";
    body.style.height = "100vh";
    body.style.background = bg;
    body.style.display = "grid";
    body.style.placeItems = "center";
    const f = w.document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.style.border = "0";
    f.style.width = dim.w + "px";
    f.style.height = dim.h + "px";
    f.style.maxWidth = "100vw";
    f.style.maxHeight = "100vh";
    f.srcdoc = result.html;
    body.appendChild(f);
  }

  const items = Object.values(library || {}).filter(g => g && g.id && !g.archived)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const stageBg = chroma === "checker" ? CHECKER : chroma;
  const empty = !result;

  return (
    <div style={{ height: "calc(100vh - 104px)", overflow: "hidden", background: VX.bg, color: VX.fg, fontFamily: VX.sans, display: "flex" }}>
      {/* ── LEFT: controls ── */}
      <div style={{ width: 348, flex: "0 0 auto", borderRight: "1px solid " + VX.border, background: VX.rail, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid " + VX.borderSoft }}>
          <div style={{ fontFamily: VX.sans, fontSize: 16, fontWeight: 800, color: VX.fg, letterSpacing: "-0.01em" }}>Motion Graphics</div>
          <div style={{ fontFamily: VX.sans, fontSize: 11.5, color: VX.muted, marginTop: 3 }}>Describe it, generate an animation, screen-record it.</div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 24 }}>
          <MGGroup n="1" label="Describe">
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5} maxLength={2000} placeholder="e.g. animated lower third, client name slides in from the left, Viewix blue, thin underline draws across"
              style={{ width: "100%", resize: "vertical", fontFamily: VX.sans, fontSize: 13.5, fontWeight: 500, color: VX.fg, background: VX.inset, border: "1px solid " + VX.border, borderRadius: VX.r3, padding: "11px 13px", lineHeight: 1.5, outline: "none", boxSizing: "border-box" }} />
          </MGGroup>

          <MGGroup n="2" label="Format">
            <MGSeg options={DIMENSIONS} value={dimension} onChange={setDimension} render={o => (
              <span style={{ display: "flex", flexDirection: "column", gap: 1 }}><span>{o.label}</span><span style={{ fontFamily: VX.mono, fontSize: 9.5, color: VX.muted }}>{o.sub}</span></span>
            )} />
            <MGSlider label="Loop length" value={duration} min={2} max={20} unit="s" onChange={setDuration} />
          </MGGroup>

          <MGGroup n="3" label="Background (for keying)">
            <MGSeg options={CHROMA} value={chroma} onChange={setChroma} />
            <div style={{ fontFamily: VX.sans, fontSize: 11, color: VX.muted, lineHeight: 1.5 }}>The graphic is transparent. Pick a chroma colour to key out in your edit, or keep it transparent for reference.</div>
          </MGGroup>
        </div>

        <div style={{ padding: "14px 22px", borderTop: "1px solid " + VX.borderSoft, display: "flex", flexDirection: "column", gap: 9 }}>
          {generating ? (
            <button onClick={cancel} style={{ width: "100%", padding: "11px 0", borderRadius: VX.r2, border: "1px solid " + VX.border, background: VX.card, color: VX.fg2, fontFamily: VX.sans, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          ) : (
            <button onClick={() => callGenerate(false)} disabled={!prompt.trim()} style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px 0", borderRadius: VX.r2, border: "none",
              cursor: prompt.trim() ? "pointer" : "not-allowed", fontFamily: VX.sans, fontSize: 13.5, fontWeight: 700,
              background: prompt.trim() ? VX.accent : "#1b2436", color: prompt.trim() ? "#fff" : VX.faint, boxShadow: prompt.trim() ? "0 6px 18px -8px rgba(0,130,250,0.9)" : "none" }}>
              <Icon name="spark" size={16} sw={2} />Generate
            </button>
          )}
        </div>
      </div>

      {/* ── RIGHT: preview + library ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* toolbar */}
        <div style={{ height: 56, flex: "0 0 auto", borderBottom: "1px solid " + VX.border, display: "flex", alignItems: "center", gap: 12, padding: "0 22px" }}>
          <span style={{ fontFamily: VX.sans, fontSize: 13, fontWeight: 700, color: VX.fg2 }}>Preview</span>
          {result && <span style={{ fontFamily: VX.mono, fontSize: 11, color: VX.muted }}>{dim.sub}{!result.fromLibrary && result.cost != null ? ` · $${Number(result.cost).toFixed(4)}` : ""}</span>}
          <div style={{ flex: 1 }} />
          {error && <span style={{ fontFamily: VX.sans, fontSize: 11.5, fontWeight: 600, color: VX.danger, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{error}</span>}
          {result && <>
            <ToolbarBtn icon="play" label="Replay" onClick={() => setPreviewKey(k => k + 1)} />
            <ToolbarBtn icon="external" label="Present" onClick={() => setPresent(true)} />
            <ToolbarBtn icon="filter" label="Source" onClick={() => setShowSource(true)} />
            {!result.fromLibrary && (
              <button onClick={saveToLibrary} disabled={!!savedId} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: VX.r2, border: "none", cursor: savedId ? "default" : "pointer", background: savedId ? "rgba(30,192,129,0.16)" : VX.accent, color: savedId ? VX.success : "#fff" }}>
                <Icon name={savedId ? "check" : "plus"} size={15} sw={2.2} />{savedId ? "Saved" : "Save"}
              </button>
            )}
          </>}
        </div>

        {/* preview stage */}
        <div ref={stageRef} style={{ flex: 1, minHeight: 0, position: "relative", background: stageBg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {generating && !result && (
            <ViewixLoader size={56} caption="Generating animation…" captionStyle={{ color: VX.fg2, fontSize: 13, fontWeight: 600 }} />
          )}
          {empty && !generating && (
            <div style={{ textAlign: "center", color: VX.muted }}>
              <div style={{ width: 54, height: 54, borderRadius: 14, background: "rgba(255,255,255,0.04)", border: "1px dashed " + VX.line2, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <Icon name="play" size={24} sw={1.6} stroke={VX.muted} /></div>
              <div style={{ fontFamily: VX.sans, fontSize: 14, fontWeight: 700, color: VX.fg2 }}>Describe a motion graphic and hit Generate</div>
              <div style={{ fontFamily: VX.sans, fontSize: 12, color: VX.muted, marginTop: 4 }}>It renders here, looping, ready to screen-record.</div>
            </div>
          )}
          {result && (
            <div style={{ position: "relative", width: dim.w * fitScale, height: dim.h * fitScale }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: dim.w, height: dim.h, transform: `scale(${fitScale})`, transformOrigin: "top left", boxShadow: "0 12px 40px -16px rgba(0,0,0,0.7)" }}>
                <iframe key={previewKey} title="Motion graphic preview" sandbox="allow-scripts" srcDoc={result.html} style={{ width: dim.w, height: dim.h, border: 0, display: "block" }} />
              </div>
            </div>
          )}
        </div>

        {/* refine bar */}
        {result && !result.fromLibrary && (
          <div style={{ flex: "0 0 auto", borderTop: "1px solid " + VX.border, padding: "12px 22px", display: "flex", alignItems: "center", gap: 10, background: VX.rail }}>
            <Icon name="spark" size={15} sw={2} stroke={VX.accentBright} />
            <input value={refine} onChange={e => setRefine(e.target.value)} maxLength={1000} placeholder="Refine it — e.g. make the text bigger, slow it down, add the orange accent"
              onKeyDown={e => { if (e.key === "Enter" && refine.trim() && !generating) callGenerate(true); }}
              style={{ flex: 1, fontFamily: VX.sans, fontSize: 13, color: VX.fg, background: VX.inset, border: "1px solid " + VX.border, borderRadius: VX.r2, padding: "9px 12px", outline: "none" }} />
            <button onClick={() => callGenerate(true)} disabled={!refine.trim() || generating} style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700, padding: "9px 16px", borderRadius: VX.r2, border: "none", cursor: refine.trim() && !generating ? "pointer" : "not-allowed", background: refine.trim() && !generating ? VX.card2 : VX.card, color: refine.trim() && !generating ? VX.fg : VX.faint }}>Refine</button>
          </div>
        )}

        {/* library */}
        <div style={{ flex: "0 0 auto", maxHeight: 188, borderTop: "1px solid " + VX.border, background: VX.bg, overflow: "auto", padding: "12px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: VX.sans, fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: VX.fg2 }}>Library</span>
            <span style={{ fontFamily: VX.mono, fontSize: 11, color: VX.muted }}>{items.length}</span>
          </div>
          {!libLoaded ? (
            <div style={{ fontFamily: VX.sans, fontSize: 12, color: VX.muted }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ fontFamily: VX.sans, fontSize: 12, color: VX.muted }}>Saved graphics show up here. Generate one and hit Save.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 10 }}>
              {items.map(it => {
                const d = DIMENSIONS.find(x => x.key === it.dimension) || DIMENSIONS[0];
                return (
                  <div key={it.id} onClick={() => loadFromLibrary(it)} style={{ cursor: "pointer", background: VX.card, border: "1px solid " + VX.border, borderRadius: VX.r3, padding: "10px 12px", position: "relative" }}>
                    <div style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700, color: VX.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
                    <div style={{ fontFamily: VX.mono, fontSize: 10, color: VX.muted, marginTop: 4 }}>{d.label} · {it.createdBy?.name || it.createdBy?.email || "—"}</div>
                    <button onClick={e => { e.stopPropagation(); archive(it.id); }} title="Archive" style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 6, border: "none", background: "transparent", color: VX.muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon name="check" size={13} sw={2} stroke={VX.faint} style={{ display: "none" }} />×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* present overlay */}
      {present && result && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: stageBg === CHECKER ? "#0b0f17" : stageBg, display: "flex", flexDirection: "column" }}>
          <div style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 8, zIndex: 2 }}>
            <button onClick={popOut} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: VX.r2, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.4)", color: "#fff", cursor: "pointer", backdropFilter: "blur(6px)" }}><Icon name="external" size={15} sw={2} stroke="#fff" />Pop out</button>
            <button onClick={() => setPresent(false)} style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: VX.r2, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.4)", color: "#fff", cursor: "pointer", backdropFilter: "blur(6px)" }}>Close ✕</button>
          </div>
          <PresentStage dim={dim} html={result.html} previewKey={previewKey} />
          <div style={{ position: "absolute", bottom: 14, left: 0, right: 0, textAlign: "center", fontFamily: VX.sans, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
            Screen-record this region. Native {dim.sub} capture needs a display at least that tall — otherwise record at this scale and upscale in your edit.
          </div>
        </div>
      )}

      {/* view source */}
      {showSource && result && (
        <div onClick={() => setShowSource(false)} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(900px, 92vw)", maxHeight: "82vh", background: VX.card, border: "1px solid " + VX.border, borderRadius: VX.r4, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid " + VX.border }}>
              <span style={{ fontFamily: VX.sans, fontSize: 13, fontWeight: 700, color: VX.fg }}>Source</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => { navigator.clipboard?.writeText(result.html); }} style={{ fontFamily: VX.sans, fontSize: 12, fontWeight: 700, padding: "7px 13px", borderRadius: VX.r2, border: "1px solid " + VX.border, background: VX.card2, color: VX.fg, cursor: "pointer", marginRight: 8 }}>Copy</button>
              <button onClick={() => setShowSource(false)} style={{ fontFamily: VX.sans, fontSize: 12, fontWeight: 700, padding: "7px 13px", borderRadius: VX.r2, border: "none", background: "transparent", color: VX.muted, cursor: "pointer" }}>Close</button>
            </div>
            <pre style={{ margin: 0, padding: 16, overflow: "auto", fontFamily: VX.mono, fontSize: 11.5, lineHeight: 1.5, color: VX.fg2, background: VX.inset }}>{result.html}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({ icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700, padding: "8px 12px", borderRadius: VX.r2, border: "1px solid " + VX.border, background: VX.card, color: VX.fg2, cursor: "pointer" }}>
      <Icon name={icon} size={14} sw={1.9} />{label}
    </button>
  );
}

// Present stage: same sandboxed+CSP iframe, scaled to fit the fullscreen overlay.
function PresentStage({ dim, html, previewKey }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(e => { const r = e[0].contentRect; setSize({ w: r.width, h: r.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size.w && size.h ? Math.min((size.w - 80) / dim.w, (size.h - 80) / dim.h, 1) : 0.3;
  return (
    <div ref={ref} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
      <div style={{ position: "relative", width: dim.w * scale, height: dim.h * scale }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: dim.w, height: dim.h, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <iframe key={previewKey} title="Motion graphic present" sandbox="allow-scripts" srcDoc={html} style={{ width: dim.w, height: dim.h, border: 0, display: "block" }} />
        </div>
      </div>
    </div>
  );
}
