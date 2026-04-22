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

import { useState, useMemo, memo } from "react";
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
  const [notes, setNotes] = useState(project.producerNotes || "");
  // Normalise so legacy "active" / "onHold" records open with a sensible
  // current-status value instead of falling through to "Not Started".
  const [status, setStatus] = useState(normaliseStatus(project.status));
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved

  const saveField = async (patch) => {
    setSaveState("saving");
    try {
      // fbUpdate (merge) instead of fbSet (replace) so webhook-written
      // fields (packageTier, numberOfVideos, attioCompanyId, etc.) that
      // land between this component's render and the save don't get
      // silently wiped. The old fbSet pattern spread `project` captured
      // at render time, clobbering anything newer.
      await fbUpdate(`/projects/${project.id}`, {
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1200);
    } catch (e) {
      console.error("Failed to save project:", e);
      setSaveState("idle");
    }
  };

  const links = project.links || {};
  const dests = Array.isArray(project.destinations) ? project.destinations : [];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 28px 60px" }}>
      <button onClick={onBack} style={{ ...BTN, background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)", marginBottom: 20 }}>← Back to projects</button>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>
            {project.clientName}
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--fg)" }}>
            {project.projectName}
          </div>
        </div>
        {/* Seven-status taxonomy — swapped to a coloured dropdown so all
            options fit without horizontal overflow. Background colour
            reflects current selection (matches the row pill). */}
        <div style={{ minWidth: 200 }}>
          <StatusCell value={status} onChange={(s) => { setStatus(s); saveField({ status: s }); }} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Video Type", value: project.videoType || "—" },
          { label: "Number of Videos", value: project.numberOfVideos != null ? String(project.numberOfVideos) : "—" },
          { label: "Deal Value", value: project.dealValue != null ? fmtCur(Number(project.dealValue) || 0) : "—" },
          { label: "Due Date", value: project.dueDate ? fmtD(project.dueDate) : "—" },
          { label: "Signing Date", value: project.closeDate ? fmtD(project.closeDate) : "—" },
          { label: "Target Audience", value: project.targetAudience || "—" },
        ].map(f => (
          <div key={f.label} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
              {f.label}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{f.value}</div>
          </div>
        ))}
      </div>

      {dests.length > 0 && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Destinations
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {dests.map((d, i) => <Chip key={i}>{d}</Chip>)}
          </div>
        </div>
      )}

      {project.description && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Scope of Work
          </div>
          <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {project.description}
          </div>
        </div>
      )}

      {(project.clientContact?.firstName || project.clientContact?.email) && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Client Contact
          </div>
          <div style={{ fontSize: 13, color: "var(--fg)" }}>
            {project.clientContact?.firstName}
            {project.clientContact?.firstName && project.clientContact?.email && " · "}
            {project.clientContact?.email && (
              <a href={`mailto:${project.clientContact.email}`} style={{ color: "var(--accent)", textDecoration: "none" }}>{project.clientContact.email}</a>
            )}
          </div>
        </div>
      )}

      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Linked Records
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <StatusPill label={`Sherpa${links.sherpaId ? " ✓" : ""}`}     done={!!links.sherpaId}    color="#8B5CF6"/>
          <StatusPill label={`Pre-Prod${links.preprodId ? " ✓" : ""}`}  done={!!links.preprodId}   color="#EC4899"/>
          <StatusPill label={`Runsheet${links.runsheetId ? " ✓" : ""}`} done={!!links.runsheetId}  color="#06B6D4"/>
          <StatusPill label={`Delivery${links.deliveryId ? " ✓" : ""}`} done={!!links.deliveryId}  color="#10B981"/>
          <StatusPill label={`Account${links.accountId ? " ✓" : ""}`}   done={!!links.accountId}   color="#F59E0B"/>
        </div>
      </div>

      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px", marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
          <span>Producer Notes</span>
          {saveState === "saving" && <span style={{ color: "var(--muted)", textTransform: "none", fontWeight: 400 }}>Saving…</span>}
          {saveState === "saved"  && <span style={{ color: "#10B981", textTransform: "none", fontWeight: 400 }}>Saved ✓</span>}
        </div>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => { if (notes !== (project.producerNotes || "")) saveField({ producerNotes: notes }); }}
          placeholder="Internal notes about this project…"
          style={{
            width: "100%", minHeight: 100, padding: "10px 12px", borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--input-bg)",
            color: "var(--fg)", fontSize: 13, lineHeight: 1.5, outline: "none",
            resize: "vertical", fontFamily: "inherit",
          }}/>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => { if (confirm(`Delete project "${project.projectName}"? This only removes it from the Projects tab — linked records (delivery / preprod / sherpa / account) are kept.`)) onDelete(); }}
          style={{ ...BTN, background: "transparent", color: "#EF4444", border: "1px solid #EF4444" }}>
          Delete project
        </button>
      </div>
    </div>
  );
}

export function Projects({ projects, deliveries, setDeliveries, accounts }) {
  const [subTab, setSubTab] = useState("projects"); // "projects" | "deliveries"
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [filter, setFilter] = useState("all"); // "all" | "active" | "onHold" | "archived"
  const [search, setSearch] = useState("");

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
        <Deliveries deliveries={deliveries} setDeliveries={setDeliveries} accounts={accounts}/>
      )}
    </>
  );
}
