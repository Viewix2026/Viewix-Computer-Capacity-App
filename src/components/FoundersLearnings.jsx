import { useState, useEffect } from "react";
import { onFB, fbSet, fbListen } from "../firebase";

/**
 * AI Learnings tab inside the Founders dashboard.
 *
 * Previously this lived as an inline IIFE inside App.jsx, which called
 * useState / useEffect conditionally — a Rules of Hooks violation that
 * left the tab blank when React bailed out on hook-count mismatch.
 * Extracting to a real component lets React mount/unmount it cleanly
 * when the tab toggles, so the hooks live on a stable component instance.
 */
export function FoundersLearnings() {
  const [feedbackLog, setFeedbackLog] = useState({});
  const [promptLearnings, setPromptLearnings] = useState({});
  const [newLearning, setNewLearning] = useState("");

  useEffect(() => {
    let u1 = () => {}, u2 = () => {};
    onFB(() => {
      u1 = fbListen("/preproduction/feedbackLog", d => setFeedbackLog(d || {}));
      u2 = fbListen("/preproduction/promptLearnings", d => setPromptLearnings(d || {}));
    });
    return () => { u1(); u2(); };
  }, []);

  const NB2 = { padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
  const inputSt2 = { padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" };

  const activeLearnings = Object.entries(promptLearnings).filter(([, l]) => l && l.active);
  const disabledLearnings = Object.entries(promptLearnings).filter(([, l]) => l && !l.active);

  const addLearning = () => {
    if (!newLearning.trim()) return;
    fbSet(`/preproduction/promptLearnings/pl_${Date.now()}`, { rule: newLearning.trim(), active: true, createdAt: new Date().toISOString() });
    setNewLearning("");
  };

  const sortedFeedback = Object.entries(feedbackLog)
    .sort(([, a], [, b]) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, 50);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Active Prompt Learnings</h3>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
          These rules are injected into every new script generation. They compound over time to improve output quality.
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          {activeLearnings.map(([id, l]) => (
            <div key={id} style={{ padding: "10px 14px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: "var(--fg)" }}>{l.rule}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => fbSet(`/preproduction/promptLearnings/${id}/active`, false)} style={{ ...NB2, fontSize: 10, padding: "3px 8px" }}>Disable</button>
                <button onClick={() => { if (window.confirm("Delete this learning?")) fbSet(`/preproduction/promptLearnings/${id}`, null); }} style={{ background: "none", border: "none", color: "#5A6B85", cursor: "pointer", fontSize: 12 }}>x</button>
              </div>
            </div>
          ))}
          {activeLearnings.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>No active learnings yet.</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newLearning}
            onChange={e => setNewLearning(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addLearning(); }}
            placeholder="Add a learning, e.g. 'For Refined brands, soften hook aggression'"
            style={{ ...inputSt2, flex: 1 }}
          />
          <button
            onClick={addLearning}
            disabled={!newLearning.trim()}
            style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: !newLearning.trim() ? 0.5 : 1 }}
          >Add</button>
        </div>
        {disabledLearnings.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>Disabled ({disabledLearnings.length})</summary>
            <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              {disabledLearnings.map(([id, l]) => (
                <div key={id} style={{ padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: 0.6 }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{l.rule}</span>
                  <button onClick={() => fbSet(`/preproduction/promptLearnings/${id}/active`, true)} style={{ ...NB2, fontSize: 10, padding: "3px 8px" }}>Re-enable</button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Feedback Log</h3>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
          All client feedback and producer edits. Identify patterns and promote to learnings.
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          {sortedFeedback.map(([id, entry]) => {
            const tc = (
              entry.type === "clientFeedback" ? { bg: "rgba(245,158,11,0.1)", fg: "#F59E0B", label: "Client" } :
              entry.type === "rewrite"        ? { bg: "rgba(59,130,246,0.1)", fg: "#3B82F6", label: "AI Rewrite" } :
                                                { bg: "rgba(139,92,246,0.1)", fg: "#8B5CF6", label: "Manual" }
            );
            return (
              <div key={id} style={{ padding: "10px 14px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: tc.bg, color: tc.fg }}>{tc.label}</span>
                  <span style={{ fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>{entry.companyName}</span>
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>{entry.column}{entry.cellId ? ` / ${entry.cellId}` : ""}</span>
                  <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>{entry.timestamp ? new Date(entry.timestamp).toLocaleDateString("en-AU") : ""}</span>
                </div>
                {entry.instruction && <div style={{ fontSize: 12, color: "var(--fg)", marginBottom: 4 }}><strong>Instruction:</strong> {entry.instruction}</div>}
                {entry.text && <div style={{ fontSize: 12, color: "var(--fg)", marginBottom: 4 }}><strong>Feedback:</strong> {entry.text}</div>}
                {entry.previousValue && <div style={{ fontSize: 11, color: "var(--muted)" }}>Was: {entry.previousValue.substring(0, 100)}{entry.previousValue.length > 100 ? "..." : ""}</div>}
                {entry.newValue && <div style={{ fontSize: 11, color: "var(--accent)" }}>Now: {entry.newValue.substring(0, 100)}{entry.newValue.length > 100 ? "..." : ""}</div>}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button
                    onClick={() => {
                      const rule = window.prompt("Create a learning from this feedback:", entry.instruction || entry.text || "");
                      if (rule) fbSet(`/preproduction/promptLearnings/pl_${Date.now()}`, { rule, active: true, createdAt: new Date().toISOString(), sourceLogId: id });
                    }}
                    style={{ ...NB2, fontSize: 10, padding: "3px 8px" }}
                  >Promote to Learning</button>
                  <button
                    onClick={() => { if (window.confirm("Delete this feedback log entry?")) fbSet(`/preproduction/feedbackLog/${id}`, null); }}
                    style={{ ...NB2, fontSize: 10, padding: "3px 8px", color: "#EF4444", borderColor: "rgba(239,68,68,0.3)" }}
                  >Delete</button>
                </div>
              </div>
            );
          })}
          {Object.keys(feedbackLog).length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>No feedback logged yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
