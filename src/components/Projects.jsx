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

import { useState, useMemo, useEffect, useRef, memo, Fragment } from "react";
import { BTN } from "../config";
import { fmtCur, fmtD, matchSherpaForName } from "../utils";
import { fbSet, fbUpdate } from "../firebase";
import { Deliveries } from "./Deliveries";
import { TeamBoard } from "./TeamBoard";
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";

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

// ─── Subtask taxonomy ──────────────────────────────────────────────
// Subtasks have a slightly different status set than their parent
// project — Jeremy's spec calls out: Stuck, On Hold, Scheduled, In
// Progress, Waiting on Client, Done. No "Not Started" / "Archived"
// since subtasks are atomic units of work that always have a target.
const SUBTASK_STATUS_OPTIONS = [
  { key: "scheduled",     label: "Scheduled",         color: "#3B82F6" },
  { key: "inProgress",    label: "In Progress",       color: "#F97316" },
  { key: "waitingClient", label: "Waiting on Client", color: "#8B5CF6" },
  { key: "onHold",        label: "On Hold",           color: "#EAB308" },
  { key: "stuck",         label: "Stuck",             color: "#EC4899" },
  { key: "done",          label: "Done",              color: "#10B981" },
];
const SUBTASK_STATUS_MAP = Object.fromEntries(SUBTASK_STATUS_OPTIONS.map(s => [s.key, s]));
function normaliseSubtaskStatus(raw) {
  // Subtasks have their own status set — "onHold" is a real key here,
  // not a legacy alias for "waitingClient" like it is on projects. So
  // we deliberately skip LEGACY_STATUS and only fall back to "stuck"
  // when the value isn't a valid subtask status.
  const key = raw || "stuck";
  return SUBTASK_STATUS_MAP[key] ? key : "stuck";
}

// Stage = which phase of the production lifecycle this subtask sits in
// (Pre Production → Shoot → Revisions → Edit, plus Hold for paused
// work). Independent from status — a subtask can be "Stuck" inside any
// stage, "Done" for that stage, etc. The four default phase subtasks
// get auto-tagged with their matching stage; manual + video subtasks
// default to Pre Production until the producer moves them on.
const SUBTASK_STAGE_OPTIONS = [
  { key: "preProduction", label: "Pre Production", color: "#8B5CF6" },
  // Shoot is red — visually loud (filming days are the most logistics-
  // sensitive moment of a project) and distinct from the pink Stuck
  // status, the brighter delete-button red, and the orange Revisions
  // stage. Avoids being mistaken for any other dropdown's colour.
  { key: "shoot",         label: "Shoot",          color: "#DC2626" },
  { key: "revisions",     label: "Revisions",      color: "#F97316" },
  // Edit uses the Viewix accent blue (matches --accent in config.js).
  { key: "edit",          label: "Edit",           color: "#0082FA" },
  { key: "hold",          label: "Hold",           color: "#EAB308" },
];
const SUBTASK_STAGE_MAP = Object.fromEntries(SUBTASK_STAGE_OPTIONS.map(s => [s.key, s]));

// Infer a sensible stage from the subtask's name when no `stage` field
// has been written yet. Saves the producer from having to retro-tag
// every existing subtask manually after this feature ships — the four
// default phases (and any video subtasks named after a phase) light up
// correctly on first render, and the inferred value gets persisted the
// first time the producer opens the dropdown.
function inferStage(subtask) {
  if (subtask?.stage && SUBTASK_STAGE_MAP[subtask.stage]) return subtask.stage;
  const name = (subtask?.name || "").toLowerCase();
  if (name.includes("pre production") || name.includes("preproduction") || name.includes("pre-production")) return "preProduction";
  if (name.includes("revision")) return "revisions";  // before "shoot" since "reshoot" might match
  if (name.includes("shoot")) return "shoot";
  if (name.includes("edit")) return "edit";
  return "preProduction";
}

// Default subtasks every project gets seeded with on first expand.
// Mirrors the four phases of the production lifecycle Jeremy walks
// through with every client. Each default's name maps cleanly onto a
// SUBTASK_STAGE_OPTIONS key via inferStage().
const DEFAULT_SUBTASKS = ["Pre Production", "Shoot", "Revisions", "Edit"];

// Ordered list of subtask records out of the keyed Firebase object.
// Falls back to insertion order when `order` is missing so legacy
// records (or the auto-seeded defaults) still render in a stable order.
function subtasksAsArray(subtasksObj) {
  if (!subtasksObj || typeof subtasksObj !== "object") return [];
  return Object.values(subtasksObj)
    .filter(Boolean)
    .sort((a, b) => {
      const ao = a.order ?? 9999, bo = b.order ?? 9999;
      if (ao !== bo) return ao - bo;
      const ct = (a.createdAt || "").localeCompare(b.createdAt || "");
      if (ct !== 0) return ct;
      // Final tiebreaker — without this, two subtasks created in the
      // same millisecond render in non-deterministic order across
      // reloads, which makes "stable list" assumptions break.
      return (a.id || "").localeCompare(b.id || "");
    });
}

// Persist a drag-reorder of subtasks within a single project. We
// rewrite every order value to the new index 0..n-1 (rather than only
// the changed slice) because legacy records often have sparse / null
// orders and a clean 0-based sequence is easier to reason about. Only
// the writes that actually change anything are sent.
function reorderSubtasks(projectId, subtasks, activeId, overId) {
  if (!activeId || !overId || activeId === overId) return;
  const oldIndex = subtasks.findIndex(s => s.id === activeId);
  const newIndex = subtasks.findIndex(s => s.id === overId);
  if (oldIndex < 0 || newIndex < 0) return;
  const next = arrayMove(subtasks, oldIndex, newIndex);
  next.forEach((st, idx) => {
    if ((st.order ?? -1) !== idx) {
      fbSet(`/projects/${projectId}/subtasks/${st.id}/order`, idx);
    }
  });
}

// Resolve a project's Sherpa Doc URL for the chip rendered in the
// Project detail panel (Projects list + Team Board modal). Lookup
// order:
//   1. project.links.sherpaId → /clients/{id}.docUrl   (the hard
//      link set by api/webhook-deal-won.js when an Attio deal flips
//      to Won).
//   2. matchSherpaForName() fuzzy fallback so legacy /clients
//      records typed manually with short names ("Canva") still
//      resolve against full Attio clientNames ("Canva Pty Ltd").
// Returns null if no record is linked or the matched record has no
// docUrl. `clients` may arrive as an array or undefined.
export function findSherpaDocUrl(project, clients) {
  if (!project || !clients) return null;
  const list = Array.isArray(clients) ? clients : Object.values(clients).filter(Boolean);
  // 1. Hard-link via Attio webhook id wins when present.
  const sherpaId = project?.links?.sherpaId;
  if (sherpaId) {
    const byId = list.find(c => c?.id === sherpaId);
    if (byId?.docUrl) return byId.docUrl;
  }
  // 2. Fall through to the fuzzy name matcher so legacy short-name
  //    /clients records ("Canva") still resolve against full Attio
  //    project clientNames ("Canva Pty Ltd").
  const match = matchSherpaForName(project.clientName, list);
  return match?.docUrl || null;
}

// Read a subtask's assignees as an array. New schema is
// `assigneeIds: string[]`; legacy schema was `assigneeId: string`.
// This helper transparently reads both so we don't need to migrate
// every record up-front. Writes always set the new field; the legacy
// `assigneeId` is kept in sync as the first element so any code that
// still reads it sees a consistent value.
export function getAssigneeIds(subtask) {
  if (Array.isArray(subtask?.assigneeIds)) return subtask.assigneeIds.filter(Boolean);
  if (subtask?.assigneeId) return [subtask.assigneeId];
  return [];
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
  // separate `displayValue` (currency / date) OR the input is a
  // number/date type (browser rejects formatted strings for those).
  // For plain text fields we just render the input directly.
  const useSwap = !!displayValue || type === "date" || type === "number";
  if (useSwap && !focused) {
    // Fall back to the raw value when no displayValue was supplied.
    // Without this, a number field like "Number of Videos" with no
    // displayValue would render blank and fall through to placeholder
    // text — same bug the deal-value field had before fefe8a1.
    const showText = (value || draft) ? (displayValue ?? (value || draft)) : "";
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

// Inline stage dropdown — sits next to the subtask name. Smaller than
// the right-column status pill (which classifies *how* the work is
// going); this one classifies *which phase of production* the work is
// in. Replaces the earlier purple/cyan/slate source-indicator square.
function SubtaskStageCell({ value, onChange, subtask }) {
  // inferStage gives us a sensible default when the subtask predates
  // this feature and has no stage field yet. We don't write the
  // inferred value back automatically — only when the producer touches
  // the dropdown does it get persisted.
  const key = inferStage({ ...subtask, stage: value });
  const opt = SUBTASK_STAGE_MAP[key];
  return (
    <select
      value={key}
      onClick={e => e.stopPropagation()}
      onChange={e => { e.stopPropagation(); onChange(e.target.value); }}
      title={`Stage: ${opt.label}`}
      style={{
        padding: "3px 7px", border: "none", borderRadius: 4,
        background: opt.color, color: "#fff",
        fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
        textTransform: "uppercase", cursor: "pointer",
        textAlign: "center", appearance: "none",
        fontFamily: "inherit",
        flexShrink: 0,
      }}>
      {SUBTASK_STAGE_OPTIONS.map(s => (
        <option key={s.key} value={s.key} style={{ background: "var(--card)", color: "var(--fg)" }}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

// Subtask-specific status pill — reuses the StatusCell visual but
// pulls from SUBTASK_STATUS_OPTIONS so "On Hold" appears (and the
// project-only "Not Started" / "Archived" don't).
function SubtaskStatusCell({ value, onChange }) {
  const key = normaliseSubtaskStatus(value);
  const opt = SUBTASK_STATUS_MAP[key];
  return (
    <select
      value={key}
      onClick={e => e.stopPropagation()}
      onChange={e => { e.stopPropagation(); onChange(e.target.value); }}
      style={{
        width: "100%", padding: "6px 10px", border: "none",
        background: opt.color, color: "#fff",
        fontSize: 10, fontWeight: 800, letterSpacing: 0.4,
        textTransform: "uppercase", cursor: "pointer",
        textAlign: "center", appearance: "none",
        fontFamily: "inherit",
      }}>
      {SUBTASK_STATUS_OPTIONS.map(s => (
        <option key={s.key} value={s.key} style={{ background: "var(--card)", color: "var(--fg)" }}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

// Compact inline editor used inside the subtask row — same commit-on-blur
// behaviour as InlineText but smaller padding/font + transparent background
// so the row stays Monday-style dense. When `multiline` is true, renders a
// textarea that auto-grows so long subtask names wrap instead of clipping.
function SubtaskInline({ value, onSave, placeholder, type = "text", style, multiline = false }) {
  const [draft, setDraft] = useState(value || "");
  const [focused, setFocused] = useState(false);
  const taRef = useRef(null);
  useEffect(() => { if (!focused) setDraft(value || ""); }, [value, focused]);
  // Auto-resize the textarea to fit its content. Reset to auto first so the
  // height shrinks when text is deleted, not just when it grows.
  useEffect(() => {
    if (!multiline || !taRef.current) return;
    const el = taRef.current;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [draft, multiline]);
  const commit = () => {
    if ((draft || "") === (value || "")) return;
    onSave(draft || "");
  };
  const sharedStyle = {
    width: "100%", padding: "5px 8px", borderRadius: 4,
    border: "1px solid transparent", background: "transparent",
    color: "var(--fg)", fontSize: 12, fontWeight: 500,
    fontFamily: "inherit", outline: "none",
    ...style,
  };
  const sharedHandlers = {
    onClick: e => e.stopPropagation(),
    onFocus: () => setFocused(true),
    onBlur: () => { setFocused(false); commit(); },
    placeholder,
    onMouseEnter: e => e.currentTarget.style.borderColor = "var(--border)",
    onMouseLeave: e => { if (!focused) e.currentTarget.style.borderColor = "transparent"; },
  };
  if (multiline) {
    return (
      <textarea
        ref={taRef}
        rows={1}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          // Enter commits (no newline). Shift+Enter inserts a newline.
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
          if (e.key === "Escape") { setDraft(value || ""); e.target.blur(); }
        }}
        {...sharedHandlers}
        style={{
          ...sharedStyle,
          resize: "none", overflow: "hidden",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          lineHeight: 1.35,
        }}
      />
    );
  }
  return (
    <input
      type={type}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { setDraft(value || ""); e.target.blur(); } }}
      {...sharedHandlers}
      style={sharedStyle}
    />
  );
}

// Frame.io review-link cell — compact inline URL editor with a Watch
// button. Resolved view value prefers the linked delivery video's link
// (matched by canonical videoId) and falls back to the subtask's own
// frameioLink, so the producer-managed delivery side stays canonical.
// On save, the parent's onSave handler writes to BOTH sides so they
// stay in sync going forward; clearing the field clears both. Soft
// validation marks non-frame.io URLs in red but doesn't block saving —
// producers/leads sometimes paste interim Drive / Vimeo links during
// triage and we don't want to fight them at the cell.
function FrameioLinkCell({ subtask, project, deliveries, onSave }) {
  const resolved = (() => {
    if (subtask?.videoId && project) {
      const delId = (project.links || {}).deliveryId;
      const del = delId && Array.isArray(deliveries)
        ? deliveries.find(d => d?.id === delId)
        : null;
      const vid = del && Array.isArray(del.videos)
        ? del.videos.find(v => v && v.videoId === subtask.videoId)
        : null;
      if (vid?.link) return vid.link;
    }
    return subtask?.frameioLink || "";
  })();
  const [draft, setDraft] = useState(resolved);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(resolved); }, [resolved, focused]);
  const commit = () => {
    if ((draft || "") === (resolved || "")) return;
    onSave(draft || "");
  };
  const trimmedDraft = (draft || "").trim();
  const looksLikeFrameio = !trimmedDraft || /(^|\.|\/\/)f(rame)?\.io(\/|$)/i.test(trimmedDraft);
  const watchUrl = trimmedDraft
    ? (/^https?:\/\//i.test(trimmedDraft) ? trimmedDraft : `https://${trimmedDraft}`)
    : null;
  const baseBorder = focused
    ? (looksLikeFrameio ? "var(--accent)" : "#EF4444")
    : "transparent";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
      <input
        type="url"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onClick={e => e.stopPropagation()}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={e => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") { setDraft(resolved); e.target.blur(); }
        }}
        placeholder="+ Frame.io link"
        title="Paste a Frame.io review link. Saves to this subtask AND the matching delivery video (synced by videoId)."
        style={{
          width: 160, padding: "4px 8px", borderRadius: 4,
          border: `1px solid ${baseBorder}`,
          background: focused ? "var(--input-bg)" : "transparent",
          color: "var(--fg)", fontSize: 11, fontFamily: "inherit",
          outline: "none",
          textOverflow: "ellipsis",
        }}
        onMouseEnter={e => { if (!focused) e.currentTarget.style.borderColor = "var(--border)"; }}
        onMouseLeave={e => { if (!focused) e.currentTarget.style.borderColor = "transparent"; }}
      />
      {watchUrl && (
        <a href={watchUrl} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={`Open Frame.io review: ${trimmedDraft}`}
          style={{
            padding: "3px 8px", borderRadius: 4,
            background: "rgba(0,130,250,0.14)", color: "#0082FA",
            fontSize: 10, fontWeight: 700, textDecoration: "none",
            display: "inline-flex", alignItems: "center", gap: 3,
            fontFamily: "inherit",
            border: "1px solid rgba(0,130,250,0.35)",
          }}>
          🎬
        </a>
      )}
    </div>
  );
}

// Subtask row — indented under its parent project. Same column layout
// as ProjectRow so the timeline / status pills line up vertically.
// `editors` is the roster from App.jsx (/editors node). `project` is
// passed in so we can check sibling subtasks for the auto-mark-done
// rollup (when every subtask hits Done, the project itself flips to
// Done too — saves producers a manual click).
// Multi-assignee picker. Click the button → popover with one row per
// editor + a checkbox. Toggling persists immediately via `onChange`.
// Designed for inline use inside a subtask row, so width is constrained
// and the popover floats below the button.
function MultiAssigneePicker({ value, editors, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const ids = Array.isArray(value) ? value : [];
  const idSet = new Set(ids);
  const assigned = (editors || []).filter(e => idSet.has(e.id));

  // Close on outside-click. Bound only while the popover is open so
  // we don't re-render the whole table on every document click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const label = assigned.length === 0
    ? "Unassigned"
    : assigned.length === 1
    ? assigned[0].name
    : `${assigned[0].name} +${assigned.length - 1}`;

  const toggle = (editorId) => {
    const next = idSet.has(editorId)
      ? ids.filter(x => x !== editorId)
      : [...ids, editorId];
    onChange(next);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        title={assigned.length > 0 ? assigned.map(a => a.name).join(", ") : "Click to assign"}
        style={{
          padding: "4px 8px", borderRadius: 4,
          border: "1px solid var(--border)",
          background: assigned.length > 0 ? "var(--input-bg)" : "var(--bg)",
          color: assigned.length > 0 ? "var(--fg)" : "var(--muted)",
          fontSize: 11, fontWeight: 600, cursor: "pointer",
          fontFamily: "inherit",
          maxWidth: 160, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
          display: "inline-flex", alignItems: "center", gap: 4,
        }}>
        {label} <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: "absolute", top: "100%", left: 0, marginTop: 4,
            minWidth: 200, maxHeight: 280, overflowY: "auto",
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 6, boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
            zIndex: 10,
            padding: 4,
          }}>
          {(editors || []).length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
              No editors in roster.
            </div>
          ) : (editors || []).map(ed => {
            const checked = idSet.has(ed.id);
            return (
              <label
                key={ed.id}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 8px", borderRadius: 4,
                  fontSize: 12, cursor: "pointer",
                  color: "var(--fg)",
                  background: checked ? "rgba(99,102,241,0.12)" : "transparent",
                }}
                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { if (!checked) e.currentTarget.style.background = "transparent"; }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(ed.id)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span style={{ fontWeight: checked ? 600 : 500 }}>{ed.name}</span>
              </label>
            );
          })}
          {assigned.length > 0 && (
            <button
              onClick={() => onChange([])}
              style={{
                width: "100%", marginTop: 4,
                padding: "5px 8px", borderRadius: 4,
                border: "1px solid var(--border)",
                background: "transparent", color: "var(--muted)",
                fontSize: 10, fontWeight: 600, cursor: "pointer",
                fontFamily: "inherit",
              }}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SubtaskRow({ projectId, subtask, project, editors, deliveries, onDelete, striped }) {
  // useSortable wires this row into whatever <SortableContext> wraps
  // it (project details + the projects sub-tab list each have their
  // own). The drag handle in the leading cell carries the listeners
  // so producers grab there, not on the whole row — clicking the row
  // body opens the project, which would conflict with a row-wide drag.
  const {
    attributes: dragAttrs, listeners: dragListeners,
    setNodeRef: setDragRef, transform, transition, isDragging,
  } = useSortable({ id: subtask.id });
  const persist = (field, value) => {
    fbSet(`/projects/${projectId}/subtasks/${subtask.id}/${field}`, value);
    fbSet(`/projects/${projectId}/subtasks/${subtask.id}/updatedAt`, new Date().toISOString());

    // Rollup: when a subtask flips to Done, check whether every sibling
    // is now Done too — if so, mark the project Done. We compute against
    // local state (treating this subtask as already-Done) because the
    // fbSet above hasn't round-tripped through the listener yet, so the
    // `project` prop still has the stale subtask status. Only rolls up
    // → Done; doesn't auto-revert if a producer un-completes a subtask
    // later (preserving any manual status change they might have made).
    if (field === "status" && value === "done" && project) {
      const siblings = Object.values(project.subtasks || {}).filter(Boolean);
      const allDone = siblings.length > 0 && siblings.every(s =>
        s.id === subtask.id ? true : normaliseSubtaskStatus(s.status) === "done"
      );
      if (allDone && normaliseStatus(project.status) !== "done") {
        fbSet(`/projects/${projectId}/status`, "done");
        fbSet(`/projects/${projectId}/updatedAt`, new Date().toISOString());
      }
    }

    // Cross-system flip: when a video subtask moves into "Waiting on
    // Client", the matching delivery video's viewix status becomes
    // "Ready for Review" so the client view updates without a
    // producer needing to flip both records by hand. Only fires when
    // the subtask carries a videoId (auto-seeded from pre-prod
    // approval, or stamped by the videoId backfill in App.jsx) so we
    // don't false-trigger on phase / manual subtasks. Limited to the
    // inProgress -> waitingClient transition to match the producer
    // intent the spec describes.
    if (field === "status" && value === "waitingClient" && subtask.videoId && project) {
      const oldStatus = normaliseSubtaskStatus(subtask.status);
      const delId = (project.links || {}).deliveryId;
      const delivery = delId ? (deliveries || []).find(d => d?.id === delId) : null;
      if (oldStatus === "inProgress" && delivery && Array.isArray(delivery.videos)) {
        const idx = delivery.videos.findIndex(v => v && v.videoId === subtask.videoId);
        if (idx >= 0) {
          fbSet(`/deliveries/${delId}/videos/${idx}/viewixStatus`, "Ready for Review");
        }
      }
    }
  };
  const baseBg = striped ? "rgba(255,255,255,0.02)" : "transparent";
  // Format start/end into a single timeline span if both are present —
  // mirrors the parent ProjectRow's TimelineCell so the visual lineage
  // is obvious.
  return (
    <tr
      ref={setDragRef}
      style={{
        background: baseBg,
        borderBottom: "1px solid var(--border)",
        transform: DndCSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        // Keep the dragged row above its neighbours so the dotted/striped
        // siblings don't clip the lifted row's content during the slide.
        position: isDragging ? "relative" : undefined,
        zIndex: isDragging ? 2 : undefined,
      }}>
      <td style={{ ...tdStyle, padding: "4px 14px", width: 28 }}>
        <span
          {...dragAttrs}
          {...dragListeners}
          title="Drag to reorder"
          aria-label="Drag to reorder"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 18, height: 18,
            color: "var(--muted)", opacity: 0.55,
            cursor: isDragging ? "grabbing" : "grab",
            userSelect: "none",
            fontSize: 12, lineHeight: 1, letterSpacing: -1,
            transition: "opacity 0.12s, color 0.12s",
            touchAction: "none",
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "var(--fg)"; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = "0.55"; e.currentTarget.style.color = "var(--muted)"; }}>
          {/* Six-dot grip — two columns of three dots, classic drag affordance. */}
          ⋮⋮
        </span>
      </td>
      <td style={{ ...tdStyle, padding: "4px 14px 4px 48px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          {/* Stage pill — replaces the previous purple/cyan/slate
              source-indicator square. The pill's colour communicates
              which production phase this subtask sits in (Pre
              Production / Shoot / Revisions / Edit / Hold). Click to
              reclassify. The right-column Status pill (Stuck / In
              Progress / Done / etc.) stays — they answer different
              questions: stage = where, status = how. */}
          <SubtaskStageCell
            value={subtask.stage}
            subtask={subtask}
            onChange={(s) => persist("stage", s)}
          />
          {/* flex:1 + minWidth:0 lets the name take all remaining width
              and shrink without overflowing the row's siblings. The
              multiline textarea then wraps long names instead of clipping. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <SubtaskInline
              value={subtask.name || ""}
              onSave={(v) => persist("name", v.trim() || "Untitled subtask")}
              placeholder="Subtask name"
              multiline
              style={{ fontSize: 12, fontWeight: 600 }}
            />
          </div>
          {/* Frame.io review-link cell — inline editable URL field with
              a Watch button next to it. Saves to subtask.frameioLink
              AND propagates onto the matching delivery video (resolved
              by canonical videoId) so the subtask, internal Deliveries
              tab, and the public client view all carry the same URL.
              Clearing the field clears both sides. */}
          <FrameioLinkCell
            subtask={subtask}
            project={project}
            deliveries={deliveries}
            onSave={(next) => {
              const trimmed = (next || "").trim();
              persist("frameioLink", trimmed);
              if (subtask.videoId && project) {
                const delId = (project.links || {}).deliveryId;
                const delivery = delId && Array.isArray(deliveries)
                  ? deliveries.find(d => d?.id === delId)
                  : null;
                if (delivery && Array.isArray(delivery.videos)) {
                  const idx = delivery.videos.findIndex(v => v && v.videoId === subtask.videoId);
                  if (idx >= 0) {
                    fbSet(`/deliveries/${delId}/videos/${idx}/link`, trimmed);
                  }
                }
              }
            }}
          />
          {/* Multi-assignee picker — supports multiple people on the
              same subtask (e.g. shoot crew). Writes to assigneeIds and
              keeps legacy assigneeId in sync as the first element so
              any code still reading the singular field gets a sensible
              value. Reads via getAssigneeIds() so existing records
              with only assigneeId render correctly without migration. */}
          <MultiAssigneePicker
            value={getAssigneeIds(subtask)}
            editors={editors}
            onChange={(nextIds) => {
              persist("assigneeIds", nextIds);
              persist("assigneeId", nextIds[0] || null);
            }}
          />
          {/* Delete subtask — visible by default in red so producers
              don't have to hover-hunt for the × like the previous
              implementation required. Hover deepens the background to
              confirm the hit. */}
          <button
            onClick={() => { if (window.confirm(`Delete subtask "${subtask.name}"?`)) onDelete(subtask.id); }}
            title="Delete subtask"
            aria-label="Delete subtask"
            style={{
              marginLeft: "auto",
              width: 24, height: 24,
              padding: 0, borderRadius: 6,
              border: "1px solid rgba(239,68,68,0.35)",
              background: "rgba(239,68,68,0.10)",
              color: "#EF4444",
              fontSize: 16, fontWeight: 700,
              lineHeight: 1, cursor: "pointer",
              fontFamily: "inherit", flexShrink: 0,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              transition: "background 0.12s, border-color 0.12s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(239,68,68,0.22)";
              e.currentTarget.style.borderColor = "#EF4444";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "rgba(239,68,68,0.10)";
              e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
            }}
          >×</button>
        </div>
        {/* Time row — start/end times sit under the name on the same column */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, marginLeft: 18 }}>
          <span style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>Time</span>
          <SubtaskInline
            value={subtask.startTime || ""} type="time" placeholder="Start"
            onSave={(v) => persist("startTime", v || null)}
            style={{ fontSize: 11, padding: "3px 6px", maxWidth: 90 }}
          />
          <span style={{ fontSize: 10, color: "var(--muted)" }}>→</span>
          <SubtaskInline
            value={subtask.endTime || ""} type="time" placeholder="End"
            onSave={(v) => persist("endTime", v || null)}
            style={{ fontSize: 11, padding: "3px 6px", maxWidth: 90 }}
          />
        </div>
      </td>
      <td style={{ ...tdStyle, width: 120, padding: "4px 8px" }}>
        <SubtaskInline
          value={subtask.startDate || ""} type="date" placeholder="—"
          onSave={(v) => persist("startDate", v || null)}
          style={{ fontSize: 11, textAlign: "center" }}
        />
      </td>
      <td style={{ ...tdStyle, width: 120, padding: "4px 8px" }}>
        <SubtaskInline
          value={subtask.endDate || ""} type="date" placeholder="—"
          onSave={(v) => persist("endDate", v || null)}
          style={{ fontSize: 11, textAlign: "center" }}
        />
      </td>
      <td style={{ ...tdStyle, width: 140, padding: "4px 14px" }}>
        <TimelineCell start={subtask.startDate} end={subtask.endDate} />
      </td>
      <td style={{ ...tdStyle, width: 180, padding: 0 }}>
        <SubtaskStatusCell value={subtask.status} onChange={(s) => persist("status", s)} />
      </td>
    </tr>
  );
}

// "+ Add subtask" footer row, anchored to the bottom of the expanded
// subtask group. Click → push a new subtask record under the project.
function AddSubtaskRow({ projectId, nextOrder }) {
  const add = () => {
    const id = `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    fbSet(`/projects/${projectId}/subtasks/${id}`, {
      id, name: "New subtask", status: "stuck",
      // Manual subtasks default to the Edit stage — most ad-hoc rows
      // producers add by hand are tracking edit/post work; rename in
      // the dropdown if it's actually a shoot/pre-prod task.
      stage: "edit",
      startDate: null, endDate: null, startTime: null, endTime: null,
      assigneeIds: [], assigneeId: null, source: "manual", order: nextOrder,
      createdAt: now, updatedAt: now,
    });
  };
  return (
    <tr style={{ background: "transparent", borderBottom: "1px solid var(--border)" }}>
      <td style={{ ...tdStyle, padding: "6px 14px" }} />
      <td colSpan={5} style={{ ...tdStyle, padding: "6px 14px 10px 48px" }}>
        <button onClick={add}
          style={{
            padding: "5px 12px", borderRadius: 4, border: "1px dashed var(--border)",
            background: "transparent", color: "var(--muted)",
            fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}
        >
          + Add subtask
        </button>
      </td>
    </tr>
  );
}

function ProjectRow({ project, onOpen, onStatusChange, striped, selected, onToggleSelect, expanded, onToggleExpand, subtaskCount, subtaskDoneCount }) {
  const videoCount = project.numberOfVideos;
  const clientPart = project.clientName || "—";
  const namePart = project.projectName || "Untitled project";
  const startDate = project.closeDate || project.createdAt;
  const dueDate = project.dueDate;
  // Selected rows get a soft indigo wash so the selection is obvious in
  // a long list. Hover still overrides briefly while the cursor is on
  // the row, then snaps back to selected/striped/normal on leave.
  const baseBg = selected ? "rgba(99,102,241,0.12)"
               : striped  ? "rgba(255,255,255,0.015)"
               : "transparent";
  return (
    <tr
      onClick={() => onOpen(project.id)}
      style={{
        cursor: "pointer",
        background: baseBg,
        borderBottom: "1px solid var(--border)",
      }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(99,102,241,0.06)"}
      onMouseLeave={e => e.currentTarget.style.background = baseBg}>
      <td style={tdStyle} onClick={e => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(project.id)}
          title="Select for bulk actions"
          style={{ cursor: "pointer", accentColor: "var(--accent)", width: 16, height: 16 }}
        />
      </td>
      <td style={{ ...tdStyle, minWidth: 320 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Expand toggle — click reveals subtasks under this project.
              Stop propagation so the row's row-level click (open detail)
              doesn't fire. Larger hit area (24px) than the original tiny
              chevron + a subtle hover background to make it feel like an
              actual button. Caret rotates 90° when expanded. */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleExpand(project.id); }}
            title={expanded ? "Collapse subtasks" : "Show subtasks"}
            aria-label={expanded ? "Collapse subtasks" : "Show subtasks"}
            style={{
              width: 28, height: 28, borderRadius: 6,
              border: "1px solid var(--border)",
              background: expanded ? "rgba(99,102,241,0.15)" : "var(--bg)",
              color: expanded ? "var(--accent)" : "var(--fg)",
              cursor: "pointer", padding: 0,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
              fontFamily: "inherit", flexShrink: 0,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(99,102,241,0.15)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "var(--accent)";
            }}
            onMouseLeave={e => {
              if (!expanded) {
                e.currentTarget.style.background = "var(--bg)";
                e.currentTarget.style.color = "var(--fg)";
                e.currentTarget.style.borderColor = "var(--border)";
              }
            }}
          >
            {/* Inline SVG caret — renders identically across fonts/OSes,
                rotates 90° via transform. Bigger + bolder than the glyph
                version so it actually reads as "expandable" at a glance. */}
            <svg
              width="14" height="14" viewBox="0 0 16 16" fill="none"
              style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.15s",
              }}>
              <path d="M5 3l6 5-6 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.3 }}>
            <span style={{ fontWeight: 700 }}>{clientPart}:</span>{" "}
            <span style={{ fontWeight: 500 }}>{namePart}</span>
          </span>
          {/* Video count — bare-number monospace badge, labelled "vids"
              so it can't be mistaken for the subtask badge sitting next
              to it. Both used to render as "4" / "4" when the counts
              happened to match — looked like a duplicate. */}
          {videoCount != null && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
              background: "var(--bg)", color: "var(--muted)",
              fontFamily: "'JetBrains Mono',monospace",
            }} title={`${videoCount} video${videoCount === 1 ? "" : "s"}`}>
              <span style={{ fontFamily: "inherit" }}>🎬</span> {videoCount}
            </span>
          )}
          {/* Subtask progress — done/total instead of bare count, so it
              both disambiguates from the video count and gives an
              at-a-glance progress read. Pill goes green once everything
              is Done. Hidden when there are no subtasks. */}
          {subtaskCount > 0 && (() => {
            const allDone = subtaskDoneCount === subtaskCount;
            return (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                background: allDone ? "rgba(16,185,129,0.15)" : "rgba(99,102,241,0.15)",
                color: allDone ? "#10B981" : "var(--accent)",
                fontFamily: "'JetBrains Mono',monospace",
              }} title={`${subtaskDoneCount} of ${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"} done`}>
                {allDone ? "✓" : "☐"} {subtaskDoneCount}/{subtaskCount}
              </span>
            );
          })()}
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

function ProjectTable({ projects, deliveries, onOpen, onStatusChange, selectedIds, onToggleSelect, onToggleSelectAll, expandedIds, onToggleExpand, editors }) {
  // Header checkbox is tri-state: empty / checked (all) / indeterminate
  // (some). Browsers don't have a CSS-only indeterminate state — set
  // it on the DOM via ref.
  const headerCheckRef = useRef(null);
  const allChecked = projects.length > 0 && projects.every(p => selectedIds.has(p.id));
  const someChecked = !allChecked && projects.some(p => selectedIds.has(p.id));
  useEffect(() => {
    if (headerCheckRef.current) headerCheckRef.current.indeterminate = someChecked;
  }, [someChecked]);

  // One DndContext spans the whole table; each expanded project gets
  // its own SortableContext below so dragging is scoped to siblings
  // within the same project. Subtask ids are unique across all
  // projects, so onDragEnd resolves the owning project by lookup.
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onSubtaskDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const owning = projects.find(p =>
      Object.values(p.subtasks || {}).some(s => s && s.id === active.id)
    );
    if (!owning) return;
    const subs = subtasksAsArray(owning.subtasks);
    if (!subs.some(s => s.id === over.id)) return; // dragged outside the project's group — ignore
    reorderSubtasks(owning.id, subs, active.id, over.id);
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", position: "relative" }}>
      {/* Thin pink accent stripe on the left — matches the Monday-style
          "this is a project table" affordance in Jeremy's reference. */}
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "#EC4899" }} />
      <div style={{ overflowX: "auto" }}>
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={onSubtaskDragEnd}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg)" }}>
              <th style={thStyle}>
                <input
                  ref={headerCheckRef}
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => onToggleSelectAll(allChecked)}
                  title={allChecked ? "Deselect all" : "Select all"}
                  style={{ cursor: "pointer", accentColor: "var(--accent)", width: 16, height: 16 }}
                />
              </th>
              <th style={{ ...thStyle, textAlign: "left" }}>Project</th>
              <th style={thStyle}>Start Date</th>
              <th style={thStyle}>Due date</th>
              <th style={thStyle}>Timeline</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p, i) => {
              const subtasks = subtasksAsArray(p.subtasks);
              const isExpanded = expandedIds.has(p.id);
              return (
                <Fragment key={p.id}>
                  <ProjectRow
                    project={p}
                    onOpen={onOpen}
                    onStatusChange={onStatusChange}
                    striped={i % 2 === 1}
                    selected={selectedIds.has(p.id)}
                    onToggleSelect={onToggleSelect}
                    expanded={isExpanded}
                    onToggleExpand={onToggleExpand}
                    subtaskCount={subtasks.length}
                    subtaskDoneCount={subtasks.filter(s => normaliseSubtaskStatus(s.status) === "done").length}
                  />
                  {isExpanded && (
                    <SortableContext items={subtasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
                      {subtasks.map((st, idx) => (
                        <SubtaskRow
                          key={st.id}
                          projectId={p.id}
                          subtask={st}
                          project={p}
                          editors={editors}
                          deliveries={deliveries}
                          striped={idx % 2 === 1}
                          onDelete={(stId) => fbSet(`/projects/${p.id}/subtasks/${stId}`, null)}
                        />
                      ))}
                    </SortableContext>
                  )}
                  {isExpanded && (
                    <AddSubtaskRow
                      projectId={p.id}
                      nextOrder={subtasks.length > 0 ? Math.max(...subtasks.map(s => s.order ?? 0)) + 1 : 0}
                    />
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </DndContext>
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

function ProjectDetail({ project, onBack, onDelete, editors, clients, deliveries }) {
  // Status normalised once on mount — legacy "active" / "onHold" records
  // map to the 7-status taxonomy via normaliseStatus().
  const [status, setStatus] = useState(normaliseStatus(project.status));
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved

  // dnd-kit sensor for the subtasks list. 6px activation distance keeps
  // a producer's casual click on the drag handle from being read as a
  // tiny drag and bouncing the row 1px on mouse-up.
  const subtaskDragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
  // Sherpa pill: the Sherpas tab is gone, so the pill now opens the
  // matching /clients record's Google Doc directly via findSherpaDocUrl().
  // Disabled if no link is found (no /clients record matches this
  // project's clientName + sherpaId).
  const sherpaUrl = findSherpaDocUrl(project, clients);
  const openSherpa = () => {
    if (sherpaUrl) window.open(sherpaUrl, "_blank", "noopener,noreferrer");
  };
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
        {/* Deal Value field intentionally removed from the detail
            view (both the inline page detail and the Team Board's
            quick-view modal). The value is still persisted on the
            /projects/{id} record — Attio webhook keeps writing it,
            and it still surfaces in places like the project card chip
            in the list view. Just not in the editable detail panel. */}
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
        {/* Sherpa doc — surfaced as an inline link directly under
            the scope of work since that's where producers naturally
            scan for "what does the client want, where's the brief".
            Lookup priority: project.links.sherpaId (set by the
            webhook), then case-insensitive name match on
            project.clientName. Edits live in the Accounts tab's
            expanded panel so this surface stays read-only. */}
        {(() => {
          const url = findSherpaDocUrl(project, clients);
          if (!url) return null;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                marginTop: 10, padding: "6px 10px", borderRadius: 6,
                background: "var(--accent-soft)", color: "var(--accent)",
                fontSize: 12, fontWeight: 700, textDecoration: "none",
                fontFamily: "inherit",
              }}>
              📄 Sherpa Doc ↗
            </a>
          );
        })()}
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
          <ClickableStatusPill label="Sherpa"   done={!!sherpaUrl}        color="#8B5CF6" onClick={openSherpa}   disabled={!sherpaUrl}        />
          <ClickableStatusPill label="Pre-Prod" done={!!links.preprodId}  color="#EC4899" onClick={openPreprod}  disabled={!links.preprodId}  />
          <ClickableStatusPill label="Runsheet" done={!!links.runsheetId} color="#06B6D4" onClick={openRunsheet} disabled={!links.runsheetId} />
          <ClickableStatusPill label="Delivery" done={!!links.deliveryId} color="#10B981" onClick={openDelivery} disabled={!links.deliveryId} />
          <ClickableStatusPill label="Account"  done={!!accountId}        color="#F59E0B" onClick={openAccount}  disabled={!accountId}        />
        </div>
      </div>

      {/* Subtasks — embed the same SubtaskRow used by the row-
          expansion drawer so producers can see + edit each subtask's
          stage, status, assignee, and dates without leaving the detail
          view. Especially important when this view is rendered inside
          the Team Board's quick-view modal — there's no row drawer
          accessible from there. SubtaskRow renders a <tr>, so it needs
          a <table> wrapper.
          Auto-seeds the four default phase subtasks the first time
          this section renders for a project that has none — same lazy
          migration pattern the row-expansion uses. */}
      {(() => {
        const subtasks = subtasksAsArray(project.subtasks);
        const seedDefaults = () => {
          const now = new Date().toISOString();
          DEFAULT_SUBTASKS.forEach((name, i) => {
            const stId = `st-default-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
            fbSet(`/projects/${project.id}/subtasks/${stId}`, {
              id: stId, name, status: "stuck",
              stage: inferStage({ name }),
              startDate: null, endDate: null, startTime: null, endTime: null,
              assigneeIds: [], assigneeId: null, source: "default", order: i,
              createdAt: now, updatedAt: now,
            });
          });
        };
        const addManual = () => {
          const id = `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date().toISOString();
          const nextOrder = subtasks.length > 0
            ? Math.max(...subtasks.map(s => s.order ?? 0)) + 1
            : 0;
          fbSet(`/projects/${project.id}/subtasks/${id}`, {
            id, name: "New subtask", status: "stuck",
            stage: "edit",
            startDate: null, endDate: null, startTime: null, endTime: null,
            assigneeIds: [], assigneeId: null, source: "manual", order: nextOrder,
            createdAt: now, updatedAt: now,
          });
        };
        return (
          <FieldCard label="Subtasks" hint="Stage = production phase. Status = how the work's going.">
            {subtasks.length === 0 ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px" }}>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>No subtasks yet.</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={seedDefaults}
                    style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 11, padding: "5px 10px" }}>
                    Seed default phases
                  </button>
                  <button onClick={addManual}
                    style={{ ...BTN, background: "var(--accent)", color: "#fff", border: "none", fontSize: 11, padding: "5px 10px" }}>
                    + Add subtask
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
                  <DndContext
                    sensors={subtaskDragSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={({ active, over }) => {
                      if (over) reorderSubtasks(project.id, subtasks, active.id, over.id);
                    }}>
                    <SortableContext items={subtasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <tbody>
                          {subtasks.map((st, idx) => (
                            <SubtaskRow
                              key={st.id}
                              projectId={project.id}
                              subtask={st}
                              project={project}
                              editors={editors}
                              deliveries={deliveries}
                              striped={idx % 2 === 1}
                              onDelete={(stId) => fbSet(`/projects/${project.id}/subtasks/${stId}`, null)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </SortableContext>
                  </DndContext>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button onClick={addManual}
                    style={{ padding: "5px 12px", borderRadius: 4, border: "1px dashed var(--border)",
                      background: "transparent", color: "var(--muted)",
                      fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                    onMouseEnter={e => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}>
                    + Add subtask
                  </button>
                </div>
              </>
            )}
          </FieldCard>
        );
      })()}

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

// Modal wrapper around <ProjectDetail>. Used by the Team Board so the
// producer can pop open a project's full editor without leaving the
// calendar. Click outside or press ESC to close. The modal stops click
// propagation on its content so clicks on inputs inside the editor
// don't accidentally trigger the backdrop close.
function ProjectQuickView({ project, onClose, onDelete, editors, clients, deliveries }) {
  // ESC closes — registered globally so it works regardless of which
  // input has focus. Cleaned up on unmount.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        zIndex: 100,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "5vh 4vw",
        overflowY: "auto",
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          width: "min(960px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          position: "relative",
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        }}>
        {/* Close × at top-right of the modal — sticky so it stays
            visible while scrolling through a long project. */}
        <button
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
          style={{
            position: "sticky", top: 12, float: "right", marginRight: 12, marginTop: 0,
            zIndex: 2,
            width: 32, height: 32, borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg)", color: "var(--fg)",
            fontSize: 18, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: "inherit",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.18)"; e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "var(--bg)"; e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--fg)"; }}
        >×</button>
        <ProjectDetail
          project={project}
          editors={editors}
          clients={clients}
          deliveries={deliveries}
          onBack={onClose}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

export function Projects({ projects, deliveries, setDeliveries, accounts, editors, setEditors, weekData, clients, route }) {
  const [subTab, setSubTab] = useState("projects"); // "projects" | "teamBoard" | "deliveries"
  const [activeProjectId, setActiveProjectId] = useState(null);
  // Quick-view modal — opened when a producer clicks a bar on the
  // Team Board. Renders the same <ProjectDetail> as the full sub-tab
  // view, but inside a backdrop overlay so the user stays on the Team
  // Board. Click outside or press ESC to close. Edits sync via the
  // same Firebase paths the full view writes to, so no extra wiring
  // needed for cross-tab sync.
  const [quickViewProjectId, setQuickViewProjectId] = useState(null);
  // Default to "active" so producers land on the workable pipeline
  // (everything except Done + Archived). They can still flip to All
  // / Done / Archived from the filter pills. The Projects sub-tab is
  // already the default sub-tab via subTab's initial state above.
  // Persisted to localStorage so a producer who's chosen Done or
  // Archived doesn't have it reset to "active" on every refresh.
  // Per-user, browser-local — not shared via URL because the filter
  // is a viewing preference, not a routable state.
  const FILTER_KEY = "viewix.projects.filter";
  const VALID_FILTERS = ["all", "active", "done", "archived"];
  const [filter, setFilter] = useState(() => {
    try {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem(FILTER_KEY) : null;
      return VALID_FILTERS.includes(saved) ? saved : "active";
    } catch { return "active"; }
  });
  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(FILTER_KEY, filter);
    } catch { /* private mode / disabled storage — ignore */ }
  }, [filter]);
  // Sort preference for the Projects sub-tab. Persisted alongside `filter`
  // so producers don't have to re-pick A–Z every visit. Default is alpha
  // for first-time / cleared-storage visits.
  const SORT_KEY = "viewix.projects.sort";
  const VALID_SORTS = ["alpha", "newest", "oldest"];
  const [sortBy, setSortBy] = useState(() => {
    try {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem(SORT_KEY) : null;
      return VALID_SORTS.includes(saved) ? saved : "alpha";
    } catch { return "alpha"; }
  });
  useEffect(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(SORT_KEY, sortBy);
    } catch { /* private mode / disabled storage — ignore */ }
  }, [sortBy]);
  const [search, setSearch] = useState("");
  // Bulk-action selection — Set of project ids checked via the row
  // checkbox or the header select-all. Clears when the filter or
  // sub-tab changes (those rows aren't visible any more, leaving them
  // selected would surprise the producer).
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  useEffect(() => { setSelectedIds(new Set()); }, [filter, subTab]);

  // Expansion state for the subtask drawer under each project. Local-only
  // (doesn't persist) so producers don't open a project to a wall of
  // expanded rows — the table starts collapsed each visit.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      // Lazy-seed default subtasks the first time a project is expanded
      // and has none yet. Mirrors the SocialOrganicResearch first-open
      // migration pattern — defaults land in Firebase only when the
      // producer actually engages with the project, keeping the data
      // tree clean for projects that nobody ever drills into.
      const project = projects.find(p => p.id === id);
      if (project && (!project.subtasks || Object.keys(project.subtasks).length === 0)) {
        const now = new Date().toISOString();
        DEFAULT_SUBTASKS.forEach((name, i) => {
          const stId = `st-default-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
          fbSet(`/projects/${id}/subtasks/${stId}`, {
            id: stId, name, status: "stuck",
            stage: inferStage({ name }),
            startDate: null, endDate: null, startTime: null, endTime: null,
            assigneeIds: [], assigneeId: null, source: "default", order: i,
            createdAt: now, updatedAt: now,
          });
        });
      }
      return next;
    });
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAllVisible = (allCurrentlyChecked) => {
    setSelectedIds(prev => {
      if (allCurrentlyChecked) return new Set();
      const next = new Set(prev);
      for (const p of filtered) next.add(p.id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

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
      .sort((a, b) => {
        // Newest / Oldest sort by the same date the row's start column
        // displays — closeDate (Attio deal close) when present, falling
        // back to createdAt for projects created directly in the UI.
        // Sorting on createdAt alone made imported projects look random
        // because their createdAt is the import timestamp, not the date
        // the producer actually sees.
        if (sortBy === "newest" || sortBy === "oldest") {
          const da = a.closeDate || a.createdAt || "";
          const db = b.closeDate || b.createdAt || "";
          return sortBy === "newest" ? db.localeCompare(da) : da.localeCompare(db);
        }
        // A–Z matches the visible "Client: Project" row label. Client
        // name is the bold leading part, so producers read alphabetical
        // order from there; project name is the tiebreaker for clients
        // with several projects. Both case-insensitive.
        const ci = { sensitivity: "base" };
        const byClient = (a.clientName || "").localeCompare(b.clientName || "", undefined, ci);
        if (byClient !== 0) return byClient;
        return (a.projectName || "").localeCompare(b.projectName || "", undefined, ci);
      });
  }, [projects, filter, search, sortBy]);

  const deleteProject = async (id) => {
    await fbSet(`/projects/${id}`, null);
    setActiveProjectId(null);
  };

  // ─── Bulk actions ──────────────────────────────────────────────
  // Applied to every project in selectedIds. All writes are leaf-path
  // fbSet so concurrent webhook patches don't get clobbered. Done
  // sequentially in a Promise.all so the listener flushes once at the
  // end rather than rerendering on every individual write.
  const bulkSetStatus = async (status) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ts = new Date().toISOString();
    await Promise.all(ids.flatMap(id => [
      fbSet(`/projects/${id}/status`, status),
      fbSet(`/projects/${id}/updatedAt`, ts),
    ]));
    clearSelection();
  };
  const bulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} project${ids.length === 1 ? "" : "s"}? Linked records (delivery / preprod / sherpa / account) are kept.`)) return;
    await Promise.all(ids.map(id => fbSet(`/projects/${id}`, null)));
    clearSelection();
  };

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Projects</span>
          {!active && (
            <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3, marginLeft: 12 }}>
              <button onClick={() => setSubTab("projects")} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: subTab === "projects" ? "var(--card)" : "transparent", color: subTab === "projects" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Projects</button>
              <button onClick={() => setSubTab("teamBoard")} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: subTab === "teamBoard" ? "var(--card)" : "transparent", color: subTab === "teamBoard" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Team Board</button>
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
            <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
              {[
                { key: "alpha",  label: "A–Z" },
                { key: "newest", label: "Newest" },
                { key: "oldest", label: "Oldest" },
              ].map(s => (
                <button key={s.key} onClick={() => setSortBy(s.key)}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: sortBy === s.key ? "var(--card)" : "transparent", color: sortBy === s.key ? "var(--fg)" : "var(--muted)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                  {s.label}
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
            <>
              {/* Bulk-action bar — appears whenever any rows are
                  selected. Sticky at the top of the table area so it
                  follows the producer down a long list. */}
              {selectedIds.size > 0 && (
                <div style={{
                  position: "sticky", top: 12, zIndex: 5,
                  display: "flex", alignItems: "center", gap: 12, marginBottom: 12,
                  padding: "10px 16px", background: "var(--card)",
                  border: "1px solid var(--accent)", borderRadius: 10,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>
                    {selectedIds.size} selected
                  </span>
                  <div style={{ width: 1, height: 20, background: "var(--border)" }} />
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Set status:</span>
                  <select
                    value=""
                    onChange={e => { if (e.target.value) bulkSetStatus(e.target.value); }}
                    style={{
                      padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "var(--input-bg)", color: "var(--fg)",
                      fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                    }}>
                    <option value="">Choose…</option>
                    {STATUS_OPTIONS.map(s => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                  <button onClick={() => bulkSetStatus("archived")}
                    style={{
                      padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "var(--bg)", color: "var(--muted)",
                      fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                    }}>
                    Archive
                  </button>
                  <button onClick={bulkDelete}
                    style={{
                      padding: "5px 12px", borderRadius: 6, border: "1px solid #EF4444",
                      background: "transparent", color: "#EF4444",
                      fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                    }}>
                    Delete
                  </button>
                  <button onClick={clearSelection}
                    style={{
                      marginLeft: "auto",
                      padding: "5px 10px", borderRadius: 6, border: "none",
                      background: "transparent", color: "var(--muted)",
                      fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                    }}>
                    Clear
                  </button>
                </div>
              )}
              <ProjectTable
                projects={filtered}
                deliveries={deliveries}
                onOpen={(id) => setActiveProjectId(id)}
                onStatusChange={(id, status) => {
                  // Write the status leaf directly so the change lands before
                  // any listener race — same pattern as the Deliveries
                  // per-field write fix. Also bump updatedAt for sort keys.
                  fbSet(`/projects/${id}/status`, status);
                  fbSet(`/projects/${id}/updatedAt`, new Date().toISOString());
                }}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onToggleSelectAll={toggleSelectAllVisible}
                expandedIds={expandedIds}
                onToggleExpand={toggleExpand}
                editors={editors}
              />
            </>
          )}
        </div>
      )}

      {subTab === "projects" && active && (
        <ProjectDetail project={active} editors={editors} clients={clients} deliveries={deliveries} onBack={() => setActiveProjectId(null)} onDelete={() => deleteProject(active.id)}/>
      )}

      {subTab === "teamBoard" && !active && (
        <>
          <TeamBoard
            projects={projects}
            editors={editors}
            setEditors={setEditors}
            weekData={weekData}
            onOpenProject={(id) => setQuickViewProjectId(id)}
          />
          {/* Quick-view modal — renders the full ProjectDetail editor
              over the team board. All edits persist to the same
              Firebase paths the Projects sub-tab writes to, so the
              two views are always in sync (the listener on /projects
              flows updates back into the live `projects` array). If
              the project gets deleted (or its id otherwise vanishes),
              quickViewProject becomes undefined and the modal
              auto-unmounts. */}
          {(() => {
            const qv = projects.find(p => p.id === quickViewProjectId);
            return qv ? (
              <ProjectQuickView
                project={qv}
                editors={editors}
                clients={clients}
                deliveries={deliveries}
                onClose={() => setQuickViewProjectId(null)}
                onDelete={async () => {
                  await deleteProject(qv.id);
                  setQuickViewProjectId(null);
                }}
              />
            ) : null;
          })()}
        </>
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
