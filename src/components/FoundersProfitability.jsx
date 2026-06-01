// Founders -> Profitability
//
// The margin/contribution instrument. Reads the cron-persisted
// /profitability rows (each already carries hoursByPerson, so labour can
// be repriced without ever loading /timeLogs) and RECOMPUTES LIVE from the
// current input nodes — editing a labour rate, an external cost, or a
// commission assignment updates the screen instantly. The nightly cron
// (api/cron/profitability-rollup.js) remains the SOLE writer of the
// persisted snapshot; this component only writes the founder-editable
// inputs (/laborCosts, /commissionPlans, /projectCostInputs,
// /projectCommissionInputs).
//
// Truthfulness: any row with a warning is "Incomplete" — badged,
// visually separated, and EXCLUDED from the headline totals. A missing
// input never reads as profit. Figures are EX GST. The headline number is
// "Contribution (before overhead)", never "profit".

import { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { fbListenSafe, fbSet } from "../firebase";
import { pct, fmtCur } from "../utils";
import { DEF_EDS } from "../config";
import { recomputeRow, buildRollups, WARNINGS } from "../../shared/profitability.js";

const PL_LABEL = {
  metaAds: "Meta Ads",
  socialPremium: "Social Premium",
  socialOrganic: "Social Organic",
  oneOff: "One-off / Live Action",
};
const plLabel = (k) => PL_LABEL[k] || k || "(unspecified)";

const WARN_LABEL = {
  [WARNINGS.MISSING_LABOUR_RATE]: "Labour rate missing for a logged person",
  [WARNINGS.MISSING_EXTERNAL_COST]: "External costs not entered",
  [WARNINGS.COMMISSION_UNASSIGNED]: "Commission not assigned",
  [WARNINGS.COMMISSION_RATE_MISSING]: "Assigned payee has no rate set",
  [WARNINGS.MISSING_OR_ZERO_DEAL_VALUE]: "Deal value missing or zero",
  [WARNINGS.DUPLICATE_TASK_ID]: "Duplicate task id — labour may misattribute",
  [WARNINGS.DEAL_MATCH_AMBIGUOUS]: "Attio match not unique — set this deal's value manually",
};

const money = (v) => fmtCur(Number(v) || 0);
const pctOr = (v) => (v == null ? "—" : pct(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function relTime(ms) {
  if (!ms) return "never";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const C = {
  bg: "var(--bg)", card: "var(--card)", fg: "var(--fg)",
  muted: "var(--muted)", border: "var(--border)",
};

function Card({ label, tone = "green", children }) {
  const tones = {
    green: "rgba(16,185,129,0.35)", blue: "rgba(0,130,250,0.40)",
    pink: "rgba(244,114,182,0.35)", amber: "rgba(245,158,11,0.35)",
  };
  const ring = tones[tone] || tones.green;
  return (
    <div style={{ padding: "14px 18px", background: C.bg, border: `1px solid ${ring}`, borderRadius: 10, boxShadow: `0 0 0 1px ${ring}` }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Pill({ text, color }) {
  return (
    <span style={{ display: "inline-block", fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap" }}>{text}</span>
  );
}

function Num({ value, onCommit, width = 78, placeholder = "" }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value === "" || value == null ? "" : String(value)}
      placeholder={placeholder}
      onChange={(e) => onCommit(e.target.value === "" ? "" : Number(e.target.value))}
      style={{ width, padding: "4px 6px", fontSize: 12, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 5 }}
    />
  );
}

function Sel({ value, onChange, options, placeholder }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={{ padding: "4px 6px", fontSize: 12, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 5 }}>
      {placeholder != null && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

const th = { textAlign: "right", padding: "6px 8px", fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
const thL = { ...th, textAlign: "left" };
const td = { textAlign: "right", padding: "7px 8px", fontSize: 12, color: C.fg, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
const tdL = { ...td, textAlign: "left" };

export function FoundersProfitability() {
  // cron-persisted snapshot (read-only display base)
  const [profitability, setProfitability] = useState({});
  const [editors, setEditors] = useState(DEF_EDS);
  // founder-editable input nodes (remote)
  const [laborCosts, setLaborCosts] = useState({});
  const [commissionPlans, setCommissionPlans] = useState({});
  const [costInputs, setCostInputs] = useState({});
  const [commissionInputs, setCommissionInputs] = useState({});
  // optimistic drafts so edits recompute instantly (draft wins per id)
  const [rateDraft, setRateDraft] = useState({});
  const [planDraft, setPlanDraft] = useState({});
  const [costDraft, setCostDraft] = useState({});
  const [commDraft, setCommDraft] = useState({});

  const [expandedId, setExpandedId] = useState(null);
  const [showRates, setShowRates] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    const obj = (d) => (d && typeof d === "object" ? d : {});
    const unsubs = [
      fbListenSafe("/profitability", (d) => { setProfitability(obj(d)); loaded.current = true; }),
      fbListenSafe("/editors", (d) => setEditors(Array.isArray(d) ? d : DEF_EDS)),
      fbListenSafe("/laborCosts", (d) => setLaborCosts(obj(d))),
      fbListenSafe("/commissionPlans", (d) => setCommissionPlans(obj(d))),
      fbListenSafe("/projectCostInputs", (d) => setCostInputs(obj(d))),
      fbListenSafe("/projectCommissionInputs", (d) => setCommissionInputs(obj(d))),
    ];
    return () => unsubs.forEach((u) => typeof u === "function" && u());
  }, []);

  // merged = remote overlaid with local drafts (draft wins for edited ids)
  const laborCostsM = useMemo(() => ({ ...laborCosts, ...rateDraft }), [laborCosts, rateDraft]);
  const commissionPlansM = useMemo(() => ({ ...commissionPlans, ...planDraft }), [commissionPlans, planDraft]);
  const costInputsM = useMemo(() => ({ ...costInputs, ...costDraft }), [costInputs, costDraft]);
  const commissionInputsM = useMemo(() => ({ ...commissionInputs, ...commDraft }), [commissionInputs, commDraft]);

  // live recompute from the persisted bases + current inputs
  const baseRows = useMemo(
    () => Object.entries(profitability)
      .filter(([k]) => k !== "_rollups")
      .map(([, r]) => r)
      .filter((r) => r && typeof r === "object"),
    [profitability]
  );
  const rows = useMemo(
    () => baseRows.map((b) => recomputeRow(b, { laborCosts: laborCostsM, costInputs: costInputsM, commissionInputs: commissionInputsM, commissionPlans: commissionPlansM })),
    [baseRows, laborCostsM, costInputsM, commissionInputsM, commissionPlansM]
  );
  const rollups = useMemo(() => buildRollups(rows, { commissionPlans: commissionPlansM }), [rows, commissionPlansM]);
  const totals = rollups.totals;
  const persistedAt = profitability?._rollups?.computedAt || null;

  const completeRows = useMemo(
    () => rows.filter((r) => r.complete).sort((a, b) => (a.contributionPct ?? Infinity) - (b.contributionPct ?? Infinity)),
    [rows]
  );
  const incompleteRows = useMemo(
    () => rows.filter((r) => !r.complete).sort((a, b) => b.warnings.length - a.warnings.length || String(a.clientName).localeCompare(String(b.clientName))),
    [rows]
  );

  // every person who logged time (so none can hide from the rate panel)
  const loggedPersonIds = useMemo(() => {
    const s = new Set();
    for (const r of rows) for (const id of Object.keys(r.hoursByPerson || {})) s.add(id);
    return s;
  }, [rows]);

  const roster = useMemo(() => {
    const byId = new Map();
    for (const e of editors || []) if (e && e.id) byId.set(e.id, { id: e.id, name: e.name || e.id, role: e.role || "" });
    for (const id of loggedPersonIds) if (!byId.has(id)) byId.set(id, { id, name: id, role: "ex-roster" });
    return Array.from(byId.values());
  }, [editors, loggedPersonIds]);

  const ratesIncomplete = useMemo(
    () => roster.some((p) => loggedPersonIds.has(p.id) && (laborCostsM[p.id]?.costPerHour === "" || laborCostsM[p.id]?.costPerHour == null)),
    [roster, loggedPersonIds, laborCostsM]
  );

  const closerOpts = useMemo(
    () => Object.entries(commissionPlansM).filter(([, p]) => p && p.type === "closer" && p.active !== false).map(([id, p]) => ({ value: id, label: p.name || id })),
    [commissionPlansM]
  );
  const amOpts = useMemo(
    () => Object.entries(commissionPlansM).filter(([, p]) => p && p.type === "accountManager" && p.active !== false).map(([id, p]) => ({ value: id, label: p.name || id })),
    [commissionPlansM]
  );

  // first-run setup: before the cron has written any snapshot, open the
  // rate + commission panels so the empty-state "set rates below" guidance
  // is actionable. One-shot (ref-guarded) so a manual collapse sticks.
  const setupOpened = useRef(false);
  useEffect(() => {
    if (loaded.current && baseRows.length === 0 && !setupOpened.current) {
      setupOpened.current = true;
      setShowRates(true);
      setShowPlans(true);
    }
  }, [baseRows.length]);

  // ── writers (optimistic draft + persist) ──────────────────────────
  const saveRate = (id, patch) => {
    const next = { ...(laborCostsM[id] || {}), ...patch, updatedAt: Date.now() };
    setRateDraft((d) => ({ ...d, [id]: next }));
    fbSet(`/laborCosts/${id}`, next);
  };
  const savePlan = (id, patch) => {
    const next = { ...(commissionPlansM[id] || {}), ...patch, updatedAt: Date.now() };
    setPlanDraft((d) => ({ ...d, [id]: next }));
    fbSet(`/commissionPlans/${id}`, next);
  };
  const saveCost = (id, patch) => {
    const next = { ...(costInputsM[id] || {}), ...patch, updatedAt: Date.now() };
    setCostDraft((d) => ({ ...d, [id]: next }));
    fbSet(`/projectCostInputs/${id}`, next);
  };
  const saveComm = (id, patch) => {
    const next = { ...(commissionInputsM[id] || {}), ...patch, updatedAt: Date.now() };
    setCommDraft((d) => ({ ...d, [id]: next }));
    fbSet(`/projectCommissionInputs/${id}`, next);
  };
  const addPlan = () => {
    const id = "pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    savePlan(id, { name: "", type: "closer", providedLeadPct: 10, selfSourcedPct: 15, repeatPct: "", flatPerDeal: 0, active: true });
    setShowPlans(true);
  };

  if (!loaded.current) {
    return <div style={{ color: C.muted, fontSize: 13, padding: "20px 4px" }}>Loading profitability…</div>;
  }

  const noSnapshot = baseRows.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18, fontWeight: 800, color: C.fg }}>Profitability</span>
          <Pill text="Figures ex GST" color="#0082FA" />
          <span style={{ fontSize: 11, color: C.muted }}>last persisted {relTime(persistedAt)}</span>
        </div>
        <p style={{ fontSize: 12, color: C.muted, margin: "6px 0 0", lineHeight: 1.5, maxWidth: 760 }}>
          Contribution = deal value − production cost (logged labour + entered externals) − sales commission.
          It is <strong style={{ color: C.fg }}>before overhead</strong>, so it is not profit. Logged labour only counts time someone ran the timer on; un-logged shoot time must be entered as an external or it is missing.
        </p>
      </div>

      {noSnapshot && (
        <div style={{ color: C.muted, fontSize: 13, padding: "4px 0", lineHeight: 1.6 }}>
          No profitability snapshot yet. The nightly rollup (<code>profitability-rollup</code>) writes <code>/profitability</code> after its first run (tonight 05:30 Sydney, or trigger it now).
          Set per-person labour rates and commission plans below so that first run lands with real costs.
        </div>
      )}

      {!noSnapshot && (
        <>
      {/* estimates / missing-rate banner */}
      <div style={{ fontSize: 12, color: ratesIncomplete ? "#F59E0B" : C.muted, background: ratesIncomplete ? "rgba(245,158,11,0.10)" : "transparent", border: `1px solid ${ratesIncomplete ? "rgba(245,158,11,0.35)" : C.border}`, borderRadius: 8, padding: "9px 12px", lineHeight: 1.5 }}>
        {ratesIncomplete
          ? "Some people who logged time have no labour rate set — their labour counts as $0 and those projects are marked Incomplete. Set rates in “Per-person labour rates” below."
          : "Labour uses the per-person rates below. Until those reflect real costs (Xero-calibrated later), treat all margins as estimates."}
      </div>

      {/* headline cards — COMPLETE rows only */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <Card label="Contribution (before overhead)" tone={totals.contribution >= 0 ? "green" : "pink"}>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.fg }}>{money(totals.contribution)}</div>
        </Card>
        <Card label="Blended Contribution %" tone="blue">
          <div style={{ fontSize: 22, fontWeight: 800, color: C.fg }}>{pctOr(totals.contributionPct)}</div>
        </Card>
        <Card label="Production Margin %" tone="amber">
          <div style={{ fontSize: 22, fontWeight: 800, color: C.fg }}>{pctOr(totals.productionMarginPct)}</div>
        </Card>
        <Card label="Total Commission" tone="pink">
          <div style={{ fontSize: 22, fontWeight: 800, color: C.fg }}>{money(totals.commission)}</div>
        </Card>
        <Card label="Contribution / Video" tone="green">
          <div style={{ fontSize: 22, fontWeight: 800, color: C.fg }}>{totals.perVideoContribution == null ? "—" : money(totals.perVideoContribution)}</div>
        </Card>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: -8 }}>
        Totals cover <strong style={{ color: C.fg }}>{rollups.completeCount}</strong> complete {rollups.completeCount === 1 ? "project" : "projects"} ({money(totals.dealValue)} deal value).
        {rollups.incompleteCount > 0 && <> <span style={{ color: "#F59E0B" }}>{rollups.incompleteCount} incomplete</span> excluded — fill their missing inputs below.</>}
      </div>

      {/* by product line */}
      {Object.keys(rollups.byProductLine).length > 0 && (
        <section>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.fg, marginBottom: 8 }}>By product line <span style={{ fontWeight: 400, color: C.muted }}>(complete only)</span></div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={thL}>Line</th><th style={th}>Deals</th><th style={th}>Videos</th><th style={th}>Deal value</th><th style={th}>Production cost</th><th style={th}>Commission</th><th style={th}>Contribution</th><th style={th}>Contrib %</th>
              </tr></thead>
              <tbody>
                {Object.entries(rollups.byProductLine).sort((a, b) => (a[1].contribution / (a[1].dealValue || 1)) - (b[1].contribution / (b[1].dealValue || 1))).map(([k, v]) => (
                  <tr key={k}>
                    <td style={tdL}>{plLabel(k)}</td>
                    <td style={td}>{v.count || 0}</td>
                    <td style={td}>{v.videos || 0}</td>
                    <td style={td}>{money(v.dealValue)}</td>
                    <td style={td}>{money(v.productionCost)}</td>
                    <td style={td}>{money(v.commission)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{money(v.contribution)}</td>
                    <td style={td}>{v.dealValue > 0 ? pct(v.contribution / v.dealValue) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* projects */}
      <section>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.fg, marginBottom: 8 }}>Projects <span style={{ fontWeight: 400, color: C.muted }}>(worst contribution % first — click a row to edit costs & commission)</span></div>
        <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={thL}>Client / Project</th><th style={thL}>Product</th><th style={th}>Deal</th><th style={th}>Labour</th><th style={th}>Ext.</th><th style={th}>Commission</th><th style={th}>Contribution</th><th style={th}>Contrib %</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {completeRows.map((r) => renderProjectRows(r))}
              {incompleteRows.length > 0 && (
                <tr><td colSpan={9} style={{ padding: "10px 8px 4px", fontSize: 11, fontWeight: 800, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${C.border}` }}>Incomplete — excluded from totals</td></tr>
              )}
              {incompleteRows.map((r) => renderProjectRows(r))}
            </tbody>
          </table>
        </div>
      </section>

        </>
      )}

      {/* per-person labour rates */}
      <section>
        <button onClick={() => setShowRates((s) => !s)} style={collapseBtn}>{showRates ? "▾" : "▸"} Per-person labour rates <span style={{ color: C.muted, fontWeight: 400 }}>($/hr — covers editors & crew)</span></button>
        {showRates && (
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={thL}>Person</th><th style={thL}>Role</th><th style={th}>Cost $/hr</th><th style={thL}>Note</th></tr></thead>
              <tbody>
                {roster.map((p) => {
                  const missing = loggedPersonIds.has(p.id) && (laborCostsM[p.id]?.costPerHour === "" || laborCostsM[p.id]?.costPerHour == null);
                  return (
                    <tr key={p.id}>
                      <td style={tdL}>{p.name}{loggedPersonIds.has(p.id) && <span style={{ color: C.muted }}> · logged time</span>}</td>
                      <td style={tdL}>{p.role}</td>
                      <td style={td}>
                        <Num value={laborCostsM[p.id]?.costPerHour ?? ""} onCommit={(v) => saveRate(p.id, { costPerHour: v })} />
                        {missing && <span style={{ marginLeft: 6 }}><Pill text="missing" color="#F59E0B" /></span>}
                      </td>
                      <td style={tdL}><input value={laborCostsM[p.id]?.note ?? ""} onChange={(e) => saveRate(p.id, { note: e.target.value })} placeholder="optional" style={{ width: 200, padding: "4px 6px", fontSize: 12, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 5 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* commission plans */}
      <section>
        <button onClick={() => setShowPlans((s) => !s)} style={collapseBtn}>{showPlans ? "▾" : "▸"} Commission plans <span style={{ color: C.muted, fontWeight: 400 }}>(payees & rates — these are the dropdown options)</span></button>
        {showPlans && (
          <div style={{ marginTop: 8 }}>
            <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={thL}>Name</th><th style={thL}>Type</th><th style={th}>Provided %</th><th style={th}>Self-sourced %</th><th style={th}>Repeat %</th><th style={th}>Flat $/deal</th><th style={th}>Active</th></tr></thead>
                <tbody>
                  {Object.entries(commissionPlansM).length === 0 && (
                    <tr><td colSpan={7} style={{ ...tdL, color: C.muted }}>No payees yet. Add a closer or account manager.</td></tr>
                  )}
                  {Object.entries(commissionPlansM).map(([id, p]) => (
                    <tr key={id}>
                      <td style={tdL}><input value={p.name ?? ""} onChange={(e) => savePlan(id, { name: e.target.value })} placeholder="name" style={{ width: 150, padding: "4px 6px", fontSize: 12, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 5 }} /></td>
                      <td style={tdL}><Sel value={p.type} onChange={(v) => savePlan(id, { type: v })} options={[{ value: "closer", label: "Closer" }, { value: "accountManager", label: "Account manager" }]} /></td>
                      <td style={td}>{p.type === "accountManager" ? "—" : <Num value={p.providedLeadPct ?? ""} onCommit={(v) => savePlan(id, { providedLeadPct: v })} width={64} />}</td>
                      <td style={td}>{p.type === "accountManager" ? "—" : <Num value={p.selfSourcedPct ?? ""} onCommit={(v) => savePlan(id, { selfSourcedPct: v })} width={64} />}</td>
                      <td style={td}>{p.type === "accountManager" ? <Num value={p.repeatPct ?? ""} onCommit={(v) => savePlan(id, { repeatPct: v })} width={64} /> : "—"}</td>
                      <td style={td}><Num value={p.flatPerDeal ?? ""} onCommit={(v) => savePlan(id, { flatPerDeal: v })} width={72} /></td>
                      <td style={td}><input type="checkbox" checked={p.active !== false} onChange={(e) => savePlan(id, { active: e.target.checked })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={addPlan} style={{ ...collapseBtn, marginTop: 8, color: "#0082FA" }}>+ Add payee</button>
          </div>
        )}
      </section>
    </div>
  );

  // ── per-project row + expandable editor ──────────────────────────
  function renderProjectRows(r) {
    const open = expandedId === r.projectId;
    const ci = commissionInputsM[r.projectId] || {};
    const co = costInputsM[r.projectId];
    return (
      <Fragment key={r.projectId}>
        <tr onClick={() => setExpandedId(open ? null : r.projectId)} style={{ cursor: "pointer", background: open ? "rgba(0,130,250,0.06)" : "transparent" }}>
          <td style={tdL}>
            <div style={{ fontWeight: 600 }}>{r.clientName || "(no client)"}</div>
            {r.projectName && <div style={{ fontSize: 11, color: C.muted }}>{r.projectName}</div>}
          </td>
          <td style={tdL}>{plLabel(r.productLine)}</td>
          <td style={td}>
            {money(r.dealValue)}
            {r.dealValueSource === "attio" && (
              <span title="Sourced from the matched Attio Won deal (the project had no value of its own)" style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, letterSpacing: 0.3, color: "#60A5FA", border: "1px solid rgba(96,165,250,0.4)", borderRadius: 4, padding: "1px 4px", verticalAlign: "middle" }}>ATTIO</span>
            )}
          </td>
          <td style={td}>{money(r.labourCost)}</td>
          <td style={td}>{money(r.externalCosts)}</td>
          <td style={td}>{money(r.commission)}</td>
          <td style={{ ...td, fontWeight: 700, color: r.contribution < 0 ? "#F472B6" : C.fg }}>{money(r.contribution)}</td>
          <td style={td}>{pctOr(r.contributionPct)}</td>
          <td style={td}>{r.complete ? <Pill text="Complete" color="#10B981" /> : <Pill text="Incomplete" color="#F59E0B" />}</td>
        </tr>
        {open && (
          <tr>
            <td colSpan={9} style={{ padding: "12px 14px", background: C.bg, borderBottom: `1px solid ${C.border}` }}>
              {r.warnings.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {r.warnings.map((w) => <Pill key={w} text={WARN_LABEL[w] || w} color="#F59E0B" />)}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 18 }}>
                {/* external costs */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>External costs (ex GST)</div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center", maxWidth: 280 }}>
                    {["crew", "travel", "location", "gear", "other"].map((f) => (
                      <Fragment key={f}>
                        <label style={{ fontSize: 12, color: C.fg, textTransform: "capitalize" }}>{f}</label>
                        <Num value={co?.[f] ?? ""} onCommit={(v) => saveCost(r.projectId, { [f]: v })} width={110} placeholder="0" />
                      </Fragment>
                    ))}
                    <label style={{ fontSize: 12, color: C.fg }}>Note</label>
                    <input value={co?.note ?? ""} onChange={(e) => saveCost(r.projectId, { note: e.target.value })} placeholder="freelance crew, travel…" style={{ padding: "4px 6px", fontSize: 12, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 5 }} />
                  </div>
                  {!co && (
                    <button onClick={() => saveCost(r.projectId, { crew: 0, travel: 0, location: 0, gear: 0, other: 0, note: "confirmed none" })} style={{ ...collapseBtn, marginTop: 8, fontSize: 11, color: "#10B981" }}>✓ Confirm no external costs</button>
                  )}
                </div>

                {/* commission */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Commission</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 280 }}>
                    <label style={{ fontSize: 12, color: C.fg }}>Deal type
                      <div style={{ marginTop: 3 }}><Sel value={ci.dealType} onChange={(v) => saveComm(r.projectId, { dealType: v })} options={[{ value: "new", label: "New business" }, { value: "repeat", label: "Repeat / managed" }]} placeholder="— choose —" /></div>
                    </label>
                    {ci.dealType === "new" && (
                      <>
                        <label style={{ fontSize: 12, color: C.fg }}>Closer
                          <div style={{ marginTop: 3 }}><Sel value={ci.closerId} onChange={(v) => saveComm(r.projectId, { closerId: v })} options={closerOpts} placeholder={closerOpts.length ? "— choose —" : "add a closer below"} /></div>
                        </label>
                        <label style={{ fontSize: 12, color: C.fg }}>Lead source
                          <div style={{ marginTop: 3 }}><Sel value={ci.leadSource || "provided"} onChange={(v) => saveComm(r.projectId, { leadSource: v })} options={[{ value: "provided", label: "Company provided (10%)" }, { value: "selfSourced", label: "Self-sourced (15%)" }]} /></div>
                        </label>
                      </>
                    )}
                    {ci.dealType === "repeat" && (
                      <label style={{ fontSize: 12, color: C.fg }}>Account manager
                        <div style={{ marginTop: 3 }}><Sel value={ci.accountManagerId} onChange={(v) => saveComm(r.projectId, { accountManagerId: v })} options={amOpts} placeholder={amOpts.length ? "— choose —" : "add an AM below"} /></div>
                      </label>
                    )}
                  </div>
                </div>

                {/* breakdown */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Breakdown</div>
                  <table style={{ borderCollapse: "collapse", fontSize: 12 }}><tbody>
                    {[
                      ["Logged hours", `${(r.loggedHours || 0).toFixed(1)}h`],
                      ["Labour", money(r.labourCost)],
                      ["Externals", money(r.externalCosts)],
                      ["Production cost", money(r.productionCost)],
                      ["Production margin", money(r.productionMargin)],
                      ["Commission", `− ${money(r.commission)}`],
                      ["Contribution", money(r.contribution)],
                      ["Per video", r.perVideoContribution == null ? "—" : money(r.perVideoContribution)],
                    ].map(([k, v], i) => (
                      <tr key={i}><td style={{ padding: "2px 14px 2px 0", color: C.muted }}>{k}</td><td style={{ padding: "2px 0", textAlign: "right", fontWeight: k === "Contribution" ? 800 : 500, color: C.fg }}>{v}</td></tr>
                    ))}
                  </tbody></table>
                </div>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  }
}

const collapseBtn = { background: "transparent", border: "none", color: "var(--fg)", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "4px 0", textAlign: "left" };
