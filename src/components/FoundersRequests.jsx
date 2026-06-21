// FoundersRequests — the Dashboard Requests Kanban (bug/feature requests).
//
// Source of truth is /dashboardRequests in RTDB (read-only to the client at
// the rules layer). Every mutation goes through POST /api/dashboard-requests
// (founders-only, Admin-SDK) — the client never writes the node directly, so
// there is no client-side trust boundary to get wrong. Drag-between-columns
// dispatches an `update` with the new status; the New-ticket form dispatches
// `create`; the drawer can change priority/type, edit the plan, or delete.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCenter, DragOverlay,
} from "@dnd-kit/core";
import { fbListenSafe, authFetch } from "../firebase";

const COLUMNS = [
  { key: "triage", label: "Triage" },
  { key: "ready", label: "Ready" },
  { key: "building", label: "Building" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];
const COLUMN_KEYS = COLUMNS.map(c => c.key);

const TYPE_BADGE = {
  bug: { label: "Bug", bg: "rgba(244,114,182,0.15)", fg: "#F472B6" },
  feature: { label: "Feature", bg: "rgba(16,185,129,0.15)", fg: "#10B981" },
};
const PRIORITY_DOT = { high: "#F472B6", med: "#FBBF24", low: "#64748B" };

async function callApi(action, payload) {
  const r = await authFetch("/api/dashboard-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `request failed (${r.status})`);
  }
  return r.json();
}

// ─── Card body (presentational, no hooks) ──────────────────────────
// Shared by the draggable Card and the DragOverlay clone, so the overlay
// never instantiates a second useDraggable with the same id (Codex R2-F8).
function CardBody({ ticket, dragging }) {
  const badge = TYPE_BADGE[ticket.type] || TYPE_BADGE.bug;
  return (
    <div
      style={{
        opacity: dragging ? 0.4 : 1,
        background: "var(--card)",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 8,
        cursor: "grab",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: badge.bg, color: badge.fg }}>
          {badge.label}
        </span>
        {ticket.priority && (
          <span title={`priority: ${ticket.priority}`} style={{ width: 8, height: 8, borderRadius: "50%", background: PRIORITY_DOT[ticket.priority] || "var(--muted)" }} />
        )}
        {ticket.source === "slack" && <span title="from Slack" style={{ fontSize: 10, color: "var(--muted)" }}>💬</span>}
        {ticket.github?.issueUrl && <span title="GitHub issue" style={{ fontSize: 10, color: "var(--muted)" }}>#{ticket.github.issueNumber}</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)", lineHeight: 1.3 }}>{ticket.title}</div>
      {ticket.requestedBy?.name && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{ticket.requestedBy.name}</div>
      )}
    </div>
  );
}

// ─── Card (draggable) ──────────────────────────────────────────────
function Card({ ticket, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: ticket.id });
  // dnd-kit fires a click after every drop (pointerdown+up land on the same
  // moved node). Swallow it for a beat so a drag never opens the drawer — the
  // exact pattern TeamBoard.jsx uses (Codex R2-F1).
  const wasDragging = useRef(false);
  useEffect(() => {
    if (isDragging) { wasDragging.current = true; return; }
    if (wasDragging.current) {
      const t = setTimeout(() => { wasDragging.current = false; }, 200);
      return () => clearTimeout(t);
    }
  }, [isDragging]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined }}
      {...listeners}
      {...attributes}
      onClick={() => { if (!isDragging && !wasDragging.current) onOpen(ticket.id); }}
    >
      <CardBody ticket={ticket} dragging={isDragging} />
    </div>
  );
}

// ─── Column ────────────────────────────────────────────────────────
function Column({ col, tickets, onOpen }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  return (
    <div style={{ flex: "1 1 0", minWidth: 200 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <span>{col.label}</span>
        <span style={{ background: "var(--card)", borderRadius: 10, padding: "0 7px", fontSize: 11, lineHeight: "16px", color: "var(--fg)" }}>{tickets.length}</span>
      </div>
      <div
        ref={setNodeRef}
        style={{
          background: isOver ? "rgba(59,130,246,0.08)" : "transparent",
          border: "1px dashed " + (isOver ? "rgba(59,130,246,0.4)" : "transparent"),
          borderRadius: 8,
          padding: 6,
          minHeight: 120,
          transition: "background 0.12s",
        }}
      >
        {tickets.map(t => <Card key={t.id} ticket={t} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

// ─── New ticket form ───────────────────────────────────────────────
function NewTicketForm({ onClose, onError }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState("bug");
  const [priority, setPriority] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await callApi("create", { title, body, type, priority: priority || null });
      onClose();
    } catch (e) {
      onError(e.message);
      setBusy(false);
    }
  };

  const field = { width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--bg, #0b0f17)", color: "var(--fg)", fontSize: 13, marginBottom: 10 };
  return (
    <div style={{ background: "var(--card)", borderRadius: 10, padding: 16, marginBottom: 16, border: "1px solid var(--border, rgba(255,255,255,0.08))" }}>
      <input style={field} placeholder="Short title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
      <textarea style={{ ...field, minHeight: 80, resize: "vertical" }} placeholder="What's the bug / request? Where in the dashboard?" value={body} onChange={e => setBody(e.target.value)} />
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <select style={{ ...field, marginBottom: 0 }} value={type} onChange={e => setType(e.target.value)}>
          <option value="bug">Bug</option>
          <option value="feature">Feature</option>
        </select>
        <select style={{ ...field, marginBottom: 0 }} value={priority} onChange={e => setPriority(e.target.value)}>
          <option value="">No priority</option>
          <option value="high">High</option>
          <option value="med">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={busy || !title.trim()} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#10B981", color: "#04140d", fontWeight: 700, fontSize: 13, cursor: busy ? "default" : "pointer", opacity: !title.trim() ? 0.5 : 1 }}>
          {busy ? "Creating…" : "Create ticket"}
        </button>
        <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "transparent", color: "var(--muted)", fontSize: 13, cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Detail drawer ─────────────────────────────────────────────────
function Drawer({ ticket, onClose, onError }) {
  const [busy, setBusy] = useState(false);
  // Optimistic overlay for the edited selects so the chosen value shows
  // instantly instead of snapping back for the server round-trip (Codex
  // R2-F3). A field clears once live RTDB echoes the value we wrote.
  const [pending, setPending] = useState({});
  useEffect(() => {
    setPending(prev => {
      const next = { ...prev }; let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        const cur = k === "priority" ? (ticket?.priority || "") : ticket?.[k];
        if (cur === (k === "priority" ? (v || "") : v)) { delete next[k]; changed = true; }
      }
      // Setting status to `ready` triggers the server-side GitHub handoff, which
      // auto-advances the ticket to `building`. The intermediate `ready` echo may
      // never arrive, so an exact-match clear would leave the select stuck on
      // "Ready" forever — clear it once the ticket has moved on to building
      // (Codex F8).
      if (next.status === "ready" && ticket?.status === "building") { delete next.status; changed = true; }
      return changed ? next : prev;
    });
  }, [ticket]);

  if (!ticket) return null;
  const view = { ...ticket, ...pending };

  const patch = async (fields) => {
    setPending(p => ({ ...p, ...fields }));
    try { await callApi("update", { id: ticket.id, fields }); }
    catch (e) {
      onError(e.message);
      setPending(p => { const n = { ...p }; for (const k of Object.keys(fields)) delete n[k]; return n; });
    }
  };
  const del = async () => {
    if (!window.confirm("Delete this ticket? This can't be undone.")) return;
    setBusy(true);
    try { await callApi("delete", { id: ticket.id }); onClose(); }
    catch (e) { onError(e.message); setBusy(false); }
  };

  const label = { fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, marginTop: 14 };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 440, maxWidth: "90vw", height: "100%", background: "var(--card)", borderLeft: "1px solid var(--border, rgba(255,255,255,0.1))", padding: 24, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: "var(--fg)" }}>{ticket.title}</h3>
          <button onClick={onClose} style={{ border: "none", background: "transparent", color: "var(--muted)", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={label}>Status</div>
        <select value={view.status} onChange={e => patch({ status: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--bg, #0b0f17)", color: "var(--fg)", fontSize: 13 }}>
          {COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={label}>Type</div>
            <select value={view.type} onChange={e => patch({ type: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--bg, #0b0f17)", color: "var(--fg)", fontSize: 13 }}>
              <option value="bug">Bug</option>
              <option value="feature">Feature</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={label}>Priority</div>
            <select value={view.priority || ""} onChange={e => patch({ priority: e.target.value })} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border, rgba(255,255,255,0.12))", background: "var(--bg, #0b0f17)", color: "var(--fg)", fontSize: 13 }}>
              <option value="">None</option>
              <option value="high">High</option>
              <option value="med">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        {ticket.body && (<><div style={label}>Description</div><div style={{ fontSize: 13, color: "var(--fg)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{ticket.body}</div></>)}

        {Array.isArray(ticket.clarifications) && ticket.clarifications.length > 0 && (
          <><div style={label}>Clarifications</div>
          {ticket.clarifications.map((c, i) => (
            <div key={i} style={{ fontSize: 12, marginBottom: 8 }}>
              <div style={{ color: "var(--muted)" }}>Q: {c.q}</div>
              <div style={{ color: "var(--fg)" }}>A: {c.a}</div>
            </div>
          ))}</>
        )}

        {Array.isArray(ticket.screenshots) && ticket.screenshots.length > 0 && (
          <><div style={label}>Screenshots</div>
          {ticket.screenshots.map((s, i) => (
            <div key={i}><a href={s.permalink} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#3B82F6" }}>{s.name || "View in Slack"} ↗</a></div>
          ))}</>
        )}

        {ticket.plan && (<><div style={label}>Plan</div><div style={{ fontSize: 13, color: "var(--fg)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{ticket.plan}</div></>)}

        {ticket.github?.issueUrl && (<><div style={label}>GitHub</div>
          <div style={{ fontSize: 13 }}>
            <a href={ticket.github.issueUrl} target="_blank" rel="noreferrer" style={{ color: "#3B82F6" }}>Issue #{ticket.github.issueNumber} ↗</a>
            {ticket.github.prUrl && <> · <a href={ticket.github.prUrl} target="_blank" rel="noreferrer" style={{ color: "#3B82F6" }}>PR ↗</a></>}
          </div></>)}

        {ticket.slack?.permalink && (<><div style={label}>Slack thread</div><a href={ticket.slack.permalink} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "#3B82F6" }}>Open in Slack ↗</a></>)}

        <div style={{ marginTop: 28, paddingTop: 16, borderTop: "1px solid var(--border, rgba(255,255,255,0.08))" }}>
          <button onClick={del} disabled={busy} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid rgba(244,114,182,0.4)", background: "transparent", color: "#F472B6", fontSize: 13, cursor: "pointer" }}>Delete ticket</button>
        </div>
      </div>
    </div>
  );
}

// ─── Board ─────────────────────────────────────────────────────────
export function FoundersRequests() {
  const [raw, setRaw] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState("");
  const [activeId, setActiveId] = useState(null);
  // optimistic status override so a dragged card doesn't snap back during the
  // server round-trip; cleared once RTDB echoes the new status.
  const [override, setOverride] = useState({});

  // fbListenSafe (not raw fbListen): gates on auth-ready and suppresses the
  // transient null Firebase fires on token rotation, so the board doesn't
  // blank to "Loading…" mid-session (Codex R2-F2).
  useEffect(() => fbListenSafe("/dashboardRequests", d => setRaw(d || {}), () => setRaw({})), []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const tickets = useMemo(() => {
    const list = Object.values(raw || {}).filter(t => t && t.id);
    return list
      .map(t => override[t.id] ? { ...t, status: override[t.id] } : t)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }, [raw, override]);

  // drop optimistic overrides once the server confirms the status we wrote, or
  // if the ticket was deleted — so an override can't get stuck. (A clear on
  // *any* raw push would prematurely revert a still-in-flight drag, so we only
  // clear on an exact match or deletion — Codex R2-F7.)
  useEffect(() => {
    setOverride(prev => {
      const next = { ...prev };
      let changed = false;
      for (const [id, st] of Object.entries(prev)) {
        const cur = raw?.[id];
        // Clear on confirm or deletion, and on the ready→building auto-advance
        // (the server opens the GitHub issue and skips the `ready` echo, so an
        // exact-match clear would strand a dragged card in Ready — Codex R2-N3,
        // same gap the Drawer fix closed for the detail view).
        if (!cur || cur.status === st || (st === "ready" && cur.status === "building")) {
          delete next[id]; changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [raw]);

  const byColumn = useMemo(() => {
    const m = Object.fromEntries(COLUMN_KEYS.map(k => [k, []]));
    for (const t of tickets) (m[t.status] || m.triage).push(t);
    return m;
  }, [tickets]);

  const openTicket = tickets.find(t => t.id === openId) || null;
  const activeTicket = tickets.find(t => t.id === activeId) || null;

  const onDragEnd = async (e) => {
    setActiveId(null);
    const id = e.active?.id;
    const target = e.over?.id;
    if (!id || !target || !COLUMN_KEYS.includes(target)) return;
    const current = tickets.find(t => t.id === id);
    if (!current || current.status === target) return;
    setOverride(o => ({ ...o, [id]: target }));
    try {
      await callApi("update", { id, fields: { status: target } });
    } catch (e2) {
      setErr(e2.message);
      setOverride(o => { const n = { ...o }; delete n[id]; return n; }); // revert
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Bug &amp; feature requests. Drag cards between columns to update status.
        </div>
        {!showNew && (
          <button onClick={() => setShowNew(true)} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#3B82F6", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ New ticket</button>
        )}
      </div>

      {err && (
        <div style={{ background: "rgba(244,114,182,0.12)", border: "1px solid rgba(244,114,182,0.3)", color: "#F472B6", padding: "8px 12px", borderRadius: 6, fontSize: 13, marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
          <span>{err}</span>
          <button onClick={() => setErr("")} style={{ border: "none", background: "transparent", color: "#F472B6", cursor: "pointer" }}>×</button>
        </div>
      )}

      {showNew && <NewTicketForm onClose={() => setShowNew(false)} onError={setErr} />}

      {raw === null ? (
        <div style={{ color: "var(--muted)", fontSize: 13, padding: 40, textAlign: "center" }}>Loading…</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={e => setActiveId(e.active?.id)} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {COLUMNS.map(col => (
              <Column key={col.key} col={col} tickets={byColumn[col.key] || []} onOpen={setOpenId} />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {activeTicket ? <CardBody ticket={activeTicket} /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {openTicket && <Drawer ticket={openTicket} onClose={() => setOpenId(null)} onError={setErr} />}
    </div>
  );
}
