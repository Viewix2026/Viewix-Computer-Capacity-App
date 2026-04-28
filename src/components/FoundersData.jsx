// Founders Data — monthly metrics log + raw data table.
//
// The previous Tier 1 / Tier 2 / Tier 3 picker has been removed. All
// fields are visible all the time, grouped by category. The Trends
// grid that used to live here has moved to the Dashboard sub-tab so
// every visualisation in the Founders area is in one place. This tab
// is now purely the data-entry + audit surface.
//
// Data shape on disk (Firebase /foundersMetrics):
//   {
//     "2026-04": { date: "2026-04", <fieldKey>: <number or "">, ... },
//     "2026-03": { ... }
//   }

import { useState } from "react";
import { BTN } from "../config";
import {
  CATEGORIES, CATEGORY_COLORS, ALL_FIELDS, formatValue,
} from "./foundersShared";

export function FoundersData({ metrics, setMetrics }) {
  const [editDate, setEditDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [editVals, setEditVals] = useState({});
  // Default-open all categories so producers see everything they could
  // possibly log without an extra click. Operations is opened by
  // default too now (it was collapsed under the prior tier scheme).
  const [openCategories, setOpenCategories] = useState(
    Object.fromEntries(CATEGORIES.map(c => [c.key, true]))
  );

  const entries = Object.values(metrics || {}).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const existing = metrics?.[editDate];
  const formVal = key => editVals[key] !== undefined ? editVals[key] : (existing?.[key] ?? "");

  const saveEntry = () => {
    const entry = { date: editDate };
    if (existing) {
      for (const k of Object.keys(existing)) entry[k] = existing[k];
    }
    ALL_FIELDS.forEach(f => {
      const raw = editVals[f.key] !== undefined ? editVals[f.key] : (existing?.[f.key] ?? "");
      entry[f.key] = raw === "" ? "" : (parseFloat(raw) || 0);
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

  const loadEntry = (date) => { setEditDate(date); setEditVals({}); };
  const toggleCategory = key => setOpenCategories(p => ({ ...p, [key]: !p[key] }));

  const inputSt = {
    padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none",
    fontFamily: "'DM Sans',sans-serif", width: "100%",
  };

  return (<>
    {/* Entry Form — all fields, grouped by category, in McKinsey-funnel
        order: Revenue, Conversion, Acquisition, Sources, LTV+CAC,
        Retention, Risk, Operations. */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Log Monthly Data</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Pick a month, fill what you have, save. Trends visualised on the Dashboard tab.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="month" value={editDate} onChange={e => { setEditDate(e.target.value); setEditVals({}); }} style={{ ...inputSt, width: 160 }} />
          <button onClick={saveEntry} style={{ ...BTN, background: "var(--accent)", color: "white", fontSize: 12, padding: "6px 16px" }}>{existing ? "Update" : "Save"}</button>
        </div>
      </div>
      {existing && <div style={{ fontSize: 11, color: "#F59E0B", marginBottom: 12 }}>Editing existing entry for {editDate}. Save will overwrite the values shown.</div>}

      <div style={{ display: "grid", gap: 10 }}>
        {CATEGORIES.map(cat => {
          const catFields = ALL_FIELDS.filter(f => f.category === cat.key);
          if (!catFields.length) return null;
          const isOpen = !!openCategories[cat.key];
          const colour = CATEGORY_COLORS[cat.key];
          return (
            <div key={cat.key} style={{
              background: "var(--bg)",
              border: `1px solid ${colour}33`,
              borderRadius: 8,
              boxShadow: `0 0 0 1px ${colour}22, 0 0 14px ${colour}1A`,
            }}>
              <button
                onClick={() => toggleCategory(cat.key)}
                style={{
                  width: "100%", padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                  fontFamily: "inherit",
                }}>
                <span style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: colour,
                  boxShadow: `0 0 8px ${colour}, 0 0 14px ${colour}55`,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "var(--fg)" }}>{cat.label}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>{cat.blurb}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>{catFields.length} field{catFields.length === 1 ? "" : "s"}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen && (
                <div style={{ padding: "0 14px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                  {catFields.map(f => (
                    <div key={f.key}>
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                        <span style={{ color: "var(--fg)", fontWeight: 600 }}>{f.label}</span>
                        <span style={{ color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>({f.unit})</span>
                        <span title={f.cadence} style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", textTransform: "uppercase" }}>{f.cadence?.[0] || ""}</span>
                      </label>
                      <input type="number" step="any"
                        value={formVal(f.key)}
                        onChange={e => setEditVals(p => ({ ...p, [f.key]: e.target.value }))}
                        style={inputSt}
                        placeholder={f.def ? f.def.slice(0, 40) + (f.def.length > 40 ? "…" : "") : "0"}
                        title={f.def}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>

    {/* Data Table — all logged months × all fields. Click a row to
        load that month into the form above. */}
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Logged Data</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{entries.length} month{entries.length === 1 ? "" : "s"} logged · {ALL_FIELDS.length} fields</div>
      </div>
      {entries.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          No data logged yet. Use the form above to add your first month.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left", position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>Month</th>
                {ALL_FIELDS.map(f => (
                  <th key={f.key} style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: CATEGORY_COLORS[f.category], textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right", whiteSpace: "nowrap" }} title={f.def}>
                    {f.label}
                  </th>
                ))}
                <th style={{ padding: "8px 10px", borderBottom: "2px solid var(--border)" }} />
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.date} style={{ cursor: "pointer" }} onClick={() => loadEntry(e.date)}>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--fg)", position: "sticky", left: 0, background: "var(--card)", zIndex: 1, fontFamily: "'JetBrains Mono',monospace" }}>{e.date}</td>
                  {ALL_FIELDS.map(f => (
                    <td key={f.key} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)", whiteSpace: "nowrap" }}>
                      {formatValue(e[f.key], f.unit)}
                    </td>
                  ))}
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-light)" }}>
                    <button onClick={ev => { ev.stopPropagation(); deleteEntry(e.date); }}
                      title="Delete this month's entry"
                      style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12, cursor: "pointer", padding: "2px 6px" }}>
                      ×
                    </button>
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
