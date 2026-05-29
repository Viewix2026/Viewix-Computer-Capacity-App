// TeamBoard — Monday-style scheduling grid for project subtasks.
//
// Editors run down the rows (sourced from /editors), days run across the
// columns. Each subtask renders as a Gantt-style bar positioned by its
// startDate / endDate / assigneeId. Drag a bar between rows to reassign,
// between columns to reschedule (preserves duration). Drag the right
// edge to extend the endDate. Drop on the leftmost "Unscheduled" column
// to clear the dates.
//
// All state lives on /projects/{id}/subtasks/{stId} — same leaves the
// Projects.jsx subtask drawer reads. Per-leaf fbSet writes so concurrent
// webhook patches don't clobber producer drags.

import { useMemo, useState, useRef, useCallback, useEffect, useContext } from "react";
import { fbSet, fbUpdate, authFetch } from "../firebase";
import { resolveAccountForProject } from "../utils";
import {
  CalendarSyncContext,
  enqueueCalendarSync,
  CANCELLATION_PROMPT_DAYS,
} from "../calendar-sync";
import { computeSelectsTimelineWrites } from "../../shared/scheduling/selects.js";
import { SelectsPickerModal } from "./SelectsPickerModal";
import TeamBoardFlagBanner from "./TeamBoardFlagBanner.jsx";
import { isOverdueEdit, isBehindScheduleFlagged } from "../../shared/scheduling/overdue.js";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, useDndContext, closestCenter, pointerWithin, DragOverlay,
} from "@dnd-kit/core";

// ─── Subtask stage palette ────────────────────────────────────────
// Mirrors SUBTASK_STAGE_OPTIONS in Projects.jsx — kept duplicated here
// (not imported) for the same reason as the rest of TeamBoard's local
// constants: tight coupling-by-import would force Projects.jsx to
// export every visual fragment. If the palette ever changes, change
// it in both places.
//
// Bars on the Team Board are coloured by STAGE (which production phase
// is this in) rather than STATUS (how is the work going). Stage gives
// a much more useful at-a-glance read of where the team's effort is
// concentrated — "lots of red bars next week" = lots of shoot days.
// NOTE: duplicated from shared/scheduling/stages.js to avoid pulling the
// shared module's full surface into the Team Board bundle. Keep in sync
// with STAGE_OPTIONS over there. (A future refactor could just import.)
const STAGE_COLOURS = {
  preProduction:   "#8B5CF6",
  shoot:           "#DC2626",
  selectsTimeline: "#0EA5E9",
  revisions:       "#F97316",
  edit:            "#0082FA",
  hold:            "#EAB308",
};
// Mirrors inferStage in shared/scheduling/stages.js — falls back to a
// name-based guess when the stage field is missing (legacy data) or
// invalid. Keeps the Team Board readable for projects that haven't been
// touched since each stage shipped.
const stageOf = (st) => {
  if (st?.stage && STAGE_COLOURS[st.stage]) return st.stage;
  const name = (st?.name || "").toLowerCase();
  if (name.includes("pre production") || name.includes("preproduction") || name.includes("pre-production")) return "preProduction";
  if (name.includes("revision")) return "revisions";
  if (name.includes("shoot")) return "shoot";
  if (name.includes("timeline")) return "selectsTimeline";
  if (name.includes("edit")) return "edit";
  return "preProduction";
};
const colourFor = (subtask) => STAGE_COLOURS[stageOf(subtask)];

// Ordered list for the legend strip — same order as STAGE_OPTIONS in
// shared/scheduling/stages.js so producers see a consistent sequence
// across the Projects dropdown, the Team Board legend, and the brain.
const STAGE_LEGEND = [
  { key: "preProduction",   label: "Pre Production" },
  { key: "shoot",           label: "Shoot" },
  { key: "selectsTimeline", label: "Selects Timeline" },
  { key: "revisions",       label: "Revisions" },
  { key: "edit",            label: "Edit" },
  { key: "hold",            label: "Hold" },
];

// ─── Date helpers (local — too narrow for src/utils.js) ────────────
//
// These all work in the browser's LOCAL timezone, not UTC. Earlier the
// helpers used `d.toISOString().slice(0, 10)` which silently converted
// to UTC — for users in positive timezones (e.g. Sydney UTC+10) the
// converted ISO string lands a day earlier than intended, and chaining
// `addDays` produced the same date repeatedly because the +1 day shift
// and the timezone roll-back cancelled. Result: every Team Board column
// rendered as the same day.
const toISO = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const isoToday = () => toISO(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISO(d);
};
const daysBetween = (a, b) => Math.round(
  (new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000
);
// Snap an ISO date back to the Monday of its week. Producers expect the
// board to start on Monday so the current week is fully visible from
// the moment they open the tab, regardless of which weekday they're on.
const startOfWeek = (iso) => {
  const d = new Date(iso + "T00:00:00");
  const wd = d.getDay();           // 0 Sun, 1 Mon, … 6 Sat
  const shift = wd === 0 ? -6 : 1 - wd;
  d.setDate(d.getDate() + shift);
  return toISO(d);
};
// ─── Lane assignment ───────────────────────────────────────────────
// Given the scheduled subtasks for a single editor row, group them
// into "lanes" (vertical slots) so overlapping bars stack instead of
// rendering on top of each other. Lane 0 is the topmost; new lanes
// are created lazily as needed. Within a lane, bars never overlap.
//
// Algorithm: greedy interval scheduling. Sort by startDate, then for
// each bar walk through existing lanes in order and place it in the
// first lane whose previous bar ended before this one starts. If no
// lane can hold it, open a new lane.
//
// Each lane gets its own CSS Grid sub-row in the parent layout, so
// lane heights are content-driven (auto-sized) and bars are free to
// grow as tall as their wrapped text needs.
// Scope a manual day-priority to one editor row + one start day. A
// subtask renders in every assignee's row and (if multi-day) anchors to
// its start day, so priority can't be a single scalar — it's a map keyed
// by this composite. "|" / "-" / ":" are all legal RTDB key chars.
const pkey = (editorId, dateISO) => `${editorId}|${dateISO}`;

// A bar's manual priority for this editor row, or Infinity when unset so
// un-prioritised bars sort after explicitly-ordered ones (then fall back
// to the deterministic endDate/id tiebreak below).
function dayPriorityOf(bar, editorId) {
  const v = bar?.dayPriority?.[pkey(editorId, bar.startDate)];
  return Number.isFinite(v) ? v : Infinity;
}

function assignLanes(scheduledBars, editorId) {
  const sorted = [...scheduledBars].sort((a, b) => {
    const sa = a.startDate || "";
    const sb = b.startDate || "";
    if (sa !== sb) return sa.localeCompare(sb);
    // Same start day for THIS editor → honour the manual order the
    // producer set by dragging the priority badge. Unset → endDate, id.
    const pa = dayPriorityOf(a, editorId);
    const pb = dayPriorityOf(b, editorId);
    if (pa !== pb) return pa - pb;
    const ea = (a.endDate || a.startDate || "");
    const eb = (b.endDate || b.startDate || "");
    if (ea !== eb) return ea.localeCompare(eb);
    return (a.id || "").localeCompare(b.id || "");
  });

  // Count bars per start day so each bar knows its 1-based rank + the
  // group size (badge only shows when a day has ≥2 bars for this editor).
  const daySizes = new Map();
  for (const bar of sorted) daySizes.set(bar.startDate, (daySizes.get(bar.startDate) || 0) + 1);
  const daySeen = new Map();

  const laneEnds = []; // laneEnds[i] = ISO endDate of the last bar in lane i
  const result = [];
  for (const bar of sorted) {
    const start = bar.startDate;
    const end = bar.endDate || bar.startDate;
    let lane = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      // Strict less-than: if the previous bar ends on the same day
      // this one starts, treat it as overlap (visually they'd touch
      // edge-to-edge and read as a continuous bar). Force a new lane.
      if (laneEnds[i] < start) {
        lane = i;
        laneEnds[i] = end;
        break;
      }
    }
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    }
    const rank = (daySeen.get(start) || 0) + 1;
    daySeen.set(start, rank);
    result.push({ ...bar, lane, dayRank: rank, daySize: daySizes.get(start) || 1 });
  }
  return { bars: result, laneCount: laneEnds.length };
}

// Format a YYYY-MM-DD as "21 Apr" using the en-AU locale. Parses the
// ISO with an explicit T00:00:00 so the browser uses local time (not
// UTC) — same reasoning as toISO above. Avoids using utils.js#fmtD
// which parses a bare YYYY-MM-DD as UTC midnight and can render the
// previous calendar day in negative timezones.
const fmtDateLabel = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const dateRange = (from, dayCount) => {
  const out = [];
  if (!from || !dayCount) return out;
  let d = from;
  // Hard cap at 365 days — even with infinite scroll a year is plenty
  // and protects against runaway memo recomputes if scrollLeft tracking
  // ever loops.
  const cap = Math.min(dayCount, 365);
  for (let i = 0; i < cap; i++) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
};
// Look up an editor's working status for a specific date, integrating
// the Capacity tab's weekly schedule into the Team Board. Returns:
//   "weekend" — Saturday/Sunday (always non-working; cell is left for
//                 the column-stripe layer to dim)
//   "off"     — weekday this editor is marked as not coming in
//   "in"      — weekday this editor is working
//   "shoot"   — weekday this editor is on a shoot day (still working)
//
// Resolution order:
//   1. /weekData/{mondayISO}/editors[] — week-specific override set in
//      the Capacity tab's Weekly Schedule grid.
//   2. editor.defaultDays[mon|tue|...] — the editor's standing default.
//   3. Falls back to "in" if neither is set, so missing data doesn't
//      silently grey out the entire grid.
//
// Mirrors the same dayVal() logic the Capacity tab uses (see utils.js)
// so the two surfaces stay consistent: a cell that reads "off" in
// Capacity reads "off" here, no exceptions.
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function getEditorDayStatus(weekData, editor, dateISO) {
  if (!editor || !dateISO) return "in";
  const d = new Date(dateISO + "T00:00:00");
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return "weekend";

  const dayKey = DAY_KEYS[dow];

  // Compute the wKey (ISO Monday) for this date's week.
  const monday = new Date(d);
  monday.setDate(d.getDate() + (1 - dow));
  const wkey = toISO(monday);

  let dayValue;
  const weekEditors = weekData?.[wkey]?.editors;
  if (Array.isArray(weekEditors)) {
    const weekEd = weekEditors.find(e => e.id === editor.id);
    if (weekEd) dayValue = weekEd.days?.[dayKey];
  }
  if (dayValue === undefined) {
    dayValue = editor.defaultDays?.[dayKey];
  }

  if (dayValue === true || dayValue === "in") return "in";
  if (dayValue === "shoot") return "shoot";
  return "off";
}

// Read a subtask's assignees as an array. New schema is `assigneeIds`;
// legacy schema was `assigneeId`. Mirrors the helper in Projects.jsx
// (kept local rather than imported — same convention as the rest of
// TeamBoard's local constants).
function getAssigneeIds(subtask) {
  if (Array.isArray(subtask?.assigneeIds)) return subtask.assigneeIds.filter(Boolean);
  if (subtask?.assigneeId) return [subtask.assigneeId];
  return [];
}

// Drop-zone id is "{assigneeId}|{dateOrNull}". Null/undefined values
// serialise to literal "null" so the round-trip survives split().
const cellId = (assigneeId, date) => `${assigneeId || "null"}|${date || "null"}`;
const parseCellId = (id) => {
  const [a, d] = id.split("|");
  return { assigneeId: a === "null" ? null : a, date: d === "null" ? null : d };
};

// ─── Static UI ────────────────────────────────────────────────────

// Stage colour key. Sits above the resizable scroll container so
// producers can match a coloured bar back to its stage name without
// having to memorise the palette. The bars themselves use the muted
// stage palette (so wrapped multi-line text stays readable on top of
// the tinted bg); the LEGEND uses brighter "neon" variants of the
// same hues + a soft glow so the key reads punchily even at this
// small size. Text is full-fg so it's easy to scan.
const LEGEND_COLOURS = {
  preProduction: "#A78BFA",   // brighter violet
  shoot:         "#EF4444",   // brighter red
  revisions:     "#FB923C",   // brighter orange
  edit:          "#38BDF8",   // brighter sky-blue
  hold:          "#FACC15",   // brighter yellow
};
function StageLegend() {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16,
      // Row padding is owned by the wrapper in TeamBoard so the legend
      // and the collapse-all toggle share one baseline.
      padding: 0,
      flexWrap: "wrap",
    }}>
      {STAGE_LEGEND.map(s => {
        const c = LEGEND_COLOURS[s.key];
        return (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{
              width: 12, height: 12, borderRadius: 3,
              background: c,
              // Soft "neon" glow so the swatch pops without needing
              // a bigger size. Two layered shadows: a tighter inner
              // halo and a softer outer glow at the same hue.
              boxShadow: `0 0 4px ${c}, 0 0 10px ${c}88`,
              flexShrink: 0,
            }}/>
            <span style={{
              fontSize: 11, fontWeight: 600,
              color: "var(--fg)",
              letterSpacing: 0.2, whiteSpace: "nowrap",
            }}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// Searchable "Filter by client" dropdown (replaces the old modal).
// Operates on the blacklist set (hiddenClients): a ticked box = visible
// = NOT in the set. Empty set shows everything; new clients show by
// default. Self-contained — owns its open + search state. The trigger
// shows the active count; the panel has a live search, Select/Deselect
// All, and a multi-select checkbox list. Outside-click or ESC closes.
function ClientFilterDropdown({ allClients, hiddenClients, setHiddenClients }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [open]);

  const toggle = (client) => {
    setHiddenClients(prev => {
      const next = new Set(prev);
      if (next.has(client)) next.delete(client); // was hidden → show
      else next.add(client);                     // was visible → hide
      return next;
    });
  };
  const selectAll = () => setHiddenClients(new Set());
  const deselectAll = () => setHiddenClients(new Set(allClients));

  const visibleCount = allClients.filter(c => !hiddenClients.has(c)).length;
  const narrowed = hiddenClients.size > 0;
  const q = query.trim().toLowerCase();
  const filtered = q ? allClients.filter(c => (c || "").toLowerCase().includes(q)) : allClients;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Filter the board by client"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: narrowed ? "var(--accent-soft, rgba(0,130,250,0.15))" : "none",
          border: `1px solid ${narrowed || open ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 6, padding: "4px 10px", margin: 0, cursor: "pointer",
          color: narrowed ? "var(--accent)" : "var(--fg)",
          opacity: narrowed || open ? 1 : 0.7,
          fontSize: 11, fontWeight: 700, lineHeight: 1,
          fontFamily: "inherit", whiteSpace: "nowrap",
          textTransform: "uppercase", letterSpacing: 0.4,
          transition: "opacity 0.12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = (narrowed || open) ? 1 : 0.7; }}
      >⛃ Filter{narrowed ? ` (${visibleCount}/${allClients.length})` : ""}</button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 200,
          width: 280, maxHeight: 380, background: "var(--card)",
          border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search clients…"
              style={{
                width: "100%", padding: "7px 10px", borderRadius: 6,
                border: "1px solid var(--border)", background: "var(--input-bg)",
                color: "var(--fg)", fontSize: 13, outline: "none",
                fontFamily: "inherit", boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" onClick={selectAll} style={FILTER_PILL_BTN}>Select all</button>
              <button type="button" onClick={deselectAll} style={FILTER_PILL_BTN}>Deselect all</button>
            </div>
          </div>
          <div style={{ overflowY: "auto", padding: "6px 10px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
            {filtered.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 6px", fontStyle: "italic" }}>No clients match.</div>
            ) : filtered.map(client => {
              const checked = !hiddenClients.has(client);
              return (
                <label key={client} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "6px", borderRadius: 6, cursor: "pointer",
                  fontSize: 13, color: "var(--fg)",
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(client)}
                    style={{ accentColor: "var(--accent)", width: 16, height: 16, cursor: "pointer" }}
                  />
                  <span style={{ flex: 1 }}>{client}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const FILTER_PILL_BTN = {
  flex: 1, padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)",
  fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  textTransform: "uppercase", letterSpacing: 0.4,
};

// ─── Drag-related primitives ───────────────────────────────────────

// A scheduled Gantt bar. The parent passes the grid column span via the
// outer wrapper in Row(); this component is the visual bar that fills
// that wrapper.
//
// Three drag interactions:
//   - Body → "move": reassign + reschedule.
//   - Right-edge handle → "resizeEnd": pull endDate to the dropped day.
//     If the dropped day is BEFORE startDate, that day becomes the new
//     startDate (treats "drag the right end past the left" as a flip).
//   - Left-edge handle → "resizeStart": pull startDate to the dropped
//     day. If the dropped day is AFTER endDate, that day becomes the
//     new endDate (mirror of the right-flip).
function GanttBar({ subtask, sourceAssigneeId, onClick, reorderable = false, dayRank = 1 }) {
  // Drag IDs include the sourceAssigneeId so multi-assignee subtasks
  // (which render once per assignee row) each have a unique draggable.
  // Without the suffix dnd-kit would see two useDraggables with the
  // same id and only the last would respond to events.
  const dragId = `bar:${subtask.id}:${sourceAssigneeId}`;
  // Calendar-sync status for the corner dot (shoot bars only).
  const calendarSyncQueue = useContext(CalendarSyncContext);
  const calQueueEntry = calendarSyncQueue?.get?.(`${subtask.projectId}__${subtask.id}`) || null;
  const calPendingSync = !!(calQueueEntry && calQueueEntry.dueAt && Date.parse(calQueueEntry.dueAt) > Date.now());
  const calSyncFailed = !!subtask.calendarSyncError;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    data: { mode: "move", subtask, sourceAssigneeId },
  });
  const resizeEnd = useDraggable({
    id: `resize-end:${subtask.id}:${sourceAssigneeId}`,
    data: { mode: "resizeEnd", subtask, sourceAssigneeId },
  });
  const resizeStart = useDraggable({
    id: `resize-start:${subtask.id}:${sourceAssigneeId}`,
    data: { mode: "resizeStart", subtask, sourceAssigneeId },
  });
  // Day-priority reorder: the priority badge doubles as a drag grip
  // (mode "reorderDay"), and the whole bar is a drop target for OTHER
  // bars being reordered (mode "reorderDayTarget"). A mode-filtered
  // collision strategy on the DndContext keeps these from interfering
  // with the body "move" / edge "resize" drags. Both only matter when
  // the bar shares its day with siblings (reorderable).
  const reorder = useDraggable({
    id: `reorder:${subtask.id}:${sourceAssigneeId}`,
    data: { mode: "reorderDay", subtask, sourceAssigneeId },
  });
  const reorderTarget = useDroppable({
    id: `reorderbar:${subtask.id}:${sourceAssigneeId}`,
    data: { mode: "reorderDayTarget", subtask, editorId: sourceAssigneeId },
  });
  // The bar node is both the move draggable and the reorder drop target.
  const setBarRef = (node) => { setNodeRef(node); reorderTarget.setNodeRef(node); };

  const colour = colourFor(subtask);
  // Phase 3 (#5): overdue (dated past the project's due date) → yellow/
  // black hazard stripes. behind-schedule (rolled by the overnight cron)
  // → red priority badge. The two are independent and can co-occur.
  const overdue = !!subtask.isOverdue;
  const behind = isBehindScheduleFlagged(subtask);
  const done = subtask.status === "done";
  // A finished bar always shows a static green tick in the badge slot
  // (item 3) so the producer can see at a glance which work is done.
  // Otherwise the badge only appears to rank the day (≥2 same-day tasks)
  // or to flag a behind-schedule edit. A done bar is never a drag grip.
  const showBadge = reorderable || behind || done;
  const badgeDraggable = reorderable && !done;
  const span = (subtask.startDate && subtask.endDate)
    ? Math.max(1, daysBetween(subtask.startDate, subtask.endDate) + 1)
    : 1;

  const baseStyle = {
    width: "100%", boxSizing: "border-box",
    margin: 0,
    // Right padding leaves room for the drag-handle dot cluster; left
    // padding widens when the priority badge/grip is shown so the
    // client name doesn't sit under it.
    padding: showBadge ? "6px 22px 6px 30px" : "6px 22px 6px 12px",
    borderRadius: 6,
    // Overdue → translucent yellow/black hazard stripes (kept low-opacity
    // so the light bar text stays readable on the dark board).
    background: overdue
      ? "repeating-linear-gradient(45deg, rgba(234,179,8,0.32) 0, rgba(234,179,8,0.32) 9px, rgba(0,0,0,0.42) 9px, rgba(0,0,0,0.42) 18px)"
      : `${colour}38`,
    borderLeft: `3px solid ${overdue ? "#EAB308" : colour}`,
    color: "var(--fg)",
    fontSize: 11,
    fontWeight: 600,
    cursor: isDragging ? "grabbing" : "grab",
    // No fixed height — the bar grows with content so wrapped titles
    // (long client + project + subtask names) display in full. Each
    // bar lives in its own auto-sized lane sub-row in the parent grid,
    // so growing taller doesn't bleed into another bar's lane.
    minHeight: 48,
    overflow: "visible",
    position: "relative",
    opacity: isDragging ? 0.4 : 1,
    // When another bar's reorder grip is dragged over this one, ring it
    // so the producer sees where the drop will land.
    outline: reorderTarget.isOver ? `2px solid ${colour}` : "none",
    outlineOffset: reorderTarget.isOver ? 1 : 0,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    userSelect: "none",
  };

  return (
    <div
      ref={setBarRef}
      style={baseStyle}
      onClick={(e) => {
        // PointerSensor's 6px activation distance means a real click
        // (no drag) lands here unmolested. Open the parent project.
        if (!isDragging) onClick?.();
      }}
      title={`${subtask.clientName} · ${subtask.projectName}\n${subtask.name}\n${subtask.startDate} → ${subtask.endDate}\nStage: ${stageOf(subtask)}`}
      {...listeners}
      {...attributes}>
      {/* Priority badge — only when this editor has ≥2 tasks starting
          this day. Shows the 1-based order AND doubles as the reorder
          drag grip: drag it onto another of the day's bars to reslot.
          stopPropagation on click so grabbing it never opens the
          project; the mode-filtered collision strategy keeps the drag
          from being read as a reschedule. */}
      {showBadge && (
        <div
          // Draggable reorder grip only when there are siblings to
          // reorder AND the task isn't done; a lone behind-schedule edit
          // or a finished bar shows a static badge (no drag).
          ref={badgeDraggable ? reorder.setNodeRef : undefined}
          {...(badgeDraggable ? reorder.listeners : {})}
          {...(badgeDraggable ? reorder.attributes : {})}
          onClick={e => e.stopPropagation()}
          title={done
            ? "Done"
            : behind
            ? "Behind schedule — this edit was due before and rolled to its editor's next working day"
            : "Drag to reorder this day's tasks for this editor"}
          style={{
            position: "absolute", top: 4, left: 6,
            width: 18, height: 18, borderRadius: "50%",
            // Green = done; red = behind schedule; otherwise stage colour.
            background: done ? "#10B981" : behind ? "#EF4444" : colour,
            color: "#fff",
            fontSize: 10, fontWeight: 800, lineHeight: 1,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: badgeDraggable ? (reorder.isDragging ? "grabbing" : "grab") : "default",
            boxShadow: done
              ? "0 0 0 2px rgba(16,185,129,0.35), 0 1px 3px rgba(0,0,0,0.45)"
              : behind
              ? "0 0 0 2px rgba(239,68,68,0.35), 0 1px 3px rgba(0,0,0,0.45)"
              : "0 1px 3px rgba(0,0,0,0.45)",
            // Lift + follow the cursor while dragging so the gesture
            // reads as "moving this task"; the target bar also rings.
            transform: badgeDraggable && reorder.transform
              ? `translate3d(${reorder.transform.x}px, ${reorder.transform.y}px, 0)`
              : undefined,
            zIndex: badgeDraggable && reorder.isDragging ? 1000 : 3,
            opacity: badgeDraggable && reorder.isDragging ? 0.9 : 1,
          }}
        >{done ? "✓" : dayRank}</div>
      )}
      {/* Drag-handle resting cue — small 2-row × 2-col dot grid in
          the top-right corner so producers see the bar is grabbable
          without hovering. Top-RIGHT instead of top-left because the
          left edge already has the resize handle stripe; piling them
          up would read as visual noise. Painted via radial gradients
          so no extra DOM. */}
      <div style={{
        position: "absolute", top: 4, right: 8,
        width: 8, height: 10,
        backgroundImage: `
          radial-gradient(circle at 1px 1px, rgba(255,255,255,0.35) 1px, transparent 1.5px),
          radial-gradient(circle at 7px 1px, rgba(255,255,255,0.35) 1px, transparent 1.5px),
          radial-gradient(circle at 1px 5px, rgba(255,255,255,0.35) 1px, transparent 1.5px),
          radial-gradient(circle at 7px 5px, rgba(255,255,255,0.35) 1px, transparent 1.5px),
          radial-gradient(circle at 1px 9px, rgba(255,255,255,0.35) 1px, transparent 1.5px),
          radial-gradient(circle at 7px 9px, rgba(255,255,255,0.35) 1px, transparent 1.5px)
        `,
        pointerEvents: "none",
      }}/>
      {/* Calendar-sync dot (shoot bars only). Bottom-right, colour-coded:
          red = sync error (incl. the loud "event still live, no crew"
          state) · amber = pending (debouncing / in flight) · green =
          on calendar. */}
      {subtask.stage === "shoot" && (calPendingSync || calSyncFailed || subtask.calendarEventId) && (
        <div
          title={
            calSyncFailed
              ? `Calendar: ${subtask.calendarSyncError}`
              : calPendingSync
                ? `Syncs to Viewix calendar at ${calQueueEntry?.dueAt ? new Date(calQueueEntry.dueAt).toLocaleTimeString() : "soon"}.`
                : "On Viewix calendar."
          }
          style={{
            position: "absolute", bottom: 4, right: 8,
            width: 8, height: 8, borderRadius: 999,
            background: calSyncFailed ? "#EF4444" : calPendingSync ? "#F59E0B" : "#10B981",
            boxShadow: "0 0 0 2px rgba(0,0,0,0.25)",
            pointerEvents: "none",
          }}/>
      )}
      {/* Line 1: client name + project name. Bold so the row is
          identifiable at a glance even when the bar is short. */}
      <div style={{
        fontWeight: 700, fontSize: 11, lineHeight: 1.3,
        whiteSpace: "normal", wordBreak: "break-word",
        marginBottom: 2,
      }}>
        {subtask.clientName}: {subtask.projectName}
      </div>
      {/* Line 2: subtask name. Slightly muted to distinguish from
          the client/project headline above. */}
      <div style={{
        fontWeight: 500, fontSize: 11, lineHeight: 1.3,
        whiteSpace: "normal", wordBreak: "break-word",
        opacity: 0.85,
      }}>
        {subtask.name}
      </div>
      {/* Footer: time range or span days, monospace for legibility. */}
      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 4, fontFamily: "'JetBrains Mono',monospace" }}>
        {subtask.startTime && subtask.endTime
          ? `${subtask.startTime} → ${subtask.endTime}`
          : `${span}d`}
      </div>
      {/* Resting-state grip cue + resize hit area. Hit area shrunk
          from 8px to 5px and the visible cue widened to 3px (was 2px)
          so the visible stripe matches the actual hit zone. Reason:
          when bars in the same lane sit adjacent to each other, the
          ~16px combined "resize zone" between them was easy to
          accidentally grab while intending to click a bar's body. A
          5px hit area drops the misfire risk significantly without
          breaking the resize-by-edge gesture. */}
      <div
        ref={resizeStart.setNodeRef}
        {...resizeStart.listeners}
        {...resizeStart.attributes}
        onClick={e => e.stopPropagation()}
        style={{
          position: "absolute", top: 0, left: 0, bottom: 0,
          width: 5, cursor: "ew-resize",
          background: resizeStart.isDragging
            ? colour
            : `linear-gradient(to right, transparent 1px, ${colour}55 1px, ${colour}55 4px, transparent 4px)`,
          borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
          zIndex: 2,
        }}
        onMouseEnter={e => e.currentTarget.style.background = `${colour}aa`}
        onMouseLeave={e => {
          if (!resizeStart.isDragging) {
            e.currentTarget.style.background = `linear-gradient(to right, transparent 1px, ${colour}55 1px, ${colour}55 4px, transparent 4px)`;
          }
        }}
        title="Drag to change start date"
      />
      <div
        ref={resizeEnd.setNodeRef}
        {...resizeEnd.listeners}
        {...resizeEnd.attributes}
        onClick={e => e.stopPropagation()}
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0,
          width: 5, cursor: "ew-resize",
          background: resizeEnd.isDragging
            ? colour
            : `linear-gradient(to left, transparent 1px, ${colour}55 1px, ${colour}55 4px, transparent 4px)`,
          borderTopRightRadius: 6, borderBottomRightRadius: 6,
          zIndex: 2,
        }}
        onMouseEnter={e => e.currentTarget.style.background = `${colour}aa`}
        onMouseLeave={e => {
          if (!resizeEnd.isDragging) {
            e.currentTarget.style.background = `linear-gradient(to left, transparent 1px, ${colour}55 1px, ${colour}55 4px, transparent 4px)`;
          }
        }}
        title="Drag to change end date"
      />
    </div>
  );
}

// Drop target — wraps a row + col cell. Column-scope visuals (weekend
// tint, today wash, Monday week-boundary border) are NOT handled here
// — they live on a separate background-stripe layer rendered above.
// This cell handles only row-scope styling: optional row striping,
// drop-hover highlight, mouse-hover highlight, and the row-bottom
// separator.
function DropCell({
  id, children, gridColumn, gridRow, sticky, striped, minHeight, dayStatus,
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  // Only highlight on drag-over if the active drag is compatible with
  // this drop zone. Date cells accept "move" + "resizeEnd" +
  // "resizeStart" (anything from a bar/pool card). Editor reorder drags
  // shouldn't tint date cells — confusing because the drop is silently
  // ignored anyway.
  const { active } = useDndContext();
  const activeMode = active?.data?.current?.mode;
  const isCompatible = !activeMode
    || activeMode === "move" || activeMode === "resizeEnd" || activeMode === "resizeStart";
  const [hovered, setHovered] = useState(false);

  // Capacity-driven cell tint:
  //   - "off" (editor not coming in that weekday): heavily dimmed so
  //     the producer can see at a glance that no one's available.
  //   - "in" / "shoot" (working): brighter than the default striped
  //     wash so working cells stand out vs the off ones. Producer
  //     asked specifically for this contrast.
  //   - "weekend": leave the column-stripe layer to handle it (we
  //     don't double-darken — would otherwise read pure black).
  const isOff = dayStatus === "off";
  const isWorking = dayStatus === "in" || dayStatus === "shoot";

  // Sticky left columns get solid backgrounds (matching the assignee
  // label cells in Row()) so the column-stripe layer behind doesn't
  // bleed through translucent rgba and break the "frozen" feel of the
  // left columns.
  // Background priority: drag-over > mouse hover > capacity off > capacity working > striped/sticky > base.
  let bg = "transparent";
  if (sticky != null) bg = striped ? "#1E2638" : "#1A2236";
  else if (isOff) bg = "rgba(0,0,0,0.45)";
  else if (isWorking) bg = striped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.04)";
  else if (striped) bg = "rgba(255,255,255,0.018)";
  if (hovered && sticky == null) bg = "rgba(99,102,241,0.10)";
  if (isOver && isCompatible) bg = "rgba(99,102,241,0.22)";

  return (
    <div
      ref={setNodeRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        gridColumn, gridRow,
        background: bg,
        borderRight: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        // Caller drives row height via minHeight so the cell expands
        // with the lane count of the parent row. Falls back to 44.
        minHeight: minHeight ?? 44,
        position: sticky != null ? "sticky" : "static",
        left: sticky,
        // Sticky columns sit above the column-stripe layer (z 0) but
        // below the drag overlay. Body cells sit just above the stripe.
        zIndex: sticky != null ? 2 : 1,
        transition: "background 0.1s",
      }}>
      {children}
    </div>
  );
}

// ─── Main board ────────────────────────────────────────────────────

export function TeamBoard({ projects = [], setProjects, editors = [], setEditors, weekData = {}, accounts = {}, onOpenProject }) {
  // Calendar-sync queue (via the Provider in Projects.jsx) — used for
  // the Gantt-bar sync dot + drag-drop intercepts.
  const calendarSyncQueue = useContext(CalendarSyncContext);
  // Modal state — drop-time entry + 7-day cancellation confirm. Set by
  // the onDragEnd intercept, cleared on close.
  const [shootDropModal, setShootDropModal] = useState(null);
  const [cancelConfirmModal, setCancelConfirmModal] = useState(null);
  // The board opens centred on the Monday of the current week so the
  // producer sees the full current week (including past days they may
  // have already worked) without scrolling left. From there:
  //   - daysAhead controls forward span. Initial 28 days (4 weeks).
  //     Scrolling near the right edge appends another 14-day batch.
  //   - daysBack controls past span. Initial 0 (no preloaded history).
  //     Scrolling near the left edge prepends another 14-day batch.
  //     Once revealed, prepended columns stay until the page reloads.
  // Both directions cap at 365 days. No toolbar, no manual prev/next.
  const [daysAhead, setDaysAhead] = useState(28);
  const [daysBack, setDaysBack] = useState(0);
  const fromDate = useMemo(() => {
    if (daysBack === 0) return startOfWeek(isoToday());
    const d = new Date(isoToday() + "T00:00:00");
    d.setDate(d.getDate() - daysBack);
    return startOfWeek(toISO(d));
  }, [daysBack]);
  const dates = useMemo(() => dateRange(fromDate, daysBack + daysAhead), [fromDate, daysBack, daysAhead]);

  // Bidirectional scroll-extension. Right-edge approach appends future
  // days. Left-edge approach (only when the producer is actively
  // scrolling left, not on initial mount when scrollLeft sits at 0)
  // prepends past days, then adjusts scrollLeft by the added pixel
  // width so the visible position doesn't visually jump backward
  // across the screen. We throttle via a "loading" guard so a fast
  // flick doesn't fire the extension multiple times during one
  // momentum scroll. Cap at 365 days each direction.
  const scrollRef = useRef(null);
  const extending = useRef(false);
  const lastScrollLeft = useRef(0);
  const onScroll = useCallback((e) => {
    if (extending.current) return;
    const el = e.currentTarget;
    const wasScrollingLeft = el.scrollLeft < lastScrollLeft.current;
    lastScrollLeft.current = el.scrollLeft;

    const remainingRight = el.scrollWidth - (el.scrollLeft + el.clientWidth);
    if (remainingRight < 320 && daysAhead < 365) {
      extending.current = true;
      setDaysAhead(d => Math.min(365, d + 14));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        extending.current = false;
      }));
      return;
    }
    if (wasScrollingLeft && el.scrollLeft < 320 && daysBack < 365) {
      extending.current = true;
      const oldScrollWidth = el.scrollWidth;
      setDaysBack(d => Math.min(365, d + 14));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const delta = el.scrollWidth - oldScrollWidth;
        if (delta > 0) {
          el.scrollLeft += delta;
          lastScrollLeft.current = el.scrollLeft;
        }
        extending.current = false;
      }));
    }
  }, [daysAhead, daysBack]);

  // Flatten every subtask across every project, carrying parent project
  // metadata along so the bar can render "Canva: Pre Production" without
  // a second lookup per cell during render.
  const flatSubtasks = useMemo(() => {
    const out = [];
    for (const p of projects) {
      if (!p?.subtasks) continue;
      for (const st of Object.values(p.subtasks)) {
        if (!st || !st.id) continue;
        out.push({
          ...st,
          projectId: p.id,
          projectName: p.projectName || "Untitled project",
          clientName: p.clientName || "—",
          // Phase 3 (#5): overdue = edit dated beyond the project's
          // effective due date. Computed here where the parent project
          // (dueDate + shoots) is in scope; the bar reads `isOverdue`.
          isOverdue: isOverdueEdit(st, p),
        });
      }
    }
    return out;
  }, [projects]);

  // ── Client filter ──────────────────────────────────────────────────
  // Blacklist model: we store the set of clients the producer has chosen
  // to HIDE (not a whitelist of selected ones). Empty set = everything
  // visible. This means a newly-scheduled client shows by default — you
  // never silently miss fresh work — and a narrowed view never silently
  // widens. Local view preference, so it lives in localStorage like the
  // per-row collapse state below.
  const HIDDEN_CLIENTS_LS_KEY = "viewix.teamBoard.hiddenClients";
  const [hiddenClients, setHiddenClients] = useState(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_CLIENTS_LS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_CLIENTS_LS_KEY, JSON.stringify([...hiddenClients]));
    } catch { /* storage disabled / quota — non-fatal */ }
  }, [hiddenClients]);

  // Distinct client names that actually have work on the board, sorted.
  // "Scheduled clients only" by construction — we read off flatSubtasks.
  const allClients = useMemo(() => {
    const set = new Set();
    for (const st of flatSubtasks) if (st.clientName) set.add(st.clientName);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [flatSubtasks]);

  // Apply the filter once, here, so both the editor-row grouping and the
  // pool drawer below see the same narrowed set.
  const visibleSubtasks = useMemo(
    () => flatSubtasks.filter(st => !hiddenClients.has(st.clientName)),
    [flatSubtasks, hiddenClients]
  );

  // Two bins:
  //   - scheduled: per-editor list of bars to render in that editor's
  //     row. A multi-assignee subtask appears once in EACH of its
  //     assignees' rows.
  //   - pool: subtasks that are missing a startDate, missing all
  //     assignees, or whose assignees are all stale (orphaned to
  //     deleted editors). One entry per subtask, not per assignee.
  //
  // The "valid current editor" check on each assignee is critical —
  // without it, a subtask assigned only to a deleted editor would have
  // no row to render in, silently disappearing.
  const editorIds = useMemo(() => new Set(editors.map(e => e.id)), [editors]);
  const editorById = useMemo(() => new Map(editors.map(e => [e.id, e.name || ""])), [editors]);
  const { scheduled, pool } = useMemo(() => {
    const scheduled = new Map();
    const pool = [];
    for (const st of visibleSubtasks) {
      const ids = getAssigneeIds(st);
      const validIds = ids.filter(id => editorIds.has(id));
      const hasDates = !!st.startDate;
      const hasAssignee = validIds.length > 0;
      const onCalendar = hasDates && hasAssignee;
      if (onCalendar) {
        // Render one bar per valid assignee in their respective rows.
        for (const aid of validIds) {
          if (!scheduled.has(aid)) scheduled.set(aid, []);
          scheduled.get(aid).push(st);
        }
      } else if (st.status === "scheduled") {
        // Pool only shows subtasks the producer has explicitly marked
        // Scheduled — those are the ones actively waiting for a slot.
        // "stuck" / "notStarted" / "inProgress" / "done" / etc. don't
        // belong here so the pool stays focused on assignment work.
        // Within the Scheduled pool we further require the subtask to
        // be missing an assignee OR a start date — i.e. it's not yet
        // landing on the calendar. Once both are set it'll move out
        // of the pool into the editor's row above on the next render.
        pool.push(st);
      }
    }
    pool.sort((a, b) => {
      const aIds = getAssigneeIds(a);
      const bIds = getAssigneeIds(b);
      // "_" < "a-z" so unassigned (and orphan) sorts to the front.
      const aName = aIds[0] ? (editorById.get(aIds[0]) || "zzz") : "_unassigned";
      const bName = bIds[0] ? (editorById.get(bIds[0]) || "zzz") : "_unassigned";
      if (aName !== bName) return aName.localeCompare(bName);
      return (a.clientName || "").localeCompare(b.clientName || "");
    });
    return { scheduled, pool };
  }, [visibleSubtasks, editorIds, editorById]);

  // Rows are just the editor roster now. The "Unassigned" lane has
  // moved out of the main grid into the bottom pool drawer below it.
  const rows = useMemo(() =>
    editors.map(e => ({ id: e.id, name: e.name, muted: false })),
    [editors]
  );

  // Per-person collapse. A producer can fold a heavy editor's row into a
  // thin line so the rest of the roster stays scannable. This is a local
  // view preference (not shared state) so it lives in localStorage, read
  // once at mount and written back by the effect below — the setCollapsed
  // updaters stay pure.
  const COLLAPSE_LS_KEY = "viewix.teamBoard.collapsedEditors";
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_LS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify([...collapsed]));
    } catch { /* storage disabled / quota — non-fatal, just won't persist */ }
  }, [collapsed]);

  const toggleCollapsed = useCallback((id) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const collapseAll = useCallback(() => {
    setCollapsed(new Set(editors.map(e => e.id)));
  }, [editors]);
  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);
  // True only when every editor is folded — drives the all-toggle label.
  const allCollapsed = editors.length > 0 && editors.every(e => collapsed.has(e.id));

  // Single droppable id for the bottom pool. Used by both the
  // useDroppable hook on the drawer and by onDragEnd to detect drops.
  const POOL_ID = "__pool__";

  // Per-editor layout: walks the rows in order assigning each editor a
  // contiguous block of grid rows = (laneCount) sub-rows. Each lane
  // gets its own auto-sizing grid track so bars in different lanes
  // grow vertically without overlapping. Carries the full editor
  // record (including defaultDays for the Capacity-tab integration)
  // alongside the simplified row info.
  // Fixed height of a collapsed editor's single thin row. Distinct from
  // the expanded lane track (minmax(56px, auto)) so a folded person reads
  // as a slim line, not a short-but-still-chunky band.
  const COLLAPSED_ROW = "32px";
  const editorLayout = useMemo(() => {
    let cursor = 2;  // grid row 1 = header row
    // Explicit per-track sizing instead of repeat(...): expanded editors
    // emit one minmax(56px,auto) track per lane (identical to the old
    // behaviour), collapsed editors emit one fixed COLLAPSED_ROW track.
    const trackSizes = [];
    const items = editors.map(editor => {
      const row = { id: editor.id, name: editor.name, muted: false };
      const sched = scheduled.get(editor.id) || [];
      const { bars: laneBars, laneCount } = assignLanes(sched, editor.id);
      const isCollapsed = collapsed.has(editor.id);
      const startRow = cursor;
      if (isCollapsed) {
        trackSizes.push(COLLAPSED_ROW);
        cursor += 1;
        return {
          row, editor, laneBars, laneCount: 1, startRow,
          collapsed: true, hiddenCount: sched.length,
        };
      }
      const rowCount = Math.max(1, laneCount);
      for (let i = 0; i < rowCount; i++) trackSizes.push("minmax(44px, auto)");
      cursor += rowCount;
      return {
        row, editor, laneBars, laneCount: rowCount, startRow,
        collapsed: false, hiddenCount: 0,
      };
    });
    return { items, totalRows: cursor - 2, trackSizes };
  }, [editors, scheduled, collapsed]);

  // ─── Drag handler ────────────────────────────────────────────────
  const sensors = useSensors(useSensor(PointerSensor, {
    // 6px buffer so producers reading a card don't accidentally pick it.
    // Same pattern as SocialOrganicSelect.jsx.
    activationConstraint: { distance: 6 },
  }));

  // Mode-filtered collision detection. The board has two disjoint sets
  // of drop targets: date cells / pool / editor-reorder slots (for
  // move / resize / reorderEditor), and per-bar reorder targets (for
  // reorderDay). Without filtering, closestCenter would let a bar's
  // reorder target steal a normal reschedule drop (or vice-versa). We
  // keep only the targets relevant to the active drag's mode, and skip
  // the dragged bar's own reorder target.
  const collisionStrategy = useCallback((args) => {
    const mode = args.active?.data?.current?.mode;
    const activeSubId = args.active?.data?.current?.subtask?.id;
    const containers = args.droppableContainers.filter(c => {
      const isReorderTarget = c.data?.current?.mode === "reorderDayTarget";
      if (mode === "reorderDay") {
        return isReorderTarget && c.data?.current?.subtask?.id !== activeSubId;
      }
      return !isReorderTarget;
    });
    const scoped = { ...args, droppableContainers: containers };
    // reorderDay = bar-to-bar; closestCenter is right (small same-day targets).
    if (mode === "reorderDay") return closestCenter(scoped);
    // move / resize onto date cells: cells span the editor's FULL lane
    // height, so on tall multi-lane rows closestCenter (dragged-center →
    // cell-center) mis-targets the adjacent editor near a row's top/bottom
    // (bug #2). pointerWithin returns the cell geometrically under the
    // cursor — drop registers anywhere over the lane. Fall back to
    // closestCenter when the pointer is briefly outside all cells (fast drags).
    const within = pointerWithin(scoped);
    return within.length ? within : closestCenter(scoped);
  }, []);

  const [dragPreview, setDragPreview] = useState(null);

  // Inline brain-flag banner shown after a drag commits. Populated by
  // a fire-and-forget POST to /api/scheduling-brain-check at the end
  // of each drag write. Auto-dismisses after 30s via the banner
  // component's own timer; producer can dismiss earlier with the X.
  const [brainFlags, setBrainFlags] = useState(null);

  // Helper: kick off the brain check after a drag write commits.
  // Fire-and-forget — failures (auth blip, /api/* down) are silent
  // so they never block the producer's drag UX.
  const triggerBrainCheck = useCallback(({ projectId, subtaskId, patch, affectedDate }) => {
    authFetch("/api/scheduling-brain-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger: "drag",
        projectId, subtaskId, affectedDate,
        proposedPatch: patch,
      }),
    })
      .then(r => r.json().catch(() => ({})))
      .then(({ flags }) => {
        if (Array.isArray(flags) && flags.length) setBrainFlags(flags);
      })
      .catch(err => console.warn("scheduling-brain-check:", err?.message || err));
  }, []);

  // ── Phase 2 (#3): Selects-timeline sync on shoot drag ──────────────
  // When a shoot bar is dragged/resized to a new day, keep the project's
  // Selects subtask in sync (shoot+1, lead-assigned, top priority) — the
  // same rule the Projects-detail date edit already applies, via the same
  // pure helper. If the lead is unavailable that day, open the picker.
  const [selectsPicker, setSelectsPicker] = useState(null);

  const resolveLeadIdTB = (project) => {
    const acct = resolveAccountForProject(project, accounts);
    const leadName = (acct?.projectLead || "").trim().toLowerCase();
    if (!leadName) return null;
    const ed = (editors || []).find(e => (e?.name || "").trim().toLowerCase() === leadName);
    return ed?.id || null;
  };

  // Apply the helper's leaf writes: optimistic setProjects (echo guard)
  // then per-leaf fbSet. Same shape as the Projects-detail applier.
  const applySelectsWritesTB = (projectId, writes) => {
    if (!writes?.length) return;
    if (typeof setProjects === "function") {
      setProjects(prev => prev.map(p => {
        if (!p || p.id !== projectId) return p;
        const subs = { ...(p.subtasks || {}) };
        for (const w of writes) {
          const m = w.path.match(/\/subtasks\/([^/]+)\/(.+)$/);
          if (!m) continue;
          const sid = m[1];
          const field = m[2];
          const cur = { ...(subs[sid] || {}) };
          if (field.startsWith("dayPriority/")) {
            const key = field.slice("dayPriority/".length);
            cur.dayPriority = { ...(cur.dayPriority || {}), [key]: w.value };
          } else {
            cur[field] = w.value;
          }
          subs[sid] = cur;
        }
        return { ...p, subtasks: subs };
      }));
    }
    for (const w of writes) fbSet(w.path, w.value);
  };

  // Run the sync against a project whose shoot date just changed. Wrapped
  // so a failure here can NEVER break the drag that triggered it.
  const runSelectsSyncTB = (updatedProject, overrideAssigneeId) => {
    try {
      const leadId = resolveLeadIdTB(updatedProject);
      const res = computeSelectsTimelineWrites(updatedProject, {
        allProjects: projects, editors, weekData, leadId,
        overrideAssigneeId: overrideAssigneeId || null,
      });
      if (res.writes) { applySelectsWritesTB(updatedProject.id, res.writes); setSelectsPicker(null); }
      else if (res.needsPicker) {
        setSelectsPicker({ updatedProject, selectsDate: res.selectsDate, candidates: res.candidates || [] });
      }
    } catch (e) {
      console.warn("Selects sync (Team Board) failed:", e?.message || e);
    }
  };

  // Build the post-write project snapshot for a shoot subtask whose date
  // changed, then run the sync. No-op for non-shoot subtasks.
  const maybeSyncSelectsAfterShootMove = (subtask, newStart, newEnd) => {
    const isShoot = subtask.stage === "shoot" || (subtask.name || "").toLowerCase().includes("shoot");
    if (!isShoot) return;
    const proj = projects.find(p => p.id === subtask.projectId);
    if (!proj) return;
    const updatedProject = {
      ...proj,
      subtasks: {
        ...(proj.subtasks || {}),
        [subtask.id]: { ...(proj.subtasks?.[subtask.id] || subtask), startDate: newStart, endDate: newEnd ?? newStart },
      },
    };
    runSelectsSyncTB(updatedProject);
  };

  const onDragStart = (e) => {
    // Only show the floating preview for "move" drags. Resize gestures
    // are an edge-pull on a bar that stays put — a floating preview
    // following the cursor would suggest the whole bar is moving, which
    // it isn't. Editor reorder drags also skip the preview (the row
    // visually translates via its own transform).
    const mode = e.active?.data?.current?.mode;
    if (mode === "move") {
      setDragPreview(e.active?.data?.current?.subtask || null);
    } else {
      setDragPreview(null);
    }
  };

  const onDragEnd = (e) => {
    setDragPreview(null);
    const { active, over } = e;
    if (!over || !active?.data?.current) return;

    const activeData = active.data.current;
    const overData = over.data?.current;

    // Editor-row reorder. Insert dragged editor at the target's
    // position. Persist via setEditors — the App.jsx debounced bulk
    // write will save the new array order to /editors. Last-write-
    // wins is fine; simultaneous edits across tabs would be rare.
    if (activeData.mode === "reorderEditor") {
      if (!setEditors) return;
      if (overData?.mode !== "reorderEditor") return;
      const fromIdx = activeData.fromIdx;
      const toIdx = overData.targetIdx;
      if (fromIdx === toIdx || fromIdx == null || toIdx == null) return;
      setEditors(prev => {
        const next = [...prev];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return next;
      });
      return;
    }

    // Per-day priority reorder. Drag one bar's badge onto another bar in
    // the SAME editor row + SAME start day to reslot. We rebuild that
    // day's ordered list, move the dragged bar to the target's slot, and
    // rewrite a dense 1..N priority. Optimistic patch first (the
    // recentlyWroteTo guard would otherwise revert it), then per-leaf
    // writes to /dayPriority/<editorId|day>.
    if (activeData.mode === "reorderDay") {
      if (overData?.mode !== "reorderDayTarget") return;
      const editorId = activeData.sourceAssigneeId;
      const dragged = activeData.subtask;
      const target = overData.subtask;
      if (!editorId || !dragged || !target || dragged.id === target.id) return;
      if (overData.editorId !== editorId) return;          // different row
      const day = dragged.startDate;
      if (!day || target.startDate !== day) return;        // different day

      const sortDay = (a, b) => {
        const pa = dayPriorityOf(a, editorId);
        const pb = dayPriorityOf(b, editorId);
        if (pa !== pb) return pa - pb;
        const ea = (a.endDate || a.startDate || "");
        const eb = (b.endDate || b.startDate || "");
        if (ea !== eb) return ea.localeCompare(eb);
        return (a.id || "").localeCompare(b.id || "");
      };
      const dayBars = (scheduled.get(editorId) || [])
        .filter(b => b.startDate === day)
        .sort(sortDay);
      const fromIdx = dayBars.findIndex(b => b.id === dragged.id);
      const toIdx = dayBars.findIndex(b => b.id === target.id);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const reordered = [...dayBars];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);

      const key = pkey(editorId, day);
      const tsR = new Date().toISOString();
      // [subtaskId, projectId, newPriority] for bars whose value changed.
      const changed = [];
      reordered.forEach((b, i) => {
        const newP = i + 1;
        if (dayPriorityOf(b, editorId) !== newP) changed.push([b.id, b.projectId, newP]);
      });
      if (changed.length === 0) return;
      if (typeof setProjects === "function") {
        setProjects(prev => prev.map(p => {
          if (!p) return p;
          const mine = changed.filter(c => c[1] === p.id);
          if (mine.length === 0) return p;
          const subs = { ...(p.subtasks || {}) };
          for (const [sid, , newP] of mine) {
            const cur = subs[sid];
            if (!cur) continue;
            subs[sid] = { ...cur, dayPriority: { ...(cur.dayPriority || {}), [key]: newP }, updatedAt: tsR };
          }
          return { ...p, subtasks: subs, updatedAt: tsR };
        }));
      }
      for (const [sid, pid, newP] of changed) {
        fbSet(`/projects/${pid}/subtasks/${sid}/dayPriority/${key}`, newP);
      }
      return;
    }

    const { mode, subtask, sourceAssigneeId } = activeData;
    const path = `/projects/${subtask.projectId}/subtasks/${subtask.id}`;
    const now = new Date().toISOString();

    // Optimistic local-state patch for a single subtask leaf. Mirrors
    // the pattern used in Projects.jsx for inline edits / status pill
    // changes (PRs #49 / #59 / #60): without this, every fbSet below
    // hits Firebase fine but the App.jsx listener wrapper suppresses
    // the listener echo for ~1.5s via recentlyWroteTo("/projects"),
    // so the local `projects` array never advances and the dragged
    // GanttBar visibly "snaps back" until reload — which is exactly
    // the symptom Jeremy reported as "drag and drop has stopped
    // working" on the Team Board.
    const patchSubtaskLocal = (patch) => {
      if (typeof setProjects !== "function") return;
      setProjects(prev => prev.map(p => {
        if (!p || p.id !== subtask.projectId) return p;
        const subs = { ...(p.subtasks || {}) };
        const cur = subs[subtask.id] || {};
        subs[subtask.id] = { ...cur, ...patch, updatedAt: now };
        return { ...p, subtasks: subs, updatedAt: now };
      }));
    };

    if (mode === "resizeEnd" || mode === "resizeStart") {
      // Pool drop on a resize handle is a no-op.
      if (over.id === POOL_ID) return;
      const { date } = parseCellId(over.id);
      if (!date) return;
      // Audit log — if a producer reports "an unrelated subtask got
      // its endDate changed", open the browser console and screenshot
      // these lines. They show exactly which subtaskId got which mode
      // applied, so we can tell whether it was a misfire (mode=resize
      // when intending move) vs a real bug elsewhere.
      console.info("[TeamBoard drag]", {
        mode, projectId: subtask.projectId, subtaskId: subtask.id,
        oldStart: subtask.startDate, oldEnd: subtask.endDate, droppedDate: date,
      });

      // If the bar somehow has no startDate (orphan / corrupted data),
      // treat the dropped date as both ends — collapses to a 1-day bar.
      const oldStart = subtask.startDate || date;
      const oldEnd = subtask.endDate || oldStart;
      let newStart = oldStart;
      let newEnd = oldEnd;

      if (mode === "resizeEnd") {
        // Pull the right edge to the dropped date. If it lands before
        // the current startDate, the gesture flips the bar — the
        // dropped date becomes the new startDate and the previous
        // startDate becomes the new endDate.
        if (date < oldStart) {
          newStart = date;
          newEnd = oldStart;
        } else {
          newEnd = date;
        }
      } else {
        // resizeStart: mirror. Pull the left edge to the dropped date.
        if (date > oldEnd) {
          newStart = oldEnd;
          newEnd = date;
        } else {
          newStart = date;
        }
      }

      patchSubtaskLocal({ startDate: newStart, endDate: newEnd });
      // Atomic multi-leaf write — single fbUpdate so a blip can't
      // leave the bar with a new start but old end.
      fbUpdate(path, { startDate: newStart, endDate: newEnd, updatedAt: now });
      triggerBrainCheck({
        projectId: subtask.projectId,
        subtaskId: subtask.id,
        patch: { startDate: newStart, endDate: newEnd },
        affectedDate: mode === "resizeEnd" ? newEnd : newStart,
      });
      // Keep the Selects timeline in sync if this was a shoot resize.
      maybeSyncSelectsAfterShootMove(subtask, newStart, newEnd);
      // Calendar sync — fires alongside Selects, writes nothing here.
      enqueueCalendarSync({
        projectId: subtask.projectId,
        prevSubtask: subtask,
        nextSubtask: { ...subtask, startDate: newStart, endDate: newEnd },
      });
      return;
    }

    // mode === "move"
    if (over.id === POOL_ID) {
      // 7-day cancellation prompt — a synced shoot scheduled within
      // CANCELLATION_PROMPT_DAYS needs a confirm before we tear down
      // the calendar event + email the client a cancellation. Far-
      // future drops skip the prompt (common reshuffle, less risk).
      if (subtask.stage === "shoot" && subtask.calendarEventId && subtask.startDate) {
        const startMs = Date.parse(`${subtask.startDate}T00:00:00`);
        const daysOut = Number.isFinite(startMs)
          ? Math.ceil((startMs - Date.now()) / (24 * 60 * 60 * 1000))
          : Infinity;
        if (daysOut <= CANCELLATION_PROMPT_DAYS) {
          setCancelConfirmModal({ subtask, path, daysOut: Math.max(0, daysOut) });
          return;
        }
      }
      // Drop into the pool drawer = unschedule. Keeps the assigneeIds
      // intact so the producer can drop the card back into a date cell
      // later without re-picking everyone — pool cards still show all
      // assignees in their footer.
      // Skip brain check on pool drops — clearing dates only REMOVES
      // potential conflicts, never creates one. No flag worth posting.
      console.info("[TeamBoard drag]", {
        mode: "move-to-pool", projectId: subtask.projectId, subtaskId: subtask.id,
        oldStart: subtask.startDate, oldEnd: subtask.endDate,
      });
      patchSubtaskLocal({ startDate: null, endDate: null });
      fbUpdate(path, { startDate: null, endDate: null, updatedAt: now });
      enqueueCalendarSync({
        projectId: subtask.projectId,
        prevSubtask: subtask,
        nextSubtask: { ...subtask, startDate: null, endDate: null },
      });
      return;
    }

    // Drop into a date cell. Both newAssignee + newDate must be set.
    const { assigneeId: newAssignee, date: newDate } = parseCellId(over.id);
    if (!newAssignee || !newDate) return;
    const oldStart = subtask.startDate;
    const oldEnd = subtask.endDate;
    console.info("[TeamBoard drag]", {
      mode: "move", projectId: subtask.projectId, subtaskId: subtask.id,
      sourceAssigneeId, newAssignee,
      oldStart, oldEnd, newStart: newDate, newEnd: newDate,
    });

    // Date logic: SLIDE, don't STRETCH. Drop on a single day = collapse
    // to a 1-day bar at that day. Producer uses the resize handles to
    // make a bar multi-day deliberately — same principle as the
    // auto-roll cron fix in PR #74. Earlier behaviour preserved
    // duration (delta from oldStart applied to oldEnd), which silently
    // pushed multi-day bars further into the future on every drag.
    // Symptom Jeremy hit: dragging a bar that had been silently
    // stretched by the auto-roll cron made an "unrelated" task appear
    // to expand by ~14 days when it actually was the same bar
    // preserving its old span. The audit log line above shows
    // newStart === newEnd, matching what gets written.
    const newEnd = newDate;

    // Assignee logic for multi-assignee subtasks (hoisted ahead of the
    // write so the shoot-times modal can carry the full payload):
    //   - If the producer dragged from an editor row's bar, sourceAssigneeId
    //     identifies which assignee the bar represented.
    //   - Drop on the SAME editor row → only the date changed; assignees stay.
    //   - Drop on a DIFFERENT editor row → swap source for target. If target
    //     is already assigned, just drop source (avoids duplicates). If
    //     somehow there's no source (legacy single-assignee bar dragged from
    //     pool, no row context), just ensure the target is in the list.
    const currentIds = getAssigneeIds(subtask);
    const droppedFromRow = !!sourceAssigneeId && sourceAssigneeId !== newAssignee;
    let nextIds;
    if (droppedFromRow) {
      const stripped = currentIds.filter(id => id !== sourceAssigneeId);
      nextIds = stripped.includes(newAssignee) ? stripped : [...stripped, newAssignee];
    } else if (!sourceAssigneeId) {
      // From the pool — transfer to target, don't append (see history
      // in git blame: append-not-replace silently doubled up owners).
      nextIds = currentIds.includes(newAssignee) ? currentIds : [newAssignee];
    } else {
      // sourceAssigneeId === newAssignee → just a date change.
      nextIds = currentIds;
    }
    const assigneeChanged = JSON.stringify(nextIds) !== JSON.stringify(currentIds);

    // Shoot-times intercept — dropping a shoot onto a date cell without
    // valid start+end times defers the write to a modal that captures
    // the times (+ optional location) and writes everything atomically.
    // Calendar sync can't proceed without explicit times.
    if (subtask.stage === "shoot") {
      const haveTimes = !!subtask.startTime && !!subtask.endTime;
      const timesOk = haveTimes && `${newEnd}T${subtask.endTime}` > `${newDate}T${subtask.startTime}`;
      if (!timesOk) {
        setShootDropModal({
          subtask, path, newDate, newEnd, newAssignee, sourceAssigneeId,
          nextIds, assigneeChanged,
          defaults: { startTime: subtask.startTime || "", endTime: subtask.endTime || "", location: subtask.location || "" },
        });
        return;
      }
    }

    patchSubtaskLocal({ startDate: newDate, endDate: newEnd });
    // Atomic multi-leaf write — single fbUpdate replaces the previous
    // per-leaf fbSet sequence so a blip can't half-update the row.
    const updates = { startDate: newDate, endDate: newEnd, updatedAt: now };
    if (assigneeChanged) {
      const cleaned = (nextIds || []).filter(Boolean);
      patchSubtaskLocal({ assigneeIds: cleaned, assigneeId: cleaned[0] || null });
      updates.assigneeIds = cleaned;
      updates.assigneeId = cleaned[0] || null;
    }
    fbUpdate(path, updates);

    triggerBrainCheck({
      projectId: subtask.projectId,
      subtaskId: subtask.id,
      patch: { startDate: newDate, endDate: newEnd, assigneeIds: nextIds, assigneeId: nextIds[0] || null },
      affectedDate: newDate,
    });
    // Keep the Selects timeline in sync if this move was a shoot reschedule.
    maybeSyncSelectsAfterShootMove(subtask, newDate, newEnd);
    // Calendar sync — fires alongside Selects.
    enqueueCalendarSync({
      projectId: subtask.projectId,
      prevSubtask: subtask,
      nextSubtask: {
        ...subtask, startDate: newDate, endDate: newEnd,
        ...(assigneeChanged ? { assigneeIds: nextIds, assigneeId: nextIds[0] || null } : {}),
      },
    });
  };

  // ─── Layout maths ────────────────────────────────────────────────
  // Grid columns: 1 = assignee label, 2..(N+1) = dates. The dedicated
  // Unscheduled column is gone — its job moved to the bottom pool
  // drawer that sits below the grid.
  // 140px minimum per date column so the dual-line bars (client +
  // project name on top, subtask below) breathe before clipping.
  const gridTemplateColumns = `200px repeat(${dates.length}, minmax(140px, 1fr))`;
  const dateToCol = useMemo(() => {
    const m = new Map();
    dates.forEach((d, i) => m.set(d, i + 2));
    return m;
  }, [dates]);

  // For a subtask with startDate / endDate, find the inclusive grid-
  // column range that falls inside the visible window. Returns null if
  // the entire span is outside the window (= bar shouldn't render).
  // Bars that partially overlap render clipped to the window edge.
  const lastDate = dates[dates.length - 1];
  const colsForSpan = (st) => {
    if (!st.startDate) return null;
    // Guard against an empty visible range (lastDate undefined). Shouldn't
    // happen in normal use given useState(28) and a valid fromDate, but
    // `dateToCol.get(undefined)` would silently return undefined and the
    // bar wrapper would receive a malformed grid-column value.
    if (!lastDate) return null;
    const end = st.endDate || st.startDate;
    if (end < fromDate || st.startDate > lastDate) return null;
    const startClamped = st.startDate < fromDate ? fromDate : st.startDate;
    const endClamped = end > lastDate ? lastDate : end;
    const startCol = dateToCol.get(startClamped);
    const endCol = dateToCol.get(endClamped);
    if (startCol == null || endCol == null) return null;
    return [startCol, endCol];
  };

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div style={{ padding: "16px 28px 60px" }}>
      {/* Inline brain-flag banner — appears after a drag commits a
          write that creates a scheduling conflict (double-book, off-day
          assignment, over-capacity, etc.). Auto-dismisses after 30s.
          A delayed Slack post (3 min) follows if the conflict is still
          active by then — gives the producer time to drag again to fix
          before the channel pings. See api/scheduling-brain-check.js +
          api/scheduling-flag-flusher.js. */}
      {brainFlags && (
        <TeamBoardFlagBanner
          flags={brainFlags}
          onDismiss={() => setBrainFlags(null)}
        />
      )}
      {selectsPicker && (
        <SelectsPickerModal
          selectsDate={selectsPicker.selectsDate}
          candidates={selectsPicker.candidates}
          editors={editors}
          onPick={(editorId) => runSelectsSyncTB(selectsPicker.updatedProject, editorId)}
          onClose={() => setSelectsPicker(null)}
        />
      )}
      {/* Stage colour key (left) + collapse-all toggle (right). The
          wrapper owns the row padding; StageLegend's own padding was
          zeroed so both sit on one baseline. */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 16, padding: "0 4px 12px", flexWrap: "wrap",
      }}>
        <StageLegend />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {allClients.length > 0 && (
            <ClientFilterDropdown
              allClients={allClients}
              hiddenClients={hiddenClients}
              setHiddenClients={setHiddenClients}
            />
          )}
          {editors.length > 0 && (
            <button
              type="button"
              onClick={allCollapsed ? expandAll : collapseAll}
              title={allCollapsed ? "Expand every row" : "Collapse every row"}
              style={{
                background: "none", border: "none", padding: "2px 4px",
                margin: 0, cursor: "pointer",
                color: "var(--fg)", opacity: 0.55,
                fontSize: 11, fontWeight: 700, lineHeight: 1,
                fontFamily: "inherit", whiteSpace: "nowrap",
                textTransform: "uppercase", letterSpacing: 0.4,
                transition: "opacity 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = 1; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = 0.55; }}
            >{allCollapsed ? "▾ Expand all" : "▸ Collapse all"}</button>
          )}
        </div>
      </div>
      {/* No toolbar — the calendar is purely scroll-driven. The grid
          starts on the Monday of the current week and extends right as
          the producer scrolls. */}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionStrategy}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}>
        {/* Outer container = vertical flex column, resizable via the
            CSS handle in the bottom-right corner. The schedule grid
            takes the remaining height (flex 1, scrolls internally),
            and the pool drawer is pinned at the bottom (fixed height,
            scrolls horizontally on its own). The drawer staying inside
            the same DndContext means cards can be dragged between the
            two regions in either direction. */}
        <div
          style={{
            display: "flex", flexDirection: "column",
            background: "#1A2236",
            border: "1px solid var(--border)", borderRadius: 12,
            overflow: "hidden", position: "relative",
            height: "calc(100vh - 200px)",
            resize: "both",
            minHeight: 360, minWidth: 600, maxWidth: "100%",
          }}>
          {/* ── Top: the schedule grid ── */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="chunky-scroll"
            style={{
              flex: 1, minHeight: 0,
              overflow: "auto",
              position: "relative",
            }}>
            <div style={{
              display: "grid",
              gridTemplateColumns,
              // Header row, then one auto-sized track per LANE (not per
              // editor — each editor expands to as many lane sub-rows
              // as its busiest day demands), then a 1fr filler so the
              // column-stripe layer (grid-row 1/-1) carries weekend
              // tints all the way to the bottom of the scroll viewport.
              gridTemplateRows: `auto ${editorLayout.trackSizes.join(" ")} 1fr`,
              minWidth: "fit-content",
              minHeight: "100%",
            }}>
              {/* Column-stripe layer — one stripe per date, spanning
                  every row of the grid (header + all editor rows).
                  Sits at z 0 with pointer-events disabled so it paints
                  a continuous vertical band beneath cells and bars
                  without intercepting drags. */}
              {dates.map((d, i) => {
                const dayNum = new Date(d + "T00:00:00").getDay();
                const isWeekend = dayNum === 0 || dayNum === 6;
                const isToday = d === isoToday();
                const isMonday = dayNum === 1;
                if (!isWeekend && !isToday && !isMonday) return null;
                return (
                  <div
                    key={`stripe-${d}`}
                    style={{
                      gridColumn: i + 2,
                      gridRow: "1 / -1",
                      // Today bumped 0.10 → 0.18 so the active column
                      // reads as the brightest in view from across the
                      // board. Weekend bumped 0.32 → 0.42 so Sat + Sun
                      // are clear column boundaries, not faint texture.
                      background: isToday ? "rgba(99,102,241,0.18)"
                                : isWeekend ? "rgba(0,0,0,0.42)"
                                : "transparent",
                      borderLeft: isMonday ? "2px solid var(--border)" : undefined,
                      pointerEvents: "none",
                      zIndex: 0,
                    }}
                  />
                );
              })}

              {/* Header row — col labels. Every header cell gets an
                  explicit gridRow:1 + gridColumn so auto-placement
                  doesn't get blocked by the stripe layer above. */}
              <div style={{
                ...headerCell, gridRow: 1, gridColumn: 1,
                position: "sticky", top: 0, left: 0, zIndex: 5, background: "var(--bg)",
              }}>
                Team
              </div>
              {dates.map((d, i) => {
                const dt = new Date(d + "T00:00:00");
                const dayNum = dt.getDay();
                const isToday = d === isoToday();
                const isWeekend = dayNum === 0 || dayNum === 6;
                return (
                  <div key={d} style={{
                    ...headerCell,
                    gridRow: 1, gridColumn: i + 2,
                    position: "sticky", top: 0, zIndex: 4,
                    background: isToday ? "rgba(99,102,241,0.28)"
                              : isWeekend ? "rgba(0,0,0,0.45)"
                              : "var(--bg)",
                    color: isToday ? "var(--accent)" : isWeekend ? "var(--muted)" : "var(--fg)",
                    // Today's header gets a solid accent underline so
                    // the column "head" pops without further tinting.
                    // Override headerCell's existing 1px muted bottom
                    // border for this one column only.
                    borderBottom: isToday ? "2px solid var(--accent)" : undefined,
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6 }}>
                      {dt.toLocaleDateString("en-AU", { weekday: "short" })}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{fmtDateLabel(d)}</div>
                  </div>
                );
              })}

              {/* Rows — each editor occupies a contiguous block of
                  laneCount sub-rows. The block info (startRow,
                  laneCount, laneBars) is computed once in editorLayout
                  above so the grid template can size correctly. */}
              {editorLayout.items.map((item, rowIdx) => (
                <Row
                  key={item.row.id}
                  row={item.row}
                  editor={item.editor}
                  weekData={weekData}
                  rowIdx={rowIdx}
                  startRow={item.startRow}
                  laneCount={item.laneCount}
                  laneBars={item.laneBars}
                  dates={dates}
                  colsForSpan={colsForSpan}
                  onOpenProject={onOpenProject}
                  collapsed={item.collapsed}
                  hiddenCount={item.hiddenCount}
                  onToggleCollapse={toggleCollapsed}
                />
              ))}
            </div>

            {rows.length === 0 && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                No editors in the roster yet. Add team members in the Editors tab.
              </div>
            )}
          </div>

          {/* ── Bottom: pool drawer ── */}
          <PoolDrawer
            poolId={POOL_ID}
            pool={pool}
            editors={editors}
            onOpenProject={onOpenProject}
          />
        </div>

        {/* Drag preview floating with the cursor — clear "you're
            dragging this" cue when the bar leaves its row or the pool
            card leaves the drawer. */}
        <DragOverlay dropAnimation={null}>
          {dragPreview && (
            <div style={{
              padding: "6px 10px", borderRadius: 6,
              background: `${colourFor(dragPreview)}`,
              color: "#fff", fontSize: 11, fontWeight: 700,
              boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
              maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {dragPreview.clientName}: {dragPreview.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {shootDropModal && (
        <ShootDropTimeModal
          state={shootDropModal}
          setProjects={setProjects}
          onScheduled={maybeSyncSelectsAfterShootMove}
          onClose={() => setShootDropModal(null)}
        />
      )}
      {cancelConfirmModal && (
        <ShootCancellationConfirmModal
          state={cancelConfirmModal}
          setProjects={setProjects}
          onClose={() => setCancelConfirmModal(null)}
        />
      )}
    </div>
  );
}

// ─── Drop-time modal ───────────────────────────────────────────────
// Opens when a shoot is dropped on a date cell without valid times.
// Captures start/end/optional location, writes all fields (dates +
// times + location + assignees) in ONE atomic fbUpdate, then enqueues
// the calendar sync. Single-write so a blip can't leave new dates with
// old times — the worker would otherwise read inconsistent data.
function ShootDropTimeModal({ state, setProjects, onScheduled, onClose }) {
  const [startTime, setStartTime] = useState(state.defaults.startTime || "");
  const [endTime, setEndTime] = useState(state.defaults.endTime || "");
  const [location, setLocation] = useState(state.defaults.location || "");
  const [error, setError] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (!startTime || !endTime) { setError("Both start and end times are required."); return; }
    if (`${state.newEnd}T${endTime}` <= `${state.newDate}T${startTime}`) { setError("End must be after start."); return; }
    const now = new Date().toISOString();
    const cleaned = (state.nextIds || []).filter(Boolean);
    const updates = {
      startDate: state.newDate, endDate: state.newEnd,
      startTime, endTime, location: location.trim() || null, updatedAt: now,
    };
    if (state.assigneeChanged) { updates.assigneeIds = cleaned; updates.assigneeId = cleaned[0] || null; }
    if (typeof setProjects === "function") {
      setProjects(prev => prev.map(p => {
        if (!p || p.id !== state.subtask.projectId) return p;
        const subs = { ...(p.subtasks || {}) };
        subs[state.subtask.id] = { ...(subs[state.subtask.id] || {}), ...updates };
        return { ...p, subtasks: subs, updatedAt: now };
      }));
    }
    fbUpdate(state.path, updates);
    enqueueCalendarSync({
      projectId: state.subtask.projectId,
      prevSubtask: state.subtask,
      nextSubtask: { ...state.subtask, ...updates },
    });
    // Keep the Selects timeline auto-schedule in sync — scheduling a
    // shoot via this modal sets the shoot date, same as a direct drop.
    onScheduled?.({ ...state.subtask, ...updates }, state.newDate, state.newEnd);
    onClose();
  };

  return (
    <div onClick={onClose} style={calModalBackdrop}>
      <div onClick={e => e.stopPropagation()} style={{ ...calModalCard, width: "min(440px, 100%)" }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Shoot times required</h3>
        <p style={{ margin: "0 0 16px", fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
          Set the start and end times before scheduling this shoot. The Viewix
          calendar event won't sync until both are filled in and end is after start.
        </p>
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <label style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>Start
            <input type="time" value={startTime} onChange={e => { setStartTime(e.target.value); setError(null); }} style={calModalInput} />
          </label>
          <label style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>End
            <input type="time" value={endTime} onChange={e => { setEndTime(e.target.value); setError(null); }} style={calModalInput} />
          </label>
        </div>
        <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>Location (optional)
          <input type="text" value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Bondi Beach" style={calModalInput} />
        </label>
        {error && <div style={{ fontSize: 11, color: "#EF4444", marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={calBtnSubtle}>Cancel</button>
          <button onClick={submit} style={calBtnPrimary}>Schedule shoot</button>
        </div>
      </div>
    </div>
  );
}

// ─── 7-day cancellation confirm ────────────────────────────────────
function ShootCancellationConfirmModal({ state, setProjects, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirm = () => {
    const now = new Date().toISOString();
    if (typeof setProjects === "function") {
      setProjects(prev => prev.map(p => {
        if (!p || p.id !== state.subtask.projectId) return p;
        const subs = { ...(p.subtasks || {}) };
        subs[state.subtask.id] = { ...(subs[state.subtask.id] || {}), startDate: null, endDate: null, updatedAt: now };
        return { ...p, subtasks: subs, updatedAt: now };
      }));
    }
    fbUpdate(state.path, { startDate: null, endDate: null, updatedAt: now });
    enqueueCalendarSync({
      projectId: state.subtask.projectId,
      prevSubtask: state.subtask,
      nextSubtask: { ...state.subtask, startDate: null, endDate: null },
    });
    onClose();
  };

  const dateLabel = state.subtask.startDate || "(unknown)";
  const daysLabel = state.daysOut === 0 ? "today" : state.daysOut === 1 ? "1 day away" : `${state.daysOut} days away`;

  return (
    <div onClick={onClose} style={calModalBackdrop}>
      <div onClick={e => e.stopPropagation()} style={{ ...calModalCard, width: "min(460px, 100%)" }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Cancel calendar event?</h3>
        <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: "var(--muted)" }}>
          This shoot is on <b style={{ color: "var(--fg)" }}>{dateLabel}</b> ({daysLabel}).
          Unscheduling will delete the Viewix calendar event and email the
          cancellation to the client and crew.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={calBtnSubtle}>Cancel</button>
          <button onClick={confirm} style={calBtnDanger}>Confirm cancellation</button>
        </div>
      </div>
    </div>
  );
}

const calModalBackdrop = {
  position: "fixed", inset: 0, zIndex: 200,
  background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
};
const calModalCard = {
  background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
  padding: 20, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", color: "var(--fg)", fontFamily: "inherit",
};
const calModalInput = {
  display: "block", width: "100%", marginTop: 4, padding: "6px 8px", fontSize: 13,
  fontFamily: "inherit", background: "var(--bg)", color: "var(--fg)",
  border: "1px solid var(--border)", borderRadius: 6,
};
const calBtnBase = { fontFamily: "inherit", cursor: "pointer", padding: "8px 14px", fontSize: 13, fontWeight: 600, borderRadius: 8 };
const calBtnSubtle = { ...calBtnBase, background: "transparent", color: "var(--fg)", border: "1px solid var(--border)" };
const calBtnPrimary = { ...calBtnBase, background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)" };
const calBtnDanger = { ...calBtnBase, background: "#EF4444", color: "#fff", border: "1px solid #EF4444" };

// Sticky-left editor label. Draggable (drag the ⋮⋮ grip — or just the
// row — to reorder editors) and droppable (drop another editor's
// drag here to insert at this position). Pulled out from Row() so the
// useDraggable / useDroppable hook calls don't fire for the date cells
// it doesn't apply to.
//
// Spans every lane sub-row of its editor block via gridRow:
// "${startRow} / ${startRow + laneCount}". The auto-sized lanes inside
// the block drive the editor's total height; the label stretches to
// match.
function EditorLabel({ row, rowIdx, startRow, laneCount, striped, collapsed, hiddenCount, onToggleCollapse }) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: `editor-drag:${row.id}`,
    data: { mode: "reorderEditor", editorId: row.id, fromIdx: rowIdx },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `editor-drop:${row.id}`,
    data: { mode: "reorderEditor", targetIdx: rowIdx },
  });
  // Only highlight as a drop target when a reorder drag is in flight.
  // Bar drags hovering the editor label would otherwise tint it
  // suggesting a drop will work — silently ignored at dragEnd.
  const { active } = useDndContext();
  const isCompatible = active?.data?.current?.mode === "reorderEditor";
  const showDrop = isOver && isCompatible;
  // Combine draggable + droppable refs onto the same DOM node.
  const setRef = (node) => { setDragRef(node); setDropRef(node); };
  return (
    <div
      ref={setRef}
      {...attributes}
      style={{
        ...rowLabel,
        // Collapsed: shrink the label to fit the 32px track. rowLabel is
        // sized for the 60px expanded row (big padding + 24px font) which
        // would overflow a folded line.
        ...(collapsed ? { padding: "0 14px", minHeight: 0, fontSize: 13 } : null),
        gridColumn: 1,
        gridRow: `${startRow} / ${startRow + laneCount}`,
        position: "sticky", left: 0, zIndex: 3,
        background: showDrop ? "rgba(99,102,241,0.22)"
                  : striped ? "#1E2638" : "#1A2236",
        borderRight: "2px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        // Drop hint: a 2px line at the top edge when something is
        // being dragged over this row.
        borderTop: showDrop ? "2px solid var(--accent)" : undefined,
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        userSelect: "none",
        gap: 8,
      }}>
      {/* Drag handle. Only this is the "grip" listener target — the
          rest of the row is unaffected so producers can still click
          the editor name without picking up the row by accident. */}
      <span
        {...listeners}
        title="Drag to reorder"
        style={{
          cursor: isDragging ? "grabbing" : "grab",
          // Resting opacity bumped from var(--muted) to fg-at-55%
          // so the grip reads as legible at rest. Hover takes it to
          // full white via onMouseEnter below.
          color: "var(--fg)", opacity: 0.55,
          fontSize: 14, lineHeight: 1,
          padding: "4px 2px", marginLeft: -4,
          fontFamily: "inherit", userSelect: "none",
          transition: "opacity 0.12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={e => { if (!isDragging) e.currentTarget.style.opacity = 0.55; }}
      >⋮⋮</span>
      {/* Collapse toggle. Not inside the grip's listener span, and it
          stops pointer/click propagation so it can never start the
          editor-reorder draggable. */}
      <button
        type="button"
        title={collapsed ? "Expand row" : "Collapse row"}
        aria-label={collapsed ? "Expand row" : "Collapse row"}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggleCollapse?.(row.id); }}
        style={{
          background: "none", border: "none", padding: "2px 4px",
          margin: 0, cursor: "pointer",
          color: "var(--fg)", opacity: 0.55,
          fontSize: 11, lineHeight: 1, fontFamily: "inherit",
          transition: "opacity 0.12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = 0.55; }}
      >{collapsed ? "▸" : "▾"}</button>
      <span style={{ fontWeight: 700, color: "var(--fg)" }}>
        {row.name}
      </span>
      {collapsed && hiddenCount > 0 && (
        <span style={{
          color: "var(--muted)", fontWeight: 600, fontSize: 12,
          whiteSpace: "nowrap",
        }}>
          · {hiddenCount}
        </span>
      )}
    </div>
  );
}

// One assignee row, split into laneCount sub-rows. Each lane sub-row is
// its own auto-sizing CSS Grid track, so bars in different lanes can
// have different content-driven heights without overlapping. The
// editor label and the date drop cells span ALL lane sub-rows via
// gridRow ranges; bars sit in their specific lane's sub-row.
//
// Replaces the previous fixed-height + paddingTop arrangement which
// clipped wrapped text whenever a bar's content exceeded the bar's
// height.
function Row({ row, editor, weekData, rowIdx, startRow, laneCount, laneBars, dates, colsForSpan, onOpenProject, collapsed, hiddenCount, onToggleCollapse }) {
  const striped = rowIdx % 2 === 1;
  const endRow = startRow + laneCount;  // exclusive end for grid-row range

  // Collapsed: just the sticky label + a non-droppable filler strip so the
  // thin row keeps a visible bottom rule across the day columns (without
  // it the row vanishes except for the name cell). It mirrors an expanded
  // body DropCell's treatment — translucent bg at zIndex 1, above the
  // column-stripe layer — so weekend/today/Monday tints read THROUGH it
  // exactly as they do on full rows (an opaque fill here would paint over
  // the stripes and break their top-to-bottom continuity). pointerEvents
  // off so it's never a drop target and never intercepts a drag.
  if (collapsed) {
    return (
      <>
        <EditorLabel
          row={row}
          rowIdx={rowIdx}
          startRow={startRow}
          laneCount={laneCount}
          striped={striped}
          collapsed={collapsed}
          hiddenCount={hiddenCount}
          onToggleCollapse={onToggleCollapse}
        />
        <div
          style={{
            gridColumn: "2 / -1",
            gridRow: `${startRow} / ${endRow}`,
            background: striped ? "rgba(255,255,255,0.018)" : "transparent",
            borderBottom: "1px solid var(--border)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      </>
    );
  }

  return (
    <>
      <EditorLabel
        row={row}
        rowIdx={rowIdx}
        startRow={startRow}
        laneCount={laneCount}
        striped={striped}
        collapsed={collapsed}
        hiddenCount={hiddenCount}
        onToggleCollapse={onToggleCollapse}
      />

      {/* One drop cell per date (cols 2..N+1). Each cell spans all of
          this editor's lane sub-rows so a producer can drop anywhere
          in the editor + day cell, regardless of how many lanes are
          stacked. Column-scope tinting (weekend / today / Monday
          border) still lives on the stripe layer above. */}
      {dates.map((d, i) => (
        <DropCell
          key={d}
          id={cellId(row.id, d)}
          gridColumn={i + 2}
          gridRow={`${startRow} / ${endRow}`}
          striped={striped}
          dayStatus={getEditorDayStatus(weekData, editor, d)}
        />
      ))}

      {/* Gantt bars — placed last so they stack above the drop cells.
          Each occupies its own lane sub-row (gridRow = startRow + lane),
          and spans grid-column [startCol .. endCol+1] for its date
          range. The wrapper is a transparent positioning shim; the
          visual bar lives inside <GanttBar> and grows to fit content. */}
      {laneBars.map(st => {
        const cols = colsForSpan(st);
        if (!cols) return null;
        return (
          <div key={st.id} style={{
            gridColumn: `${cols[0]} / ${cols[1] + 1}`,
            gridRow: startRow + st.lane,
            padding: 4,
            // Above DropCell so the bar receives drags before the
            // cell underneath does.
            zIndex: 1,
            display: "flex",
            // flex-start (not stretch) so a short card sizes to its own
            // content instead of being stretched to the tallest bar in
            // the same lane track — that stretch was the "dead space at
            // the bottom of the card" the producer reported.
            alignItems: "flex-start",
          }}>
            <GanttBar
              subtask={st}
              sourceAssigneeId={row.id}
              reorderable={st.daySize >= 2}
              dayRank={st.dayRank}
              onClick={() => onOpenProject?.(st.projectId, st.id)}
            />
          </div>
        );
      })}
    </>
  );
}

// ─── Pool drawer ───────────────────────────────────────────────────
// Pinned to the bottom of the team board. Shows every subtask that's
// either unassigned or unscheduled (or both). Producers drag cards
// from here onto a date cell to schedule + assign in one move; or drag
// a scheduled bar from the grid down here to clear the dates and send
// the subtask back to the pile. The whole drawer is one big drop zone.
function PoolDrawer({ poolId, pool, editors, onOpenProject }) {
  const { setNodeRef, isOver } = useDroppable({ id: poolId });
  // Only show the drop highlight for "move" drags. Resize and reorder
  // drops on the pool are no-ops — tinting would mislead the producer
  // into thinking the drop will do something.
  const { active } = useDndContext();
  const showDrop = isOver && active?.data?.current?.mode === "move";
  return (
    <div
      ref={setNodeRef}
      className="chunky-scroll"
      style={{
        flexShrink: 0,
        height: 180,
        background: showDrop ? "rgba(99,102,241,0.16)" : "#0F1421",
        borderTop: "2px solid var(--border)",
        // Horizontal scroll only — vertical contained inside the cards.
        overflowX: "auto",
        overflowY: "hidden",
        transition: "background 0.15s",
        padding: "10px 14px 14px",
      }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 800, textTransform: "uppercase",
          letterSpacing: 0.6, color: "var(--muted)",
        }}>
          Subtasks: Unassigned + Unscheduled date/time + Status = Scheduled · {pool.length}
        </span>
        <span style={{ fontSize: 10, color: "var(--muted)", fontStyle: "italic" }}>
          Drag a card up to schedule it · drag a scheduled bar down to clear it
        </span>
      </div>
      {pool.length === 0 ? (
        <div style={{
          padding: "16px 8px", color: "var(--muted)", fontSize: 12,
          fontStyle: "italic",
        }}>
          Everything's scheduled and assigned. Nice.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {pool.map(st => (
            <PoolCard
              key={st.id}
              subtask={st}
              editors={editors}
              onClick={() => onOpenProject?.(st.projectId, st.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One card in the bottom pool drawer. Horizontal-scrollable strip of
// these. Carries the same drag payload as a Gantt bar so onDragEnd's
// "move" branch can route it onto either a date cell or back into the
// pool drop zone.
function PoolCard({ subtask, editors, onClick }) {
  // Pool cards have no source row — sourceAssigneeId is null, which
  // onDragEnd's "move" branch handles by ADDING the target editor to
  // the assigneeIds list rather than swapping anyone out.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `bar:${subtask.id}:pool`,
    data: { mode: "move", subtask, sourceAssigneeId: null },
  });
  const colour = colourFor(subtask);
  const editorById = useMemo(() =>
    new Map((editors || []).map(e => [e.id, e.name || ""])),
    [editors]
  );
  const ids = getAssigneeIds(subtask);
  const names = ids.map(id => editorById.get(id)).filter(Boolean);
  const assigneeLabel = names.length === 0
    ? "Unassigned"
    : names.length <= 2
    ? names.join(", ")
    : `${names[0]}, ${names[1]} +${names.length - 2}`;
  const isUnassigned = names.length === 0;
  const done = subtask.status === "done";
  return (
    <div
      ref={setNodeRef}
      onClick={() => { if (!isDragging) onClick?.(); }}
      title={`${subtask.clientName} · ${subtask.projectName}\n${subtask.name}\n${assigneeLabel} · Stage: ${stageOf(subtask)}`}
      {...listeners}
      {...attributes}
      style={{
        flexShrink: 0,
        width: 220,
        // Left padding widens when a done-tick is shown so the client
        // name doesn't sit under the badge.
        padding: done ? "8px 10px 8px 30px" : "8px 10px",
        borderRadius: 6,
        background: `${colour}38`,
        borderLeft: `3px solid ${colour}`,
        color: "var(--fg)",
        fontSize: 11,
        cursor: isDragging ? "grabbing" : "grab",
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        userSelect: "none",
        boxSizing: "border-box",
        position: "relative",
      }}>
      {/* A finished card sitting in the pool shows the same static green
          tick as a done bar on the grid, so producers don't waste time
          scheduling already-completed work back onto the board. */}
      {done && (
        <div style={{
          position: "absolute", top: 6, left: 6,
          width: 18, height: 18, borderRadius: "50%",
          background: "#10B981", color: "#fff",
          fontSize: 10, fontWeight: 800, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 0 0 2px rgba(16,185,129,0.35), 0 1px 3px rgba(0,0,0,0.45)",
          pointerEvents: "none",
        }}>✓</div>
      )}
      <div style={{
        fontWeight: 700, lineHeight: 1.3,
        whiteSpace: "normal", wordBreak: "break-word", marginBottom: 2,
      }}>
        {subtask.clientName}: {subtask.projectName}
      </div>
      <div style={{
        fontWeight: 500, lineHeight: 1.3, opacity: 0.85, marginBottom: 4,
        whiteSpace: "normal", wordBreak: "break-word",
      }}>
        {subtask.name}
      </div>
      <div style={{
        fontSize: 9, fontWeight: 700,
        color: isUnassigned ? "#EAB308" : "var(--muted)",
        textTransform: "uppercase", letterSpacing: 0.4,
      }}>
        {assigneeLabel}
      </div>
    </div>
  );
}

// ─── Style fragments ───────────────────────────────────────────────
const headerCell = {
  padding: "8px 10px", textAlign: "center",
  fontSize: 11, fontWeight: 700, color: "var(--muted)",
  borderBottom: "1px solid var(--border)",
  borderRight: "1px solid var(--border)",
  whiteSpace: "nowrap", letterSpacing: 0.3,
};
const rowLabel = {
  padding: "6px 14px", display: "flex", alignItems: "center",
  borderBottom: "1px solid var(--border)",
  // 24px so editor names stay legible when the producer zooms the
  // browser out (e.g., 67%) to fit more days on screen. Sized up
  // twice — 13px → 18px → 24px — based on Jeremy's feedback that
  // 18px still felt too small at zoom-out.
  fontSize: 24, minHeight: 44,
};
