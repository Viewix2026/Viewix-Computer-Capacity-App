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
// LANE_HEIGHT below is the vertical space allotted per lane (bar +
// gap). Bars taller than this clip with overflow: hidden — keeps the
// row predictable at the cost of long subtask names being truncated
// when stacked.
const LANE_HEIGHT = 64;
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

// ─── Drag-related primitives ───────────────────────────────────────

// A scheduled Gantt bar. The parent passes the grid column span via the
// outer wrapper in Row(); this component is the visual bar that fills
// that wrapper. Drag → reassign + reschedule. Right-edge handle →
// extend endDate.
function GanttBar({ subtask, onClick }) {
  const dragId = `bar:${subtask.id}`;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    data: { mode: "move", subtask },
  });
  const resize = useDraggable({
    id: `resize:${subtask.id}`,
    data: { mode: "resize", subtask },
  });

  const colour = colourFor(subtask);
  const span = (subtask.startDate && subtask.endDate)
    ? Math.max(1, daysBetween(subtask.startDate, subtask.endDate) + 1)
    : 1;

  const baseStyle = {
    width: "100%", boxSizing: "border-box",
    margin: 0,
    padding: "6px 10px 6px 12px",
    borderRadius: 6,
    background: `${colour}38`,
    borderLeft: `3px solid ${colour}`,
    color: "var(--fg)",
    fontSize: 11,
    fontWeight: 600,
    cursor: isDragging ? "grabbing" : "grab",
    // Wrap on word boundaries for rectangular shape, but clip at the
    // lane height so the bar can't push into the next stacked lane
    // when text wraps to many lines.
    overflow: "hidden",
    position: "relative",
    height: LANE_HEIGHT - 8,
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
      {/* Right-edge resize handle. Sits inside the bar so its hit area
          tracks with the bar's grid-column span automatically. */}
      <div
        ref={resize.setNodeRef}
        {...resize.listeners}
        {...resize.attributes}
        onClick={e => e.stopPropagation()}
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0,
          width: 6, cursor: "ew-resize",
          background: resize.isDragging ? colour : "transparent",
          borderTopRightRadius: 6, borderBottomRightRadius: 6,
        }}
        onMouseEnter={e => e.currentTarget.style.background = `${colour}88`}
        onMouseLeave={e => { if (!resize.isDragging) e.currentTarget.style.background = "transparent"; }}
        title="Drag to extend"
      />
    </div>
  );
}

// Drop target — wraps a row + col cell. Column-scope visuals (weekend
// tint, today wash, Monday week-boundary border) are NOT handled here
// — they live on a separate background-stripe layer rendered above.
// This cell handles only row-scope styling: optional row striping,
// drop-hover highlight, and the row-bottom separator.
function DropCell({
  id, children, gridColumn, gridRow, sticky, striped, minHeight,
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  // Sticky left columns get solid backgrounds (matching the assignee
  // label cells in Row()) so the column-stripe layer behind doesn't
  // bleed through translucent rgba and break the "frozen" feel of the
  // left columns. Body cells stay transparent / very faintly striped
  // so the stripes show through.
  let bg = "transparent";
  if (sticky != null) bg = striped ? "#1E2638" : "#1A2236";
  else if (striped) bg = "rgba(255,255,255,0.018)";
  if (isOver) bg = "rgba(99,102,241,0.22)";

  return (
    <div
      ref={setNodeRef}
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
      }}>
      {children}
    </div>
  );
}

// ─── Main board ────────────────────────────────────────────────────

export function TeamBoard({ projects = [], editors = [], onOpenProject }) {
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

    const { mode, subtask } = active.data.current;
    const path = `/projects/${subtask.projectId}/subtasks/${subtask.id}`;
    const now = new Date().toISOString();

    if (mode === "resize") {
      // For resize we treat over.id as the date we want to extend to.
      // Pool drop on a resize handle is a no-op (the resize gesture
      // doesn't make sense outside the date grid).
      if (over.id === POOL_ID) return;
      const { date } = parseCellId(over.id);
      if (!date) return;
      // New endDate = the date we dropped on. If it's earlier than
      // startDate, swap startDate to the dropped date so the bar stays
      // valid (treating it as a "drag the end past the start" gesture).
      let newStart = subtask.startDate || date;
      let newEnd = date;
      if (subtask.startDate && date < subtask.startDate) {
        newStart = date;
        newEnd = subtask.startDate;
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
              // Final 1fr row absorbs remaining vertical space below
              // the last editor row, so the column-stripe layer
              // (grid-row 1/-1) carries weekend / today tints all the
              // way down rather than stopping at the last data row.
              gridTemplateRows: `auto repeat(${rows.length}, minmax(60px, auto)) 1fr`,
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
                      background: isToday ? "rgba(99,102,241,0.10)"
                                : isWeekend ? "rgba(0,0,0,0.32)"
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
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6 }}>
                      {dt.toLocaleDateString("en-AU", { weekday: "short" })}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{fmtDateLabel(d)}</div>
                  </div>
                );
              })}

              {/* Rows */}
              {rows.map((row, rowIdx) => {
                const gr = rowIdx + 2;
                const sched = scheduled.get(row.id) || [];
                return (
                  <Row
                    key={row.id}
                    row={row}
                    rowIdx={rowIdx}
                    gridRow={gr}
                    scheduled={sched}
                    dates={dates}
                    colsForSpan={colsForSpan}
                    onOpenProject={onOpenProject}
                  />
                );
              })}
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

// One assignee row. Split out so each row's date cells become individual
// drop zones without ballooning the parent component's render scope.
// `rowIdx` drives row striping so every other editor lane gets a subtle
// tint and the eye can scan vertically.
function Row({ row, rowIdx, gridRow, scheduled, dates, colsForSpan, onOpenProject }) {
  const striped = rowIdx % 2 === 1;

  // Group overlapping scheduled bars into vertical lanes so two bars on
  // the same day don't render on top of each other. Lane 0 is topmost;
  // we set the row's minHeight from laneCount so the grid track grows
  // to fit. Recomputed every render — cheap (<= a few dozen bars per
  // editor row in any realistic workload).
  const { bars: laneBars, laneCount } = assignLanes(scheduled);
  const rowMinHeight = Math.max(60, laneCount * LANE_HEIGHT + 8);

  return (
    <>
      {/* Sticky left: assignee label. SOLID backgrounds — the column
          stripe layer painting weekend / today / Monday tints behind
          the grid would otherwise bleed through translucent rgba and
          the "frozen" left column would stop looking frozen. Striped
          rows use a slightly brighter solid shade so the row separation
          still reaches the left edge. */}
      <div style={{
        ...rowLabel, gridColumn: 1, gridRow,
        position: "sticky", left: 0, zIndex: 3,
        background: striped ? "#1E2638" : "#1A2236",
        borderRight: "2px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        minHeight: rowMinHeight,
      }}>
        <span style={{ fontWeight: 700, color: "var(--fg)" }}>
          {row.name}
        </span>
      </div>

      {/* One drop cell per date (cols 2..N+1). Column-scope tinting
          (weekend / today / Monday border) lives on the dedicated
          stripe layer in the parent component — these cells just
          handle row striping and drop-hover state. Bars are placed
          below as separate grid children. minHeight tracks the lane
          count so the cell stays tall enough to receive drops anywhere
          along its vertical extent. */}
      {dates.map((d, i) => (
        <DropCell
          key={d}
          id={cellId(row.id, d)}
          gridColumn={i + 2}
          gridRow={gridRow}
          striped={striped}
          minHeight={rowMinHeight}
        />
      ))}

      {/* Gantt bars — placed last so they stack visually above empty
          drop cells. Each occupies grid-column [startCol .. endCol+1]
          inside this row, plus a paddingTop offset based on its
          assigned lane so overlapping bars don't render on top of each
          other. The wrapper itself is a transparent positioning shim;
          the bar visual lives inside <GanttBar>. */}
      {laneBars.map(st => {
        const cols = colsForSpan(st);
        if (!cols) return null;
        return (
          <div key={st.id} style={{
            gridColumn: `${cols[0]} / ${cols[1] + 1}`,
            gridRow,
            alignSelf: "start",
            paddingTop: st.lane * LANE_HEIGHT + 4,
            paddingLeft: 4, paddingRight: 4,
            // Sit above DropCell so the bar receives drags before the
            // cell underneath does.
            zIndex: 1,
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
