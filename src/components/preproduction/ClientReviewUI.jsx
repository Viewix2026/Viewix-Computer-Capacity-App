// Shared design tokens + primitives for the redesigned client
// pre-production review page. Ported from the Anthropic design
// handover (cockpit-ui.jsx) into standard ESM with named exports.
//
// Everything in here is pure presentation. No Firebase, no project
// shape assumptions — the higher-level components hand these
// primitives whatever they need to render.
import { useState } from "react";

export const C = {
  bg:        "#F4F5F9",
  bgDim:     "#EEF0F6",
  card:      "#FFFFFF",
  ink:       "#0B1220",
  ink2:      "#374151",
  mute:      "#6B7280",
  muteSoft:  "#9CA3AF",
  rule:      "#E5E7EB",
  ruleSoft:  "#EDEFF4",
  blue:      "#0082FA",
  blueDk:    "#004F99",
  blueDeep:  "#002B57",
  blueBg:    "#E5F0FD",
  orange:    "#F87700",
  orangeDk:  "#AE3A00",
  orangeBg:  "#FFEDDC",
  green:     "#1F9D55",
  greenDk:   "#15803D",
  greenBg:   "#E4F4EA",
  red:       "#DC2626",
  redBg:     "#FEE2E2",
  grey:      "#CBCCD1",
};

export const STATUS_MAP = {
  "needs-review": { label: "Needs review", color: C.orangeDk, bg: C.orangeBg, icon: "•" },
  "approved":     { label: "Approved",     color: C.greenDk,  bg: C.greenBg,  icon: "✓" },
  "comments":     { label: "Feedback left", color: C.blueDk,  bg: C.blueBg,   icon: "✎" },
};

// Format library is open-ended (producers add new format names any time),
// so we can't hard-code the 8 design palette pairs to specific titles.
// Hash the title into a stable palette slot — same name always lands on
// the same colour across sessions, regardless of the order they were
// added to the library.
const FORMAT_PALETTE = [
  { fg: "#004F99", bg: "#E5F0FD" }, // Viewix navy
  { fg: "#0082FA", bg: "#E0EEFD" }, // Viewix blue
  { fg: "#1F2A38", bg: "#E6E8EC" }, // Slate
  { fg: "#AE3A00", bg: "#FCE5D6" }, // Burnt orange
  { fg: "#1F9D55", bg: "#E0F0E6" }, // Green
  { fg: "#7C3AED", bg: "#EEE6FB" }, // Purple
  { fg: "#C24E00", bg: "#FFEAD3" }, // Orange
  { fg: "#0E1118", bg: "#E5E7EB" }, // Ink
];
function hashString(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function colorForFormat(title) {
  if (!title) return FORMAT_PALETTE[0];
  return FORMAT_PALETTE[hashString(title) % FORMAT_PALETTE.length];
}

export const BRAND_ICON = {
  "Brand Truths": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 12l2 2 4-4" /><path d="M12 22s-8-4-8-12V5l8-3 8 3v5c0 8-8 12-8 12z" />
    </svg>
  ),
  "Brand Ambitions": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  ),
  "Overall Client Goals": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
    </svg>
  ),
  "Key Considerations": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 9v4M12 17h.01" /><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  ),
  "Target Viewer": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" /><path d="M4 22c0-4 4-7 8-7s8 3 8 7" />
    </svg>
  ),
  "Pain Points": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2 3 14h8l-1 8 10-12h-8z" />
    </svg>
  ),
  "Language": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5h16M4 5v14M4 19h16M20 5v14" /><path d="M8 9h8M8 13h5" />
    </svg>
  ),
};

export const BRAND_ACCENT = {
  "Brand Truths":         C.blueDk,
  "Brand Ambitions":      C.blue,
  "Overall Client Goals": C.green,
  "Key Considerations":   C.orangeDk,
  "Target Viewer":        "#7C3AED",
  "Pain Points":          C.red,
  "Language":             C.ink,
};

// ─── Primitives ────────────────────────────────────────────────────────────

export function StatusPill({ status, size = "md" }) {
  const s = STATUS_MAP[status] || STATUS_MAP["needs-review"];
  const pad = size === "sm" ? "4px 8px" : "6px 11px";
  const fz = size === "sm" ? 10 : 11;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: pad, borderRadius: 999, background: s.bg, color: s.color, font: `600 ${fz}px/1 "Montserrat", sans-serif`, letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
      <span style={{ font: `700 ${fz}px/1 "Montserrat", sans-serif` }}>{s.icon}</span>{s.label}
    </span>
  );
}

export function SectionHead({ idx, title, sub, count, status, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, marginBottom: 24, paddingBottom: 16, borderBottom: `1px solid ${C.rule}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ font: '700 11px/1 "JetBrains Mono", monospace', color: C.blueDk, padding: "5px 9px", border: `1px solid ${C.blueBg}`, background: C.blueBg, borderRadius: 4, letterSpacing: "0.06em" }}>{idx}</span>
          <h2 style={{ font: '700 26px/1.15 "Montserrat", sans-serif', color: C.ink, margin: 0, letterSpacing: "-0.015em" }}>{title}</h2>
          {count != null && <span style={{ font: '500 14px/1 "Montserrat", sans-serif', color: C.mute }}>· {count}</span>}
        </div>
        {sub && <p style={{ font: '400 14.5px/1.55 "Montserrat", sans-serif', color: C.ink2, margin: 0, maxWidth: 680 }}>{sub}</p>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        {right}
        {status && status !== "info" && <StatusPill status={status} />}
      </div>
    </div>
  );
}

export function ChannelCard({ name, handle, followers, accent }) {
  const logos = {
    Instagram: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" /></svg>,
    TikTok:    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19.6 7.2a5.7 5.7 0 0 1-3.5-1.2v8.6a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1V12a2.7 2.7 0 1 0 1.9 2.6V3h2.8a5.7 5.7 0 0 0 3.5 4.2z" /></svg>,
    YouTube:   <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M23 7.5a3 3 0 0 0-2.1-2.1C19 5 12 5 12 5s-7 0-8.9.4A3 3 0 0 0 1 7.5 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.5 3 3 0 0 0 2.1 2.1C5 19 12 19 12 19s7 0 8.9-.4A3 3 0 0 0 23 16.5a31 31 0 0 0 .5-4.5 31 31 0 0 0-.5-4.5zM10 15V9l5 3z" /></svg>,
  };
  return (
    <div style={{ padding: "18px 20px", border: `1px solid ${C.rule}`, borderRadius: 12, background: C.card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, font: '600 11px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          <span style={{ color: accent, display: "inline-flex" }}>{logos[name]}</span>
          {name}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ font: '700 30px/1 "Montserrat", sans-serif', color: C.ink, letterSpacing: "-0.02em" }}>{followers}</div>
        <div style={{ font: '500 12px/1 "Montserrat", sans-serif', color: C.mute }}>followers</div>
      </div>
      {handle && <div style={{ font: '500 12px/1.3 "JetBrains Mono", monospace', color: C.ink2 }}>{handle.startsWith("@") ? handle : `@${handle}`}</div>}
    </div>
  );
}

export function Metric({ label, value, sub, hue }) {
  return (
    <div style={{ padding: "16px 18px", border: `1px solid ${C.rule}`, borderRadius: 12, background: C.card, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.14em", textTransform: "uppercase" }}>
        {hue && <span style={{ width: 6, height: 6, borderRadius: 999, background: hue }} />}
        {label}
      </div>
      <div style={{ font: '700 26px/1.05 "Montserrat", sans-serif', color: C.ink, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ font: '500 11.5px/1.3 "Montserrat", sans-serif', color: C.mute }}>{sub}</div>}
    </div>
  );
}

export function BrandCard({ heading, items, accent, icon }) {
  return (
    <div style={{ padding: "20px 22px", background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ width: 28, height: 28, borderRadius: 6, background: accent + "1a", color: accent, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
        <div style={{ font: '700 13px/1 "Montserrat", sans-serif', color: C.ink, letterSpacing: "0.04em", textTransform: "uppercase" }}>{heading}</div>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((it, i) => (
          <li key={i} style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 10, font: '400 13.5px/1.55 "Montserrat", sans-serif', color: C.ink2, textWrap: "pretty" }}>
            <span style={{ font: '600 11px/1.55 "JetBrains Mono", monospace', color: accent, opacity: 0.75 }}>{String(i + 1).padStart(2, "0")}</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FormatCard({ f, color, scriptCount, onJump }) {
  return (
    <article
      style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", transition: "border-color .15s, transform .15s", cursor: "pointer" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = color.fg + "55"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.rule; }}
      onClick={onJump}
    >
      <div style={{ aspectRatio: "9 / 16", width: "100%", background: `linear-gradient(135deg, ${color.bg} 0%, ${C.bgDim} 100%)`, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, opacity: 0.4, background: `repeating-linear-gradient(45deg, transparent 0 14px, ${color.fg}10 14px 15px)` }} />
        {f.ref && (
          <div style={{ position: "absolute", top: 14, left: 14, right: 14, display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 999, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: color.fg, border: `1px solid ${C.rule}`, boxShadow: "0 2px 6px rgba(11,18,32,0.06)" }}>@</div>
            <div style={{ font: '600 11px/1.2 "Montserrat", sans-serif', color: C.ink2, background: "rgba(255,255,255,0.85)", padding: "4px 8px", borderRadius: 4, backdropFilter: "blur(2px)" }}>{f.ref}</div>
          </div>
        )}
        <div style={{ width: 56, height: 56, borderRadius: 999, background: "rgba(255,255,255,0.96)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 24px rgba(11,18,32,0.18)", position: "relative", zIndex: 1 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill={color.fg}><path d="M8 5v14l11-7z" /></svg>
        </div>
        <div style={{ position: "absolute", bottom: 14, left: 14, font: '600 11px/1 "JetBrains Mono", monospace', color: color.fg, background: "rgba(255,255,255,0.85)", padding: "4px 8px", borderRadius: 4 }}>{f.n}</div>
      </div>
      <div style={{ padding: "16px 18px 18px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <h3 style={{ font: '700 16px/1.2 "Montserrat", sans-serif', color: C.ink, margin: 0 }}>{f.title}</h3>
        <p style={{ font: '400 12.5px/1.55 "Montserrat", sans-serif', color: C.ink2, margin: 0, textWrap: "pretty", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{f.blurb}</p>
        <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, paddingTop: 12, borderTop: `1px solid ${C.ruleSoft}` }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, font: '600 11px/1 "Montserrat", sans-serif', color: color.fg }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: color.fg }} />
            {scriptCount} script{scriptCount === 1 ? "" : "s"}
          </span>
          <span style={{ font: '500 11px/1 "Montserrat", sans-serif', color: C.muteSoft }}>Jump ↓</span>
        </div>
      </div>
    </article>
  );
}

// Section-level feedback box: approve / changes verdict + free-text note,
// debounced autosave. Calls onSave({ verdict, text }) with the merged
// state every time the user clicks one of the verdict buttons or "Save".
export function FeedbackBox({ sectionLabel, state, onSave }) {
  const [text, setText] = useState(state?.text || "");
  const [verdict, setVerdict] = useState(state?.verdict || null);
  const [focus, setFocus] = useState(false);
  const submitted = !!state?.submittedAt;

  function persist(nextVerdict, nextText) {
    setVerdict(nextVerdict);
    onSave({ verdict: nextVerdict, text: nextText });
  }

  return (
    <div style={{ marginTop: 24, border: `1px solid ${focus ? C.blue : C.rule}`, borderRadius: 12, background: C.card, overflow: "hidden", transition: "border-color .15s, box-shadow .15s", boxShadow: focus ? `0 0 0 4px ${C.blueBg}` : "none" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", background: C.bg, borderBottom: `1px solid ${C.rule}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.blueDk} strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          <div style={{ font: '600 11px/1 "Montserrat", sans-serif', color: C.ink, letterSpacing: "0.08em", textTransform: "uppercase" }}>Section feedback · {sectionLabel}</div>
        </div>
        {submitted && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, font: '500 11px/1 "Montserrat", sans-serif', color: C.greenDk }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
            Saved · {new Date(state.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={`Leave a note on ${sectionLabel.toLowerCase()} — questions, changes, or things you love.`}
        rows={3}
        style={{ width: "100%", border: "none", padding: "16px 20px", font: '400 14.5px/1.55 "Montserrat", sans-serif', color: C.ink, background: "#fff", resize: "vertical", outline: "none", boxSizing: "border-box", minHeight: 90 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderTop: `1px solid ${C.rule}`, background: C.card, flexWrap: "wrap" }}>
        <PickBtn active={verdict === "approve"} kind="approve" onClick={() => persist("approve", text)}>Approve section</PickBtn>
        <PickBtn active={verdict === "changes"} kind="changes" onClick={() => persist("changes", text)}>Request changes</PickBtn>
        <div style={{ flex: 1 }} />
        <span style={{ font: '500 11px/1 "Montserrat", sans-serif', color: C.mute }}>{text.length} chars</span>
        <button
          onClick={() => persist(verdict, text)}
          disabled={!text.trim() && !verdict}
          style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: "#fff", background: (!text.trim() && !verdict) ? C.muteSoft : C.ink, border: "none", padding: "10px 16px", borderRadius: 6, cursor: (!text.trim() && !verdict) ? "not-allowed" : "pointer", transition: "background .12s" }}
        >Save note</button>
      </div>
    </div>
  );
}

export function PickBtn({ active, kind, onClick, children }) {
  const palette = kind === "approve"
    ? { bg: active ? C.greenBg : C.card, color: active ? C.greenDk : C.ink2, border: active ? C.green : C.rule }
    : { bg: active ? C.orangeBg : C.card, color: active ? C.orangeDk : C.ink2, border: active ? C.orange : C.rule };
  return (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: palette.color, background: palette.bg, border: `1px solid ${palette.border}`, padding: "9px 12px", borderRadius: 6, cursor: "pointer", transition: "all .12s" }}>
      {kind === "approve" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 6h18M3 12h18M3 18h12" /></svg>
      )}
      {children}
    </button>
  );
}

export function ViewixMark({ size = 30 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: 7, background: `linear-gradient(135deg, ${C.blueDk} 0%, ${C.blue} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", font: '800 13px/1 "Montserrat", sans-serif', letterSpacing: "-0.02em", boxShadow: "0 2px 6px rgba(0,79,153,0.25)" }}>VX</div>
  );
}

export function TopBar({ project, search, onSearch, onPrint }) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 36px", background: "rgba(244,245,249,0.94)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${C.rule}`, gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, font: '500 12px/1 "Montserrat", sans-serif', color: C.mute, flexShrink: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ color: C.ink, fontWeight: 600 }}>{project.client}</span>
        {project.productLine && <>
          <span style={{ color: C.muteSoft }}>›</span>
          <span>{project.productLine}</span>
        </>}
        {project.sentDate && <>
          <span style={{ color: C.muteSoft }}>·</span>
          <span>Sent {project.sentDate}</span>
        </>}
        {project.revision && <>
          <span style={{ color: C.muteSoft }}>·</span>
          <span>Rev {project.revision}</span>
        </>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ position: "relative" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="2" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search scripts, hooks, props…"
            style={{ width: 280, padding: "9px 12px 9px 34px", font: '500 12.5px/1 "Montserrat", sans-serif', color: C.ink, background: C.card, border: `1px solid ${C.rule}`, borderRadius: 8, outline: "none", boxSizing: "border-box" }}
            onFocus={(e) => { e.target.style.borderColor = C.blue; e.target.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }}
            onBlur={(e) => { e.target.style.borderColor = C.rule; e.target.style.boxShadow = "none"; }}
          />
        </div>
        <button onClick={onPrint} style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.08em", textTransform: "uppercase", color: C.ink2, background: C.card, border: `1px solid ${C.rule}`, padding: "9px 12px", borderRadius: 6, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
          Print
        </button>
      </div>
    </div>
  );
}

export function SubmitDock({ visible, reviewed, total, onSubmit }) {
  if (!visible) return null;
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 20, background: C.ink, color: "#fff", padding: "14px 18px 14px 20px", borderRadius: 14, display: "flex", alignItems: "center", gap: 16, boxShadow: "0 12px 32px rgba(11,18,32,0.3)", border: `1px solid #1f2937`, maxWidth: 460 }}>
      <div style={{ width: 36, height: 36, borderRadius: 999, background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A6F4C5" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
      </div>
      <div>
        <div style={{ font: '600 13px/1.2 "Montserrat", sans-serif' }}>You have feedback to send</div>
        <div style={{ font: '500 11.5px/1.4 "Montserrat", sans-serif', opacity: 0.7, marginTop: 2 }}>{reviewed} of {total} sections reviewed · we&apos;ll respond within 1 business day</div>
      </div>
      <button onClick={onSubmit} style={{ font: '700 11px/1 "Montserrat", sans-serif', letterSpacing: "0.08em", textTransform: "uppercase", color: "#fff", background: C.orange, border: "none", padding: "11px 16px", borderRadius: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        Submit review
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  );
}

export function SubmitModal({ open, onClose, onConfirm, reviewed, total, scriptStats, submitting, error, alreadySubmittedAt }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(11,18,32,0.55)", backdropFilter: "blur(6px)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: 16, width: "100%", maxWidth: 520, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.35)" }}>
        <div style={{ padding: "26px 28px 18px", borderBottom: `1px solid ${C.rule}` }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: C.greenBg, color: C.greenDk, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
          </div>
          <h3 style={{ font: '700 22px/1.2 "Montserrat", sans-serif', color: C.ink, margin: 0, letterSpacing: "-0.01em" }}>{alreadySubmittedAt ? "Resend your feedback?" : "Send your feedback to Viewix?"}</h3>
          <p style={{ font: '400 14px/1.55 "Montserrat", sans-serif', color: C.ink2, margin: "8px 0 0" }}>
            {alreadySubmittedAt
              ? `You already submitted on ${new Date(alreadySubmittedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Submitting again will ping the producer with the latest feedback.`
              : "We'll bundle everything below and respond within 1 business day with the next revision or a kickoff call."}
          </p>
        </div>
        <div style={{ padding: "20px 28px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ padding: "14px 16px", background: C.bg, borderRadius: 10 }}>
            <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>Sections</div>
            <div style={{ font: '700 22px/1 "Montserrat", sans-serif', color: C.ink, letterSpacing: "-0.01em" }}>{reviewed}/{total} reviewed</div>
          </div>
          <div style={{ padding: "14px 16px", background: C.bg, borderRadius: 10 }}>
            <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>Script feedback</div>
            <div style={{ display: "flex", gap: 10, font: '600 13px/1 "Montserrat", sans-serif' }}>
              <span style={{ color: C.greenDk }}>{scriptStats.love} love</span>
              <span style={{ color: C.orangeDk }}>{scriptStats.tweak} tweak</span>
              <span style={{ color: C.red }}>{scriptStats.cut} cut</span>
            </div>
          </div>
        </div>
        {error && (
          <div style={{ margin: "0 28px 16px", padding: "10px 14px", background: C.redBg, color: C.red, borderRadius: 8, font: '500 12px/1.5 "Montserrat", sans-serif' }}>
            {error}
          </div>
        )}
        <div style={{ padding: "16px 28px 26px", display: "flex", justifyContent: "flex-end", gap: 10, borderTop: `1px solid ${C.rule}`, background: C.bg }}>
          <button onClick={onClose} disabled={submitting} style={{ font: '600 12px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: C.ink2, background: C.card, border: `1px solid ${C.rule}`, padding: "12px 18px", borderRadius: 8, cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.6 : 1 }}>Keep reviewing</button>
          <button onClick={onConfirm} disabled={submitting} style={{ font: '700 12px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: "#fff", background: C.orange, border: "none", padding: "12px 22px", borderRadius: 8, cursor: submitting ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 8, opacity: submitting ? 0.6 : 1 }}>
            {submitting ? "Submitting…" : "Submit review"}
            {!submitting && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6" /></svg>}
          </button>
        </div>
      </div>
    </div>
  );
}
