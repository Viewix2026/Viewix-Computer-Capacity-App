import { useState } from "react";
import { BTN } from "../config";

const METRICS = [
  { key: "cac", label: "CAC", unit: "$", group: "cost" },
  { key: "ltv", label: "LTV", unit: "$", group: "cost" },
  { key: "cpl", label: "CPL", unit: "$", group: "cost" },
  { key: "cpm", label: "CPM", unit: "$", group: "cost" },
  { key: "predictedAdSpend", label: "Predicted Ad Spend", unit: "$", group: "spend" },
  { key: "dailyAdSpendGoal", label: "Daily Ad Spend Goal", unit: "$", group: "spend" },
  { key: "monthlyAdSpend", label: "Monthly Ad Spend", unit: "$", group: "spend" },
  { key: "tenMonthAdSpend", label: "10 Month Ad Spend", unit: "$", group: "spend" },
  { key: "dailyChurnRate", label: "Daily Churn Rate", unit: "%", group: "rate" },
  { key: "showRate", label: "Show Rate", unit: "%", group: "rate" },
  { key: "conversionRate", label: "Conversion Rate", unit: "%", group: "rate" },
];

const COLORS = ["#0082FA","#10B981","#F59E0B","#EF4444","#8B5CF6","#F87700","#EC4899","#06B6D4","#84CC16","#6366F1","#14B8A6"];

function LineChart({ entries, visibleKeys, height = 220 }) {
  if (!entries || entries.length < 2) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>Need at least 2 data points to show a chart</div>;
  const W = 700, H = height, PAD = { t: 20, r: 20, b: 40, l: 60 };
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;

  const activeMetrics = METRICS.filter(m => visibleKeys.includes(m.key));
  if (activeMetrics.length === 0) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>Select metrics to display</div>;

  let allVals = [];
  activeMetrics.forEach(m => { entries.forEach(e => { const v = parseFloat(e[m.key]); if (!isNaN(v)) allVals.push(v); }); });
  const minV = Math.min(...allVals, 0);
  const maxV = Math.max(...allVals, 1);
  const range = maxV - minV || 1;

  const xStep = cw / (entries.length - 1);
  const yScale = v => PAD.t + ch - ((v - minV) / range) * ch;
  const xPos = i => PAD.l + i * xStep;

  const gridLines = 5;
  const gridStep = range / gridLines;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
      {Array.from({ length: gridLines + 1 }).map((_, i) => {
        const val = minV + i * gridStep;
        const y = yScale(val);
        return <g key={i}>
          <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#1E2A3A" strokeWidth={1} />
          <text x={PAD.l - 8} y={y + 4} fill="#5A6B85" fontSize={9} textAnchor="end" fontFamily="'JetBrains Mono',monospace">
            {val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(val < 10 ? 1 : 0)}
          </text>
        </g>;
      })}
      {entries.map((e, i) => (
        <text key={i} x={xPos(i)} y={H - 8} fill="#5A6B85" fontSize={9} textAnchor="middle" fontFamily="'JetBrains Mono',monospace">
          {e.label || e.date}
        </text>
      ))}
      {activeMetrics.map((m, mi) => {
        const color = COLORS[METRICS.indexOf(m) % COLORS.length];
        const points = entries.map((e, i) => {
          const v = parseFloat(e[m.key]);
          if (isNaN(v)) return null;
          return { x: xPos(i), y: yScale(v), v };
        }).filter(Boolean);
        if (points.length < 2) return null;
        const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
        return <g key={m.key}>
          <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3.5} fill={color} stroke="#0B0F1A" strokeWidth={2} />)}
        </g>;
      })}
    </svg>
  );
}

export function FoundersData({ metrics, setMetrics }) {
  const [editDate, setEditDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [editVals, setEditVals] = useState({});
  const [chartMode, setChartMode] = useState("combined");
  const [visibleKeys, setVisibleKeys] = useState(METRICS.map(m => m.key));

  const entries = Object.values(metrics || {}).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const entryLabels = entries.map(e => {
    const [y, m] = (e.date || "").split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return { ...e, label: `${months[parseInt(m) - 1] || m} ${y?.slice(2)}` };
  });

  const existing = metrics?.[editDate];
  const formVals = key => editVals[key] !== undefined ? editVals[key] : (existing?.[key] ?? "");

  const saveEntry = () => {
    const entry = { date: editDate };
    METRICS.forEach(m => {
      const v = editVals[m.key] !== undefined ? editVals[m.key] : (existing?.[m.key] ?? "");
      entry[m.key] = v === "" ? "" : parseFloat(v) || 0;
    });
    setMetrics(prev => ({ ...prev, [editDate]: entry }));
    setEditVals({});
  };

  const deleteEntry = (date) => {
    if (!confirm(`Delete data for ${date}?`)) return;
    setMetrics(prev => {
      const next = { ...prev };
      delete next[date];
      return next;
    });
  };

  const loadEntry = (date) => {
    setEditDate(date);
    setEditVals({});
  };

  const toggleKey = key => {
    setVisibleKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const inputSt = { padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "'DM Sans',sans-serif", width: "100%" };

  const costKeys = METRICS.filter(m => m.group === "cost").map(m => m.key);
  const spendKeys = METRICS.filter(m => m.group === "spend").map(m => m.key);
  const rateKeys = METRICS.filter(m => m.group === "rate").map(m => m.key);

  return (<>
    {/* Entry Form */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Log Monthly Data</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="month" value={editDate} onChange={e => { setEditDate(e.target.value); setEditVals({}); }} style={{ ...inputSt, width: 160 }} />
          <button onClick={saveEntry} style={{ ...BTN, background: "var(--accent)", color: "white", fontSize: 12, padding: "6px 16px" }}>{existing ? "Update" : "Save"}</button>
        </div>
      </div>
      {existing && <div style={{ fontSize: 11, color: "#F59E0B", marginBottom: 12 }}>Editing existing entry for {editDate}. Changes will overwrite.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Cost Metrics</div>
          {METRICS.filter(m => m.group === "cost").map(m => (
            <div key={m.key} style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 3 }}>{m.label} ({m.unit})</label>
              <input type="number" step="any" value={formVals(m.key)} onChange={e => setEditVals(p => ({ ...p, [m.key]: e.target.value }))} style={inputSt} placeholder="0" />
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Ad Spend</div>
          {METRICS.filter(m => m.group === "spend").map(m => (
            <div key={m.key} style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 3 }}>{m.label} ({m.unit})</label>
              <input type="number" step="any" value={formVals(m.key)} onChange={e => setEditVals(p => ({ ...p, [m.key]: e.target.value }))} style={inputSt} placeholder="0" />
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Rate Metrics</div>
          {METRICS.filter(m => m.group === "rate").map(m => (
            <div key={m.key} style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 3 }}>{m.label} ({m.unit})</label>
              <input type="number" step="any" value={formVals(m.key)} onChange={e => setEditVals(p => ({ ...p, [m.key]: e.target.value }))} style={inputSt} placeholder="0" />
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Charts */}
    {entryLabels.length >= 2 && (<div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Trends</div>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          {[{ key: "combined", label: "All Metrics" }, { key: "grouped", label: "Grouped" }].map(t => (
            <button key={t.key} onClick={() => setChartMode(t.key)} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: chartMode === t.key ? "var(--card)" : "transparent", color: chartMode === t.key ? "var(--fg)" : "var(--muted)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
          ))}
        </div>
      </div>

      {chartMode === "combined" && (<>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {METRICS.map((m, i) => {
            const active = visibleKeys.includes(m.key);
            const color = COLORS[i % COLORS.length];
            return <button key={m.key} onClick={() => toggleKey(m.key)} style={{ padding: "4px 10px", borderRadius: 4, border: "none", background: active ? `${color}20` : "var(--bg)", color: active ? color : "var(--muted)", fontSize: 10, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? color : "var(--muted)", opacity: active ? 1 : 0.3 }} />
              {m.label}
            </button>;
          })}
        </div>
        <LineChart entries={entryLabels} visibleKeys={visibleKeys} />
      </>)}

      {chartMode === "grouped" && (<>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Cost Metrics (CAC, LTV, CPL, CPM)</div>
          <LineChart entries={entryLabels} visibleKeys={costKeys} height={180} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Ad Spend</div>
          <LineChart entries={entryLabels} visibleKeys={spendKeys} height={180} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Rate Metrics (Churn, Show Rate, Conversion)</div>
          <LineChart entries={entryLabels} visibleKeys={rateKeys} height={180} />
        </div>
      </>)}
    </div>)}

    {/* Data Table */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Logged Data</div>
      {entries.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No data logged yet. Use the form above to add your first month.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead><tr>
              <th style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left", position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>Month</th>
              {METRICS.map(m => <th key={m.key} style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right", whiteSpace: "nowrap" }}>{m.label}</th>)}
              <th style={{ padding: "8px 10px", borderBottom: "2px solid var(--border)" }} />
            </tr></thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.date} style={{ cursor: "pointer" }} onClick={() => loadEntry(e.date)}>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--fg)", position: "sticky", left: 0, background: "var(--card)", zIndex: 1, fontFamily: "'JetBrains Mono',monospace" }}>{e.date}</td>
                  {METRICS.map(m => <td key={m.key} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>
                    {e[m.key] !== "" && e[m.key] !== undefined ? `${m.unit === "$" ? "$" : ""}${typeof e[m.key] === "number" ? e[m.key].toLocaleString() : e[m.key]}${m.unit === "%" ? "%" : ""}` : ""}
                  </td>)}
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)" }}>
                    <button onClick={ev => { ev.stopPropagation(); deleteEntry(e.date); }} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12, cursor: "pointer", padding: "2px 6px" }}>x</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </>);
}
