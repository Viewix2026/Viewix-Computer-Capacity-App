import { sCol, gSC, pct } from "../utils";
import { BTN } from "../config";

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

export function SideIcon({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "12px 8px", borderRadius: 8, border: "none", background: active ? "var(--accent-soft)" : "transparent", color: active ? "var(--accent)" : "var(--muted)", cursor: "pointer", width: "100%", transition: "all 0.15s" }} title={label}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase" }}>{label}</span>
    </button>
  );
}
