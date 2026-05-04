// EditorDashboardViewix — the Viewix Dashboard sub-tab inside the
// Editors tab. Same UX shell as the Monday.com sub-tab (person picker
// → today's tasks with timers, future this week, overdue, daily 8h
// summary) but the data comes entirely from Firebase rather than the
// Monday API:
//
//   - Editors picker  → /editors (the Viewix team roster)
//   - Tasks per person → walk all /projects/{id}/subtasks where
//     assigneeIds includes the picked editor's id, classified by date
//   - Time tracking   → /timeLogs/{editorId}/{today}  (shared path
//     with the Monday view; subtask ids never collide with Monday item
//     ids so this just gives the producer a single daily total across
//     both surfaces)
//
// Mounted by EditorDashboard.jsx via its sub-tab toggle.

import { useState, useEffect, useRef, useMemo } from "react";
import confetti from "canvas-confetti";
import { fmtSecsShort, matchSherpaForName, EDITOR_DAILY_TARGET_HOURS, EDITOR_DAILY_TARGET_SECS } from "../utils";
import { fbSet, fbListen, fbUpdate, onFB } from "../firebase";

// ─── Date helpers (local, in browser timezone) ─────────────────────
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isoToday() { return toISO(new Date()); }
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// Stage palette mirrors the project subtask stage colours so producers
// see the same chip colour here that they pick in the Projects tab.
const STAGE_COLOURS = {
  preProduction: { bg: "rgba(139,92,246,0.18)", text: "#A78BFA", label: "Pre Production" },
  shoot:         { bg: "rgba(220,38,38,0.18)",  text: "#EF4444", label: "Shoot" },
  revisions:     { bg: "rgba(249,115,22,0.18)", text: "#FB923C", label: "Revisions" },
  edit:          { bg: "rgba(0,130,250,0.18)",  text: "#38BDF8", label: "Edit" },
  hold:          { bg: "rgba(234,179,8,0.18)",  text: "#FACC15", label: "Hold" },
};
const STATUS_COLOURS = {
  scheduled:     { bg: "rgba(59,130,246,0.16)",  text: "#3B82F6", label: "Scheduled" },
  inProgress:    { bg: "rgba(249,115,22,0.16)",  text: "#F97316", label: "In Progress" },
  waitingClient: { bg: "rgba(139,92,246,0.16)",  text: "#8B5CF6", label: "Waiting on Client" },
  onHold:        { bg: "rgba(234,179,8,0.16)",   text: "#EAB308", label: "On Hold" },
  stuck:         { bg: "rgba(236,72,153,0.16)",  text: "#EC4899", label: "Stuck" },
  done:          { bg: "rgba(16,185,129,0.16)",  text: "#10B981", label: "Done" },
};

// Read a subtask's assignees as an array, handling the legacy
// singular `assigneeId` field too.
function getAssigneeIds(st) {
  if (Array.isArray(st?.assigneeIds)) return st.assigneeIds.filter(Boolean);
  if (st?.assigneeId) return [st.assigneeId];
  return [];
}

// Walk every project's subtasks, find the ones assigned to this editor,
// flatten into a single list with parent metadata stamped on each row
// for the "Client: Project" sub-line.
// Build a `client.id → docUrl` map for hard-linked sherpas (set by the
// Attio webhook), plus carry the raw client list along so the fuzzy
// name matcher can be applied per-project for everything else. We
// memo the per-clientName resolution downstream so we don't re-walk
// the list on every task row of a busy editor's queue.
function buildSherpaIndex(clients) {
  const list = Array.isArray(clients) ? clients : Object.values(clients || {}).filter(Boolean);
  const byId = new Map();
  for (const c of list) {
    if (!c?.docUrl) continue;
    if (c.id) byId.set(c.id, c.docUrl);
  }
  return { byId, list, byName: new Map() };
}
function sherpaUrlForProject(p, sherpaIdx) {
  const sherpaId = p?.links?.sherpaId;
  if (sherpaId && sherpaIdx.byId.has(sherpaId)) return sherpaIdx.byId.get(sherpaId);
  const lcName = (p?.clientName || "").trim().toLowerCase();
  if (!lcName) return null;
  // Cheap per-build cache so the same clientName isn't re-fuzzy-matched
  // for every subtask in a project.
  if (sherpaIdx.byName.has(lcName)) return sherpaIdx.byName.get(lcName);
  const match = matchSherpaForName(p.clientName, sherpaIdx.list);
  const url = match?.docUrl || null;
  sherpaIdx.byName.set(lcName, url);
  return url;
}
function tasksForEditor(projects, editorId, sherpaIdx) {
  const out = [];
  if (!editorId || !Array.isArray(projects)) return out;
  for (const p of projects) {
    const subs = p?.subtasks ? Object.values(p.subtasks) : [];
    const sherpaUrl = sherpaUrlForProject(p, sherpaIdx);
    for (const st of subs) {
      if (!st || !st.id) continue;
      if (!getAssigneeIds(st).includes(editorId)) continue;
      out.push({
        id: st.id,
        name: st.name || "Untitled subtask",
        parentName: `${p.clientName || "—"}: ${p.projectName || "Untitled project"}`,
        projectId: p.id,
        startDate: st.startDate || null,
        endDate: st.endDate || st.startDate || null,
        startTime: st.startTime || null,
        endTime: st.endTime || null,
        stage: st.stage || "preProduction",
        status: st.status || "stuck",
        sherpaUrl,
        // Cross-system fields the Finish modal needs: videoId routes the
        // submit to the matching delivery video; frameioLink prefills any
        // link the editor pasted earlier so they don't lose work; the
        // delivery id lets us write the link + status without re-scanning.
        videoId: st.videoId || null,
        frameioLink: st.frameioLink || "",
        deliveryId: (p.links || {}).deliveryId || null,
      });
    }
  }
  return out;
}

// Categorise a flat task list relative to today.
function classifyTasks(tasks, today) {
  const todayTasks = [];
  const upcomingTasks = [];   // start within next 6 days, not today
  const overdueTasks = [];
  const upcomingCutoff = addDays(today, 7);

  for (const t of tasks) {
    if (!t.startDate) continue;
    const end = t.endDate || t.startDate;
    const onToday = t.startDate <= today && today <= end;
    if (onToday) {
      todayTasks.push(t);
      continue;
    }
    if (end < today && t.status !== "done") {
      overdueTasks.push(t);
      continue;
    }
    if (t.startDate > today && t.startDate < upcomingCutoff) {
      upcomingTasks.push(t);
    }
  }

  // Sort each list by startDate then name for stable display.
  const sortFn = (a, b) =>
    (a.startDate || "").localeCompare(b.startDate || "") ||
    (a.name || "").localeCompare(b.name || "");
  todayTasks.sort(sortFn);
  upcomingTasks.sort(sortFn);
  overdueTasks.sort(sortFn);
  return { todayTasks, upcomingTasks, overdueTasks };
}

// ─── Person picker ────────────────────────────────────────────────
function PersonPicker({ editors, onPick }) {
  if (!Array.isArray(editors) || editors.length === 0) {
    return (
      <div style={{ padding: "48px 28px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
        No team members in the roster yet. Add them in the Editors tab → Team Roster.
      </div>
    );
  }
  return (
    <div style={{ padding: "24px 28px", display: "flex", justifyContent: "center" }}>
      <div style={{ width: 460, maxWidth: "100%", padding: "40px 36px", background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)", textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Viewix Team Dashboard</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 26 }}>
          Select your name to see today's tasks
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {editors.map(ed => (
            <button key={ed.id} onClick={() => onPick(ed.id)}
              style={{
                padding: "13px 18px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--fg)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                textAlign: "left",
                display: "flex", alignItems: "center", gap: 12,
                transition: "all 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "rgba(0,130,250,0.06)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg)"; }}>
              <span style={{
                width: 36, height: 36, borderRadius: "50%",
                background: "var(--accent-soft)", color: "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 800,
              }}>
                {(ed.name || "?").split(" ").map(n => n[0]).join("").slice(0, 2)}
              </span>
              {ed.name || "(unnamed)"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Stage / status pill ──────────────────────────────────────────
function StagePill({ stage }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.preProduction;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 8px", borderRadius: 999,
      background: c.bg, color: c.text,
      fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4,
    }}>{c.label}</span>
  );
}
function StatusPill({ status }) {
  const c = STATUS_COLOURS[status] || STATUS_COLOURS.stuck;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 8px", borderRadius: 999,
      background: c.bg, color: c.text,
      fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4,
    }}>{c.label}</span>
  );
}

// ─── Finish-flow animations ────────────────────────────────────────
// Confetti for internal-review submit. Bursts from the top of the
// viewport so it actually "falls from the top" as Jeremy specified —
// canvas-confetti's default origin is mid-screen, so we override.
function fireConfetti() {
  confetti({
    particleCount: 220,
    spread: 100,
    startVelocity: 35,
    gravity: 1.0,
    origin: { y: -0.05 },
    ticks: 280,
  });
}
// Fireworks for client-review submit. Multiple bursts over ~3 seconds,
// alternating left and right halves of the viewport. Lifted from the
// canvas-confetti README's fireworks recipe.
function fireFireworks() {
  const duration = 3000;
  const end = Date.now() + duration;
  const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 1000 };
  const interval = setInterval(() => {
    const remain = end - Date.now();
    if (remain <= 0) { clearInterval(interval); return; }
    const particleCount = Math.max(20, 50 * (remain / duration));
    confetti({ ...defaults, particleCount, origin: { x: Math.random() * 0.4 + 0.05, y: Math.random() * 0.4 + 0.1 } });
    confetti({ ...defaults, particleCount, origin: { x: Math.random() * 0.4 + 0.55, y: Math.random() * 0.4 + 0.1 } });
  }, 250);
}
// Smaller, single burst for shoot-wrap finish — felt celebratory but
// not over-the-top for a non-deliverable task.
function fireSmallBurst() {
  confetti({ particleCount: 80, spread: 60, origin: { y: 0.7 }, startVelocity: 25, ticks: 180 });
}

// ─── Frame.io URL guard ────────────────────────────────────────────
// Editors paste links from a fixed set of review tools. Anything
// that's not a frame.io URL (or its short form f.io) is rejected
// at the gate — we don't want a Drive / Vimeo / Slack URL silently
// reaching the client view. Tolerant of trailing whitespace + missing
// protocol so a quick paste still validates.
function isFrameioLink(s) {
  const trimmed = String(s || "").trim();
  if (!trimmed) return false;
  return /(^|\.|\/\/)frame\.io(\/|$)/i.test(trimmed) || /(^|\.|\/\/)f\.io(\/|$)/i.test(trimmed);
}

// ─── Finish modal ──────────────────────────────────────────────────
// Two modes driven by task.stage:
//  - shoot: confirmation with optional notes (notes append to the
//    project's producerNotes field with editor name + date stamp).
//  - everything else (treated as edit): Frame.io link input + Watch
//    gate + radio between internal / client review. Submit propagates
//    appropriately.
function FinishModal({ task, editorName, projects, deliveries, onClose, onSubmitted }) {
  const isShoot = task.stage === "shoot";
  const [link, setLink] = useState(task.frameioLink || "");
  const [watched, setWatched] = useState(false);
  const [reviewType, setReviewType] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const linkValid = isFrameioLink(link);
  const canSubmit = isShoot
    ? !submitting
    : (linkValid && watched && reviewType && !submitting);

  // ESC closes — same affordance as the project quick-view modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const handleWatch = () => {
    if (!linkValid) return;
    // Normalise missing protocol so window.open doesn't open relative.
    const url = /^https?:\/\//i.test(link.trim()) ? link.trim() : `https://${link.trim()}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setWatched(true);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      if (isShoot) {
        await fbUpdate(`/projects/${task.projectId}/subtasks/${task.id}`, {
          status: "done",
          updatedAt: now,
        });
        const trimmedNotes = notes.trim();
        if (trimmedNotes) {
          // Append to the project's producerNotes with a date + editor
          // stamp so the producer can scan the bottom of the project
          // and see who said what after a shoot day.
          const project = (projects || []).find(p => p?.id === task.projectId);
          const existing = (project?.producerNotes || "").trimEnd();
          const today = now.slice(0, 10);
          const stamped = `[${today} · ${editorName || "Editor"} · shoot wrap]\n${trimmedNotes}`;
          const next = existing ? `${existing}\n\n${stamped}` : stamped;
          await fbSet(`/projects/${task.projectId}/producerNotes`, next);
        }
        fireSmallBurst();
      } else {
        const linkOut = link.trim();
        await fbUpdate(`/projects/${task.projectId}/subtasks/${task.id}`, {
          frameioLink: linkOut,
          status: "done",
          updatedAt: now,
        });
        if (reviewType === "client") {
          // Find the matching delivery video by canonical videoId so the
          // link + Ready-for-Review status land on both internal and
          // client views without name-matching. If we can't resolve it
          // (e.g. pre-migration record without a videoId), the subtask
          // still flips Done — propagation is best-effort.
          const delId = task.deliveryId;
          const delivery = delId ? (deliveries || []).find(d => d?.id === delId) : null;
          if (delivery && task.videoId && Array.isArray(delivery.videos)) {
            const idx = delivery.videos.findIndex(v => v && v.videoId === task.videoId);
            if (idx >= 0) {
              await fbUpdate(`/deliveries/${delId}/videos/${idx}`, {
                link: linkOut,
                viewixStatus: "Ready for Review",
              });
            }
          }
          fireFireworks();
        } else {
          fireConfetti();
        }
      }
      onSubmitted?.();
      onClose();
    } catch (e) {
      console.error("Finish submit failed:", e);
      setError(e?.message || String(e));
      setSubmitting(false);
    }
  };

  // Backdrop blocks page interaction; the inner card stops propagation
  // so clicks inside don't close.
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 520, maxWidth: "100%",
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 12, padding: "24px 26px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)", marginBottom: 6 }}>
          {isShoot ? "Wrap shoot" : "Finish edit"}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 18 }}>
          {task.parentName} · <span style={{ fontWeight: 600 }}>{task.name}</span>
        </div>

        {isShoot ? (
          <>
            <div style={{ fontSize: 12, color: "var(--fg)", marginBottom: 10 }}>
              Mark this shoot as complete?
            </div>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, display: "block", marginBottom: 6 }}>
              Notes (optional — appended to project notes)
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={4}
              placeholder="Anything the producer should know about today's shoot…"
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--input-bg)",
                color: "var(--fg)", fontSize: 13, fontFamily: "inherit",
                outline: "none", resize: "vertical", marginBottom: 16,
              }}/>
          </>
        ) : (
          <>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, display: "block", marginBottom: 6 }}>
              Frame.io review link
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                type="url"
                value={link}
                onChange={e => { setLink(e.target.value); setWatched(false); }}
                placeholder="https://app.frame.io/reviews/…"
                style={{
                  flex: 1, padding: "10px 12px", borderRadius: 8,
                  border: `1px solid ${link && !linkValid ? "#EF4444" : "var(--border)"}`,
                  background: "var(--input-bg)", color: "var(--fg)",
                  fontSize: 13, fontFamily: "inherit", outline: "none",
                }}/>
              <button
                onClick={handleWatch}
                disabled={!linkValid}
                title={linkValid ? "Open the review link to verify it before submitting" : "Paste a frame.io URL first"}
                style={{
                  padding: "8px 16px", borderRadius: 8, border: "none",
                  background: !linkValid ? "var(--bg)" : (watched ? "#10B981" : "#0082FA"),
                  color: !linkValid ? "var(--muted)" : "#fff",
                  fontSize: 12, fontWeight: 700,
                  cursor: linkValid ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  // Glow while the editor still needs to click — fades
                  // once they've watched. Keyframe-free to avoid a
                  // global CSS injection; pulses via inline animation.
                  boxShadow: (linkValid && !watched) ? "0 0 0 0 rgba(0,130,250,0.55)" : "none",
                  animation: (linkValid && !watched) ? "viewix-watch-pulse 1.4s ease-in-out infinite" : "none",
                  transition: "background 0.15s",
                }}>
                {watched ? "✓ Watched" : "Watch"}
              </button>
            </div>
            {link && !linkValid && (
              <div style={{ fontSize: 11, color: "#EF4444", marginTop: -10, marginBottom: 14 }}>
                That doesn't look like a Frame.io URL. Use a frame.io or f.io link.
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {[
                { key: "internal", label: "Ready for internal review", hint: "Producer reviews first. No client-side changes." },
                { key: "client",   label: "Ready for client review",   hint: "Link + status push to the delivery page (internal + client view)." },
              ].map(opt => {
                const active = reviewType === opt.key;
                return (
                  <label key={opt.key}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 10,
                      padding: "10px 12px", borderRadius: 8,
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      background: active ? "rgba(0,130,250,0.08)" : "var(--bg)",
                      cursor: "pointer",
                    }}>
                    <input
                      type="radio"
                      name="reviewType"
                      value={opt.key}
                      checked={active}
                      onChange={() => setReviewType(opt.key)}
                      style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}/>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>{opt.label}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{opt.hint}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {error && (
          <div style={{ fontSize: 11, color: "#EF4444", marginBottom: 12 }}>
            Couldn't submit: {error}. Try again.
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={submitting}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "1px solid var(--border)",
              background: "transparent", color: "var(--muted)",
              fontSize: 12, fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}>Cancel</button>
          <button onClick={handleSubmit} disabled={!canSubmit}
            style={{
              padding: "8px 18px", borderRadius: 8, border: "none",
              background: canSubmit ? "#10B981" : "var(--bg)",
              color: canSubmit ? "#fff" : "var(--muted)",
              fontSize: 12, fontWeight: 800, cursor: canSubmit ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}>{submitting ? "Submitting…" : "Submit"}</button>
        </div>
      </div>
      {/* Inline keyframes for the Watch button pulse. Kept local to
          this modal so it doesn't leak into the global stylesheet. */}
      <style>{`@keyframes viewix-watch-pulse{0%{box-shadow:0 0 0 0 rgba(0,130,250,0.55);}70%{box-shadow:0 0 0 10px rgba(0,130,250,0);}100%{box-shadow:0 0 0 0 rgba(0,130,250,0);}}`}</style>
    </div>
  );
}

// ─── Task row with timer ──────────────────────────────────────────
function TaskRow({
  task, isRunning, elapsedSecs, loggedSecs,
  onStart, onStop, onReset, onAdjust, onFinish, dim,
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "14px 16px",
      background: "var(--bg)",
      border: `1px solid ${isRunning ? "rgba(16,185,129,0.45)" : "var(--border)"}`,
      borderRadius: 10,
      boxShadow: isRunning ? "0 0 14px rgba(16,185,129,0.22)" : "none",
      opacity: dim ? 0.7 : 1,
      transition: "all 0.15s",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {task.parentName}
          </div>
          {/* Sherpa Doc link — appears next to the client/project line
              when this task's parent project has a sherpa URL on file
              (looked up in EditorDashboardViewix's sherpaIdx via
              project.links.sherpaId or clientName match). Click stops
              propagation so we don't accidentally open the project
              modal at the same time. */}
          {task.sherpaUrl && (
            <a href={task.sherpaUrl} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              title="Open the client's Sherpa doc in a new tab"
              style={{
                flexShrink: 0,
                padding: "1px 6px", borderRadius: 4,
                background: "var(--accent-soft)", color: "var(--accent)",
                fontSize: 10, fontWeight: 700, textDecoration: "none",
                display: "inline-flex", alignItems: "center", gap: 3,
                fontFamily: "inherit",
              }}>
              📄 Sherpa
            </a>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {task.name}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <StagePill stage={task.stage} />
          <StatusPill status={task.status} />
          {task.startDate && (
            <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>
              {task.startDate === task.endDate ? task.startDate : `${task.startDate} → ${task.endDate}`}
              {task.startTime && task.endTime ? ` · ${task.startTime}–${task.endTime}` : ""}
            </span>
          )}
        </div>
      </div>
      {!dim && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {isRunning ? (
            <>
              <div style={{
                fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace",
                color: "#10B981", minWidth: 78, textAlign: "right",
                textShadow: "0 0 10px rgba(16,185,129,0.4)",
              }}>{fmtSecsShort(loggedSecs + elapsedSecs)}</div>
              <button onClick={() => onStop(task.id)}
                style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#EF4444", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Stop
              </button>
            </>
          ) : (
            <>
              <div style={{
                fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
                color: loggedSecs > 0 ? "var(--fg)" : "var(--muted)",
                minWidth: 60, textAlign: "right",
              }}>{loggedSecs > 0 ? fmtSecsShort(loggedSecs) : "—"}</div>
              <button onClick={() => onStart(task.id)}
                style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#10B981", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Start
              </button>
            </>
          )}
          <button onClick={() => onAdjust(task.id)}
            title="Add or subtract logged time"
            style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            ± Time
          </button>
          {/* Finish button — greyed out until the editor has logged any
              time on this task (loggedSecs > 0). Click opens the Finish
              modal: a confirmation for shoots, or a Frame.io review-link
              flow for everything else. The Watch-button-then-Submit gate
              and the animations live inside the modal. */}
          {(() => {
            const allowed = (loggedSecs || 0) > 0 || isRunning;
            return (
              <button
                onClick={() => allowed && onFinish && onFinish(task.id)}
                disabled={!allowed}
                title={allowed ? "Finish this task" : "Start the timer first — Finish unlocks once you've logged time."}
                style={{
                  padding: "7px 14px", borderRadius: 8, border: "none",
                  background: allowed ? "#10B981" : "var(--bg)",
                  color: allowed ? "#fff" : "var(--muted)",
                  fontSize: 12, fontWeight: 800,
                  cursor: allowed ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  border: allowed ? "none" : "1px solid var(--border)",
                  transition: "background 0.15s, color 0.15s",
                }}>
                Finish
              </button>
            );
          })()}
          {loggedSecs > 0 && (
            <button onClick={() => onReset(task.id)}
              title="Reset logged time for this task"
              style={{ padding: "7px 8px", borderRadius: 8, border: "none", background: "transparent", color: "var(--muted)", fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              ↺
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────
export function EditorDashboardViewix({ projects = [], editors = [], clients = [], deliveries = [] }) {
  const [editorId, setEditorId] = useState(null);
  const [timers, setTimers] = useState({});
  const [timeLogs, setTimeLogs] = useState({});
  // History across all days for stats computation (avg hrs / Edit
  // task etc). Keyed by date → { taskId → { secs, stage, ... } }.
  // Separate from `timeLogs` (today only) so the live-tick UX
  // doesn't get clobbered by every history-listener pulse.
  const [allDaysLogs, setAllDaysLogs] = useState({});
  const [adjustingTask, setAdjustingTask] = useState(null);
  const [adjustMins, setAdjustMins] = useState("");
  const [timerWarning, setTimerWarning] = useState(null);
  // Finish modal — id of the task currently being wrapped. Null = closed.
  const [finishingTaskId, setFinishingTaskId] = useState(null);
  const intervalRef = useRef(null);
  const justStoppedRef = useRef({});
  const today = isoToday();

  // All tasks for this editor, classified.
  const sherpaIdx = useMemo(() => buildSherpaIndex(clients), [clients]);
  const allTasks = useMemo(() => tasksForEditor(projects, editorId, sherpaIdx), [projects, editorId, sherpaIdx]);
  const { todayTasks, upcomingTasks, overdueTasks } = useMemo(
    () => classifyTasks(allTasks, today),
    [allTasks, today]
  );

  // Listen to Firebase /timeLogs for this editor + day. Mirrors the
  // Monday view's listener so timers resume after page reload and the
  // daily total is consistent across surfaces.
  useEffect(() => {
    if (!editorId) return;
    const path = `/timeLogs/${editorId}/${today}`;
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen(path, (data) => {
        if (data) {
          const { _running, ...logs } = data;
          setTimeLogs(logs);
          if (_running && _running.taskId && _running.startedAt) {
            const stoppedAt = justStoppedRef.current[_running.taskId];
            if (stoppedAt && (Date.now() - stoppedAt) < 3000) return;
            setTimers(prev => {
              if (prev[_running.taskId]?.running) return prev;
              return {
                ...prev,
                [_running.taskId]: {
                  running: true,
                  elapsed: Math.floor((Date.now() - _running.startedAt) / 1000),
                  startedAt: _running.startedAt,
                },
              };
            });
          }
        } else {
          setTimeLogs({});
        }
      });
    });
    return () => { cancelled = true; unsub(); };
  }, [editorId, today]);

  // History listener — pulls every day's logs for this editor so the
  // stats grid can compute trailing averages. Cheap: one editor's
  // /timeLogs node is small (one entry per task per day) so a full
  // listener is fine even at 6 months of data.
  useEffect(() => {
    if (!editorId) return;
    const path = `/timeLogs/${editorId}`;
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen(path, (data) => {
        setAllDaysLogs(data || {});
      });
    });
    return () => { cancelled = true; unsub(); };
  }, [editorId]);

  // Avg hours per Edit-stage task. Aggregates `secs` per taskId
  // across every logged day, filtering to entries marked `stage:
  // "edit"`. Returns { avgHours, taskCount } so the tile can show
  // both the headline and the sample size in its sub-line.
  const editStats = useMemo(() => {
    const perTask = new Map();
    for (const day of Object.values(allDaysLogs || {})) {
      if (!day || typeof day !== "object") continue;
      for (const [taskId, entry] of Object.entries(day)) {
        if (taskId === "_running") continue;
        if (!entry) continue;
        const stage = typeof entry === "object" ? entry.stage : null;
        if (stage !== "edit") continue;
        const secs = typeof entry === "number" ? entry : (entry.secs || 0);
        perTask.set(taskId, (perTask.get(taskId) || 0) + secs);
      }
    }
    const tasks = [...perTask.values()].filter(s => s > 0);
    if (tasks.length === 0) return { avgHours: null, taskCount: 0 };
    const totalSecs = tasks.reduce((a, b) => a + b, 0);
    return { avgHours: totalSecs / 3600 / tasks.length, taskCount: tasks.length };
  }, [allDaysLogs]);

  // Tick the running timer's elapsed value once per second.
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setTimers(prev => {
        const next = { ...prev };
        let changed = false;
        for (const tid of Object.keys(next)) {
          if (next[tid]?.running) {
            const elapsed = Math.floor((Date.now() - next[tid].startedAt) / 1000);
            if (elapsed !== next[tid].elapsed) {
              next[tid] = { ...next[tid], elapsed };
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const getRunningTaskId = () => {
    for (const tid of Object.keys(timers)) {
      if (timers[tid]?.running) return tid;
    }
    return null;
  };

  const findTask = (taskId) => allTasks.find(t => t.id === taskId);

  const doStart = (taskId) => {
    const now = Date.now();
    setTimers(prev => ({ ...prev, [taskId]: { running: true, elapsed: 0, startedAt: now } }));
    fbSet(`/timeLogs/${editorId}/${today}/_running`, { taskId, startedAt: now });
  };

  const startTimer = (taskId) => {
    const runningId = getRunningTaskId();
    if (runningId && runningId !== taskId) {
      const runningTask = findTask(runningId);
      setTimerWarning({ pendingTaskId: taskId, runningTaskId: runningId, runningTaskName: runningTask?.name || "another task" });
      return;
    }
    doStart(taskId);
  };

  const stopTimer = (taskId) => {
    const t = timers[taskId];
    if (!t || !t.running) return;
    justStoppedRef.current[taskId] = Date.now();
    const elapsed = Math.floor((Date.now() - t.startedAt) / 1000);
    setTimers(prev => ({ ...prev, [taskId]: { running: false, elapsed: 0, startedAt: null } }));
    fbSet(`/timeLogs/${editorId}/${today}/_running`, null);
    const prevLog = timeLogs[taskId] || {};
    const prevSecs = typeof prevLog === "number" ? prevLog : (prevLog.secs || 0);
    const newTotal = prevSecs + elapsed;
    const task = findTask(taskId);
    const logData = {
      secs: newTotal,
      name: task?.name || "",
      parentName: task?.parentName || "",
      stage: task?.stage || "",
      // Marker so future reporting can split Viewix vs Monday entries.
      source: "viewix",
    };
    fbSet(`/timeLogs/${editorId}/${today}/${taskId}`, logData);
    setTimeLogs(p => ({ ...p, [taskId]: logData }));
  };

  const confirmTimerSwitch = () => {
    if (!timerWarning) return;
    stopTimer(timerWarning.runningTaskId);
    doStart(timerWarning.pendingTaskId);
    setTimerWarning(null);
  };

  const resetTimer = (taskId) => {
    fbSet(`/timeLogs/${editorId}/${today}/${taskId}`, null);
    fbSet(`/timeLogs/${editorId}/${today}/_running`, null);
    setTimeLogs(p => { const n = { ...p }; delete n[taskId]; return n; });
    setTimers(prev => ({ ...prev, [taskId]: { running: false, elapsed: 0, startedAt: null } }));
  };

  const adjustTime = (taskId, minutes) => {
    const secs = Math.round(minutes * 60);
    const prevLog = timeLogs[taskId] || {};
    const prevSecs = typeof prevLog === "number" ? prevLog : (prevLog.secs || 0);
    const newTotal = Math.max(0, prevSecs + secs);
    const task = findTask(taskId);
    const logData = {
      secs: newTotal,
      name: task?.name || "",
      parentName: task?.parentName || "",
      stage: task?.stage || "",
      source: "viewix",
    };
    fbSet(`/timeLogs/${editorId}/${today}/${taskId}`, logData);
    setTimeLogs(p => ({ ...p, [taskId]: logData }));
    setAdjustingTask(null);
    setAdjustMins("");
  };

  const isRunning = (taskId) => !!timers[taskId]?.running;
  const elapsedFor = (taskId) => timers[taskId]?.elapsed || 0;
  const loggedFor = (taskId) => {
    const v = timeLogs[taskId];
    if (!v) return 0;
    return typeof v === "number" ? v : (v.secs || 0);
  };
  const totalToday = Object.values(timeLogs).reduce((a, v) => {
    const s = typeof v === "number" ? v : (v?.secs || 0);
    return a + s;
  }, 0);

  // ─── No editor picked yet ──────────────────────────────────────
  if (!editorId) return <PersonPicker editors={editors} onPick={setEditorId} />;

  const editor = editors.find(e => e.id === editorId);
  const editorName = editor?.name || "(unknown)";

  // ─── Picked editor view ─────────────────────────────────────────
  return (
    <div style={{ background: "transparent", color: "var(--fg)" }}>
      {/* Header */}
      <div style={{
        padding: "16px 28px", borderBottom: "1px solid var(--border)",
        background: "var(--card)",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>Viewix Dashboard</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{editorName} · {today}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {/* Stats grid — Today's progress + Avg per Edit task. Each
              tile is its own glow-ringed card so the row reads as a
              dashboard, not a chrome strip. Wraps on narrow screens. */}
          <div style={{
            display: "flex", gap: 10, flexWrap: "wrap",
          }}>
            {/* Today's hours */}
            <div style={{
              padding: "10px 14px", borderRadius: 10,
              background: "var(--bg)",
              border: `1px solid ${totalToday > 0 ? "rgba(16,185,129,0.4)" : "var(--border)"}`,
              boxShadow: totalToday > 0 ? "0 0 14px rgba(16,185,129,0.18)" : "none",
              minWidth: 200,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>Today</span>
                <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: totalToday > 0 ? "#10B981" : "var(--fg)", textShadow: totalToday > 0 ? "0 0 8px rgba(16,185,129,0.4)" : "none" }}>
                  {fmtSecsShort(totalToday)} / {EDITOR_DAILY_TARGET_HOURS}h
                </span>
              </div>
              <div style={{ width: "100%", height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden", border: "1px solid var(--border)" }}>
                <div style={{
                  width: `${Math.min((totalToday / EDITOR_DAILY_TARGET_SECS) * 100, 100)}%`, height: "100%",
                  background: totalToday >= EDITOR_DAILY_TARGET_SECS ? "#F59E0B" : "#10B981",
                  borderRadius: 3, transition: "width 0.3s",
                  boxShadow: totalToday > 0 ? "0 0 8px rgba(16,185,129,0.55)" : "none",
                }}/>
              </div>
            </div>

            {/* Avg hrs per Edit task — needs at least one logged
                edit-stage task to light up. Empty state shows "—"
                with an explanatory sub-line so the tile doesn't read
                as broken before any data has accumulated. */}
            <div style={{
              padding: "10px 14px", borderRadius: 10,
              background: "var(--bg)",
              border: `1px solid ${editStats.taskCount > 0 ? "rgba(0,130,250,0.4)" : "var(--border)"}`,
              boxShadow: editStats.taskCount > 0 ? "0 0 14px rgba(0,130,250,0.2)" : "none",
              minWidth: 200,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>Avg / Edit task</span>
                <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: editStats.taskCount > 0 ? "#0082FA" : "var(--muted)", textShadow: editStats.taskCount > 0 ? "0 0 8px rgba(0,130,250,0.4)" : "none" }}>
                  {editStats.avgHours == null
                    ? "—"
                    : `${editStats.avgHours.toFixed(editStats.avgHours >= 10 ? 0 : 1)}h`}
                </span>
              </div>
              <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", letterSpacing: 0.3 }}>
                {editStats.taskCount === 0
                  ? "no tasks yet"
                  : `across ${editStats.taskCount} task${editStats.taskCount === 1 ? "" : "s"}`}
              </div>
            </div>
          </div>

          <button onClick={() => setEditorId(null)}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            Switch editor
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "24px 28px 60px" }}>
        {/* Today */}
        <Section title="Today" count={todayTasks.length} colour="#10B981">
          {todayTasks.length === 0 ? (
            <Empty text="Nothing scheduled today. Reach out to your Production Manager." />
          ) : todayTasks.map(t => (
            <TaskRow key={t.id} task={t}
              isRunning={isRunning(t.id)}
              elapsedSecs={elapsedFor(t.id)}
              loggedSecs={loggedFor(t.id)}
              onStart={startTimer}
              onStop={stopTimer}
              onReset={resetTimer}
              onAdjust={(taskId) => { setAdjustingTask(taskId); setAdjustMins(""); }}
              onFinish={(taskId) => setFinishingTaskId(taskId)}
            />
          ))}
        </Section>

        {/* Upcoming this week */}
        {upcomingTasks.length > 0 && (
          <Section title="Coming up this week" count={upcomingTasks.length} colour="#0082FA">
            {upcomingTasks.map(t => (
              <TaskRow key={t.id} task={t}
                isRunning={false} elapsedSecs={0} loggedSecs={0}
                onStart={() => {}} onStop={() => {}} onReset={() => {}} onAdjust={() => {}}
                dim
              />
            ))}
          </Section>
        )}

        {/* Overdue */}
        {overdueTasks.length > 0 && (
          <Section title="Overdue" count={overdueTasks.length} colour="#EF4444">
            {overdueTasks.map(t => (
              <TaskRow key={t.id} task={t}
                isRunning={false} elapsedSecs={0} loggedSecs={loggedFor(t.id)}
                onStart={startTimer} onStop={stopTimer}
                onReset={resetTimer}
                onAdjust={(taskId) => { setAdjustingTask(taskId); setAdjustMins(""); }}
                onFinish={(taskId) => setFinishingTaskId(taskId)}
              />
            ))}
          </Section>
        )}

        {/* Daily summary */}
        {totalToday > 0 && (
          <Section title="Today's totals" count={null} colour="#10B981">
            <div style={{
              padding: "16px 18px",
              background: "var(--card)",
              border: "1px solid rgba(16,185,129,0.35)",
              borderRadius: 10,
              boxShadow: "0 0 14px rgba(16,185,129,0.18)",
            }}>
              {Object.entries(timeLogs).map(([taskId, log]) => {
                const secs = typeof log === "number" ? log : (log?.secs || 0);
                if (secs <= 0) return null;
                const name = (typeof log === "object" && log?.name) || taskId;
                const parent = (typeof log === "object" && log?.parentName) || "";
                return (
                  <div key={taskId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                      <div style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parent}</div>
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 800, fontSize: 13, color: "var(--fg)", marginLeft: 12 }}>
                      {fmtSecsShort(secs)}
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Total</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 800, fontSize: 14, color: "#10B981", textShadow: "0 0 8px rgba(16,185,129,0.45)" }}>{fmtSecsShort(totalToday)}</span>
              </div>
            </div>
          </Section>
        )}
      </div>

      {/* Switch-timer warning modal */}
      {timerWarning && (
        <Modal onClose={() => setTimerWarning(null)}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>
            Already running another task
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
            "{timerWarning.runningTaskName}" is currently being timed. Stop it and start the new one?
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setTimerWarning(null)} style={modalBtn("ghost")}>Cancel</button>
            <button onClick={confirmTimerSwitch} style={modalBtn("primary")}>Switch</button>
          </div>
        </Modal>
      )}

      {/* Finish modal — confirmation for shoot tasks, Frame.io review
          flow for everything else. Resolved against the latest task list
          on render so a Firebase update during the modal's open window
          doesn't leave it pinned to a stale row. */}
      {finishingTaskId && (() => {
        const ft = allTasks.find(x => x.id === finishingTaskId);
        if (!ft) return null;
        const editor = editors.find(e => e.id === editorId);
        return (
          <FinishModal
            task={ft}
            editorName={editor?.name || ""}
            projects={projects}
            deliveries={deliveries}
            onClose={() => setFinishingTaskId(null)}
          />
        );
      })()}

      {/* Adjust-time modal */}
      {adjustingTask && (
        <Modal onClose={() => setAdjustingTask(null)}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>
            Adjust time
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Enter minutes to add (positive) or remove (negative). E.g. <code>30</code> or <code>-15</code>.
          </div>
          <input
            type="number" autoFocus
            value={adjustMins}
            onChange={e => setAdjustMins(e.target.value)}
            placeholder="Minutes"
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: "1px solid var(--border)", background: "var(--input-bg)",
              color: "var(--fg)", fontSize: 14, fontFamily: "inherit", outline: "none",
              marginBottom: 12,
            }}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const m = parseFloat(adjustMins);
                if (!isNaN(m)) adjustTime(adjustingTask, m);
              } else if (e.key === "Escape") {
                setAdjustingTask(null);
              }
            }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setAdjustingTask(null)} style={modalBtn("ghost")}>Cancel</button>
            <button onClick={() => {
              const m = parseFloat(adjustMins);
              if (!isNaN(m)) adjustTime(adjustingTask, m);
            }} style={modalBtn("primary")}>Apply</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Small section wrapper ─────────────────────────────────────────
function Section({ title, count, colour, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%",
          background: colour,
          boxShadow: `0 0 8px ${colour}, 0 0 14px ${colour}55`,
        }}/>
        <div style={{ fontSize: 12, fontWeight: 800, color: "var(--fg)", textTransform: "uppercase", letterSpacing: 0.6 }}>
          {title}
        </div>
        {count != null && (
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>
            {count}
          </div>
        )}
      </div>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </div>
  );
}
function Empty({ text }) {
  return (
    <div style={{ padding: "20px 16px", background: "var(--bg)", border: "1px dashed var(--border)", borderRadius: 10, color: "var(--muted)", fontSize: 13, textAlign: "center" }}>
      {text}
    </div>
  );
}

// ─── Tiny modal helper ────────────────────────────────────────────
function Modal({ children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)", zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: 380, maxWidth: "100%",
          padding: "20px 22px",
          background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}>
        {children}
      </div>
    </div>
  );
}
function modalBtn(kind) {
  if (kind === "primary") return { padding: "8px 14px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
  return { padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
}
