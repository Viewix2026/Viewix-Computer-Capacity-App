import { sCol, gSC, pct } from "../utils";
import { BTN } from "../config";
import { Icon, ICON_PATHS } from "./Icon";

export function Badge({ util, large }) {
  const s = large ? gSC(util) : sCol(util);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: large ? "8px 20px" : "3px 10px", borderRadius: 6, fontSize: large ? 15 : 11, fontWeight: 700, letterSpacing: "0.05em", background: s.bg, color: s.text, border: large ? "none" : `1px solid ${s.border}`, boxShadow: large ? s.glow : "none", fontFamily: "'JetBrains Mono',monospace" }}>
      <span style={{ width: large ? 10 : 7, height: large ? 10 : 7, borderRadius: "50%", background: s.text, opacity: 0.7 }} />{s.label}
    </span>
  );
}

export function Metric({ label, value, sub, accent }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: accent || "var(--fg)", fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export function NumIn({ label, value, onChange, step, min, max, suffix }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "0.03em", textTransform: "uppercase" }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="number" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} step={step} min={min} max={max}
          style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 15, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace", outline: "none" }} />
        {suffix && <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{suffix}</span>}
      </div>
    </div>
  );
}

export function UBar({ value, height = 16 }) {
  const w = Math.min((Math.min(value, 1.5) / 1.2) * 100, 100);
  return (
    <div style={{ width: "100%", height, background: "var(--bar-bg)", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: `${w}%`, height: "100%", borderRadius: height / 2, transition: "width 0.4s", background: value >= 0.95 ? "#EF4444" : value >= 0.85 ? "#F59E0B" : value >= 0.7 ? "#EAB308" : "#10B981" }} />
    </div>
  );
}

export function FChart({ forecast }) {
  const mx = Math.max(...forecast.map(f => f.workload), 1);
  const H = 200;
  return (
    <div style={{ height: H + 50, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-end", height: H, gap: 2, padding: "0 4px" }}>
        {forecast.map((f, i) => {
          const h = (f.workload / (mx * 1.15)) * H;
          const c = f.realUtil >= 0.95 ? "#EF4444" : f.realUtil >= 0.85 ? "#F59E0B" : f.realUtil >= 0.7 ? "#EAB308" : "#10B981";
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>{Math.round(f.workload)}h</span>
              <div style={{ width: "70%", height: h, background: c, borderRadius: "4px 4px 0 0", opacity: 0.7 + (i / forecast.length) * 0.3 }} title={`W${f.week}: ${f.projects}p, ${f.workload}h, ${pct(f.realUtil)}`} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", padding: "6px 4px 0", gap: 2 }}>
        {forecast.map((f, i) => <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 10, fontWeight: 600, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>W{f.week}</div>)}
      </div>
    </div>
  );
}

export function StatusSelect({ value, options, colors, onChange, disabled }) {
  const col = colors[value] || "var(--muted)";
  return (
    <select value={value || ""} onChange={e => onChange(e.target.value)} disabled={disabled}
      style={{ padding: "4px 8px", borderRadius: 4, border: "none", background: value ? `${col}20` : "var(--bg)", color: value ? col : "var(--muted)", fontSize: 11, fontWeight: 700, cursor: disabled ? "default" : "pointer", outline: "none", appearance: "auto", textTransform: "uppercase" }}>
      <option value="">—</option>
      {options.filter(o => o).map(o => (<option key={o} value={o}>{o}</option>))}
    </select>
  );
}

// ── Pop sidebar rail ────────────────────────────────────────────────
// Every tab carries a signature hue; the glyph rides a soft tinted tile,
// and the active item ignites into a vivid gradient with a glow + colour
// edge-marker. The gradient tiles restore the warmth/cuteness of the old
// emoji rail while giving the chrome a deliberate, designed feel.
//
// RAIL_GLYPH flips the in-tile glyph between the original emoji ("emoji",
// the shipped default — keeps the familiar look) and a crisp SVG line set
// ("line" — device-consistent, no emoji rendering variance) in the same
// Pop treatment.
export const RAIL_GLYPH = "emoji";

// Signature hue + line-icon name per tab. App.jsx passes `name` (and may
// override `hue`); the emoji it already passes is kept for the emoji
// variant and as a fallback.
export const NAV_META = {
  home:      { icon: "home",      hue: 32 },
  founders:  { icon: "founders",  hue: 85 },
  capacity:  { icon: "capacity",  hue: 240 },
  sale:      { icon: "sale",      hue: 152 },
  accounts:  { icon: "accounts",  hue: 292 },
  projects:  { icon: "projects",  hue: 58 },
  analytics: { icon: "analytics", hue: 196 },
  socials:   { icon: "socials",   hue: 218 },
  preprod:   { icon: "preprod",   hue: 100 },
  editors:   { icon: "editors",   hue: 350 },
  training:  { icon: "training",  hue: 272 },
  resources: { icon: "resources", hue: 175 },
  users:     { icon: "users",     hue: 15 },
};

export function SideIcon({ icon, name, hue, label, active, onClick }) {
  const meta = NAV_META[name] || {};
  const h = hue ?? meta.hue ?? 220;
  const glyphName = meta.icon || name;
  const tile = {
    width: 40, height: 36, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center",
    transition: "all .18s ease", transform: active ? "translateY(-1px)" : "none",
    background: active
      ? `linear-gradient(150deg, oklch(0.72 0.19 ${h}), oklch(0.55 0.17 ${h + 18}))`
      : `oklch(0.70 0.12 ${h} / 0.16)`,
    border: active ? `1px solid oklch(0.85 0.12 ${h} / 0.6)` : `1px solid oklch(0.70 0.12 ${h} / 0.10)`,
    color: active ? "#fff" : `oklch(0.80 0.135 ${h})`,
    boxShadow: active
      ? `0 6px 16px -6px oklch(0.65 0.2 ${h} / 0.85), inset 0 1px 0 rgba(255,255,255,0.35)`
      : "none",
  };
  return (
    <button onClick={onClick} title={label} style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "5px 5px",
      borderRadius: 10, border: "none", background: "transparent", cursor: "pointer", width: "100%",
      position: "relative",
    }}>
      {active && <span style={{ position: "absolute", left: -7, top: "50%", transform: "translateY(-50%)",
        width: 3, height: 24, borderRadius: 3, background: `oklch(0.78 0.17 ${h})`,
        boxShadow: `0 0 12px oklch(0.78 0.18 ${h} / 0.9)` }} />}
      <div style={tile}>
        {/* Emoji mode, or line mode with no matching glyph path, falls back
            to the emoji so a tile is never rendered empty. */}
        {(RAIL_GLYPH === "emoji" || !ICON_PATHS[glyphName]) && icon
          ? <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
          : <Icon name={glyphName} size={20} sw={active ? 2.1 : 1.85} />}
      </div>
      <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase",
        color: active ? `oklch(0.86 0.13 ${h})` : "var(--muted)" }}>{label}</span>
    </button>
  );
}
