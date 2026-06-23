// ════════════════════════════════════════════════════════════════════
// Editors · Motion Graphics — interactive subtab.
// Describe a graphic → Claude (Opus 4.7) returns a branded animated HTML
// fragment, wrapped server-side in a locked-down shell and rendered here in a
// SANDBOXED iframe. Start from a preset, refine in plain language, present
// full-bleed to screen-record, and save to a shared, client-organised library
// whose thumbnails loop live.
//
// Visuals ported from the Claude-design source (ds/tab-motion-graphics.jsx);
// the security model is the dashboard's, not the design's: the generated HTML
// is untrusted and ONLY ever renders inside <iframe sandbox="allow-scripts">
// (no allow-same-origin) carrying the strict CSP the server injects. Pairs with
// api/motion-graphics.js (generate / save / archive / assign).
// ════════════════════════════════════════════════════════════════════
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { Icon } from "./Icon";
import { ViewixLoader } from "./shared/ViewixLoader";
import { authFetch, fbListenSafe, fbGet, getCurrentUserEmail } from "../firebase";

const VX = {
  bg: "#0A0E17", rail: "#0D1220", card: "#141A29", card2: "#19202F", inset: "#0E131F",
  border: "#222D40", borderSoft: "#1A2231", line2: "#283449",
  fg: "#EAEEF6", fg2: "#9DABC2", muted: "#61728C", faint: "#3D4B62",
  accent: "#0082FA", accentBright: "#3DA2FF", accentSoft: "rgba(0,130,250,0.13)",
  amber: "#F5A623", orange: "#F87700", success: "#1EC081", danger: "#F2545B",
  r1: 6, r2: 8, r3: 10, r4: 14, r5: 18,
  sans: "'DM Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  shadow1: "0 1px 2px rgba(0,0,0,0.4)",
  shadow3: "0 30px 80px -30px rgba(0,0,0,0.9)",
};

const MG_FORMATS = {
  Portrait:  { w: 1080, h: 1920, dim: "1080x1920", sub: "1080 × 1920" },
  Landscape: { w: 1920, h: 1080, dim: "1920x1080", sub: "1920 × 1080" },
  Square:    { w: 1080, h: 1080, dim: "1080x1080", sub: "1080 × 1080" },
};
const DIM_TO_FMT = { "1080x1920": "Portrait", "1920x1080": "Landscape", "1080x1080": "Square" };
const fmtFromDim = d => DIM_TO_FMT[d] || "Landscape";

const MG_CHROMA = [
  { key: "Transparent", fill: null },
  { key: "Green", fill: "#00B140" },
  { key: "Magenta", fill: "#FF00FF" },
  { key: "Black", fill: "#000000" },
  { key: "White", fill: "#FFFFFF" },
];
const MG_CHECKER = `repeating-conic-gradient(#2a3242 0% 25%, #222a38 0% 50%) 50% / 22px 22px`;

// Preset starting points — popular social formats + custom graphics. Each fills
// the prompt and a sensible format; one click to a starting point you refine.
const PRESETS = [
  { key: "stier", label: "S-tier ranking", icon: "founders", fmt: "Portrait", prompt: "An S tier ranking board: rows labelled S, A, B, C stacked top to bottom, each a coloured band (S gold, A green, B Viewix blue, C grey), with placeholder item chips sliding into the S and A rows one at a time. Bold DM Sans labels, clean tier-list style. Loops seamlessly." },
  { key: "thisorthat", label: "This or That", icon: "socials", fmt: "Portrait", prompt: "A 'this or that' split screen: two option panels side by side divided by a bold VS badge in the centre, each panel with a placeholder label, one side pulses and highlights in Viewix blue as the pick. Energetic and modern, transparent background. Loops seamlessly." },
  { key: "roadmap", label: "Roadmap", icon: "link2", fmt: "Portrait", prompt: "A roadmap journey like a treasure map: a winding dotted trail connects 4 to 5 numbered milestone markers down the frame, a glowing pin travels along the trail step by step, and each milestone's label pops in as the pin reaches it. Viewix blue trail with orange milestone pins, a clean modern take on a treasure map, placeholder step labels that are easy to swap. Transparent background, loops seamlessly." },
  { key: "stat", label: "Stat pop", icon: "analytics", fmt: "Square", prompt: "A bold stat reveal: a large number counts up from 0 to 320 percent in JetBrains Mono, a label beneath in DM Sans, an orange underline wipes in as it lands with a subtle glow, transparent background. Plays once then holds." },
  { key: "particle", label: "Particle V", icon: "spark", fmt: "Square", prompt: "A glowing particle network in Viewix blue: around 80 dots drifting on a transparent background with thin connecting lines, slowly converging to trace a bold letter V, holding a beat, then dispersing. A few orange accent sparks and a soft glow. Loops over about 6 seconds." },
  { key: "eq", label: "Equalizer", icon: "capacity", fmt: "Landscape", prompt: "An audio equalizer: a row of about 24 vertical bars bouncing to a smooth rhythm, each a vertical gradient from Viewix blue to bright blue with the tallest peaks tipping orange, rounded tops and a soft reflection beneath, transparent background. Seamless loop." },
  { key: "lower", label: "Lower third", icon: "editors", fmt: "Landscape", prompt: "Animated lower third: a presenter name and role slide in from the left in Viewix blue, with a thin orange underline that wipes across. Clean broadcast style, transparent background. Loops seamlessly." },
  { key: "outro", label: "Reel outro", icon: "play", fmt: "Portrait", prompt: "A reel outro end card: a bold 'Follow for more' call to action with a handle placeholder, a Viewix blue button that gently pulses, and a subtle particle drift behind. Clean and punchy, transparent background. Loops seamlessly." },
];

// derive client display names from the real /clients records (array of objects)
function clientNamesFrom(clients) {
  const arr = Array.isArray(clients) ? clients : Object.values(clients || {});
  const names = arr.map(c => String(typeof c === "string" ? c : (c?.name || c?.clientName || c?.company || "")).trim()).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
function hueFor(name = "") { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
const shortClient = n => (n && n.length > 12 ? n.split(/\s+/)[0] : n);
function ClientDot({ name, size = 8 }) {
  return <span style={{ width: size, height: size, borderRadius: "50%", flex: "0 0 auto",
    background: name ? `oklch(0.72 0.15 ${hueFor(name)})` : "transparent",
    border: name ? "none" : "1.5px solid " + VX.muted }} />;
}

async function readJsonResponse(r) {
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; }
  catch {
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(r.ok ? `Non-JSON response: ${preview}` : `HTTP ${r.status} — ${preview || "request failed"}`);
  }
}

// ── control primitives (mirror the Text Generator set) ──────────────
function MGGroup({ n, label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 19, height: 19, borderRadius: 6, background: VX.accentSoft, color: VX.accentBright, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: VX.mono, fontSize: 10.5, fontWeight: 700, flex: "0 0 auto" }}>{n}</span>
        <span style={{ fontFamily: VX.sans, fontSize: 11.5, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", color: VX.fg2 }}>{label}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingLeft: 1 }}>{children}</div>
    </div>
  );
}
function MGSlider({ label, value, min, max, unit = "s", onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 600, color: VX.fg2 }}>{label}</span>
        <span style={{ fontFamily: VX.mono, fontSize: 11.5, fontWeight: 700, color: VX.accentBright }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: VX.accent, height: 4, cursor: "pointer" }} />
    </div>
  );
}
function MGSegment({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", gap: 3, background: VX.inset, borderRadius: VX.r2, padding: 3, border: "1px solid " + VX.borderSoft }}>
      {options.map(o => (
        <button key={o} onClick={() => onChange(o)} style={{ flex: 1, padding: "8px 0", borderRadius: VX.r1, border: "none", cursor: "pointer", fontFamily: VX.sans, fontSize: 12, fontWeight: 700,
          background: o === value ? VX.card2 : "transparent", color: o === value ? VX.fg : VX.muted, boxShadow: o === value ? VX.shadow1 : "none" }}>{o}</button>
      ))}
    </div>
  );
}
function MGChroma({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
      {MG_CHROMA.map(c => {
        const on = c.key === value;
        return (
          <button key={c.key} onClick={() => onChange(c.key)} title={c.key} style={{ width: 40, height: 40, borderRadius: 10, cursor: "pointer", padding: 0,
            background: c.fill || MG_CHECKER, backgroundSize: c.fill ? undefined : "10px 10px",
            border: "2px solid " + (on ? VX.accentBright : VX.border), boxShadow: on ? "0 0 0 3px " + VX.accentSoft : "none", position: "relative" }}>
            {on && <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="check" size={16} sw={3} stroke={c.fill === "#FFFFFF" || c.fill === "#00B140" ? "#000" : "#fff"} /></span>}
          </button>
        );
      })}
    </div>
  );
}
// framed, scaled, SANDBOXED animation viewport
function MGFrame({ fmt, chroma, docKey, html, maxW, maxH }) {
  const f = MG_FORMATS[fmt];
  const scale = Math.min(maxW / f.w, maxH / f.h);
  const chromaFill = MG_CHROMA.find(c => c.key === chroma);
  const bg = chromaFill && chromaFill.fill ? chromaFill.fill : MG_CHECKER;
  return (
    <div style={{ width: f.w * scale, height: f.h * scale, position: "relative", flex: "0 0 auto", borderRadius: 14, overflow: "hidden",
      background: bg, backgroundSize: chromaFill && chromaFill.fill ? undefined : "22px 22px",
      boxShadow: "0 30px 80px -30px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.06)" }}>
      <iframe key={docKey} title="motion-preview" sandbox="allow-scripts" srcDoc={html} scrolling="no"
        style={{ position: "absolute", top: 0, left: 0, width: f.w, height: f.h, border: "none", transform: `scale(${scale})`, transformOrigin: "top left", background: "transparent" }} />
    </div>
  );
}
function MGToolBtn({ icon, label, onClick, active, accent, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: VX.sans, fontSize: 12.5, fontWeight: 700,
      padding: "7px 12px", borderRadius: VX.r2, cursor: disabled ? "default" : "pointer",
      border: "1px solid " + (accent ? "transparent" : VX.border),
      background: accent ? VX.accent : active ? VX.card2 : "transparent", color: accent ? "#fff" : active ? VX.fg : VX.fg2, opacity: disabled ? 0.6 : 1 }}>
      {icon && <Icon name={icon} size={15} sw={1.9} />}{label}
    </button>
  );
}

// Library thumbnail: live looping animation, lazy-mounted only while visible so a
// long library doesn't run dozens of animations at once. Renders the saved
// graphic in the same sandbox+CSP iframe; off-screen it shows a static placeholder.
function LibraryThumb({ item, loadHtml }) {
  const fmt = fmtFromDim(item.dimension);
  const F = MG_FORMATS[fmt];
  const boxRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [html, setHtml] = useState(null);
  const BW = 160, BH = 116;
  const scale = Math.min(BW / F.w, BH / F.h);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    let on = true;
    if (visible && html === null) loadHtml(item.id).then(h => { if (on) setHtml(h || ""); }).catch(() => { if (on) setHtml(""); });
    return () => { on = false; };
  }, [visible, item.id, html, loadHtml]);
  return (
    <div ref={boxRef} style={{ height: BH, background: VX.inset, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderBottom: "1px solid " + VX.borderSoft }}>
      {visible && html ? (
        <div style={{ width: F.w * scale, height: F.h * scale, position: "relative", overflow: "hidden", borderRadius: 4, boxShadow: "0 2px 10px -4px rgba(0,0,0,0.6)" }}>
          <iframe title={"thumb-" + item.id} sandbox="allow-scripts" srcDoc={html} scrolling="no"
            style={{ position: "absolute", top: 0, left: 0, width: F.w, height: F.h, border: "none", transform: `scale(${scale})`, transformOrigin: "top left", background: "transparent", pointerEvents: "none" }} />
        </div>
      ) : (
        <div style={{ width: BW * 0.62, height: BH * 0.6, borderRadius: 5, background: "linear-gradient(135deg,#16233c,#101728)", border: "1px solid " + VX.border }} />
      )}
    </div>
  );
}

export function MotionGraphicsGenerator({ clients = [] }) {
  const names = clientNamesFrom(clients);

  const [prompt, setPrompt] = useState("");
  const [activePreset, setActivePreset] = useState("");
  const [presetLabel, setPresetLabel] = useState("");
  const [fmt, setFmt] = useState("Portrait");
  const [loop, setLoop] = useState(6);
  const [chroma, setChroma] = useState("Transparent");
  const [brandMode, setBrandMode] = useState("Viewix"); // "Viewix" | "Client site"
  const [brandUrl, setBrandUrl] = useState("");

  const [generating, setGenerating] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { id, html, fragment, dimension, cost, fromLibrary }
  const [refine, setRefine] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [present, setPresent] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedGenId, setSavedGenId] = useState(""); // generationId that was saved — compared to result.id so a late save response can't mislabel a newer generation

  const [library, setLibrary] = useState({});
  const [libLoaded, setLibLoaded] = useState(false);
  const [clientFilter, setClientFilter] = useState("All");

  const abortRef = useRef(null);
  const savingRef = useRef(false);
  const stageRef = useRef(null);
  const [stage, setStage] = useState({ w: 760, h: 520 });
  const htmlCache = useRef({});

  useEffect(() => {
    const off = fbListenSafe("/motionGraphicsLibrary/meta", d => { setLibLoaded(true); setLibrary(d || {}); });
    return off;
  }, []);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => { const r = el.getBoundingClientRect(); setStage({ w: Math.max(200, r.width - 64), h: Math.max(200, r.height - 64) }); };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const F = MG_FORMATS[fmt];
  const dim = result ? fmtFromDim(result.dimension) : fmt;

  const loadHtml = useCallback(async (id) => {
    if (htmlCache.current[id] !== undefined) return htmlCache.current[id];
    const h = await fbGet(`/motionGraphicsLibrary/html/${id}`);
    htmlCache.current[id] = h || "";
    return htmlCache.current[id];
  }, []);

  function applyPreset(p) {
    setPrompt(p.prompt); setFmt(p.fmt); setActivePreset(p.key); setPresetLabel(p.label);
  }
  function onPromptChange(v) { setPrompt(v); if (activePreset) { setActivePreset(""); setPresetLabel(""); } }

  async function enhancePrompt() {
    if (!prompt.trim() || enhancing || generating) return;
    setEnhancing(true); setError("");
    try {
      const r = await authFetch("/api/motion-graphics", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enhance", prompt: prompt.trim(), dimension: MG_FORMATS[fmt].dim, durationSec: loop }) });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (d.prompt) { setPrompt(d.prompt); setActivePreset(""); setPresetLabel(""); }
    } catch (e) { setError(e.message || "Enhance failed"); }
    finally { setEnhancing(false); }
  }

  const callGenerate = useCallback(async (isRefine) => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(""); setGenerating(true);
    const timer = setTimeout(() => controller.abort(), 170_000);
    try {
      const brandUrlArg = brandMode === "Client site" && brandUrl.trim() ? brandUrl.trim() : undefined;
      const payload = isRefine
        ? { action: "generate", prompt, dimension: result?.dimension || MG_FORMATS[fmt].dim, durationSec: loop, refineInstruction: refine.trim(), previousFragment: result?.fragment || result?.html, brandUrl: brandUrlArg }
        : { action: "generate", prompt: prompt.trim(), dimension: MG_FORMATS[fmt].dim, durationSec: loop, brandUrl: brandUrlArg };
      const r = await authFetch("/api/motion-graphics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult({ id: d.id, html: d.html, fragment: d.fragment, dimension: d.dimension, cost: d.cost, brand: d.brand || null, fromLibrary: false });
      setRefine(""); setPreviewKey(k => k + 1);
    } catch (e) {
      if (e.name === "AbortError") setError("Generation cancelled or timed out.");
      else setError(e.message || "Generation failed");
    } finally {
      clearTimeout(timer); abortRef.current = null; setGenerating(false);
    }
  }, [prompt, fmt, loop, refine, result, brandMode, brandUrl]);

  function cancel() { if (abortRef.current) abortRef.current.abort(); }

  async function saveToLibrary() {
    if (!result?.id || result.fromLibrary || savingRef.current || savedGenId === result.id) return; // re-entry + already-saved guard
    savingRef.current = true;
    const gid = result.id; // capture so a late response can't mislabel a newer generation
    setError("");
    const client = allClientNames.includes(clientFilter) ? clientFilter : null; // stamp the active client chip (incl. a stale one)
    try {
      const r = await authFetch("/api/motion-graphics", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", generationId: gid, fragment: result.fragment, html: result.html, name: (presetLabel || prompt.trim().slice(0, 48) || undefined), client }) });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSavedGenId(gid);
    } catch (e) { setError(e.message || "Save failed"); }
    finally { savingRef.current = false; }
  }

  async function loadFromLibrary(item) {
    setError("");
    try {
      const html = await loadHtml(item.id);
      if (!html) { setError("This graphic's content is missing — archive it."); return; }
      setFmt(fmtFromDim(item.dimension));
      setResult({ id: null, html, fragment: html, dimension: item.dimension, cost: item.costUsd, fromLibrary: true });
      setPreviewKey(k => k + 1);
    } catch (e) { setError(e.message || "Could not load graphic"); }
  }

  async function archive(id) {
    setError("");
    try {
      const r = await authFetch("/api/motion-graphics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive", id }) });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    } catch (e) { setError(e.message || "Archive failed"); }
  }

  async function assignClient(id, client) {
    setError("");
    try {
      const r = await authFetch("/api/motion-graphics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign", id, client: client || null }) });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    } catch (e) { setError(e.message || "Assign failed"); }
  }

  function popOut() {
    if (!result?.html) return;
    const rf = MG_FORMATS[fmtFromDim(result.dimension)]; // size from the GENERATED dim, not the live control
    const cf = MG_CHROMA.find(c => c.key === chroma);
    const bg = cf && cf.fill ? cf.fill : "#10151f";
    const w = window.open("", "_blank");
    if (!w) { setError("Pop-out was blocked — allow popups for a clean capture window."); return; }
    w.document.title = "Motion graphic — recording view";
    const b = w.document.body;
    b.style.margin = "0"; b.style.height = "100vh"; b.style.background = bg; b.style.display = "grid"; b.style.placeItems = "center";
    const f = w.document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.style.border = "0"; f.style.width = rf.w + "px"; f.style.height = rf.h + "px"; f.style.maxWidth = "100vw"; f.style.maxHeight = "100vh";
    f.srcdoc = result.html;
    b.appendChild(f);
  }

  function copySource() { if (result?.html) { navigator.clipboard?.writeText(result.html); setCopied(true); setTimeout(() => setCopied(false), 1500); } }

  const items = Object.values(library || {}).filter(g => g && g.id && !g.archived).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // union current clients with any client already stamped on an item, so a
  // removed/renamed client still has a filter chip + select option.
  const itemClients = [...new Set(items.map(i => (typeof i.client === "string" ? i.client.trim() : "")).filter(Boolean))];
  const allClientNames = [...new Set([...names, ...itemClients])].sort((a, b) => a.localeCompare(b));
  const filterChips = ["All", ...allClientNames, "Unassigned"];
  const countFor = c => c === "All" ? items.length : c === "Unassigned" ? items.filter(i => !i.client).length : items.filter(i => i.client === c).length;
  const visible = clientFilter === "All" ? items : clientFilter === "Unassigned" ? items.filter(i => !i.client) : items.filter(i => i.client === clientFilter);

  const hasResult = !!result;
  const isSaved = !!result && !result.fromLibrary && savedGenId === result.id;
  const cf = MG_CHROMA.find(c => c.key === chroma);

  return (
    <div style={{ height: "calc(100vh - 104px)", overflow: "hidden", background: VX.bg, color: VX.fg, fontFamily: VX.sans, display: "flex" }}>
      {/* ── LEFT: controls ── */}
      <div style={{ width: 348, flex: "0 0 auto", borderRight: "1px solid " + VX.border, background: VX.rail, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid " + VX.borderSoft }}>
          <div style={{ fontFamily: VX.sans, fontSize: 16, fontWeight: 800, color: VX.fg, letterSpacing: "-0.01em" }}>Motion Graphics</div>
          <div style={{ fontFamily: VX.sans, fontSize: 11.5, color: VX.muted, marginTop: 3 }}>Describe it · generate a branded animation · screen-record.</div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 24 }}>
          <MGGroup n="1" label="Start from a preset">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {PRESETS.map(p => {
                const on = activePreset === p.key;
                return (
                  <button key={p.key} onClick={() => applyPreset(p)} title={p.prompt} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 11px", borderRadius: 99, cursor: "pointer",
                    fontFamily: VX.sans, fontSize: 11.5, fontWeight: 700, background: on ? VX.accentSoft : VX.inset, color: on ? VX.accentBright : VX.fg2,
                    border: "1px solid " + (on ? "rgba(0,130,250,0.32)" : VX.border) }}>
                    <Icon name={p.icon} size={13} sw={1.9} />{p.label}
                  </button>
                );
              })}
            </div>
          </MGGroup>

          <MGGroup n="2" label="Describe">
            <textarea value={prompt} onChange={e => onPromptChange(e.target.value)} rows={5} maxLength={2000} placeholder="e.g. Bold stat reveal — “3.2× ROAS” counts up with an orange underline wipe."
              style={{ width: "100%", resize: "vertical", fontFamily: VX.sans, fontSize: 13.5, fontWeight: 500, color: VX.fg, background: VX.inset, border: "1px solid " + VX.border, borderRadius: VX.r3, padding: "11px 13px", lineHeight: 1.5, outline: "none", boxSizing: "border-box" }} />
            <button onClick={enhancePrompt} disabled={!prompt.trim() || enhancing || generating}
              title="Expand your rough idea into a vivid, detailed prompt"
              style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 7, fontFamily: VX.sans, fontSize: 12, fontWeight: 700, padding: "7px 13px", borderRadius: VX.r2,
                cursor: (!prompt.trim() || enhancing || generating) ? "not-allowed" : "pointer", border: "1px solid " + VX.border, background: VX.card,
                color: (!prompt.trim() || enhancing || generating) ? VX.faint : VX.accentBright }}>
              <Icon name="spark" size={14} sw={2} stroke={(!prompt.trim() || enhancing || generating) ? VX.faint : VX.accentBright} />{enhancing ? "Enhancing…" : "Enhance prompt"}
            </button>
          </MGGroup>

          <MGGroup n="3" label="Format">
            <MGSegment options={["Portrait", "Landscape", "Square"]} value={fmt} onChange={setFmt} />
            <div style={{ fontFamily: VX.mono, fontSize: 10.5, color: VX.muted, marginTop: -4 }}>{F.sub}</div>
            <MGSlider label="Loop length" value={loop} min={2} max={20} unit="s" onChange={setLoop} />
          </MGGroup>

          <MGGroup n="4" label="Background to key out">
            <MGChroma value={chroma} onChange={setChroma} />
            <span style={{ fontFamily: VX.sans, fontSize: 11.5, color: VX.muted, lineHeight: 1.5 }}>
              The graphic renders on <strong style={{ color: VX.fg2 }}>{chroma.toLowerCase()}</strong> so you can key it out in your edit.</span>
          </MGGroup>

          <MGGroup n="5" label="Brand">
            <MGSegment options={["Viewix", "Client site"]} value={brandMode} onChange={setBrandMode} />
            {brandMode === "Client site" && (
              <input value={brandUrl} onChange={e => setBrandUrl(e.target.value)} maxLength={2000} placeholder="https://clientsite.com" spellCheck={false}
                style={{ width: "100%", fontFamily: VX.sans, fontSize: 13, color: VX.fg, background: VX.inset, border: "1px solid " + VX.border, borderRadius: VX.r2, padding: "9px 12px", outline: "none", boxSizing: "border-box" }} />
            )}
            <span style={{ fontFamily: VX.sans, fontSize: 11.5, color: VX.muted, lineHeight: 1.5 }}>
              {brandMode === "Client site"
                ? "We read the client site's share image + theme colour and match the graphic to their brand."
                : "Graphics use the Viewix brand."}</span>
          </MGGroup>
        </div>
        <div style={{ padding: "16px 22px", borderTop: "1px solid " + VX.borderSoft }}>
          {generating ? (
            <button onClick={cancel} style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: VX.sans, fontSize: 14, fontWeight: 700, padding: "12px 0", borderRadius: VX.r2, cursor: "pointer", background: "transparent", color: VX.fg2, border: "1px solid " + VX.border }}>
              <Icon name="clock" size={16} sw={2} />Cancel
            </button>
          ) : (
            <button onClick={() => callGenerate(false)} disabled={!prompt.trim()} style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: VX.sans, fontSize: 14, fontWeight: 700, padding: "12px 0", borderRadius: VX.r2, border: "none",
              cursor: prompt.trim() ? "pointer" : "not-allowed", background: prompt.trim() ? VX.accent : "#1b2436", color: prompt.trim() ? "#fff" : VX.faint, boxShadow: prompt.trim() ? "0 8px 22px -10px rgba(0,130,250,0.9)" : "none" }}>
              <Icon name="spark" size={16} sw={2} />Generate
            </button>
          )}
        </div>
      </div>

      {/* ── RIGHT: preview + library ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 56, flex: "0 0 auto", borderBottom: "1px solid " + VX.border, display: "flex", alignItems: "center", gap: 14, padding: "0 22px" }}>
          <span style={{ fontFamily: VX.sans, fontSize: 13, fontWeight: 700, color: VX.fg2 }}>Preview</span>
          {hasResult && <span style={{ fontFamily: VX.mono, fontSize: 11.5, color: VX.muted }}>{MG_FORMATS[dim].sub}{!result.fromLibrary && result.cost != null ? ` · $${Number(result.cost).toFixed(4)}` : ""}</span>}
          {hasResult && result.brand?.siteName && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: VX.sans, fontSize: 11, fontWeight: 700, color: VX.accentBright }}><Icon name="link2" size={12} sw={2} stroke={VX.accentBright} />{result.brand.siteName}</span>}
          <div style={{ flex: 1 }} />
          {error && <span style={{ fontFamily: VX.sans, fontSize: 11.5, fontWeight: 600, color: VX.danger, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{error}</span>}
          {hasResult && <>
            <MGToolBtn icon="play" label="Replay" onClick={() => setPreviewKey(k => k + 1)} />
            <MGToolBtn icon="external" label="Present" onClick={() => setPresent(true)} />
            <MGToolBtn icon="editors" label="Source" onClick={() => setShowSource(true)} />
            {!result.fromLibrary && <MGToolBtn icon={isSaved ? "check" : "plus"} label={isSaved ? "Saved" : "Save"} accent={!isSaved} active={isSaved} onClick={saveToLibrary} />}
          </>}
        </div>

        {/* stage */}
        <div ref={stageRef} style={{ flex: 1, minHeight: 0, position: "relative", background: VX.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 32, backgroundImage: "radial-gradient(circle at 50% 40%, rgba(255,255,255,0.025), transparent 60%)" }}>
          {generating && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <ViewixLoader size={72} />
              <div style={{ fontFamily: VX.sans, fontSize: 13.5, fontWeight: 700, color: VX.fg2, marginTop: 14 }}>Generating…</div>
              <div style={{ fontFamily: VX.mono, fontSize: 11, color: VX.muted, marginTop: 5 }}>branding · timing · motion</div>
            </div>
          )}
          {!generating && !hasResult && (
            <div style={{ textAlign: "center", color: VX.muted }}>
              <div style={{ width: 56, height: 56, borderRadius: 14, background: "rgba(255,255,255,0.04)", border: "1px dashed " + VX.line2, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <Icon name="spark" size={24} sw={1.6} stroke={VX.muted} /></div>
              <div style={{ fontFamily: VX.sans, fontSize: 14, fontWeight: 700, color: VX.fg2 }}>Pick a preset or describe a graphic, then Generate</div>
              <div style={{ fontFamily: VX.sans, fontSize: 12, color: VX.muted, marginTop: 4 }}>Your branded animation plays here, looping, ready to screen-record.</div>
            </div>
          )}
          {!generating && hasResult && <MGFrame fmt={dim} chroma={chroma} docKey={previewKey} html={result.html} maxW={stage.w} maxH={stage.h - 8} />}
        </div>

        {/* refine bar */}
        {hasResult && !result.fromLibrary && (
          <div style={{ flex: "0 0 auto", borderTop: "1px solid " + VX.border, padding: "12px 22px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 9, height: 42, padding: "0 14px", borderRadius: VX.r2, border: "1px solid " + VX.border, background: VX.inset }}>
              <Icon name="spark" size={15} sw={1.8} stroke={VX.muted} />
              <input value={refine} onChange={e => setRefine(e.target.value)} maxLength={1000} placeholder="Refine in plain language — “make the wipe orange, slow the rise-in”…"
                onKeyDown={e => { if (e.key === "Enter" && refine.trim() && !generating) callGenerate(true); }}
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontFamily: VX.sans, fontSize: 13, color: VX.fg }} />
            </div>
            <button onClick={() => callGenerate(true)} disabled={!refine.trim() || generating} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: VX.sans, fontSize: 13, fontWeight: 700, padding: "10px 18px", borderRadius: VX.r2, border: "1px solid " + (refine.trim() && !generating ? "transparent" : VX.border), cursor: refine.trim() && !generating ? "pointer" : "not-allowed", background: refine.trim() && !generating ? VX.accent : "transparent", color: refine.trim() && !generating ? "#fff" : VX.faint }}>Refine</button>
          </div>
        )}

        {/* library strip */}
        <div style={{ flex: "0 0 auto", borderTop: "1px solid " + VX.border, background: VX.rail, padding: "14px 22px 18px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: VX.accent }} />
            <span style={{ fontFamily: VX.sans, fontSize: 11.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: VX.fg2, whiteSpace: "nowrap" }}>Shared Library</span>
            <span style={{ width: 1, height: 16, background: VX.border, flex: "0 0 auto" }} />
            <div style={{ display: "flex", gap: 6, overflowX: "auto", flex: 1, paddingBottom: 2 }}>
              {filterChips.map(c => {
                const on = clientFilter === c;
                return (
                  <button key={c} onClick={() => setClientFilter(c)} style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto", cursor: "pointer", fontFamily: VX.sans, fontSize: 11.5, fontWeight: 700, padding: "5px 11px", borderRadius: 99,
                    background: on ? VX.accentSoft : "transparent", color: on ? VX.accentBright : VX.muted, border: "1px solid " + (on ? "rgba(0,130,250,0.32)" : VX.border) }}>
                    {c !== "All" && c !== "Unassigned" && <ClientDot name={c} size={7} />}{shortClient(c)}
                    <span style={{ fontFamily: VX.mono, fontSize: 10, color: on ? VX.accentBright : VX.faint }}>{countFor(c)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {!libLoaded ? (
            <div style={{ fontFamily: VX.sans, fontSize: 12.5, color: VX.muted, padding: "10px 0" }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ fontFamily: VX.sans, fontSize: 12.5, color: VX.muted, padding: "10px 0" }}>No saved graphics yet — Save a generation to share it with the team.</div>
          ) : visible.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: VX.sans, fontSize: 12.5, color: VX.muted, padding: "10px 0" }}>
              <ClientDot name={clientFilter === "Unassigned" ? null : clientFilter} size={8} />No graphics for <strong style={{ color: VX.fg2 }}>{clientFilter}</strong> yet — open one and assign a client.</div>
          ) : (
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
              {visible.map(item => (
                <div key={item.id} style={{ flex: "0 0 auto", width: 184, background: VX.card, border: "1px solid " + VX.border, borderRadius: VX.r3, overflow: "hidden", position: "relative" }}>
                  <div style={{ cursor: "pointer", position: "relative" }} onClick={() => loadFromLibrary(item)}>
                    <LibraryThumb item={item} loadHtml={loadHtml} />
                    {item.client && <span style={{ position: "absolute", top: 6, left: 6, display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px 3px 6px", borderRadius: 99, background: "rgba(8,12,20,0.78)", border: "1px solid " + VX.border }}>
                      <ClientDot name={item.client} size={6} />
                      <span style={{ fontFamily: VX.sans, fontSize: 9.5, fontWeight: 700, color: VX.fg2 }}>{shortClient(item.client)}</span>
                    </span>}
                    <button onClick={e => { e.stopPropagation(); archive(item.id); }} title="Archive" style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 6, border: "none", cursor: "pointer", background: "rgba(8,12,20,0.7)", color: VX.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon name="plus" size={13} sw={2} style={{ transform: "rotate(45deg)" }} /></button>
                  </div>
                  <div style={{ padding: "9px 11px" }}>
                    <div style={{ fontFamily: VX.sans, fontSize: 12, fontWeight: 700, color: VX.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, position: "relative" }}>
                      <ClientDot name={item.client} size={8} />
                      <div style={{ position: "relative", flex: 1 }}>
                        <select value={item.client || ""} onChange={e => assignClient(item.id, e.target.value || null)}
                          style={{ width: "100%", appearance: "none", fontFamily: VX.sans, fontSize: 11, fontWeight: 600, color: item.client ? VX.fg : VX.muted, background: VX.inset, border: "1px solid " + VX.border, borderRadius: VX.r1, padding: "5px 24px 5px 9px", cursor: "pointer", outline: "none" }}>
                          <option value="" style={{ background: "#141A29" }}>Unassigned</option>
                          {allClientNames.map(n => <option key={n} value={n} style={{ background: "#141A29" }}>{n}</option>)}
                        </select>
                        <span style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: VX.muted }}><Icon name="chevdown" size={12} sw={2} /></span>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
                      <span style={{ fontFamily: VX.mono, fontSize: 9.5, color: VX.muted }}>{fmtFromDim(item.dimension)}</span>
                      <span style={{ color: VX.faint }}>·</span>
                      <span style={{ fontFamily: VX.sans, fontSize: 10, color: VX.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 64 }}>{item.createdBy?.name || item.createdBy?.email || "—"}</span>
                      {item.costUsd != null && <span style={{ marginLeft: "auto", fontFamily: VX.mono, fontSize: 9.5, color: VX.success }}>${Number(item.costUsd).toFixed(3)}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── PRESENT overlay ── */}
      {present && hasResult && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(5,8,14,0.96)", display: "flex", flexDirection: "column" }}>
          <div style={{ height: 52, flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, padding: "0 20px", borderBottom: "1px solid " + VX.border }}>
            <span style={{ fontFamily: VX.sans, fontSize: 13, fontWeight: 700, color: VX.fg }}>Present · {MG_FORMATS[dim].sub}</span>
            <span style={{ fontFamily: VX.sans, fontSize: 11.5, color: VX.amber, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="bell" size={13} sw={1.9} />Native portrait capture needs a tall display</span>
            <div style={{ flex: 1 }} />
            <MGToolBtn icon="external" label="Pop out" onClick={popOut} />
            <MGToolBtn icon="plus" label="Close" onClick={() => setPresent(false)} />
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
            <MGFrame fmt={dim} chroma={chroma} docKey={"present-" + previewKey} html={result.html} maxW={1100} maxH={760} />
          </div>
        </div>
      )}

      {/* ── SOURCE modal ── */}
      {showSource && hasResult && (
        <div onClick={() => setShowSource(false)} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(5,8,14,0.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 720, maxHeight: "80%", display: "flex", flexDirection: "column", background: VX.card, border: "1px solid " + VX.border, borderRadius: VX.r4, overflow: "hidden", boxShadow: VX.shadow3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 20px", borderBottom: "1px solid " + VX.border }}>
              <span style={{ fontFamily: VX.sans, fontSize: 14, fontWeight: 800, color: VX.fg }}>Generated Source</span>
              <span style={{ fontFamily: VX.mono, fontSize: 10.5, color: VX.muted }}>read-only</span>
              <div style={{ flex: 1 }} />
              <MGToolBtn icon="check" label={copied ? "Copied" : "Copy"} onClick={copySource} />
              <MGToolBtn icon="plus" label="Close" onClick={() => setShowSource(false)} />
            </div>
            <pre style={{ margin: 0, flex: 1, overflow: "auto", padding: "18px 20px", background: VX.inset, fontFamily: VX.mono, fontSize: 11.5, lineHeight: 1.6, color: "#9FE0C4", whiteSpace: "pre-wrap" }}>{result.html}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
