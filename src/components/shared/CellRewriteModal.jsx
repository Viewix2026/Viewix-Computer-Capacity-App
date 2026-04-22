// Per-cell rewrite modal + Clickable cell + EditableField wrapper.
// Extracted from SocialOrganicResearch.jsx (Phase 5 ScriptBuilderStep) so
// the same UX works for any field in any preproduction doc:
//   - Click a cell → two-mode modal opens (AI rewrite / manual edit)
//   - AI rewrite calls a back-end action with a freeform instruction
//   - Manual edit writes straight to Firebase
//
// Callers pass:
//   - apiAction          — the dispatcher string the backend recognises
//                          (e.g. "rewriteScriptSection", "rewriteBrandTruthField")
//   - fbPathPrefix       — Firebase path up to the field root
//                          (e.g. "/preproduction/socialOrganic/{id}/preproductionDoc")
//   - apiEndpoint        — default "/api/social-organic"
//   - extraPayload       — merged into the POST body (projectId, etc.)
//   - updatedAtPath      — written with a new ISO timestamp on manual save
//                          (optional; omit to skip)
//
// Consumers: BrandTruthStep (Tab 1), ScriptStep (Tab 7).

import { useState } from "react";
import { fbSet, fbSetAsync } from "../../firebase";

const inputSt = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "inherit", width: "100%", boxSizing: "border-box",
};
const btnPrimary = {
  padding: "8px 18px", borderRadius: 8, border: "none", background: "var(--accent)",
  color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary = {
  padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)",
  background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600,
  cursor: "pointer", fontFamily: "inherit",
};

// A "cell" that looks like static text until hovered — click opens the rewrite modal.
// `feedback` is an optional client-feedback object (has a `text` field) —
// when present, the cell renders with an amber dot + tooltip so producers
// notice unresolved comments.
export function Clickable({ value, onClick, multi, feedback }) {
  const [hover, setHover] = useState(false);
  const empty = !value || !value.toString().trim();
  const str = value == null ? "" : String(value);
  // Multi-line values render as bullet points. We strip any leading
  // bullet glyphs the source may already contain so the list is visually
  // consistent regardless of whether Claude returned dashes, asterisks,
  // or bullets.
  const bulletLines = multi && !empty
    ? str.split(/\r?\n/).map(l => l.replace(/^\s*[•\-\*\u2022]\s*/, "").trim()).filter(Boolean)
    : null;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={feedback?.text ? `Client feedback: ${feedback.text}` : ""}
      style={{
        padding: "6px 8px", borderRadius: 4,
        background: hover ? "var(--bg)" : "transparent",
        outline: hover ? "1px solid var(--accent)" : "1px solid transparent",
        cursor: "pointer",
        fontSize: 12, color: empty ? "var(--muted)" : "var(--fg)",
        lineHeight: 1.55,
        whiteSpace: (multi && !bulletLines) ? "pre-wrap" : "normal",
        minHeight: 20,
        fontStyle: empty ? "italic" : "normal",
        transition: "outline 0.1s, background 0.1s",
        position: "relative",
      }}>
      {feedback?.text && (
        <span style={{ position: "absolute", top: 4, right: 4, width: 8, height: 8, borderRadius: "50%", background: "#F59E0B" }} />
      )}
      {empty ? "(empty — click to fill)"
       : bulletLines && bulletLines.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc" }}>
            {bulletLines.map((line, i) => (
              <li key={i} style={{ marginBottom: 3 }}>{line}</li>
            ))}
          </ul>
        )
       : str}
    </div>
  );
}

// Labelled wrapper around <Clickable>. Used for doc-style layouts.
// `feedback` — optional client-feedback object ({ text, submittedAt }) —
// lights up the cell with the amber dot + tooltip, so producers can see
// which fields the client has asked to change.
export function EditableField({ label, path, value, onEdit, multi, feedback }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
        {label}
      </div>
      <Clickable value={value} onClick={() => onEdit(path, label, value)} multi={multi} feedback={feedback} />
    </div>
  );
}

export function CellRewriteModal({
  target,                             // { path, label, currentValue }
  apiAction,                          // dispatcher string
  fbPathPrefix,                       // e.g. `/preproduction/socialOrganic/${id}/brandTruth/fields`
  apiEndpoint = "/api/social-organic",
  extraPayload = {},
  updatedAtPath = null,
  onClose,
}) {
  const [mode, setMode] = useState("ai");  // "ai" | "manual"
  const [instruction, setInstruction] = useState("");
  const [manualValue, setManualValue] = useState(
    Array.isArray(target.currentValue) ? target.currentValue.join("\n") : (target.currentValue || "")
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const aiSubmit = async () => {
    if (!instruction.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: apiAction,
          path: target.path,
          instruction,
          currentValue: Array.isArray(target.currentValue) ? target.currentValue.join("\n") : (target.currentValue || ""),
          ...extraPayload,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const manualSubmit = async () => {
    // JS dot-path → Firebase slash-path. Keeps the audit trail shape
    // consistent with AI rewrites (which write the same path server-side).
    const fbPath = `${fbPathPrefix}/${target.path.replace(/\./g, "/")}`;
    // Await the write (and the updatedAt bump) before closing. The old
    // fire-and-forget pattern closed the modal optimistically, the
    // parent's Firebase listener then fired with a STALE snapshot
    // (the write hadn't committed yet), and the stale snapshot
    // clobbered the edit — user reported the rewrite "reverting".
    // fbSetAsync resolves only after Firebase acks the write, so the
    // listener's next fire sees the new value and re-rendering is a
    // no-op.
    setWorking(true);
    setError(null);
    try {
      await fbSetAsync(fbPath, manualValue);
      if (updatedAtPath) await fbSetAsync(updatedAtPath, new Date().toISOString());
      onClose();
    } catch (e) {
      setError(`Couldn't save edit: ${e.message || e}. Try again.`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 22, maxWidth: 720, width: "92%", maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--border)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{target.label}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {/* Current value preview — keeps the producer oriented on what's being rewritten */}
        <div style={{ marginBottom: 12, padding: "10px 14px", background: "var(--bg)", borderRadius: 6, fontSize: 12, color: "var(--muted)", maxHeight: 120, overflow: "auto" }}>
          <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: "uppercase" }}>Current</div>
          {target.currentValue
            ? (Array.isArray(target.currentValue) ? target.currentValue.join("\n") : target.currentValue)
            : "(empty)"}
        </div>

        <div style={{ display: "flex", gap: 2, marginBottom: 12, background: "var(--bg)", borderRadius: 6, padding: 3, width: "fit-content" }}>
          <button onClick={() => setMode("ai")}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: mode === "ai" ? "var(--accent)" : "transparent", color: mode === "ai" ? "#fff" : "var(--muted)" }}>AI rewrite</button>
          <button onClick={() => setMode("manual")}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: mode === "manual" ? "var(--accent)" : "transparent", color: mode === "manual" ? "#fff" : "var(--muted)" }}>Manual edit</button>
        </div>

        {mode === "ai" ? (
          <>
            <textarea value={instruction} onChange={e => setInstruction(e.target.value)}
              placeholder={`e.g. "Make this more direct, no fluff" or "Tie this back to the client's subject-matter expertise"`}
              rows={3} autoFocus
              style={{ ...inputSt, fontSize: 13, marginBottom: 10, resize: "vertical" }} />
            {error && (
              <div style={{ marginBottom: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={aiSubmit} disabled={working || !instruction.trim()}
                style={{ ...btnPrimary, opacity: (working || !instruction.trim()) ? 0.6 : 1 }}>
                {working ? "Rewriting…" : "Rewrite"}
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea value={manualValue} onChange={e => setManualValue(e.target.value)}
              rows={6} autoFocus
              style={{ ...inputSt, fontSize: 13, marginBottom: 10, resize: "vertical", minHeight: 140, fontFamily: "inherit" }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={manualSubmit} style={btnPrimary}>Save</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
