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

import { useMemo, useState, useRef, useCallback } from "react";
import { fbSet } from "../firebase";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCenter, DragOverlay,
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
const STAGE_COLOURS = {
  preProduction: "#8B5CF6",
  shoot:         "#DC2626",
  revisions:     "#F97316",
  edit:          "#0082FA",
  hold:          "#EAB308",
};
// Mirrors inferStage in Projects.jsx — falls back to a name-based guess
// when the stage field is missing (legacy data) or invalid. Keeps the
// Team Board readable for projects that haven't been touched since the
// stage feature shipped.
const stageOf = (st) => {
  if (st?.stage && STAGE_COLOURS[st.stage]) return st.stage;
  const name = (st?.name || "").toLowerCase();
  if (name.includes("pre production") || name.includes("preproduction") || name.includes("pre-production")) return "preProduction";
  if (name.includes("revision")) return "revisions";
  if (name.includes("shoot")) return "shoot";
  if (name.includes("edit")) return "edit";
  return "preProduction";
};
const colourFor = (subtask) => STAGE_COLOURS[stageOf(subtask)];

// Ordered list for the legend strip — same order as the dropdown in
// Projects.jsx so producers see the same sequence in both places.
const STAGE_LEGEND = [
  { key: "preProduction", label: "Pre Production" },
  { key: "shoot",         label: "Shoot" },
  { key: "revisions",     label: "Revisions" },
  { key: "edit",          label: "Edit" },
  { key: "hold",          label: "Hold" },
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
function assignLanes(scheduledBars) {
  const sorted = [...scheduledBars].sort((a, b) => {
    const sa = a.startDate || "";
    const sb = b.startDate || "";
    if (sa !== sb) return sa.localeCompare(sb);
    return (a.endDate || a.startDate || "").localeCompare(b.endDate || b.startDate || "");
  });

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
    result.push({ ...bar, lane });
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
// Saturday + Sunday → true. Cheap enough to call per cell without memo.
const isWeekendISO = (iso) => {
  const wd = new Date(iso + "T00:00:00").getDay();
  return wd === 0 || wd === 6;
};
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
      padding: "0 4px 12px",
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
function GanttBar({ subtask, onClick }) {
  const dragId = `bar:${subtask.id}`;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    data: { mode: "move", subtask },
  });
  const resizeEnd = useDraggable({
    id: `resize-end:${subtask.id}`,
    data: { mode: "resizeEnd", subtask },
  });
  const resizeStart = useDraggable({
    id: `resize-start:${subtask.id}`,
    data: { mode: "resizeStart", subtask },
  });

  const colour = colourFor(subtask);
  const span = (subtask.startDate && subtask.endDate)
    ? Math.max(1, daysBetween(subtask.startDate, subtask.endDate) + 1)
    : 1;

  const baseStyle = {
    width: "100%", boxSizing: "border-box",
    margin: 0,
    // Right padding bumped to leave room for the drag-handle dot
     // cluster pinned in the top-right corner.
    padding: "6px 22px 6px 12px",
    borderRadius: 6,
    background: `${colour}38`,
    borderLeft: `3px solid ${colour}`,
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
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    userSelect: "none",
  };

  return (
    <div
      ref={setNodeRef}
      style={baseStyle}
      onClick={(e) => {
        // PointerSensor's 6px activation distance means a real click
        // (no drag) lands here unmolested. Open the parent project.
        if (!isDragging) onClick?.();
      }}
      title={`${subtask.clientName} · ${subtask.projectName}\n${subtask.name}\n${subtask.startDate} → ${subtask.endDate}\nStage: ${stageOf(subtask)}`}
      {...listeners}
      {...attributes}>
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
      {/* Resting-state grip cue: a 2px coloured stripe inset 3px from
          each long edge of the bar. Painted via a linear gradient so
          there's no extra DOM. The 8px wide hit area + ew-resize
          cursor on hover is unchanged; this just makes the handle
          visible without hovering. */}
      <div
        ref={resizeStart.setNodeRef}
        {...resizeStart.listeners}
        {...resizeStart.attributes}
        onClick={e => e.stopPropagation()}
        style={{
          position: "absolute", top: 0, left: 0, bottom: 0,
          width: 8, cursor: "ew-resize",
          background: resizeStart.isDragging
            ? colour
            : `linear-gradient(to right, transparent 3px, ${colour}55 3px, ${colour}55 5px, transparent 5px)`,
          borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
          zIndex: 2,
        }}
        onMouseEnter={e => e.currentTarget.style.background = `${colour}aa`}
        onMouseLeave={e => {
          if (!resizeStart.isDragging) {
            e.currentTarget.style.background = `linear-gradient(to right, transparent 3px, ${colour}55 3px, ${colour}55 5px, transparent 5px)`;
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
          width: 8, cursor: "ew-resize",
          background: resizeEnd.isDragging
            ? colour
            : `linear-gradient(to left, transparent 3px, ${colour}55 3px, ${colour}55 5px, transparent 5px)`,
          borderTopRightRadius: 6, borderBottomRightRadius: 6,
          zIndex: 2,
        }}
        onMouseEnter={e => e.currentTarget.style.background = `${colour}aa`}
        onMouseLeave={e => {
          if (!resizeEnd.isDragging) {
            e.currentTarget.style.background = `linear-gradient(to left, transparent 3px, ${colour}55 3px, ${colour}55 5px, transparent 5px)`;
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
  id, children, gridColumn, gridRow, sticky, striped, minHeight,
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  // Local state so we can highlight on plain mouse hover (no drag
  // active). React state per cell is fine at this scale (~150 cells in
  // the typical 4-week × 5-editor board); avoids the global stylesheet
  // hop that inline-style :hover would otherwise need.
  const [hovered, setHovered] = useState(false);

  // Sticky left columns get solid backgrounds (matching the assignee
  // label cells in Row()) so the column-stripe layer behind doesn't
  // bleed through translucent rgba and break the "frozen" feel of the
  // left columns. Body cells stay transparent / very faintly striped
  // so the stripes show through.
  // Hover priority: drag-over > mouse hover > striped/sticky > base.
  let bg = "transparent";
  if (sticky != null) bg = striped ? "#1E2638" : "#1A2236";
  else if (striped) bg = "rgba(255,255,255,0.018)";
  if (hovered && sticky == null) bg = "rgba(99,102,241,0.10)";
  if (isOver) bg = "rgba(99,102,241,0.22)";

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
        // with the lane count of the parent row. Falls back to 60.
        minHeight: minHeight ?? 60,
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

export function TeamBoard({ projects = [], editors = [], setEditors, onOpenProject }) {
  // The board starts on the Monday of the current week so the producer
  // sees the full current week (including past days they may have
  // already worked) without scrolling left. From there, we render N
  // days forward; scrolling near the right edge appends another batch
  // (no toolbar, no manual prev/next).
  const fromDate = useMemo(() => startOfWeek(isoToday()), []);
  const [daysAhead, setDaysAhead] = useState(28);  // 4 weeks initial
  const dates = useMemo(() => dateRange(fromDate, daysAhead), [fromDate, daysAhead]);

  // Scroll listener on the grid container. When the user scrolls within
  // ~300px of the right edge, append another 14 days. We throttle via
  // a "loading" guard so a fast flick doesn't fire the extension five
  // times during the same momentum scroll. Cap at 365 days total.
  const scrollRef = useRef(null);
  const extending = useRef(false);
  const onScroll = useCallback((e) => {
    if (extending.current) return;
    const el = e.currentTarget;
    const remaining = el.scrollWidth - (el.scrollLeft + el.clientWidth);
    if (remaining < 320 && daysAhead < 365) {
      extending.current = true;
      setDaysAhead(d => Math.min(365, d + 14));
      // Reset the guard once the next render lands. Two RAFs is enough
      // for the new columns to render and grow scrollWidth past the
      // 320-remaining threshold.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        extending.current = false;
      }));
    }
  }, [daysAhead]);

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
        });
      }
    }
    return out;
  }, [projects]);

  // Two bins: subtasks that are fully on the schedule (have BOTH a
  // startDate AND an assigneeId) go into the main grid, everything
  // else goes into the bottom "pool" drawer. The pool is sorted so
  // unassigned items float to the top, then by assignee name, then
  // by client name — gives producers a stable scan order.
  const { scheduled, pool } = useMemo(() => {
    const scheduled = new Map();
    const pool = [];
    for (const st of flatSubtasks) {
      if (st.assigneeId && st.startDate) {
        if (!scheduled.has(st.assigneeId)) scheduled.set(st.assigneeId, []);
        scheduled.get(st.assigneeId).push(st);
      } else {
        pool.push(st);
      }
    }
    const editorById = new Map(editors.map(e => [e.id, e.name || ""]));
    pool.sort((a, b) => {
      // "_" < "a-z" so unassigned sorts to the front.
      const aName = a.assigneeId ? (editorById.get(a.assigneeId) || "zzz") : "_unassigned";
      const bName = b.assigneeId ? (editorById.get(b.assigneeId) || "zzz") : "_unassigned";
      if (aName !== bName) return aName.localeCompare(bName);
      return (a.clientName || "").localeCompare(b.clientName || "");
    });
    return { scheduled, pool };
  }, [flatSubtasks, editors]);

  // Rows are just the editor roster now. The "Unassigned" lane has
  // moved out of the main grid into the bottom pool drawer below it.
  const rows = useMemo(() =>
    editors.map(e => ({ id: e.id, name: e.name, muted: false })),
    [editors]
  );

  // Single droppable id for the bottom pool. Used by both the
  // useDroppable hook on the drawer and by onDragEnd to detect drops.
  const POOL_ID = "__pool__";

  // Per-editor layout: walks the rows in order assigning each editor a
  // contiguous block of grid rows = (laneCount) sub-rows. Each lane
  // gets its own auto-sizing grid track so bars in different lanes
  // grow vertically without overlapping. Replaces the previous
  // paddingTop hack which assumed every bar was the same fixed height.
  const editorLayout = useMemo(() => {
    let cursor = 2;  // grid row 1 = header row
    const items = rows.map(row => {
      const sched = scheduled.get(row.id) || [];
      const { bars: laneBars, laneCount } = assignLanes(sched);
      // Empty editor rows still need at least 1 lane sub-row so the
      // editor label has somewhere to sit and the date cells get a
      // valid gridRow span.
      const rowCount = Math.max(1, laneCount);
      const startRow = cursor;
      cursor += rowCount;
      return { row, laneBars, laneCount: rowCount, startRow };
    });
    return { items, totalRows: cursor - 2 };
  }, [rows, scheduled]);

  // ─── Drag handler ────────────────────────────────────────────────
  const sensors = useSensors(useSensor(PointerSensor, {
    // 6px buffer so producers reading a card don't accidentally pick it.
    // Same pattern as SocialOrganicSelect.jsx.
    activationConstraint: { distance: 6 },
  }));
  const [dragPreview, setDragPreview] = useState(null);

  const onDragStart = (e) => {
    setDragPreview(e.active?.data?.current?.subtask || null);
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

    const { mode, subtask } = activeData;
    const path = `/projects/${subtask.projectId}/subtasks/${subtask.id}`;
    const now = new Date().toISOString();

    if (mode === "resizeEnd" || mode === "resizeStart") {
      // Pool drop on a resize handle is a no-op (the resize gesture
      // doesn't make sense outside the date grid).
      if (over.id === POOL_ID) return;
      const { date } = parseCellId(over.id);
      if (!date) return;

      const oldStart = subtask.startDate;
      const oldEnd = subtask.endDate || subtask.startDate;
      let newStart = oldStart;
      let newEnd = oldEnd;

      if (mode === "resizeEnd") {
        // Pull the right edge to the dropped date. If it lands before
        // the current startDate, the gesture has flipped the bar — the
        // dropped date becomes the new startDate and the previous
        // startDate becomes the new endDate.
        if (oldStart && date < oldStart) {
          newStart = date;
          newEnd = oldStart;
        } else {
          newEnd = date;
        }
      } else {
        // resizeStart: mirror of the above. Pull the left edge to the
        // dropped date. If it lands after endDate, flip the bar.
        if (oldEnd && date > oldEnd) {
          newStart = oldEnd;
          newEnd = date;
        } else {
          newStart = date;
        }
      }

      fbSet(`${path}/startDate`, newStart);
      fbSet(`${path}/endDate`, newEnd);
      fbSet(`${path}/updatedAt`, now);
      return;
    }

    // mode === "move"
    if (over.id === POOL_ID) {
      // Drop into the pool drawer = unschedule. Keeps the assigneeId
      // intact so the producer can drop the card back into a date cell
      // later without having to re-pick the editor — pool cards still
      // show the assignee name in their footer.
      fbSet(`${path}/startDate`, null);
      fbSet(`${path}/endDate`, null);
      fbSet(`${path}/updatedAt`, now);
      return;
    }

    // Drop into a date cell on the main grid. Both newAssignee and
    // newDate must be set (the grid only renders date cells; bail
    // safely if somehow we get a malformed id).
    const { assigneeId: newAssignee, date: newDate } = parseCellId(over.id);
    if (!newAssignee || !newDate) return;
    const oldStart = subtask.startDate;
    const oldEnd = subtask.endDate;
    let newEnd = newDate;
    if (oldStart && oldEnd) {
      const delta = daysBetween(oldStart, newDate);
      newEnd = addDays(oldEnd, delta);
    }
    fbSet(`${path}/assigneeId`, newAssignee);
    fbSet(`${path}/startDate`, newDate);
    fbSet(`${path}/endDate`, newEnd);
    fbSet(`${path}/updatedAt`, now);
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
    const end = st.endDate || st.startDate;
    if (end < fromDate || st.startDate > lastDate) return null;
    const startClamped = st.startDate < fromDate ? fromDate : st.startDate;
    const endClamped = end > lastDate ? lastDate : end;
    return [dateToCol.get(startClamped), dateToCol.get(endClamped)];
  };

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div style={{ padding: "16px 28px 60px" }}>
      {/* Stage colour key — sits above the calendar so producers can
          map a coloured bar back to its stage name. Static, subtle,
          defers to the data below. */}
      <StageLegend />
      {/* No toolbar — the calendar is purely scroll-driven. The grid
          starts on the Monday of the current week and extends right as
          the producer scrolls. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
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
              gridTemplateRows: `auto repeat(${editorLayout.totalRows}, minmax(56px, auto)) 1fr`,
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
                  rowIdx={rowIdx}
                  startRow={item.startRow}
                  laneCount={item.laneCount}
                  laneBars={item.laneBars}
                  dates={dates}
                  colsForSpan={colsForSpan}
                  onOpenProject={onOpenProject}
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
    </div>
  );
}

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
function EditorLabel({ row, rowIdx, startRow, laneCount, striped }) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: `editor-drag:${row.id}`,
    data: { mode: "reorderEditor", editorId: row.id, fromIdx: rowIdx },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `editor-drop:${row.id}`,
    data: { mode: "reorderEditor", targetIdx: rowIdx },
  });
  // Combine draggable + droppable refs onto the same DOM node.
  const setRef = (node) => { setDragRef(node); setDropRef(node); };
  return (
    <div
      ref={setRef}
      {...attributes}
      style={{
        ...rowLabel,
        gridColumn: 1,
        gridRow: `${startRow} / ${startRow + laneCount}`,
        position: "sticky", left: 0, zIndex: 3,
        background: isOver ? "rgba(99,102,241,0.22)"
                  : striped ? "#1E2638" : "#1A2236",
        borderRight: "2px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        // Drop hint: a 2px line at the top edge when something is
        // being dragged over this row.
        borderTop: isOver ? "2px solid var(--accent)" : undefined,
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
      <span style={{ fontWeight: 700, color: "var(--fg)" }}>
        {row.name}
      </span>
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
function Row({ row, rowIdx, startRow, laneCount, laneBars, dates, colsForSpan, onOpenProject }) {
  const striped = rowIdx % 2 === 1;
  const endRow = startRow + laneCount;  // exclusive end for grid-row range

  return (
    <>
      <EditorLabel
        row={row}
        rowIdx={rowIdx}
        startRow={startRow}
        laneCount={laneCount}
        striped={striped}
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
            alignItems: "stretch",
          }}>
            <GanttBar
              subtask={st}
              onClick={() => onOpenProject?.(st.projectId)}
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
  return (
    <div
      ref={setNodeRef}
      style={{
        flexShrink: 0,
        height: 180,
        background: isOver ? "rgba(99,102,241,0.16)" : "#0F1421",
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
          Unscheduled & Unassigned · {pool.length}
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
              onClick={() => onOpenProject?.(st.projectId)}
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
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `bar:${subtask.id}`,
    data: { mode: "move", subtask },
  });
  const colour = colourFor(subtask);
  const editor = (editors || []).find(e => e.id === subtask.assigneeId);
  const assigneeLabel = editor?.name || "Unassigned";
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
        padding: "8px 10px",
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
      }}>
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
        fontSize: 9, fontWeight: 700, color: editor ? "var(--muted)" : "#EAB308",
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
  padding: "10px 14px", display: "flex", alignItems: "center",
  borderBottom: "1px solid var(--border)",
  fontSize: 13, minHeight: 60,
};
