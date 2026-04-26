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
import { fmtD } from "../utils";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCenter, DragOverlay,
} from "@dnd-kit/core";

// ─── Subtask status palette ────────────────────────────────────────
// Mirrors SUBTASK_STATUS_OPTIONS in Projects.jsx — kept duplicated here
// (not imported) because the Projects file has a *separate* project-level
// status taxonomy and re-exporting just the subtask one would invite
// confusion. If the palette ever changes, change it in both places.
const STATUS_COLOURS = {
  scheduled:     "#3B82F6",
  inProgress:    "#F97316",
  waitingClient: "#8B5CF6",
  onHold:        "#EAB308",
  stuck:         "#EC4899",
  done:          "#10B981",
};
const colourFor = (status) => STATUS_COLOURS[status] || STATUS_COLOURS.stuck;

// ─── Date helpers (local — too narrow for src/utils.js) ────────────
const isoToday = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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
  return d.toISOString().slice(0, 10);
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

  const colour = colourFor(subtask.status);
  const span = (subtask.startDate && subtask.endDate)
    ? Math.max(1, daysBetween(subtask.startDate, subtask.endDate) + 1)
    : 1;

  const baseStyle = {
    width: "100%", boxSizing: "border-box",
    margin: "3px 0",
    padding: "6px 10px",
    borderRadius: 6,
    background: `${colour}38`,
    borderLeft: `3px solid ${colour}`,
    color: "var(--fg)",
    fontSize: 11,
    fontWeight: 600,
    cursor: isDragging ? "grabbing" : "grab",
    overflow: "hidden",
    position: "relative",
    minHeight: 40,
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
      title={`${subtask.clientName}: ${subtask.name}\n${subtask.startDate} → ${subtask.endDate}\n${subtask.status}`}
      {...listeners}
      {...attributes}>
      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 700 }}>{subtask.clientName}:</span>{" "}
        <span style={{ fontWeight: 500 }}>{subtask.name}</span>
      </div>
      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 1, fontFamily: "'JetBrains Mono',monospace" }}>
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

// Unscheduled card — same drag handle as a bar but renders as a stacked
// pill in the left "Unscheduled" column. Its drag.data still uses
// mode: "move" so the same onDragEnd handler can reschedule it.
function UnscheduledCard({ subtask, onClick }) {
  const dragId = `bar:${subtask.id}`;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    data: { mode: "move", subtask },
  });
  const colour = colourFor(subtask.status);
  return (
    <div
      ref={setNodeRef}
      style={{
        margin: "3px 0",
        padding: "5px 8px",
        borderRadius: 6,
        background: `${colour}38`,
        borderLeft: `3px solid ${colour}`,
        color: "var(--fg)",
        fontSize: 11,
        cursor: isDragging ? "grabbing" : "grab",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        userSelect: "none",
      }}
      onClick={() => { if (!isDragging) onClick?.(); }}
      title={`${subtask.clientName}: ${subtask.name}\nUnscheduled • ${subtask.status}`}
      {...listeners}
      {...attributes}>
      <span style={{ fontWeight: 700 }}>{subtask.clientName}:</span>{" "}
      <span style={{ fontWeight: 500 }}>{subtask.name}</span>
    </div>
  );
}

// Drop target — wraps a row + col cell. Tinting props give weekends a
// distinct grey background, today an indigo wash, alternate rows a
// subtle stripe, and Mondays a stronger left border to break the grid
// into visible week chunks.
function DropCell({
  id, children, gridColumn, gridRow, sticky,
  isWeekend, isToday, isMonday, striped,
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  // Background priority: hover > today > weekend > striped > none.
  // For sticky left columns we paint over with var(--card) so the
  // assignee labels stay legible during horizontal scroll.
  let bg = "transparent";
  if (sticky != null) bg = "var(--card)";
  else if (striped) bg = "rgba(255,255,255,0.018)";
  if (isWeekend) bg = "rgba(0,0,0,0.32)";
  if (isToday) bg = "rgba(99,102,241,0.12)";
  if (isOver) bg = "rgba(99,102,241,0.22)";

  return (
    <div
      ref={setNodeRef}
      style={{
        gridColumn, gridRow,
        background: bg,
        borderRight: "1px solid var(--border)",
        // Mondays get a slightly heavier left border so the eye can
        // scan week-by-week even at a wide zoom.
        borderLeft: isMonday ? "2px solid var(--border)" : undefined,
        borderBottom: "1px solid var(--border)",
        minHeight: 60,
        position: sticky != null ? "sticky" : "static",
        left: sticky,
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

  // Bins for fast cell-lookup during render.
  // - byAssigneeScheduled[assigneeId] = [subtask, ...] (those with startDate)
  //   These get positioned by computing their grid columns from startDate/endDate.
  // - byAssigneeUnscheduled[assigneeId] = [subtask, ...] (no startDate)
  // assigneeId="null" is the bin for unassigned subtasks.
  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled = new Map();
    const unscheduled = new Map();
    for (const st of flatSubtasks) {
      const aKey = st.assigneeId || "null";
      if (st.startDate) {
        if (!scheduled.has(aKey)) scheduled.set(aKey, []);
        scheduled.get(aKey).push(st);
      } else {
        if (!unscheduled.has(aKey)) unscheduled.set(aKey, []);
        unscheduled.get(aKey).push(st);
      }
    }
    return { scheduled, unscheduled };
  }, [flatSubtasks]);

  // Row ordering: pinned "Unassigned" lane on top, then editors in the
  // order /editors hands them to us.
  const rows = useMemo(() => [
    { id: "null", name: "Unassigned", muted: true },
    ...editors.map(e => ({ id: e.id, name: e.name, muted: false })),
  ], [editors]);

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
      // For resize we treat over.id as the date we want to extend to —
      // any cell in any row works (we only care about the date column).
      const { date } = parseCellId(over.id);
      if (!date) return;  // can't resize onto unscheduled column
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
    const { assigneeId: newAssignee, date: newDate } = parseCellId(over.id);
    const oldStart = subtask.startDate;
    const oldEnd = subtask.endDate;

    // Compute new endDate preserving duration.
    let newStart = newDate;
    let newEnd = newDate;
    if (newDate && oldStart && oldEnd) {
      const delta = daysBetween(oldStart, newDate);
      newEnd = addDays(oldEnd, delta);
    } else if (!newDate) {
      // Dropped onto unscheduled column → clear both dates.
      newStart = null;
      newEnd = null;
    }

    fbSet(`${path}/assigneeId`, newAssignee);
    fbSet(`${path}/startDate`, newStart);
    fbSet(`${path}/endDate`, newEnd);
    fbSet(`${path}/updatedAt`, now);
  };

  // ─── Layout maths ────────────────────────────────────────────────
  // Grid columns: 1 = assignee label, 2 = unscheduled, 3..(N+2) = dates.
  const gridTemplateColumns = `200px 240px repeat(${dates.length}, minmax(110px, 1fr))`;
  const dateToCol = useMemo(() => {
    const m = new Map();
    dates.forEach((d, i) => m.set(d, i + 3));
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
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
            overflow: "auto", position: "relative",
            // Constrain height so the horizontal scroll triggers a vertical
            // scroll handler too — without it, a wide grid with few rows
            // doesn't expose a scrollbar to drive infinite-load.
            maxHeight: "calc(100vh - 200px)",
          }}>
          <div style={{ display: "grid", gridTemplateColumns, minWidth: "fit-content" }}>
            {/* Header row — col labels */}
            <div style={{ ...headerCell, position: "sticky", top: 0, left: 0, zIndex: 5, background: "var(--bg)" }}>
              Team
            </div>
            <div style={{ ...headerCell, position: "sticky", top: 0, left: 200, zIndex: 5, background: "var(--bg)" }}>
              Unscheduled
            </div>
            {dates.map(d => {
              const dt = new Date(d + "T00:00:00");
              const dayNum = dt.getDay();
              const isToday = d === isoToday();
              const isWeekend = dayNum === 0 || dayNum === 6;
              const isMonday = dayNum === 1;
              return (
                <div key={d} style={{
                  ...headerCell,
                  position: "sticky", top: 0, zIndex: 4,
                  // Header background mirrors the body cell tint below
                  // so the column reads as one consistent stripe.
                  background: isToday ? "rgba(99,102,241,0.28)"
                            : isWeekend ? "rgba(0,0,0,0.45)"
                            : "var(--bg)",
                  color: isToday ? "var(--accent)" : isWeekend ? "var(--muted)" : "var(--fg)",
                  borderLeft: isMonday ? "2px solid var(--border)" : undefined,
                }}>
                  <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6 }}>
                    {dt.toLocaleDateString("en-AU", { weekday: "short" })}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{fmtD(d)}</div>
                </div>
              );
            })}

            {/* Rows */}
            {rows.map((row, rowIdx) => {
              // grid-row index for this assignee, +2 because row 1 = header.
              const gr = rowIdx + 2;
              const sched = scheduled.get(row.id) || [];
              const unsched = unscheduled.get(row.id) || [];
              return (
                <Row
                  key={row.id}
                  row={row}
                  rowIdx={rowIdx}
                  gridRow={gr}
                  scheduled={sched}
                  unscheduled={unsched}
                  dates={dates}
                  colsForSpan={colsForSpan}
                  onOpenProject={onOpenProject}
                />
              );
            })}
          </div>
        </div>

        {/* Subtle drag preview floating with the cursor — gives a clear
            "you're dragging this" cue when the bar leaves its row. */}
        <DragOverlay dropAnimation={null}>
          {dragPreview && (
            <div style={{
              padding: "6px 10px", borderRadius: 6,
              background: `${colourFor(dragPreview.status)}`,
              color: "#fff", fontSize: 11, fontWeight: 700,
              boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
              maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {dragPreview.clientName}: {dragPreview.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {rows.length <= 1 && (
        <div style={{ marginTop: 12, padding: 16, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          No editors in the roster yet. Add team members in the Editors tab.
        </div>
      )}
    </div>
  );
}

// One assignee row. Split out so each row's date cells become individual
// drop zones without ballooning the parent component's render scope.
// `rowIdx` drives row striping so every other editor lane gets a subtle
// tint and the eye can scan vertically.
function Row({ row, rowIdx, gridRow, scheduled, unscheduled, dates, colsForSpan, onOpenProject }) {
  const striped = rowIdx % 2 === 1;
  const todayISO = isoToday();
  return (
    <>
      {/* Sticky left: assignee label. Slightly different background on
          striped rows so the row separation reaches all the way to the
          left edge. */}
      <div style={{
        ...rowLabel, gridColumn: 1, gridRow,
        position: "sticky", left: 0, zIndex: 3,
        background: row.muted ? "rgba(75,85,99,0.18)"
                  : striped ? "rgba(255,255,255,0.025)"
                  : "var(--card)",
        borderRight: "2px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <span style={{ fontWeight: 700, color: row.muted ? "var(--muted)" : "var(--fg)" }}>
          {row.name}
        </span>
      </div>

      {/* Sticky left: unscheduled column (drop zone) */}
      <DropCell id={cellId(row.id, null)} gridColumn={2} gridRow={gridRow} sticky={200} striped={striped}>
        <div style={{ padding: 4, minHeight: 56 }}>
          {unscheduled.map(st => (
            <UnscheduledCard key={st.id} subtask={st} onClick={() => onOpenProject?.(st.projectId)} />
          ))}
        </div>
      </DropCell>

      {/* One drop cell per date. Bars are added below as separate
          grid children — they span multiple columns via grid-column. */}
      {dates.map((d, i) => {
        const dayNum = new Date(d + "T00:00:00").getDay();
        return (
          <DropCell
            key={d}
            id={cellId(row.id, d)}
            gridColumn={i + 3}
            gridRow={gridRow}
            isWeekend={dayNum === 0 || dayNum === 6}
            isToday={d === todayISO}
            isMonday={dayNum === 1}
            striped={striped}
          />
        );
      })}

      {/* Gantt bars — placed last so they stack visually above empty
          drop cells. Each occupies grid-column [startCol .. endCol+1]
          inside this row. */}
      {scheduled.map(st => {
        const cols = colsForSpan(st);
        if (!cols) return null;
        return (
          <div key={st.id} style={{
            gridColumn: `${cols[0]} / ${cols[1] + 1}`,
            gridRow,
            alignSelf: "start",
            padding: "0 4px",
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
