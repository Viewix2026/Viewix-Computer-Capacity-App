// ════════════════════════════════════════════════════════════════════
// Editors · Text Generator — interactive subtab.
// Produces a transparent-PNG Instagram-Reels caption box. The signature
// per-line NOTCH (convex outer / concave inner corners) is rendered with
// an SVG "goo" filter over a two-layer text stack (crisp glyphs on top).
//
// Ported from the Claude-design source (ds/tab-caption.jsx). The design's
// local VX tokens + Icon set mirror the dashboard's own; we inline the
// tokens here for a pixel-faithful, self-contained component and use the
// real ./Icon. The design's AppShell/Rail (sidebar chrome) is intentionally
// dropped — this renders inside the Editors tab, the sidebar is untouched.
//
// Codex code-loop fixes folded in: box opacity applied OUTSIDE the goo
// filter (the alpha-cutoff matrix otherwise destroys partial opacity);
// DM Sans embedded into the export SVG (rasteriser can't reach Google
// Fonts); goo-blur bleed padding so the notch isn't clipped on export;
// canvas-size clamp; double-click export lock; slugged filename; notch=0
// is a clean (unfiltered) passthrough.
// ════════════════════════════════════════════════════════════════════
import { useState, useRef, useId, useEffect } from "react";
import { Icon } from "./Icon";

// Parse a user-typed colour code into a normalised #RRGGBB, or null if invalid.
// Accepts hex (#RGB, #RRGGBB, with or without the #) and rgb()/rgba() triples.
function normalizeColor(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(n => Math.max(0, Math.min(255, parseInt(n, 10))));
    if (parts.some(n => Number.isNaN(n))) return null;
    return "#" + parts.map(n => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  let h = s.replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map(c => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return "#" + h.toUpperCase();
  return null;
}

// Tokens lifted verbatim from the design kit (match config.js brand hues).
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

const CG_FONTS = ["Arial", "Helvetica", "Impact", "Verdana", "Georgia", "Courier New", "DM Sans"];

// The browser rasterises the export SVG in an isolated context that cannot
// reach Google Fonts, so any web font (only DM Sans here — the other six are
// system fonts) must be inlined as an @font-face with the bytes embedded, or
// the PNG silently falls back to a system font while the preview looks right.
// Best-effort + cached: on any failure we return "" and the export proceeds
// with the system fallback (no crash, same as before this fix).
const _fontFaceCache = {};
async function dmSansFaceCss(weight, italic) {
  const key = `dmsans-${weight}-${italic ? "i" : "n"}`;
  if (_fontFaceCache[key] !== undefined) return _fontFaceCache[key];
  let result = "";
  try {
    // css2 axes must be listed alphabetically; italic adds the `ital` axis.
    const axis = italic ? `ital,wght@1,${weight}` : `wght@${weight}`;
    const cssUrl = `https://fonts.googleapis.com/css2?family=DM+Sans:${axis}&display=swap`;
    const css = await (await fetch(cssUrl)).text();
    const blocks = css.split("@font-face").slice(1);
    let url = null;
    for (const b of blocks) {
      const m = b.match(/url\((https:\/\/[^)]+\.woff2)\)/);
      if (!m) continue;
      if (/U\+0000/i.test(b)) { url = m[1]; break; }   // prefer the basic-latin subset
      if (!url) url = m[1];
    }
    if (url) {
      const buf = await (await fetch(url)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      result = `@font-face{font-family:'DM Sans';font-style:${italic ? "italic" : "normal"};font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
    }
  } catch {
    result = "";
  }
  _fontFaceCache[key] = result;
  return result;
}

// ── small control primitives (themed, inline value) ─────────────────
function CGGroup({ n, label, children }) {
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
function CGSlider({ label, value, min, max, step = 1, unit = "px", onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 600, color: VX.fg2 }}>{label}</span>
        <span style={{ fontFamily: VX.mono, fontSize: 11.5, fontWeight: 700, color: VX.accentBright }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: VX.accent, height: 4, cursor: "pointer" }} />
    </div>
  );
}
// Colour control: a typeable hex/RGB field (paste an exact brand colour) kept in
// sync with the native colour-picker swatch. `draft` holds the raw text while the
// field is focused so typing isn't fought by the normalised value flowing back;
// invalid input is reverted on blur/Enter.
function CGSwatch({ label, value, onChange }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const [bad, setBad] = useState(false);
  // Mirror external changes (the picker) into the field, but not while the user
  // is mid-type in it.
  useEffect(() => { if (!focused.current) { setDraft(value); setBad(false); } }, [value]);

  const onType = (raw) => {
    setDraft(raw);
    const norm = normalizeColor(raw);
    setBad(!norm);
    if (norm && norm !== value) onChange(norm);   // live update when valid
  };
  const commit = () => {
    focused.current = false;
    const norm = normalizeColor(draft);
    if (norm) { onChange(norm); setDraft(norm); }
    else { setDraft(value); }   // revert invalid text
    setBad(false);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 600, color: VX.fg2 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <input
          value={draft}
          spellCheck={false}
          aria-label={`${label} hex or RGB code`}
          onFocus={() => { focused.current = true; }}
          onChange={e => onType(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          style={{ width: 92, fontFamily: VX.mono, fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: bad ? VX.danger : VX.fg2,
            background: VX.inset, border: "1px solid " + (bad ? VX.danger : VX.border), borderRadius: VX.r1, padding: "7px 9px", outline: "none", textAlign: "center" }}
        />
        <span style={{ position: "relative", width: 32, height: 32, borderRadius: 8, border: "1px solid " + VX.border, background: value, overflow: "hidden", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12)" }}>
          <input type="color" value={value} onChange={e => onChange(e.target.value)} aria-label={`${label} picker`} style={{ position: "absolute", inset: -4, width: "calc(100% + 8px)", height: "calc(100% + 8px)", border: "none", padding: 0, opacity: 0, cursor: "pointer" }} />
        </span>
      </div>
    </div>
  );
}
function CGToggle({ label, on, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 600, color: VX.fg2 }}>{label}</span>
      <button onClick={() => onChange(!on)} style={{ width: 42, height: 24, borderRadius: 24, padding: 0, cursor: "pointer", position: "relative",
        border: "1px solid " + (on ? "rgba(0,130,250,0.55)" : VX.border), background: on ? VX.accent : "rgba(255,255,255,0.05)", transition: "all .16s" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 21 : 2, width: 18, height: 18, borderRadius: "50%", background: on ? "#fff" : "#8295B0", transition: "left .16s", boxShadow: "0 1px 2px rgba(0,0,0,0.4)" }} />
      </button>
    </div>
  );
}
function CGSegment({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", gap: 3, background: VX.inset, borderRadius: VX.r2, padding: 3, border: "1px solid " + VX.borderSoft }}>
      {options.map(o => (
        <button key={o} onClick={() => onChange(o)} style={{ flex: 1, padding: "7px 0", borderRadius: VX.r1, border: "none", cursor: "pointer", fontFamily: VX.sans, fontSize: 12, fontWeight: 700,
          background: o === value ? VX.card2 : "transparent", color: o === value ? VX.fg : VX.muted, boxShadow: o === value ? VX.shadow1 : "none" }}>{o}</button>
      ))}
    </div>
  );
}

// ── the notched caption preview (two-layer goo stack) ───────────────
// One box-decoration-break:clone span per layer with white-space:pre — both
// layers fragment identically at the editor's Enter breaks, so they stay
// pixel-aligned. The goo filter on the bg layer merges per-line rects into
// the signature notch (convex outer / concave inner corners); crisp text
// rides on the unfiltered fg layer.
//
// `opacity` is applied to the bg WRAPPER (outside the filter): the goo's
// alpha-cutoff matrix would otherwise clamp any partial box alpha to 0 or 1.
// `useFilter` is false when notch === 0 → a clean rounded-rect passthrough.
function CaptionBox({ text, font, bold, italic, size, textColor, boxColor, opacity, pad, radius, align, gooId, useFilter }) {
  const span = (color, bg, filtered) => ({
    display: "inline", fontFamily: `'${font}', sans-serif`, fontWeight: bold ? 800 : 500, fontStyle: italic ? "italic" : "normal",
    fontSize: size, lineHeight: 1.52, letterSpacing: "-0.01em", whiteSpace: "pre",
    WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone",
    padding: `${Math.round(pad * 0.34)}px ${pad}px`, borderRadius: radius, color, background: bg,
    filter: filtered ? `url(#${gooId})` : "none",
  });
  const content = text === "" ? "​" : text;
  return (
    <div style={{ position: "relative", display: "inline-block", textAlign: align === "Center" ? "center" : "left" }}>
      {/* background layer (goo-filtered SOLID box; opacity applied on this wrapper, outside the filter) */}
      <div style={{ position: "relative", opacity }}><span style={span("transparent", boxColor, useFilter)}>{content}</span></div>
      {/* foreground layer (crisp text, no bg) */}
      <div style={{ position: "absolute", inset: 0 }}><span style={span(textColor, "transparent", false)}>{content}</span></div>
    </div>
  );
}

export function TextGenerator() {
  const [text, setText] = useState("Behind every great\nvideo is a great\nstory.");
  const [font, setFont] = useState("Arial");
  const [bold, setBold] = useState(true);
  const [italic, setItalic] = useState(false);
  const [size, setSize] = useState(56);
  const [textColor, setTextColor] = useState("#000000");
  const [boxColor, setBoxColor] = useState("#FFFFFF");
  const [opacity, setOpacity] = useState(100);
  const [pad, setPad] = useState(26);
  const [radius, setRadius] = useState(18);
  const [notch, setNotch] = useState(9);
  const [align, setAlign] = useState("Center");
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState("");
  const previewRef = useRef(null);
  const exportLock = useRef(false);   // synchronous guard against double-click races

  const empty = text.trim() === "";
  const tooBig = size > 130 && text.replace(/\n/g, "").length > 40;
  // Instance-scoped filter id (colons from useId are invalid in url(#…)).
  const gooId = "goo-" + useId().replace(/:/g, "");

  // small blur + a sharp alpha cutoff: fillets only the corners/notches,
  // keeps the box sides perfectly straight (IG caption look)
  const std = notch * 0.22 + 0.35;

  async function exportPNG() {
    if (empty || exportLock.current) return;
    exportLock.current = true;
    setExportErr("");
    const node = previewRef.current;
    if (!node) { exportLock.current = false; return; }
    setExporting(true);

    // Snapshot every input the export depends on SYNCHRONOUSLY, before any
    // await, so editing a control mid-export can't desync the embedded font /
    // slug / filter from the DOM we rasterise. The clone freezes the DOM too.
    const snapFont = font, snapBold = bold, snapItalic = italic, snapText = text, snapStd = std;
    const r = node.getBoundingClientRect();
    const W = Math.ceil(r.width), H = Math.ceil(r.height);
    const clone = node.cloneNode(true);
    clone.style.margin = "0";
    const xml = new XMLSerializer().serializeToString(clone);

    try {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch { /* non-fatal */ }
      }
      // Embed the only web font (DM Sans) so the rasteriser doesn't fall back.
      let fontFaceCss = "";
      if (snapFont === "DM Sans") fontFaceCss = await dmSansFaceCss(snapBold ? 800 : 500, snapItalic);
      const styleTag = fontFaceCss ? `<style>${fontFaceCss}</style>` : "";

      // The goo blur paints beyond the content box; without bleed the SVG
      // viewport / foreignObject clips the notch and outer corners.
      const bleed = Math.ceil(snapStd * 3) + 6;
      const SW = W + bleed * 2, SH = H + bleed * 2;

      // Clamp scale so neither axis exceeds the browser's canvas limit.
      const MAX_AXIS = 8192;
      const scale = Math.min(3, MAX_AXIS / SW, MAX_AXIS / SH);
      if (scale < 1) {
        setExportErr("Caption is too large to export. Reduce the text size or number of lines.");
        return;
      }

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}">
        <defs>${styleTag}<filter id="${gooId}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="${snapStd}" result="b"/>
        <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 32 -14" result="g"/>
        <feComposite in="SourceGraphic" in2="g" operator="atop"/></filter></defs>
        <foreignObject width="${SW}" height="${SH}"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;padding:${bleed}px;box-sizing:border-box">${xml}</div></foreignObject></svg>`;
      const img = new Image();
      const done = new Promise((resolve, reject) => {
        img.onload = () => {
          try {
            const c = document.createElement("canvas");
            c.width = Math.round(SW * scale); c.height = Math.round(SH * scale);
            const ctx = c.getContext("2d");
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0);
            c.toBlob(b => {
              if (!b) { reject(new Error("toBlob returned null")); return; }
              const slug = snapText.trim().slice(0, 40).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
              const url = URL.createObjectURL(b);
              const a = document.createElement("a"); a.href = url; a.download = `caption-${slug || "untitled"}.png`; a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              resolve();
            }, "image/png");
          } catch (e) { reject(e); }
        };
        img.onerror = () => reject(new Error("snapshot image failed to load"));
      });
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await done;
    } catch (e) {
      setExportErr("Export failed in this browser. Try Chrome, or reduce the size.");
      // eslint-disable-next-line no-console
      console.error("[TextGenerator] export failed:", e);
    } finally {
      setExporting(false);
      exportLock.current = false;
    }
  }

  const checker = `repeating-conic-gradient(#2a3242 0% 25%, #222a38 0% 50%) 50% / 22px 22px`;

  return (
    <div style={{ height: "calc(100vh - 104px)", overflow: "hidden", background: VX.bg, color: VX.fg, fontFamily: VX.sans, position: "relative" }}>
      {/* hidden goo filter def for the live preview */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <filter id={gooId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={std} result="b" />
            <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 32 -14" result="g" />
            <feComposite in="SourceGraphic" in2="g" operator="atop" />
          </filter>
        </defs>
      </svg>

      <div style={{ height: "100%", display: "flex", overflow: "hidden" }}>
        {/* ── LEFT: controls ── */}
        <div style={{ width: 348, flex: "0 0 auto", borderRight: "1px solid " + VX.border, background: VX.rail, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid " + VX.borderSoft }}>
            <div style={{ fontFamily: VX.sans, fontSize: 16, fontWeight: 800, color: VX.fg, letterSpacing: "-0.01em" }}>Text Generator</div>
            <div style={{ fontFamily: VX.sans, fontSize: 11.5, color: VX.muted, marginTop: 3 }}>Style it, export a transparent PNG overlay.</div>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 24 }}>
            <CGGroup n="1" label="Text">
              <textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="Type your caption… press Enter for a new line"
                style={{ width: "100%", resize: "vertical", fontFamily: VX.sans, fontSize: 13.5, fontWeight: 500, color: VX.fg, background: VX.inset,
                  border: "1px solid " + VX.border, borderRadius: VX.r3, padding: "11px 13px", lineHeight: 1.5, outline: "none", boxSizing: "border-box" }} />
            </CGGroup>

            <CGGroup n="2" label="Font">
              <div style={{ position: "relative" }}>
                <select value={font} onChange={e => setFont(e.target.value)} style={{ width: "100%", appearance: "none", fontFamily: VX.sans, fontSize: 13, fontWeight: 600, color: VX.fg,
                  background: VX.inset, border: "1px solid " + VX.border, borderRadius: VX.r2, padding: "10px 36px 10px 13px", cursor: "pointer", outline: "none" }}>
                  {CG_FONTS.map(f => <option key={f} value={f} style={{ background: "#141A29" }}>{f}</option>)}
                </select>
                <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: VX.muted }}><Icon name="chevdown" size={15} sw={2} /></span>
              </div>
              <CGToggle label="Bold" on={bold} onChange={setBold} />
              <CGToggle label="Italic" on={italic} onChange={setItalic} />
            </CGGroup>

            <CGGroup n="3" label="Size & Colour">
              <CGSlider label="Text size" value={size} min={24} max={160} onChange={setSize} />
              <CGSwatch label="Text colour" value={textColor} onChange={setTextColor} />
              <CGSwatch label="Box colour" value={boxColor} onChange={setBoxColor} />
              <CGSlider label="Box opacity" value={opacity} min={0} max={100} unit="%" onChange={setOpacity} />
            </CGGroup>

            <CGGroup n="4" label="Box Shape">
              <CGSlider label="Box size (padding)" value={pad} min={6} max={60} onChange={setPad} />
              <CGSlider label="Corner radius" value={radius} min={0} max={40} onChange={setRadius} />
              <CGSlider label="Notch radius" value={notch} min={0} max={30} onChange={setNotch} />
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <span style={{ fontFamily: VX.sans, fontSize: 12.5, fontWeight: 600, color: VX.fg2 }}>Alignment</span>
                <CGSegment options={["Left", "Center"]} value={align} onChange={setAlign} />
              </div>
            </CGGroup>
          </div>
        </div>

        {/* ── RIGHT: preview ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* preview toolbar */}
          <div style={{ height: 56, flex: "0 0 auto", borderBottom: "1px solid " + VX.border, display: "flex", alignItems: "center", gap: 14, padding: "0 24px" }}>
            <span style={{ fontFamily: VX.sans, fontSize: 13, fontWeight: 700, color: VX.fg2 }}>Live Preview</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: VX.sans, fontSize: 11.5, color: VX.muted }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: checker, border: "1px solid " + VX.border }} />Transparent</span>
            <div style={{ flex: 1 }} />
            {exportErr && <span style={{ fontFamily: VX.sans, fontSize: 11.5, fontWeight: 600, color: VX.danger }}>{exportErr}</span>}
            {tooBig && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: VX.sans, fontSize: 11.5, fontWeight: 600, color: VX.amber }}>
              <Icon name="bell" size={13} sw={1.9} />Very large — may export oversized</span>}
            <button onClick={exportPNG} disabled={empty || exporting} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: VX.sans, fontSize: 13, fontWeight: 700,
              padding: "9px 18px", borderRadius: VX.r2, border: "none", cursor: (empty || exporting) ? "not-allowed" : "pointer",
              background: (empty || exporting) ? "#1b2436" : VX.accent, color: (empty || exporting) ? VX.faint : "#fff",
              boxShadow: (empty || exporting) ? "none" : "0 6px 18px -8px rgba(0,130,250,0.9)" }}>
              <Icon name="arrowup" size={16} sw={2.2} />{exporting ? "Exporting…" : "Export PNG"}</button>
          </div>
          {/* canvas */}
          <div style={{ flex: 1, minHeight: 0, position: "relative", background: checker, display: "flex", alignItems: "center", justifyContent: "center", padding: 40, overflow: "auto" }}>
            {empty ? (
              <div style={{ textAlign: "center", color: VX.muted }}>
                <div style={{ width: 54, height: 54, borderRadius: 14, background: "rgba(255,255,255,0.04)", border: "1px dashed " + VX.line2, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                  <Icon name="editors" size={24} sw={1.6} stroke={VX.muted} /></div>
                <div style={{ fontFamily: VX.sans, fontSize: 14, fontWeight: 700, color: VX.fg2 }}>Type a caption to preview</div>
                <div style={{ fontFamily: VX.sans, fontSize: 12, color: VX.muted, marginTop: 4 }}>Your transparent PNG renders here in real time.</div>
              </div>
            ) : (
              <div ref={previewRef}><CaptionBox text={text} font={font} bold={bold} italic={italic} size={size} textColor={textColor}
                boxColor={boxColor} opacity={opacity / 100} pad={pad} radius={radius} align={align} gooId={gooId} useFilter={notch > 0} /></div>
            )}
          </div>
          {/* footer hint */}
          <div style={{ height: 40, flex: "0 0 auto", borderTop: "1px solid " + VX.border, display: "flex", alignItems: "center", padding: "0 24px",
            fontFamily: VX.sans, fontSize: 11.5, color: VX.muted }}>
            <Icon name="check" size={13} sw={2} stroke={VX.success} />
            <span style={{ marginLeft: 7 }}>Transparent PNG · drops straight into your edit.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
