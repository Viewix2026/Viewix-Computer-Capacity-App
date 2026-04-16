import { useState, useEffect } from "react";
import { onFB, fbSet, fbListen } from "../firebase";

const SALESPEOPLE = ["Brandon", "Jeremy"];

const inputSt = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13,
  fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box",
};
const btnPrimary = {
  padding: "8px 18px", borderRadius: 8, border: "none", background: "var(--accent)",
  color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary = {
  padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)",
  background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600,
  cursor: "pointer", fontFamily: "inherit",
};

function ratingColor(rating) {
  if (!rating) return { bg: "rgba(90,107,133,0.15)", fg: "#5A6B85" };
  if (rating >= 8) return { bg: "rgba(34,197,94,0.15)", fg: "#22C55E" };
  if (rating >= 6) return { bg: "rgba(59,130,246,0.15)", fg: "#3B82F6" };
  if (rating >= 4) return { bg: "rgba(245,158,11,0.15)", fg: "#F59E0B" };
  return { bg: "rgba(239,68,68,0.15)", fg: "#EF4444" };
}

export function MeetingFeedback() {
  const [feedbackItems, setFeedbackItems] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [formClient, setFormClient] = useState("");
  const [formMeeting, setFormMeeting] = useState("");
  const [formSalesperson, setFormSalesperson] = useState("");
  const [formTranscript, setFormTranscript] = useState("");
  const [analysing, setAnalysing] = useState(false);
  const [filterSalesperson, setFilterSalesperson] = useState("all");

  useEffect(() => {
    let u = () => {};
    onFB(() => {
      u = fbListen("/meetingFeedback", d => setFeedbackItems(d || {}));
    });
    return () => u();
  }, []);

  const list = Object.values(feedbackItems).filter(x => x && x.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const filtered = filterSalesperson === "all" ? list : list.filter(x => x.salesperson === filterSalesperson);
  const activeItem = activeId ? feedbackItems[activeId] : null;

  const handleSubmit = async () => {
    if (!formClient.trim() || !formSalesperson || !formTranscript.trim()) {
      alert("Please fill in Client, Salesperson, and Transcript");
      return;
    }
    const id = `mf-${Date.now()}`;
    const entry = {
      id,
      clientName: formClient.trim(),
      meetingName: formMeeting.trim() || "Sales call",
      salesperson: formSalesperson,
      transcript: formTranscript.trim(),
      createdAt: new Date().toISOString(),
      status: "analysing",
    };
    fbSet(`/meetingFeedback/${id}`, entry);
    setCreating(false);
    setAnalysing(true);

    try {
      const resp = await fetch("/api/meeting-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedbackId: id,
          transcript: entry.transcript,
          salesperson: entry.salesperson,
          clientName: entry.clientName,
          meetingName: entry.meetingName,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert("Analysis failed: " + (data.error || "Unknown error"));
        fbSet(`/meetingFeedback/${id}/status`, "error");
      } else {
        // Open the analysed result
        setActiveId(id);
      }
    } catch (err) {
      alert("Request failed: " + err.message);
      fbSet(`/meetingFeedback/${id}/status`, "error");
    } finally {
      setAnalysing(false);
      setFormClient("");
      setFormMeeting("");
      setFormSalesperson("");
      setFormTranscript("");
    }
  };

  const handleDelete = (id) => {
    if (!window.confirm("Delete this meeting feedback entry?")) return;
    fbSet(`/meetingFeedback/${id}`, null);
    if (activeId === id) setActiveId(null);
  };

  const reanalyse = async (item) => {
    setAnalysing(true);
    fbSet(`/meetingFeedback/${item.id}/status`, "analysing");
    try {
      const resp = await fetch("/api/meeting-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedbackId: item.id,
          transcript: item.transcript,
          salesperson: item.salesperson,
          clientName: item.clientName,
          meetingName: item.meetingName,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) alert("Analysis failed: " + (data.error || "Unknown error"));
    } catch (err) {
      alert("Request failed: " + err.message);
    } finally {
      setAnalysing(false);
    }
  };

  // ─── DETAIL VIEW ───
  if (activeItem) {
    const a = activeItem.analysis;
    const rc = ratingColor(a?.rating);
    return (
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <button onClick={() => setActiveId(null)} style={{ ...btnSecondary, padding: "5px 10px" }}>&larr; Back</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => reanalyse(activeItem)} disabled={analysing} style={btnSecondary}>
              {analysing ? "Analysing..." : "Re-analyse"}
            </button>
            <button onClick={() => handleDelete(activeItem.id)} style={{ ...btnSecondary, color: "#EF4444", borderColor: "rgba(239,68,68,0.3)" }}>Delete</button>
          </div>
        </div>

        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{activeItem.salesperson}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg)" }}>{activeItem.clientName}</div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{activeItem.meetingName}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                {activeItem.createdAt ? new Date(activeItem.createdAt).toLocaleString("en-AU") : ""}
              </div>
            </div>
            {a?.rating !== undefined && (
              <div style={{ textAlign: "center", padding: "12px 20px", borderRadius: 12, background: rc.bg, border: `1px solid ${rc.fg}33`, minWidth: 100 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: rc.fg, textTransform: "uppercase", letterSpacing: "0.04em" }}>Rating</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: rc.fg, fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>
                  {a.rating}<span style={{ fontSize: 16, opacity: 0.6 }}>/10</span>
                </div>
              </div>
            )}
          </div>

          {activeItem.status === "analysing" && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>
              <div style={{ fontSize: 14 }}>Analysing transcript...</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>This can take up to 60 seconds.</div>
            </div>
          )}

          {activeItem.status === "error" && (
            <div style={{ padding: 16, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#EF4444", fontSize: 13 }}>
              Analysis failed. Click "Re-analyse" to try again.
            </div>
          )}

          {a && (
            <>
              {a.summary && (
                <div style={{ marginBottom: 20, padding: 14, background: "var(--bg)", borderRadius: 8, fontSize: 14, color: "var(--fg)", lineHeight: 1.5 }}>
                  {a.summary}
                </div>
              )}

              {a.outcome && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Outcome</div>
                  <div style={{ fontSize: 13, color: "var(--fg)" }}>{a.outcome}</div>
                </div>
              )}

              {a.strengths?.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#22C55E", marginBottom: 8 }}>✓ Strengths</div>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                    {a.strengths.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
                  </ul>
                </div>
              )}

              {a.improvements?.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#F59E0B", marginBottom: 8 }}>! Improvements</div>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                    {a.improvements.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
                  </ul>
                </div>
              )}

              {a.keyMoments?.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#3B82F6", marginBottom: 8 }}>Key Moments</div>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
                    {a.keyMoments.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <details style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 20px" }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>View transcript</summary>
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--fg)", whiteSpace: "pre-wrap", maxHeight: 400, overflow: "auto", padding: 12, background: "var(--bg)", borderRadius: 6, lineHeight: 1.5 }}>
            {activeItem.transcript}
          </div>
        </details>
      </div>
    );
  }

  // ─── LIST VIEW ───
  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Meeting Feedback</div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={filterSalesperson} onChange={e => setFilterSalesperson(e.target.value)} style={{ ...inputSt, width: "auto", fontSize: 12, padding: "6px 10px" }}>
            <option value="all">All salespeople</option>
            {SALESPEOPLE.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {!creating && <button onClick={() => setCreating(true)} style={btnPrimary}>+ New Meeting</button>}
        </div>
      </div>

      {/* Creation form */}
      {creating && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Analyse a new meeting</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Client Name</label>
              <input value={formClient} onChange={e => setFormClient(e.target.value)} placeholder="e.g. Acme Corp" style={inputSt} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Meeting Name</label>
              <input value={formMeeting} onChange={e => setFormMeeting(e.target.value)} placeholder="e.g. Discovery call" style={inputSt} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Salesperson</label>
              <select value={formSalesperson} onChange={e => setFormSalesperson(e.target.value)} style={inputSt}>
                <option value="">Select...</option>
                {SALESPEOPLE.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4 }}>Transcript</label>
            <textarea value={formTranscript} onChange={e => setFormTranscript(e.target.value)}
              placeholder="Paste the full meeting transcript here..."
              style={{ ...inputSt, minHeight: 200, resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSubmit} disabled={analysing || !formClient.trim() || !formSalesperson || !formTranscript.trim()}
              style={{ ...btnPrimary, opacity: (analysing || !formClient.trim() || !formSalesperson || !formTranscript.trim()) ? 0.5 : 1 }}>
              {analysing ? "Analysing..." : "Analyse"}
            </button>
            <button onClick={() => { setCreating(false); setFormClient(""); setFormMeeting(""); setFormSalesperson(""); setFormTranscript(""); }} style={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && !creating && (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>&#128172;</div>
          <div style={{ fontSize: 14 }}>No meeting feedback yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Drop in a transcript to get an AI-rated breakdown</div>
        </div>
      )}

      {/* List */}
      <div style={{ display: "grid", gap: 10 }}>
        {filtered.map(item => {
          const a = item.analysis;
          const rc = ratingColor(a?.rating);
          return (
            <div key={item.id} onClick={() => setActiveId(item.id)}
              style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, cursor: "pointer", display: "flex", alignItems: "center", gap: 16, transition: "border-color 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
              <div style={{ minWidth: 72, textAlign: "center", padding: "10px 12px", borderRadius: 10, background: rc.bg, border: `1px solid ${rc.fg}22` }}>
                {item.status === "analysing" ? (
                  <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 0" }}>...</div>
                ) : a?.rating !== undefined ? (
                  <div style={{ fontSize: 24, fontWeight: 800, color: rc.fg, fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>
                    {a.rating}<span style={{ fontSize: 12, opacity: 0.6 }}>/10</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: rc.fg }}>N/A</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{item.clientName}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>·</span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{item.meetingName}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  {item.salesperson} · {item.createdAt ? new Date(item.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""}
                </div>
                {a?.summary && (
                  <div style={{ fontSize: 12, color: "var(--fg)", marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {a.summary}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
