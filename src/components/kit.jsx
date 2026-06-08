// ════════════════════════════════════════════════════════════════════
// Viewix Kit — the unified component vocabulary from the design language,
// as real React primitives wired to the CSS-var tokens in config.js (so
// they theme with the rest of the app rather than carrying their own
// hardcoded palette). Additive: tabs adopt these as they're reskinned.
// ════════════════════════════════════════════════════════════════════
import { useState } from "react";
import { Icon } from "./Icon";

const SANS = "'DM Sans', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// Brand-mark monogram (hue derived from the name) for missing logos.
function hueFor(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
function initials(raw = "") {
  const name = String(raw ?? "");             // safe even if called directly
  const w = name.replace(/[^A-Za-z0-9 &]/g, "").split(/\s+/).filter(Boolean);
  if (!w.length) return "—";
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}
export function Monogram({ name, size = 44, radius = 12 }) {
  const safeName = String(name ?? "");        // guard null/undefined/number
  const hue = hueFor(safeName);
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flex: "0 0 auto",
      background: `linear-gradient(145deg, oklch(0.45 0.13 ${hue}) 0%, oklch(0.32 0.10 ${hue + 22}) 100%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
    }}>
      <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: size * 0.37,
        color: "rgba(255,255,255,0.94)", letterSpacing: "-0.01em" }}>{initials(safeName)}</span>
    </div>
  );
}

// Button — variants: primary | ghost | quiet | danger ; sizes sm | md
export function Btn({ children, variant = "primary", size = "md", icon, onClick, style, type }) {
  const [h, setH] = useState(false);
  const pad = size === "sm" ? "7px 12px" : "9px 16px";
  const fs = size === "sm" ? 12 : 13;
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
    fontFamily: SANS, fontSize: fs, fontWeight: 700, letterSpacing: "0.005em",
    padding: pad, borderRadius: "var(--r2)", cursor: "pointer", whiteSpace: "nowrap",
    transition: "all .15s ease", border: "1px solid transparent",
  };
  const styles = {
    primary: { background: h ? "var(--accent-bright)" : "var(--accent)", color: "#fff",
      boxShadow: h ? "var(--glow)" : "0 1px 0 rgba(255,255,255,0.12) inset, 0 6px 18px -10px rgba(0,130,250,0.8)" },
    ghost:   { background: h ? "var(--card-2)" : "transparent", color: "var(--fg)", border: "1px solid var(--border)" },
    quiet:   { background: h ? "var(--card-2)" : "var(--card)", color: "var(--fg-2)", border: "1px solid var(--border-soft)" },
    danger:  { background: h ? "rgba(242,84,91,0.16)" : "transparent", color: "var(--danger)", border: "1px solid rgba(242,84,91,0.3)" },
  };
  return (
    <button type={type} onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ ...base, ...styles[variant], ...style }}>
      {icon && <Icon name={icon} size={fs + 4} sw={2} />}{children}
    </button>
  );
}

// Toggle — pill switch (on = success)
export function Toggle({ on, size = "md", onClick }) {
  const w = size === "sm" ? 38 : 44, hgt = size === "sm" ? 22 : 25, knob = hgt - 6;
  return (
    <button onClick={onClick} style={{
      width: w, height: hgt, borderRadius: hgt, padding: 0, cursor: "pointer", flex: "0 0 auto",
      border: "1px solid " + (on ? "rgba(30,192,129,0.55)" : "var(--border)"),
      background: on ? "var(--success)" : "rgba(255,255,255,0.05)", position: "relative",
      transition: "all .18s ease", boxShadow: on ? "0 0 0 3px var(--success-soft)" : "none",
    }}>
      <span style={{ position: "absolute", top: 2, left: on ? w - knob - 3 : 2, width: knob, height: knob,
        borderRadius: "50%", background: on ? "#fff" : "#8295B0", transition: "left .18s ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)" }} />
    </button>
  );
}

// StatusPill — loud status. tone via `color`; `solid` for the bright fill.
export function StatusPill({ label, color = "var(--accent)", solid }) {
  return (
    <span style={{
      fontFamily: SANS, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em",
      textTransform: "uppercase", padding: "5px 11px", borderRadius: "var(--r1)", whiteSpace: "nowrap",
      display: "inline-flex", alignItems: "center", gap: 6,
      background: solid ? color : `color-mix(in oklab, ${color} 16%, transparent)`,
      color: solid ? "#08110C" : color,
      border: solid ? "none" : `1px solid color-mix(in oklab, ${color} 38%, transparent)`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: solid ? "#08110C" : color, opacity: solid ? 0.65 : 1 }} />
      {label}
    </span>
  );
}

// Tag — translucent category tag (hue driven)
export function Tag({ children, hue = 230, mono }) {
  return (
    <span style={{
      fontFamily: mono ? MONO : SANS, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em",
      textTransform: "uppercase", padding: "3px 9px", borderRadius: "var(--r1)", whiteSpace: "nowrap",
      color: `oklch(0.80 0.11 ${hue})`, background: `oklch(0.80 0.11 ${hue} / 0.14)`,
      border: `1px solid oklch(0.80 0.11 ${hue} / 0.24)`,
    }}>{children}</span>
  );
}

// DataChip — mono metadata chip with optional icon
export function DataChip({ icon, children, tone }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 11,
      fontWeight: 600, color: tone || "var(--fg-2)", background: "rgba(255,255,255,0.035)",
      border: "1px solid var(--border)", padding: "4px 9px", borderRadius: "var(--r1)", whiteSpace: "nowrap",
    }}>{icon && <Icon name={icon} size={13} sw={1.8} />}{children}</span>
  );
}

// ConfigChip — set/unset capability chip
export function ConfigChip({ label, set, accent }) {
  const color = accent ? "var(--orange)" : "var(--success)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, fontFamily: SANS, fontSize: 11,
      fontWeight: 600, padding: "3px 9px 3px 7px", borderRadius: 99,
      border: "1px solid " + (set ? "transparent" : "var(--border)"),
      background: set ? (accent ? "var(--orange-soft)" : "var(--success-soft)") : "transparent",
      color: set ? (accent ? "#F9A35A" : "#34D9A0") : "var(--muted)",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: set ? color : "transparent",
        border: set ? "none" : "1.5px solid var(--muted)" }} />{label}
    </span>
  );
}

// SectionHeader — dotted group header (UNCOMMISSIONED · 9)
export function SectionHeader({ dot = "var(--accent)", label, count, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 0" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
      <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 800, letterSpacing: "0.09em",
        textTransform: "uppercase", color: "var(--fg)" }}>{label}</span>
      {count != null && <>
        <span style={{ color: "var(--faint)" }}>·</span>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{count}</span>
      </>}
      {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
    </div>
  );
}

// MetricCard — KPI tile
export function MetricCard({ label, value, sub, accent, delta }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r4)",
      padding: "16px 18px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 100% at 0% 0%, rgba(255,255,255,0.03), transparent 55%)", pointerEvents: "none" }} />
      <div style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700, letterSpacing: "0.08em",
        textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: accent || "var(--fg)", fontFamily: MONO, lineHeight: 1, letterSpacing: "-0.02em" }}>{value}</div>
        {delta && <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700,
          color: delta[0] === "+" ? "var(--success)" : "var(--danger)" }}>{delta}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 7 }}>{sub}</div>}
    </div>
  );
}

// SearchBox — display shell matching the Projects controls bar
export function SearchBox({ placeholder = "Search…", width = 240, value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, width, height: 38, padding: "0 14px",
      borderRadius: "var(--r2)", border: "1px solid var(--border)", background: "var(--inset)" }}>
      <Icon name="search" size={16} stroke="var(--muted)" sw={1.8} />
      {onChange
        ? <input value={value} onChange={onChange} placeholder={placeholder} style={{ flex: 1, border: "none",
            outline: "none", background: "transparent", fontFamily: SANS, fontSize: 13.5, color: "var(--fg)" }} />
        : <span style={{ fontFamily: SANS, fontSize: 13.5, color: "var(--muted)" }}>{placeholder}</span>}
    </div>
  );
}

// Segmented control
export function Segmented({ options, active, onSelect }) {
  return (
    <div style={{ display: "inline-flex", gap: 3, background: "var(--inset)", borderRadius: "var(--r2)",
      padding: 3, border: "1px solid var(--border-soft)" }}>
      {options.map(o => (
        <span key={o} onClick={() => onSelect && onSelect(o)} style={{ padding: "6px 13px", borderRadius: "var(--r1)", fontFamily: SANS,
          fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          background: o === active ? "var(--card-2)" : "transparent", color: o === active ? "var(--fg)" : "var(--muted)",
          boxShadow: o === active ? "var(--shadow1)" : "none" }}>{o}</span>
      ))}
    </div>
  );
}

// Underline tab strip
export function Tabs({ options, active, onSelect }) {
  return (
    <div style={{ display: "flex", gap: 22, borderBottom: "1px solid var(--border)" }}>
      {options.map(o => {
        const on = o === active;
        return (
          <span key={o} onClick={() => onSelect && onSelect(o)} style={{ position: "relative", padding: "0 1px 13px", fontFamily: SANS,
            fontSize: 14, fontWeight: on ? 700 : 600, color: on ? "var(--fg)" : "var(--muted)", cursor: "pointer" }}>
            {o}
            {on && <span style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2,
              borderRadius: 2, background: "var(--accent)" }} />}
          </span>
        );
      })}
    </div>
  );
}

// ProgressBar — utilisation style (colour-codes by load)
export function ProgressBar({ value, height = 8 }) {
  const w = Math.min(value, 1) * 100;
  const c = value >= 0.95 ? "var(--danger)" : value >= 0.85 ? "var(--amber)" : value >= 0.7 ? "#E0C04A" : "var(--success)";
  return (
    <div style={{ width: "100%", height, background: "rgba(255,255,255,0.06)", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: w + "%", height: "100%", borderRadius: height / 2, background: c }} />
    </div>
  );
}
