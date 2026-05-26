import { useEffect } from "react";

// Phase 2 (#3) picker — shown when the Selects-timeline auto-sync can't
// place the task on the Project Lead (lead off or has another shoot that
// day). Lets the scheduler pick the best-suited person; the choice flows
// back to the caller as overrideAssigneeId. Shared by the Projects detail
// view AND the Team Board so both shoot-scheduling paths behave the same.
export function SelectsPickerModal({ selectsDate, candidates, editors, onPick, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const editorById = new Map((editors || []).map(e => [e.id, e]));
  const list = (candidates || []).map(id => editorById.get(id)).filter(Boolean);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", zIndex: 200,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "10vh 4vw",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
        width: "min(420px,100%)", maxHeight: "75vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>Assign Selects Timeline</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            The project lead is unavailable on {selectsDate || "the selected day"}. Pick who should do the Selects timeline (~half a day, top priority that day).
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "10px 14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          {list.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic", padding: "8px 6px" }}>
              No editors are free that day — pick later, or move the shoot.
            </div>
          ) : list.map(ed => (
            <button key={ed.id} type="button" onClick={() => onPick(ed.id)}
              style={{
                textAlign: "left", padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)",
                fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
              {ed.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
