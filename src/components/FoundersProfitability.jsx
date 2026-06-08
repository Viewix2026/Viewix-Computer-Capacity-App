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
import { recomputeRow, buildRollups, keepProjectRow, isInternalProject, WARNINGS } from "../../shared/profitability.js";

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
  [WARNINGS.LEAD_SOURCE_UNSET]: "Lead source not set — pick provided or self-sourced",
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

// Dark "fintech dashboard" palette (matches the Profitability mockup): a
// near-black surface with subtly lifted panels, JetBrains Mono numbers and
// DM Sans text. Explicit colours (not theme vars) so the tab renders the
// mockup look regardless of the app theme.
const C = {
  bg: "#0A0E17",
  panel: "#0E1422",
  card: "#141B2B",
  fg: "#E7EBF2",
  muted: "#7C879B",
  border: "rgba(255,255,255,0.07)",
};
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";
const SANS = "'DM Sans', system-ui, -apple-system, sans-serif";
const ACCENT = { blue: "#0082FA", green: "#1EC081", amber: "#F5A623", orange: "#F87700", pink: "#F472B6", coral: "#FF8A80" };
const PL_COLOR = { metaAds: "#FF8A80", socialPremium: "#0082FA", socialOrganic: "#22D3EE", oneOff: "#1EC081" };
const plColor = (k) => PL_COLOR[k] || C.muted;

// Headline metric card with a glowing coloured top edge.
function MetricCard({ label, value, accent }) {
  return (
    <div style={{ position: "relative", padding: "16px 18px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent, boxShadow: `0 1px 14px 0 ${accent}` }} />
      <div style={{ fontSize: 9.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 9, lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 23, fontWeight: 600, color: C.fg, letterSpacing: -0.5 }}>{value}</div>
    </div>
  );
}

function Pill({ text, color }) {
  return (
    <span style={{ display: "inline-block", fontFamily: SANS, fontSize: 10, fontWeight: 700, color, background: `${color}1A`, border: `1px solid ${color}55`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{text}</span>
  );
}

// Product-line tag: coloured tint pill (coral Meta, blue Social Premium, …).
function Tag({ k }) {
  if (!k || !PL_COLOR[k]) return <span style={{ color: C.muted, fontStyle: "italic" }}>{plLabel(k)}</span>;
  const c = plColor(k);
  return <span style={{ fontFamily: SANS, fontSize: 9.5, fontWeight: 700, color: c, background: `${c}1A`, border: `1px solid ${c}44`, borderRadius: 6, padding: "2px 8px", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.5 }}>{plLabel(k)}</span>;
}

// Contribution-% mini bar that ramps coral → orange → amber → green.
function ContribBar({ value }) {
  if (value == null) return <span style={{ fontFamily: MONO, color: C.muted }}>—</span>;
  const p = Math.max(0, Math.min(1, value));
  const col = value >= 0.85 ? ACCENT.green : value >= 0.7 ? ACCENT.amber : value >= 0 ? ACCENT.orange : ACCENT.coral;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9, justifyContent: "flex-end" }}>
      <span style={{ width: 46, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${p * 100}%`, background: col, borderRadius: 3 }} />
      </span>
      <span style={{ fontFamily: MONO, color: col, fontWeight: 600, minWidth: 34, textAlign: "right" }}>{pct(value)}</span>
    </span>
  );
}

// Section header: glowing coloured dot + uppercase title + muted right note.
function SectionHeader({ dot, title, note }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: dot, boxShadow: `0 0 8px 0 ${dot}` }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: C.fg, textTransform: "uppercase", letterSpacing: 1 }}>{title}</span>
      {note && <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>{note}</span>}
    </div>
  );
}

// Money cell that dims an explicit $0 (the mockup keeps zeros quiet).
function MoneyCell({ v }) {
  const n = Number(v) || 0;
  return <span style={{ color: n === 0 ? "rgba(255,255,255,0.22)" : C.fg }}>{money(v)}</span>;
}

function Num({ value, onCommit, width = 78, placeholder = "" }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value === "" || value == null ? "" : String(value)}
      placeholder={placeholder}
      onChange={(e) => onCommit(e.target.value === "" ? "" : Number(e.target.value))}
      style={{ width, padding: "5px 8px", fontSize: 12, fontFamily: MONO, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6 }}
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

const th = { textAlign: "right", padding: "10px 14px", fontSize: 9.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.6, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
const thL = { ...th, textAlign: "left" };
const td = { textAlign: "right", padding: "12px 14px", fontSize: 12.5, fontFamily: MONO, color: C.fg, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
const tdL = { ...td, textAlign: "left", fontFamily: SANS };

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
      .filter((r) => r && typeof r === "object")
      // Drop Viewix's own internal projects immediately (matches the cron's
      // computeProfitability exclusion) so they vanish before the next rollup,
      // not just after it. Rows carry clientName, so the same check applies.
      .filter((r) => !isInternalProject(r)),
    [profitability]
  );
  const rows = useMemo(
    () => baseRows
      .map((b) => recomputeRow(b, { laborCosts: laborCostsM, costInputs: costInputsM, commissionInputs: commissionInputsM, commissionPlans: commissionPlansM }))
      // strict: show only projects with logged time (duplicate-flagged rows
      // survive so their warning stays visible). Mirrors the cron filter so
      // the live view matches what gets persisted. See keepProjectRow.
      .filter(keepProjectRow),
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

  // every person with labour on a row — logged OR scheduled shoot crew — so
  // none can hide from the rate panel (a shoot-only crew member with no rate
  // still makes a row Incomplete, so they must be settable here).
  const loggedPersonIds = useMemo(() => {
    const s = new Set();
    for (const r of rows) {
      for (const id of Object.keys(r.hoursByPerson || {})) s.add(id);
      for (const id of Object.keys(r.shootHoursByPerson || {})) s.add(id);
    }
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

  // distinguish "cron never ran" from "ran but every project filtered out":
  // a real run stamps _rollups.computedAt even when no rows survive the
  // no-logged-time filter, so don't show the first-run "set rates" guidance
  // in that case.
  const noSnapshot = baseRows.length === 0 && !persistedAt;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22, fontFamily: SANS, background: C.bg, color: C.fg, padding: "22px 24px", borderRadius: 16 }}>
      {/* header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: SANS, fontSize: 22, fontWeight: 800, color: C.fg, letterSpacing: -0.3 }}>Profitability</span>
          <Pill text="Figures ex GST" color="#0082FA" />
          <span style={{ fontSize: 11, color: C.muted }}>last persisted {relTime(persistedAt)}</span>
        </div>
        <p style={{ fontSize: 12, color: C.muted, margin: "6px 0 0", lineHeight: 1.5, maxWidth: 760 }}>
          Contribution = deal value − production cost (logged labour + scheduled shoot labour + entered externals) − sales commission.
          It is <strong style={{ color: C.fg }}>before overhead</strong>, so it is not profit. Labour counts timer time plus shoot time auto-costed from the booked schedule at crew rates; other un-logged costs (freelance crew, travel, gear) go in externals.
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 12 }}>
        <MetricCard label="Contribution (before overhead)" accent={totals.contribution >= 0 ? ACCENT.blue : ACCENT.coral} value={money(totals.contribution)} />
        <MetricCard label="Blended Contribution %" accent={ACCENT.blue} value={pctOr(totals.contributionPct)} />
        <MetricCard label="Production Margin %" accent={ACCENT.amber} value={pctOr(totals.productionMarginPct)} />
        <MetricCard label="Total Commission" accent={ACCENT.pink} value={money(totals.commission)} />
        <MetricCard label="Contribution / Video" accent={ACCENT.green} value={totals.perVideoContribution == null ? "—" : money(totals.perVideoContribution)} />
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: -8 }}>
        Totals cover <strong style={{ color: C.fg }}>{rollups.completeCount}</strong> complete {rollups.completeCount === 1 ? "project" : "projects"} ({money(totals.dealValue)} deal value).
        {rollups.incompleteCount > 0 && <> <span style={{ color: "#F59E0B" }}>{rollups.incompleteCount} incomplete</span> excluded — fill their missing inputs below.</>}
      </div>

      {/* by product line */}
      {Object.keys(rollups.byProductLine).length > 0 && (
        <section>
          <SectionHeader dot={ACCENT.blue} title="By product line" note="complete only" />
          <div style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={thL}>Line</th><th style={th}>Deals</th><th style={th}>Videos</th><th style={th}>Deal value</th><th style={th}>Production cost</th><th style={th}>Commission</th><th style={th}>Contribution</th><th style={th}>Contrib %</th>
              </tr></thead>
              <tbody>
                {Object.entries(rollups.byProductLine).sort((a, b) => (a[1].contribution / (a[1].dealValue || 1)) - (b[1].contribution / (b[1].dealValue || 1))).map(([k, v]) => (
                  <tr key={k}>
                    <td style={tdL}><Tag k={k} /></td>
                    <td style={td}>{v.count || 0}</td>
                    <td style={td}>{v.videos || 0}</td>
                    <td style={td}>{money(v.dealValue)}</td>
                    <td style={td}>{money(v.productionCost)}</td>
                    <td style={td}><MoneyCell v={v.commission} /></td>
                    <td style={{ ...td, fontWeight: 700 }}>{money(v.contribution)}</td>
                    <td style={td}><ContribBar value={v.dealValue > 0 ? v.contribution / v.dealValue : null} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* projects */}
      <section>
        <SectionHeader dot={ACCENT.green} title={`Projects · ${completeRows.length + incompleteRows.length}`} note="worst contribution % first · click a row to edit costs & commission" />
        <div style={{ overflowX: "auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12 }}>
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
        <tr onClick={() => setExpandedId(open ? null : r.projectId)} style={{ cursor: "pointer", background: open ? "rgba(0,130,250,0.07)" : "transparent" }}>
          <td style={tdL}>
            <div style={{ fontWeight: 700, color: C.fg }}>{r.clientName || "(no client)"}</div>
            {r.projectName && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{r.projectName}</div>}
          </td>
          <td style={tdL}><Tag k={r.productLine} /></td>
          <td style={td}>
            {money(r.dealValue)}
            {r.dealValueSource === "attio" && (
              <span title="Sourced from the matched Attio Won deal (the project had no value of its own)" style={{ marginLeft: 6, fontFamily: SANS, fontSize: 8.5, fontWeight: 800, letterSpacing: 0.4, color: ACCENT.blue, background: `${ACCENT.blue}1A`, border: `1px solid ${ACCENT.blue}55`, borderRadius: 4, padding: "1px 4px", verticalAlign: "middle" }}>ATTIO</span>
            )}
          </td>
          <td style={td}>{money(num(r.labourCost) + num(r.shootLabour))}</td>
          <td style={td}><MoneyCell v={r.externalCosts} /></td>
          <td style={td}><MoneyCell v={r.commission} /></td>
          <td style={{ ...td, fontWeight: 700, color: r.contribution < 0 ? ACCENT.coral : C.fg }}>{money(r.contribution)}</td>
          <td style={td}><ContribBar value={r.contributionPct} /></td>
          <td style={td}>{r.complete ? <Pill text="Complete" color={ACCENT.green} /> : <Pill text="Incomplete" color={ACCENT.amber} />}</td>
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
                          <div style={{ marginTop: 3 }}><Sel value={ci.leadSource} onChange={(v) => saveComm(r.projectId, { leadSource: v })} options={[{ value: "provided", label: "Company provided (10%)" }, { value: "selfSourced", label: "Self-sourced (15%)" }]} placeholder="— choose —" /></div>
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
                      ["Labour (logged)", money(r.labourCost)],
                      ...(num(r.shootHours) > 0 ? [
                        ["Shoot hours", `${num(r.shootHours).toFixed(1)}h`],
                        [r.shootHoursEstimated ? "Shoot labour (est)" : "Shoot labour", money(r.shootLabour)],
                      ] : []),
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

const collapseBtn = { background: "transparent", border: "none", color: C.fg, fontFamily: SANS, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "4px 0", textAlign: "left" };
