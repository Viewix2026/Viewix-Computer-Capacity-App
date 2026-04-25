// Projects — central registry of every won deal (fed by the Attio → Zapier
// webhook at api/webhook-deal-won.js). Two sub-tabs:
//   1. Projects — card grid of active/archived projects with status pills
//      linking to Sherpa / Preprod / Runsheet / Delivery records.
//   2. Deliveries — embeds the existing <Deliveries/> component unchanged.
//
// Each /projects/{id} record is created by the webhook with all denormalised
// Attio fields (projectName, clientName, dealValue, videoType, numberOfVideos,
// description, destinations, targetAudience, dueDate, clientContact) plus a
// `links` object tracking the IDs of linked records across the dashboard.
//
// Project records are edit-in-place (producerNotes, status). Writes go direct
// to Firebase via fbSet to avoid the App.jsx debounced bulk-write clobbering
// webhook-created records that haven't hit local state yet.

import { useState, useMemo, useEffect, useRef, memo } from "react";
import { BTN } from "../config";
import { fmtCur, fmtD } from "../utils";
import { fbSet, fbUpdate } from "../firebase";
import { Deliveries } from "./Deliveries";

// Monday.com-style status values — matches the screenshot Jeremy shared.
// Legacy records stored "active" / "onHold" — see normaliseStatus() below
// which maps those onto the new keys so nothing becomes unreadable.
const STATUS_OPTIONS = [
  { key: "notStarted",    label: "Not Started",       color: "#6B7280" },
  { key: "inProgress",    label: "In Progress",       color: "#F97316" },
  { key: "scheduled",     label: "Scheduled",         color: "#3B82F6" },
  { key: "waitingClient", label: "Waiting on Client", color: "#8B5CF6" },
  { key: "stuck",         label: "Stuck",             color: "#EC4899" },
  { key: "done",          label: "Done",              color: "#10B981" },
  { key: "archived",      label: "Archived",          color: "#475569" },
];
const STATUS_MAP = Object.fromEntries(STATUS_OPTIONS.map(s => [s.key, s]));
// Legacy → new keys so pre-refactor records still render a sensible pill.
const LEGACY_STATUS = { active: "inProgress", onHold: "waitingClient" };
function normaliseStatus(raw) {
  const key = LEGACY_STATUS[raw] || raw || "notStarted";
  return STATUS_MAP[key] ? key : "notStarted";
}

// ─── Inline edit primitives ────────────────────────────────────────
// Single-line text input that commits on blur or Enter. Optional
// `displayValue` lets number / date inputs keep the raw string in state
// but render a formatted version when not focused — e.g. dealValue is
// stored as 1500 but displays as "$1,500.00", or dueDate stored as
// "2026-04-21" displays as "21 Apr".
//
// The trick: when the field is type="number" or type="date" and the
// caller provides displayValue, we can't just render the formatted
// string in the <input> itself because the browser rejects non-numeric
// / non-ISO-date strings (the field would render blank, falling back
// to placeholder — which is what was hiding the actual deal value
// before this fix). Instead, swap the input out for a click-to-edit
// div whenever the field isn't focused. Click the div → focus state
// swaps in the real input + autofocus immediately.
function InlineText({ value, onSave, placeholder, type = "text", displayValue, style }) {
  const [draft, setDraft] = useState(value || "");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  // Keep draft in sync with the upstream value when it changes from
  // outside (e.g. another producer edits, listener updates).
  useEffect(() => { if (!focused) setDraft(value || ""); }, [value, focused]);

  const commit = () => {
    if ((draft || "") === (value || "")) return;
    onSave(draft || "");
  };

  // Swap-mode display — only relevant when the caller provided a
  // separate `displayValue` (currency / date). For plain text fields
  // we just render the input directly.
  const useSwap = !!displayValue || type === "date" || type === "number";
  if (useSwap && !focused) {
    const showText = (value || draft) ? displayValue : "";
    return (
      <div
        onClick={() => { setFocused(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        style={{
          width: "100%", padding: "8px 10px", borderRadius: 6,
          border: "1px solid var(--border)", background: "var(--input-bg)",
          color: showText ? "var(--fg)" : "var(--muted)",
          fontSize: 13, fontWeight: 600,
          fontFamily: "inherit", outline: "none", cursor: "text",
          minHeight: 35, display: "flex", alignItems: "center",
          ...style,
        }}>
        {showText || placeholder}
      </div>
    );
  }
  return (
    <input
      ref={inputRef}
      type={type}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={e => { if (e.key === "Enter") { e.target.blur(); } if (e.key === "Escape") { setDraft(value || ""); e.target.blur(); } }}
      placeholder={placeholder}
      style={{
        width: "100%", padding: "8px 10px", borderRadius: 6,
        border: "1px solid var(--border)", background: "var(--input-bg)",
        color: "var(--fg)", fontSize: 13, fontWeight: 600,
        fontFamily: "inherit", outline: "none",
        ...style,
      }}
    />
  );
}

function InlineTextArea({ value, onSave, placeholder, rows = 4 }) {
  const [draft, setDraft] = useState(value || "");
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(value || ""); }, [value, focused]);
  const commit = () => {
    if ((draft || "") === (value || "")) return;
    onSave(draft);
  };
  return (
    <textarea
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: "100%", padding: "10px 12px", borderRadius: 6,
        border: "1px solid var(--border)", background: "var(--input-bg)",
        color: "var(--fg)", fontSize: 13, lineHeight: 1.5,
        fontFamily: "inherit", outline: "none", resize: "vertical",
      }}
    />
  );
}

// Card wrapper around a labelled editable field, matching the static
// FieldCard style the previous read-only view used.
function FieldCard({ label, hint, children }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span>{label}</span>
        {hint && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, fontStyle: "italic" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// Destinations chip editor — shows existing destinations as removable
// chips, single text input below. Enter or comma adds a chip.
function DestinationsEditor({ value, onChange }) {
  const [draft, setDraft] = useState("");
  const list = Array.isArray(value) ? value : [];
  const add = (raw) => {
    const t = (raw || "").trim();
    if (!t) return;
    if (list.includes(t)) return;
    onChange([...list, t]);
    setDraft("");
  };
  const remove = (d) => onChange(list.filter(x => x !== d));
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {list.map((d, i) => (
          <button key={i} onClick={() => remove(d)} title="Click to remove"
            style={{ padding: "3px 8px 3px 10px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)",
              color: "var(--accent)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", gap: 6 }}>
            {d}
            <span style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1 }}>×</span>
          </button>
        ))}
        {list.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>None yet</span>}
      </div>
      <input type="text" value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); } }}
        onBlur={() => add(draft)}
        placeholder="Add a destination, press Enter (e.g. Instagram, YouTube, LinkedIn)"
        style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, fontFamily: "inherit", outline: "none" }}
      />
    </div>
  );
}

// Variant of StatusPill that takes onClick + disabled. Disabled looks
// dimmed and shows a "not yet" tooltip; click takes you to the matching
// record via hash routing.
function ClickableStatusPill({ label, done, color = "#10B981", onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${label} not linked yet` : `Open ${label.toLowerCase()} →`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "4px 10px", borderRadius: 999,
        background: done ? `${color}22` : "var(--bg)",
        border: `1px solid ${done ? color : "var(--border)"}`,
        color: done ? color : "var(--muted)",
        fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3,
        whiteSpace: "nowrap", fontFamily: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "transform 0.1s, opacity 0.15s",
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = "none"; }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: done ? color : "transparent",
        border: done ? "none" : "1px solid var(--muted)",
      }}/>
      {label}
      {done && <span style={{ marginLeft: 2, fontSize: 9 }}>↗</span>}
    </button>
  );
}

function StatusPill({ label, done, color = "#10B981" }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 8px", borderRadius: 999,
      background: done ? `${color}22` : "var(--bg)",
      border: `1px solid ${done ? color : "var(--border)"}`,
      color: done ? color : "var(--muted)",
      fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3,
      whiteSpace: "nowrap",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: done ? color : "transparent",
        border: done ? "none" : "1px solid var(--muted)",
      }}/>
      {label}
    </span>
  );
}

function Chip({ children, color = "var(--accent)" }) {
  return (
    <span style={{
      display: "inline-block", padding: "3px 8px", borderRadius: 4,
      background: "var(--bg)", border: "1px solid var(--border)",
      color, fontSize: 11, fontWeight: 600,
    }}>{children}</span>
  );
}

// ─── Monday-style table ────────────────────────────────────────────
// Row columns: checkbox · Project (client : name + count badge) ·
// Start Date · Due Date · Timeline · Status pill. Inline status
// dropdown so producers can reclassify a project without opening the
// detail view. Clicking the project name opens the detail view.

function StatusCell({ value, onChange }) {
  const key = normaliseStatus(value);
  const opt = STATUS_MAP[key];
  return (
    <select
      value={key}
      onClick={e => e.stopPropagation()}
      onChange={e => { e.stopPropagation(); onChange(e.target.value); }}
      style={{
        width: "100%", padding: "8px 12px", border: "none",
        background: opt.color, color: "#fff",
        fontSize: 11, fontWeight: 800, letterSpacing: 0.4,
        textTransform: "uppercase", cursor: "pointer",
        textAlign: "center", appearance: "none",
        fontFamily: "inherit",
      }}>
      {STATUS_OPTIONS.map(s => (
        <option key={s.key} value={s.key} style={{ background: "var(--card)", color: "var(--fg)" }}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

// "Timeline" column renders a thin horizontal bar showing the span
// between closeDate / startDate and dueDate. Shows "-" if either
// endpoint is missing so the cell doesn't go empty.
function TimelineCell({ start, end }) {
  if (!start || !end) {
    return <span style={{ display: "inline-block", padding: "6px 16px", background: "var(--bg)", borderRadius: 999, color: "var(--muted)", fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>—</span>;
  }
  const s = new Date(start); const e = new Date(end); const now = new Date();
  const totalMs = Math.max(1, e - s);
  const elapsedMs = Math.max(0, Math.min(totalMs, now - s));
  const pct = Math.round((elapsedMs / totalMs) * 100);
  const overdue = now > e;
  const col = overdue ? "#EF4444" : pct > 80 ? "#F59E0B" : "#3B82F6";
  return (
    <div style={{ width: "100%", minWidth: 100 }} title={`${start} → ${end} (${pct}% elapsed)`}>
      <div style={{ height: 6, background: "var(--bg)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: col, borderRadius: 999 }} />
      </div>
      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 3, fontFamily: "'JetBrains Mono',monospace", textAlign: "center" }}>{pct}%</div>
    </div>
  );
}

function ProjectRow({ project, onOpen, onStatusChange, striped }) {
  const videoCount = project.numberOfVideos;
  const clientPart = project.clientName || "—";
  const namePart = project.projectName || "Untitled project";
  const startDate = project.closeDate || project.createdAt;
  const dueDate = project.dueDate;
  return (
    <tr
      onClick={() => onOpen(project.id)}
      style={{
        cursor: "pointer",
        background: striped ? "rgba(255,255,255,0.015)" : "transparent",
        borderBottom: "1px solid var(--border)",
      }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(99,102,241,0.06)"}
      onMouseLeave={e => e.currentTarget.style.background = striped ? "rgba(255,255,255,0.015)" : "transparent"}>
      <td style={tdStyle} onClick={e => e.stopPropagation()}>
        <input type="checkbox" disabled style={{ cursor: "not-allowed", opacity: 0.4 }} title="Bulk actions coming soon" />
      </td>
      <td style={{ ...tdStyle, minWidth: 320 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1 }}>›</span>
          <span style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.3 }}>
            <span style={{ fontWeight: 700 }}>{clientPart}:</span>{" "}
            <span style={{ fontWeight: 500 }}>{namePart}</span>
          </span>
          {videoCount != null && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "var(--bg)", color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>
              {videoCount}
            </span>
          )}
        </div>
      </td>
      <td style={{ ...tdStyle, width: 120, textAlign: "center" }}>
        <span style={dateCellStyle}>{startDate ? fmtD(startDate) : "—"}</span>
      </td>
      <td style={{ ...tdStyle, width: 120, textAlign: "center" }}>
        <span style={dateCellStyle}>{dueDate ? fmtD(dueDate) : "—"}</span>
      </td>
      <td style={{ ...tdStyle, width: 140 }}>
        <TimelineCell start={startDate} end={dueDate} />
      </td>
      <td style={{ ...tdStyle, width: 180, padding: 0 }}>
        <StatusCell value={project.status} onChange={(s) => onStatusChange(project.id, s)} />
      </td>
    </tr>
  );
}

const tdStyle = { padding: "10px 14px", verticalAlign: "middle" };
const dateCellStyle = {
  display: "inline-block", padding: "4px 14px", borderRadius: 999,
  background: "var(--bg)", border: "1px solid var(--border)",
  color: "var(--muted)", fontSize: 11, fontWeight: 600,
  fontFamily: "'JetBrains Mono',monospace", minWidth: 60,
};

function ProjectTable({ projects, onOpen, onStatusChange }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", position: "relative" }}>
      {/* Thin pink accent stripe on the left — matches the Monday-style
          "this is a project table" affordance in Jeremy's reference. */}
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "#EC4899" }} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg)" }}>
              <th style={thStyle}></th>
              <th style={{ ...thStyle, textAlign: "left" }}>Project</th>
              <th style={thStyle}>Start Date</th>
              <th style={thStyle}>Due date</th>
              <th style={thStyle}>Timeline</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p, i) => (
              <ProjectRow key={p.id} project={p} onOpen={onOpen} onStatusChange={onStatusChange} striped={i % 2 === 1} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle = {
  padding: "10px 14px", textAlign: "center",
  fontSize: 10, fontWeight: 800, color: "var(--muted)",
  letterSpacing: 0.6, textTransform: "uppercase",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const ProjectCard = memo(function ProjectCard({ project, onClick }) {
  const links = project.links || {};
  const dests = Array.isArray(project.destinations) ? project.destinations : [];
  const descPreview = (project.description || "").trim();
  const descShort = descPreview.length > 140 ? descPreview.slice(0, 137) + "…" : descPreview;
  return (
    <div onClick={onClick} style={{
      background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
      padding: "16px 18px", cursor: "pointer", transition: "border-color 0.15s",
      display: "flex", flexDirection: "column", gap: 10,
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}>
      <div>
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 2 }}>
          {project.clientName || "—"}
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg)", lineHeight: 1.25 }}>
          {project.projectName || "Untitled project"}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {project.videoType && <Chip>{project.videoType}</Chip>}
        {project.numberOfVideos != null && <Chip color="var(--muted)">{project.numberOfVideos} videos</Chip>}
        {project.dealValue != null && <Chip color="#10B981">{fmtCur(Number(project.dealValue) || 0)}</Chip>}
      </div>

      {descShort && (
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
          {descShort}
        </div>
      )}

      {dests.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {dests.map((d, i) => (
            <span key={i} style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 4,
              background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)",
            }}>{d}</span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        <StatusPill label="Sherpa"   done={!!links.sherpaId}   color="#8B5CF6"/>
        <StatusPill label="Pre-Prod" done={!!links.preprodId}  color="#EC4899"/>
        <StatusPill label="Runsheet" done={!!links.runsheetId} color="#06B6D4"/>
        <StatusPill label="Delivery" done={!!links.deliveryId} color="#10B981"/>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
        <span>{project.dueDate ? `Due ${fmtD(project.dueDate)}` : (project.closeDate ? `Signed ${fmtD(project.closeDate)}` : "")}</span>
        <span>{project.createdAt ? fmtD(project.createdAt) : ""}</span>
      </div>
    </div>
  );
});

function ProjectDetail({ project, onBack, onDelete }) {
  // Status normalised once on mount — legacy "active" / "onHold" records
  // map to the 7-status taxonomy via normaliseStatus().
  const [status, setStatus] = useState(normaliseStatus(project.status));
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved

  // Per-leaf fbUpdate. fbUpdate is merge-semantics so concurrent writes
  // from the webhook (e.g. attioCompanyId arriving late) don't get
  // clobbered by a render-time spread of the old project object.
  const persistField = async (path, value) => {
    setSaveState("saving");
    try {
      await fbUpdate(`/projects/${project.id}`, {
        [path]: value,
        updatedAt: new Date().toISOString(),
      });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1200);
    } catch (e) {
      console.error("Failed to save project:", e);
      setSaveState("idle");
    }
  };

  // Click handlers for the linked-record pills. Each emits a hash-based
  // route the App-level listener picks up (#tool/subTab/recordId);
  // matching tab opens, the receiving component auto-opens the specific
  // record on mount. Falls back to no-op if the link is missing.
  const links = project.links || {};
  const dests = Array.isArray(project.destinations) ? project.destinations : [];
  const accountId = links.accountId || null;
  const navigate = (hash) => { window.location.hash = hash; };
  const openSherpa   = () => links.sherpaId   && navigate(`sherpas/${links.sherpaId}`);
  const openPreprod  = () => links.preprodId  && navigate(`preproduction/${links.preprodType || "metaAds"}/${links.preprodId}`);
  const openRunsheet = () => links.runsheetId && navigate(`preproduction/runsheets/${links.runsheetId}`);
  const openDelivery = () => links.deliveryId && navigate(`projects/deliveries/${links.deliveryId}`);
  const openAccount  = () => accountId        && navigate(`accounts/${accountId}`);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 28px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...BTN, background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)" }}>← Back to projects</button>
        {saveState === "saving" && <span style={{ fontSize: 11, color: "var(--muted)" }}>Saving…</span>}
        {saveState === "saved"  && <span style={{ fontSize: 11, color: "#10B981", fontWeight: 600 }}>Saved ✓</span>}
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, gap: 16 }}>
        <div style={{ flex: 1 }}>
          {/* clientName is intentionally read-only — it's the Attio link.
              Edits here would silently de-sync from Accounts / Deliveries /
              Sherpas which all match by name. Edit upstream in Attio and
              the next sync will refresh. */}
          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>
            {project.clientName}
          </div>
          <InlineText
            value={project.projectName || ""}
            onSave={(v) => persistField("projectName", v.trim() || "Untitled project")}
            placeholder="Project name"
            style={{ fontSize: 24, fontWeight: 700, color: "var(--fg)" }}
          />
        </div>
        {/* Seven-status taxonomy — coloured dropdown to fit without overflow */}
        <div style={{ minWidth: 200 }}>
          <StatusCell value={status} onChange={(s) => { setStatus(s); persistField("status", s); }} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
        <FieldCard label="Video Type">
          <InlineText value={project.videoType || ""} placeholder="e.g. Social Media Premium"
            onSave={(v) => persistField("videoType", v.trim())} />
        </FieldCard>
        <FieldCard label="Number of Videos">
          <InlineText value={project.numberOfVideos != null ? String(project.numberOfVideos) : ""}
            placeholder="e.g. 12" type="number"
            onSave={(v) => persistField("numberOfVideos", v.trim() === "" ? null : parseInt(v, 10) || 0)} />
        </FieldCard>
        <FieldCard label="Deal Value">
          <InlineText value={project.dealValue != null ? String(project.dealValue) : ""}
            placeholder="$ AUD" type="number"
            displayValue={project.dealValue != null ? fmtCur(Number(project.dealValue) || 0) : ""}
            onSave={(v) => persistField("dealValue", v.trim() === "" ? null : parseFloat(v) || 0)} />
        </FieldCard>
        <FieldCard label="Due Date">
          <InlineText value={project.dueDate || ""} placeholder="YYYY-MM-DD" type="date"
            displayValue={project.dueDate ? fmtD(project.dueDate) : ""}
            onSave={(v) => persistField("dueDate", v || null)} />
        </FieldCard>
        <FieldCard label="Signing Date">
          <InlineText value={project.closeDate || ""} placeholder="YYYY-MM-DD" type="date"
            displayValue={project.closeDate ? fmtD(project.closeDate) : ""}
            onSave={(v) => persistField("closeDate", v || null)} />
        </FieldCard>
        <FieldCard label="Target Audience">
          <InlineText value={project.targetAudience || ""} placeholder="e.g. Sydney women, 25-44"
            onSave={(v) => persistField("targetAudience", v.trim())} />
        </FieldCard>
      </div>

      <FieldCard label="Destinations" hint="Press Enter to add. Click a chip to remove.">
        <DestinationsEditor value={dests} onChange={(next) => persistField("destinations", next)} />
      </FieldCard>

      <FieldCard label="Scope of Work">
        <InlineTextArea value={project.description || ""}
          placeholder="What's being produced, key talking points, anything specific the client called out…"
          onSave={(v) => persistField("description", v)} />
      </FieldCard>

      <FieldCard label="Client Contact">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
          <InlineText value={project.clientContact?.firstName || ""} placeholder="First name"
            onSave={(v) => persistField("clientContact", { ...(project.clientContact || {}), firstName: v.trim() })} />
          <InlineText value={project.clientContact?.email || ""} placeholder="email@company.com" type="email"
            onSave={(v) => persistField("clientContact", { ...(project.clientContact || {}), email: v.trim() })} />
        </div>
        {project.clientContact?.email && (
          <a href={`mailto:${project.clientContact.email}`} style={{ display: "inline-block", marginTop: 6, fontSize: 11, color: "var(--accent)", textDecoration: "none" }}>
            ✉ {project.clientContact.email} ↗
          </a>
        )}
      </FieldCard>

      {/* Linked Records — pills now click through to the matching record
          via hash routing. Disabled (faded) pills are records that don't
          exist for this project (e.g. Meta Ads projects have no delivery
          until the producer pushes one from preprod approval). */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Linked Records · click to open
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <ClickableStatusPill label="Sherpa"   done={!!links.sherpaId}   color="#8B5CF6" onClick={openSherpa}   disabled={!links.sherpaId}   />
          <ClickableStatusPill label="Pre-Prod" done={!!links.preprodId}  color="#EC4899" onClick={openPreprod}  disabled={!links.preprodId}  />
          <ClickableStatusPill label="Runsheet" done={!!links.runsheetId} color="#06B6D4" onClick={openRunsheet} disabled={!links.runsheetId} />
          <ClickableStatusPill label="Delivery" done={!!links.deliveryId} color="#10B981" onClick={openDelivery} disabled={!links.deliveryId} />
          <ClickableStatusPill label="Account"  done={!!accountId}        color="#F59E0B" onClick={openAccount}  disabled={!accountId}        />
        </div>
      </div>

      <FieldCard label="Producer Notes" hint="Internal — won't be shown to the client.">
        <InlineTextArea value={project.producerNotes || ""}
          placeholder="Anything your future self / the editor needs to know about this project…"
          onSave={(v) => persistField("producerNotes", v)} />
      </FieldCard>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => { if (confirm(`Delete project "${project.projectName}"? This only removes it from the Projects tab — linked records (delivery / preprod / sherpa / account) are kept.`)) onDelete(); }}
          style={{ ...BTN, background: "transparent", color: "#EF4444", border: "1px solid #EF4444" }}>
          Delete project
        </button>
      </div>
    </div>
  );
}

export function Projects({ projects, deliveries, setDeliveries, accounts, route }) {
  const [subTab, setSubTab] = useState("projects"); // "projects" | "deliveries"
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [filter, setFilter] = useState("all"); // "all" | "active" | "onHold" | "archived"
  const [search, setSearch] = useState("");

  // Deep-link receiver — App.jsx parses #projects/<subTab>/<recordId> and
  // passes route here. We honour subTab + the record id once the matching
  // record exists in the local listener data. The Deliveries sub-tab opens
  // its own detail view via the deepLinkDeliveryId prop below.
  useEffect(() => {
    if (!route || !route.subTab) return;
    if (route.subTab !== subTab) setSubTab(route.subTab);
    if (route.subTab === "projects" && route.recordId && projects.find(p => p.id === route.recordId)) {
      setActiveProjectId(route.recordId);
    }
  }, [route?.subTab, route?.recordId, projects]);   // eslint-disable-line react-hooks/exhaustive-deps

  const active = projects.find(p => p.id === activeProjectId);

  // `filter` now maps to status groups rather than the 3 legacy keys.
  // "active" = everything except Done + Archived (the workable pipeline).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .map(p => ({ ...p, _status: normaliseStatus(p.status) }))
      .filter(p => {
        if (filter === "active")   return p._status !== "done" && p._status !== "archived";
        if (filter === "done")     return p._status === "done";
        if (filter === "archived") return p._status === "archived";
        return p._status !== "archived";  // "all"
      })
      .filter(p => !q || (p.projectName || "").toLowerCase().includes(q) || (p.clientName || "").toLowerCase().includes(q))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [projects, filter, search]);

  const deleteProject = async (id) => {
    await fbSet(`/projects/${id}`, null);
    setActiveProjectId(null);
  };

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Projects</span>
          {!active && (
            <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3, marginLeft: 12 }}>
              <button onClick={() => setSubTab("projects")} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: subTab === "projects" ? "var(--card)" : "transparent", color: subTab === "projects" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Projects</button>
              <button onClick={() => setSubTab("deliveries")} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: subTab === "deliveries" ? "var(--card)" : "transparent", color: subTab === "deliveries" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Deliveries</button>
            </div>
          )}
        </div>
        {subTab === "projects" && !active && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects…"
              style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, width: 200, outline: "none" }}/>
            <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
              {[
                { key: "active",   label: "Active" },
                { key: "done",     label: "Done" },
                { key: "archived", label: "Archived" },
                { key: "all",      label: "All" },
              ].map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: filter === f.key ? "var(--card)" : "transparent", color: filter === f.key ? "var(--fg)" : "var(--muted)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {subTab === "projects" && !active && (
        <div style={{ padding: "16px 28px 60px" }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📁</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                {search ? "No matches" : filter === "archived" ? "No archived projects" : filter === "done" ? "No projects done" : "No projects yet"}
              </div>
              {!search && filter === "active" && (
                <div style={{ fontSize: 13, maxWidth: 400, margin: "0 auto" }}>
                  Projects appear here automatically when a deal moves to <strong>Won</strong> in Attio.
                </div>
              )}
            </div>
          ) : (
            <ProjectTable
              projects={filtered}
              onOpen={(id) => setActiveProjectId(id)}
              onStatusChange={(id, status) => {
                // Write the status leaf directly so the change lands before
                // any listener race — same pattern as the Deliveries
                // per-field write fix. Also bump updatedAt for sort keys.
                fbSet(`/projects/${id}/status`, status);
                fbSet(`/projects/${id}/updatedAt`, new Date().toISOString());
              }}
            />
          )}
        </div>
      )}

      {subTab === "projects" && active && (
        <ProjectDetail project={active} onBack={() => setActiveProjectId(null)} onDelete={() => deleteProject(active.id)}/>
      )}

      {subTab === "deliveries" && (
        <Deliveries
          deliveries={deliveries}
          setDeliveries={setDeliveries}
          accounts={accounts}
          deepLinkDeliveryId={route?.subTab === "deliveries" ? route?.recordId : null}
        />
      )}
    </>
  );
}
