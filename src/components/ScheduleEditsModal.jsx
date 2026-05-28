import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../firebase";

// Phase 6 — Team Board scheduler modal. Wraps the existing planner
// (api/scheduling-plan-propose + api/scheduling-plan-apply) in a
// propose-then-approve UX: producer picks which editors are in scope,
// hits Generate, sees the proposed video → editor → day → format table,
// then Confirms. Nothing writes to Firebase until Confirm — the proposal
// is stored at /scheduling/proposedPlans/{shortId} with a 1h TTL.
//
// Format-grouping bias (Phase 6 backend, PR #216) is on by default in
// planEdits, so videos sharing a creativeFormat tend to land on the same
// editor automatically. The producer can still untick or reassign in
// the preview before Confirm.

export function ScheduleEditsModal({ project, editors, onClose, onApplied }) {
  // Editor multi-select — default all editors ticked (the brief).
  const editorList = useMemo(() =>
    (editors || []).filter(e => e?.id && e.role === "editor"),
  [editors]);
  const [picked, setPicked] = useState(() => new Set(editorList.map(e => e.id)));
  const [phase, setPhase] = useState("input"); // "input" | "loading" | "preview" | "applying" | "done"
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState(null);
  // Producer can untick individual rows in the preview to skip them.
  const [excludedRowIds, setExcludedRowIds] = useState(new Set());

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && phase !== "applying") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  const togglePick = (id) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const generate = async () => {
    setError("");
    setPhase("loading");
    try {
      const r = await authFetch("/api/scheduling-plan-propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          requestedEditorIds: Array.from(picked),
          // Falls back to project.dueDate server-side if blank.
          deadline: project.dueDate || null,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setProposal(data);
      setExcludedRowIds(new Set());
      setPhase("preview");
    } catch (e) {
      setError(e?.message || String(e));
      setPhase("input");
    }
  };

  const confirm = async () => {
    if (!proposal?.shortId) return;
    setError("");
    setPhase("applying");
    try {
      // If the producer unticked any rows we'd need a different apply
      // shape (the current /api/scheduling-plan-apply takes only the
      // shortId and applies the whole proposal). For v1, refuse to
      // partially-apply: the producer either confirms the whole plan,
      // cancels, or re-generates with a different editor selection.
      if (excludedRowIds.size > 0) {
        throw new Error("Partial apply isn't supported in v1 — untick editors and re-generate, or apply all rows.");
      }
      const r = await authFetch("/api/scheduling-plan-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId: proposal.shortId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.status !== "applied") {
        const reason = d?.reason || d?.error || `HTTP ${r.status}`;
        throw new Error(reason);
      }
      setPhase("done");
      onApplied?.(d);
      // Slight delay before close so the user sees the success.
      setTimeout(() => onClose(), 700);
    } catch (e) {
      setError(e?.message || String(e));
      setPhase("preview");
    }
  };

  return (
    <div onClick={() => phase !== "applying" && onClose()} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", zIndex: 220,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 4vw",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
        width: "min(820px,100%)", maxHeight: "80vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>
            Schedule edits — {project?.clientName ? `${project.clientName}: ` : ""}{project?.projectName || "Project"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {phase === "input"
              ? "Pick which editors are in scope. Same-format videos stick with one editor automatically."
              : phase === "preview"
              ? `Preview — ${proposal?.proposedSubtasks?.length || 0} edit rows. Nothing's written until you confirm.`
              : phase === "applying" ? "Writing subtasks…"
              : phase === "done" ? "Done."
              : "Generating plan…"}
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: "12px 16px 14px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
          {phase === "input" && (
            <>
              <div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Editors in scope</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
                  {editorList.map(ed => {
                    const on = picked.has(ed.id);
                    return (
                      <label key={ed.id} style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 10px", borderRadius: 8,
                        border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                        background: on ? "rgba(96,165,250,0.08)" : "var(--bg)",
                        cursor: "pointer", fontSize: 12, fontWeight: 600,
                      }}>
                        <input type="checkbox" checked={on} onChange={() => togglePick(ed.id)} />
                        <span>{ed.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                Deadline: <b>{project?.dueDate || "(uses project default)"}</b>. The plan window is 6 weeks from today or the deadline, whichever comes first.
              </div>
            </>
          )}

          {phase === "preview" && proposal && (
            <PreviewTable proposal={proposal} editors={editorList}
              excludedRowIds={excludedRowIds} setExcludedRowIds={setExcludedRowIds} />
          )}

          {(phase === "loading" || phase === "applying") && (
            <div style={{ padding: "30px 12px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
              {phase === "loading" ? "Generating plan…" : "Applying writes…"}
            </div>
          )}

          {phase === "done" && (
            <div style={{ padding: "30px 12px", textAlign: "center", color: "#10B981", fontSize: 14, fontWeight: 700 }}>
              ✓ Edits scheduled.
            </div>
          )}

          {error && (
            <div style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.40)", color: "#EF4444", fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {phase === "input" && (
            <>
              <button onClick={onClose} style={btnGhost}>Cancel</button>
              <button onClick={generate} disabled={picked.size === 0} style={{ ...btnPrimary, opacity: picked.size === 0 ? 0.5 : 1 }}>
                Generate plan
              </button>
            </>
          )}
          {phase === "preview" && (
            <>
              <button onClick={() => { setPhase("input"); setProposal(null); }} style={btnGhost}>Back</button>
              <button onClick={confirm} disabled={!(proposal?.proposedSubtasks?.length)} style={{ ...btnPrimary, opacity: (proposal?.proposedSubtasks?.length) ? 1 : 0.5 }}>
                Confirm + apply
              </button>
            </>
          )}
          {(phase === "loading" || phase === "applying") && (
            <button onClick={onClose} disabled={phase === "applying"} style={{ ...btnGhost, opacity: phase === "applying" ? 0.5 : 1 }}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewTable({ proposal, editors, excludedRowIds, setExcludedRowIds }) {
  const editorName = (id) => (editors.find(e => e.id === id)?.name) || id;
  const rows = (proposal?.proposedSubtasks || []).filter(r => r.stage === "edit");
  const hardCount = (proposal?.hardViolations || []).length;
  const warnCount = (proposal?.warnings || []).length;
  return (
    <div>
      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
        <span>Plan window: <b>{proposal.planWindow?.start}</b> → <b>{proposal.planWindow?.end}</b></span>
        {hardCount > 0 && <span style={{ color: "#EF4444", fontWeight: 700 }}>⚠ {hardCount} hard violation{hardCount === 1 ? "" : "s"}</span>}
        {warnCount > 0 && <span style={{ color: "#F59E0B" }}>⚠ {warnCount} warning{warnCount === 1 ? "" : "s"}</span>}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>Apply</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>Video</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>Format</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>Editor</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>Date</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>Mode</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={6} style={{ padding: "16px 8px", color: "var(--muted)", fontStyle: "italic" }}>No edit rows proposed — every video already has a scheduled edit, or the planner found no feasible day.</td></tr>
          )}
          {rows.map(r => {
            const rowKey = r.id;
            const skip = excludedRowIds.has(rowKey);
            return (
              <tr key={rowKey} style={{ opacity: skip ? 0.35 : 1, borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 8px" }}>
                  <input type="checkbox" checked={!skip} onChange={() => {
                    setExcludedRowIds(prev => {
                      const n = new Set(prev);
                      if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey);
                      return n;
                    });
                  }} />
                </td>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>Video {r.videoIndex}</td>
                <td style={{ padding: "6px 8px", color: r.creativeFormat ? "var(--fg)" : "var(--muted)" }}>{r.creativeFormat || "—"}</td>
                <td style={{ padding: "6px 8px" }}>{editorName(r.assigneeId)}</td>
                <td style={{ padding: "6px 8px", fontFamily: "ui-monospace, monospace" }}>{r.startDate}</td>
                <td style={{ padding: "6px 8px", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>{r.mode}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const btnGhost = {
  fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 8,
  border: "1px solid var(--border)", background: "transparent", color: "var(--fg)", cursor: "pointer",
};
const btnPrimary = {
  fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 8,
  border: "1px solid #2563EB", background: "#2563EB", color: "white", cursor: "pointer",
};
