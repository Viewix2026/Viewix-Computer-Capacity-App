import { useEffect, useRef, useState } from "react";
import { getCurrentUserName, getCurrentUserEmail } from "../firebase";

// Company Notes — note log for a single account, opened from the "Notes"
// button on each row of the Accounts (Clients) table.
//
// Storage: keyed children at /accounts/{id}/notes/{noteKey} — NOT a flat
// array. A single shared array meant two producers adding a note within
// the same listener window clobbered each other (last write wins). With
// keyed children each add is an independent child write, so concurrent
// adds coexist. The parent owns the actual write (writeNote → child-path
// fbUpdate); this component computes the next note and hands back
// (key, note) — or (key, null) to delete.
//
// Legacy shape: a note log first shipped as an array, so an account may
// still hold notes under numeric keys ("0","1"). noteEntries() normalises
// BOTH shapes to [key, note] pairs, and edit/delete address the *storage
// key* (which may be numeric) rather than note.id — deleting by note.id
// would miss a legacy numeric child.
//
// Author attribution uses the real SSO identity rather than a role label.
// Notes are editable and deletable (Jeremy's call); edits carry editedAt.
//
// Note shape: { id, author, authorEmail, text, createdAt, editedAt }

// Normalise /accounts/{id}/notes (array OR keyed object OR undefined) into
// an array of [storageKey, note] pairs, dropping holes.
export function noteEntries(notes) {
  if (Array.isArray(notes)) {
    return notes.map((n, i) => [String(i), n]).filter(([, n]) => n);
  }
  if (notes && typeof notes === "object") {
    return Object.entries(notes).filter(([, n]) => n);
  }
  return [];
}

export function noteCount(notes) {
  return noteEntries(notes).length;
}

function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// onWriteNote(key, noteOrNull): write a single note child (null deletes).
export function CompanyNotesModal({ account, onClose, onWriteNote }) {
  const entries = noteEntries(account?.notes);
  const [draft, setDraft] = useState("");
  const [editingKey, setEditingKey] = useState(null);
  const [editText, setEditText] = useState("");
  const addRef = useRef(null);

  // Newest first.
  const sorted = [...entries].sort(
    (a, b) => new Date(b[1].createdAt || 0) - new Date(a[1].createdAt || 0)
  );

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addNote = () => {
    const text = draft.trim();
    if (!text) return;
    const id = "note-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const note = {
      id,
      author: getCurrentUserName() || "Unknown",
      authorEmail: getCurrentUserEmail() || "",
      text,
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    // New notes key by their own id, so the storage key is globally unique.
    onWriteNote(id, note);
    setDraft("");
    addRef.current?.focus();
  };

  const startEdit = (key, note) => { setEditingKey(key); setEditText(note.text); };
  const cancelEdit = () => { setEditingKey(null); setEditText(""); };

  const saveEdit = (note) => {
    const text = editText.trim();
    if (!text) return;
    onWriteNote(editingKey, { ...note, text, editedAt: new Date().toISOString() });
    cancelEdit();
  };

  const deleteNote = (key) => {
    if (!window.confirm("Delete this note? This can't be undone.")) return;
    onWriteNote(key, null);
    if (editingKey === key) cancelEdit();
  };

  const inputSt = {
    width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 6,
    border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)",
    fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical",
  };
  const btnPrimary = {
    padding: "7px 14px", borderRadius: 6, border: "none", cursor: "pointer",
    background: "var(--accent)", color: "white", fontSize: 12, fontWeight: 700,
    fontFamily: "inherit",
  };
  const btnGhost = {
    padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)",
    cursor: "pointer", background: "transparent", color: "var(--muted)",
    fontSize: 11, fontWeight: 600, fontFamily: "inherit",
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", zIndex: 220,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 4vw",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
        width: "min(620px,100%)", maxHeight: "80vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>
              Company Notes
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              {account?.companyName || "Account"} · {entries.length} note{entries.length === 1 ? "" : "s"}
            </div>
          </div>
          <button onClick={onClose} style={{ ...btnGhost, border: "none", fontSize: 16, lineHeight: 1, padding: "2px 6px" }} title="Close">✕</button>
        </div>

        {/* Add note */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <textarea
            ref={addRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") addNote(); }}
            placeholder="Add a note about this client… (⌘/Ctrl+Enter to save)"
            rows={3}
            autoFocus
            style={inputSt}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={addNote} disabled={!draft.trim()} style={{ ...btnPrimary, opacity: draft.trim() ? 1 : 0.5, cursor: draft.trim() ? "pointer" : "default" }}>
              Add note
            </button>
          </div>
        </div>

        {/* Feed */}
        <div style={{ overflowY: "auto", padding: "12px 16px 16px", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
          {sorted.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: "28px 0" }}>
              No notes yet. Add the first one above.
            </div>
          ) : sorted.map(([key, note]) => (
            <div key={key} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  <span style={{ fontWeight: 700, color: "var(--fg)" }}>{note.author || "Unknown"}</span>
                  {" · "}{relTime(note.createdAt)}
                  {note.editedAt && <span style={{ fontStyle: "italic" }}> · edited</span>}
                </div>
                {editingKey !== key && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => startEdit(key, note)} style={btnGhost}>Edit</button>
                    <button onClick={() => deleteNote(key)} style={{ ...btnGhost, color: "#EF4444" }}>Delete</button>
                  </div>
                )}
              </div>
              {editingKey === key ? (
                <div>
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveEdit(note); if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); } }}
                    rows={3}
                    autoFocus
                    style={inputSt}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
                    <button onClick={cancelEdit} style={btnGhost}>Cancel</button>
                    <button onClick={() => saveEdit(note)} disabled={!editText.trim()} style={{ ...btnPrimary, opacity: editText.trim() ? 1 : 0.5 }}>Save</button>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{note.text}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
