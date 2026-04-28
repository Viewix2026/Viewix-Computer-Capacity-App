// FoundersGoals — sub-tab where the founder logs structured business
// goals (target value + unit + deadline + notes). Goals are stored
// at /foundersGoals/{goalId} via foundersData.goals — same write
// pattern the rest of the Founders area already uses.
//
// On first open, if there's no goal whose source === "revenueTarget",
// we auto-create one from the existing revenueTarget / currentRevenue
// fields so the headline number on the Dashboard shows up here too.
// Producers can edit it like any other goal; the Dashboard's
// right-side target keeps reading from the original
// foundersData.revenueTarget field.

import { useState, useEffect, useMemo } from "react";

const UNIT_OPTIONS = [
  { value: "$",       label: "$ (currency)" },
  { value: "clients", label: "clients" },
  { value: "videos",  label: "videos" },
  { value: "%",       label: "%" },
  { value: "x",       label: "× (multiplier)" },
  { value: "count",   label: "count" },
];

function fmtValue(v, unit) {
  if (v === "" || v == null || Number.isNaN(+v)) return "—";
  const n = +v;
  if (unit === "$") return `$${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;
  if (unit === "%") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })}%`;
  if (unit === "x") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}×`;
  return `${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}${unit && unit !== "count" ? " " + unit : ""}`;
}

function progressPct(current, target) {
  const t = +target;
  if (!t || Number.isNaN(t)) return 0;
  return Math.max(0, Math.min(((+current || 0) / t) * 100, 999));
}

const newGoal = () => ({
  id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  title: "",
  target: "",
  unit: "$",
  current: "",
  deadline: "",
  notes: "",
  source: "manual",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export function FoundersGoals({ foundersData, setFoundersData }) {
  const goals = foundersData?.goals || {};
  const goalsList = useMemo(() =>
    Object.values(goals).filter(Boolean).sort((a, b) =>
      (a.deadline || "9999").localeCompare(b.deadline || "9999")
    ),
    [goals]
  );

  // Auto-create the revenue-target goal once, derived from the
  // existing /foundersData.revenueTarget + currentRevenue fields.
  // After this initial write, the goal lives in /foundersGoals and
  // the producer can edit title / deadline / notes; the headline
  // dashboard target still reads from foundersData.revenueTarget.
  useEffect(() => {
    if (!foundersData) return;
    const hasRevenueGoal = goalsList.some(g => g.source === "revenueTarget");
    if (hasRevenueGoal) return;
    const target = foundersData.revenueTarget;
    if (!target) return;
    const year = new Date().getFullYear();
    const auto = {
      ...newGoal(),
      id: `goal-revenue-${year}`,
      title: `Revenue ${year}`,
      target: target,
      unit: "$",
      current: foundersData.currentRevenue || 0,
      deadline: `${year}-12-31`,
      notes: "Auto-created from the dashboard's Revenue Target. Editable like any other goal — the dashboard's right-hand number keeps reading the original /foundersData.revenueTarget field, so updating this goal's target also won't move the dashboard. Update the dashboard target separately if needed.",
      source: "revenueTarget",
    };
    setFoundersData(p => ({ ...p, goals: { ...(p?.goals || {}), [auto.id]: auto } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upsert = (goal) => {
    const next = { ...goal, updatedAt: new Date().toISOString() };
    setFoundersData(p => ({ ...p, goals: { ...(p?.goals || {}), [goal.id]: next } }));
  };
  const remove = (id) => {
    if (!window.confirm("Delete this goal?")) return;
    setFoundersData(p => {
      const g = { ...(p?.goals || {}) };
      delete g[id];
      return { ...p, goals: g };
    });
  };
  const addNew = () => {
    const g = newGoal();
    upsert(g);
  };

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 16, flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Goals</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            Strategic objectives, hire plans, market expansion. The Advisor reads these alongside dashboard data when generating its briefings.
          </div>
        </div>
        <button onClick={addNew}
          style={{
            padding: "9px 18px", borderRadius: 8, border: "none",
            background: "var(--accent)", color: "#fff",
            fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
            boxShadow: "0 0 12px rgba(0,130,250,0.35)",
          }}>
          + New goal
        </button>
      </div>

      {goalsList.length === 0 ? (
        <div style={{
          padding: 40, textAlign: "center", color: "var(--muted)",
          background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12, fontSize: 13,
        }}>
          No goals yet. Click "+ New goal" to add your first one.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {goalsList.map(g => (
            <GoalCard key={g.id} goal={g} onChange={upsert} onDelete={() => remove(g.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function GoalCard({ goal, onChange, onDelete }) {
  const [draft, setDraft] = useState(goal);
  // Keep local draft in sync with upstream changes (e.g. another tab edited).
  useEffect(() => { setDraft(goal); }, [goal.id, goal.updatedAt]);

  const update = (field, value) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    onChange(next);
  };

  const pct = progressPct(draft.current, draft.target);
  const deadlineColour = (() => {
    if (!draft.deadline) return "var(--muted)";
    const days = Math.round((new Date(draft.deadline) - new Date()) / 86400000);
    if (days < 0) return "#F472B6";
    if (days < 30) return "#F59E0B";
    return "var(--muted)";
  })();
  const isAutoRevenue = draft.source === "revenueTarget";

  return (
    <div style={{
      background: "var(--card)",
      border: `1px solid ${pct >= 100 ? "rgba(16,185,129,0.5)" : "var(--border)"}`,
      borderRadius: 12, padding: "18px 20px",
      boxShadow: pct >= 100 ? "0 0 16px rgba(16,185,129,0.2)" : "none",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
        <input
          type="text"
          value={draft.title}
          onChange={e => update("title", e.target.value)}
          placeholder="Goal title — e.g. Revenue 2026"
          style={{
            flex: 1, padding: "8px 12px", borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--input-bg)",
            color: "var(--fg)", fontSize: 15, fontWeight: 700, outline: "none",
            fontFamily: "inherit",
          }}
        />
        {isAutoRevenue && (
          <span title="Auto-created from the dashboard's Revenue Target"
            style={{ padding: "4px 8px", borderRadius: 4, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, alignSelf: "center" }}>
            AUTO
          </span>
        )}
        <button onClick={onDelete}
          title="Delete goal"
          style={{
            width: 30, height: 30, borderRadius: 6,
            border: "1px solid rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.10)", color: "#EF4444",
            fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>×</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Field label="Target">
          <input type="number" step="any"
            value={draft.target}
            onChange={e => update("target", e.target.value)}
            placeholder="0"
            style={inputStyle} />
        </Field>
        <Field label="Unit">
          <select value={draft.unit} onChange={e => update("unit", e.target.value)} style={inputStyle}>
            {UNIT_OPTIONS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </Field>
        <Field label="Current">
          <input type="number" step="any"
            value={draft.current}
            onChange={e => update("current", e.target.value)}
            placeholder="0"
            style={inputStyle} />
        </Field>
        <Field label="Deadline">
          <input type="date"
            value={draft.deadline || ""}
            onChange={e => update("deadline", e.target.value)}
            style={{ ...inputStyle, color: deadlineColour }} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea
          value={draft.notes}
          onChange={e => update("notes", e.target.value)}
          placeholder="Strategic context — why this matters, blockers, plan of attack…"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
        />
      </Field>

      {/* Progress bar */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11, color: "var(--muted)" }}>
          <span>
            <strong style={{ color: "var(--fg)", fontFamily: "'JetBrains Mono',monospace" }}>{fmtValue(draft.current, draft.unit)}</strong>
            <span> of </span>
            <strong style={{ color: "var(--fg)", fontFamily: "'JetBrains Mono',monospace" }}>{fmtValue(draft.target, draft.unit)}</strong>
          </span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", color: pct >= 100 ? "#10B981" : "var(--muted)", fontWeight: 700 }}>
            {pct.toFixed(0)}%
          </span>
        </div>
        <div style={{ width: "100%", height: 8, background: "var(--bar-bg)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{
            width: `${Math.min(pct, 100)}%`, height: "100%",
            background: pct >= 100 ? "#10B981" : "var(--accent)",
            borderRadius: 4, transition: "width 0.3s",
            boxShadow: pct >= 100
              ? "0 0 10px rgba(16,185,129,0.55)"
              : "0 0 10px rgba(0,130,250,0.45)",
          }}/>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border)", background: "var(--input-bg)",
  color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "'DM Sans',sans-serif",
};
