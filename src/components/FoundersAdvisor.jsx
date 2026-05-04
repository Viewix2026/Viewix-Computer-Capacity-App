// FoundersAdvisor — sub-tab where the founders ask Claude Opus 4.7
// to analyse the business and produce a strategic briefing. Reads
// from /foundersBriefings (history) and calls the
// /api/founders-advisor endpoint to generate new briefings or post
// existing ones to Slack.
//
// Presentation is intentionally minimal: a "Run analysis" CTA at the
// top, a list of past briefings on the left, and the selected
// briefing's full markdown on the right. Renders a primitive markdown
// flavour (headings, bold, bullets, numbered lists, line breaks) —
// no full markdown lib needed for the tight format our prompt asks
// Claude to emit.

import { useState, useEffect } from "react";
import { authFetch, fbListenSafe } from "../firebase";

async function readJsonResponse(r) {
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; }
  catch {
    const preview = text.slice(0, 240).replace(/\s+/g, " ").trim();
    throw new Error(r.ok
      ? `Server returned non-JSON response: ${preview}`
      : `HTTP ${r.status} — ${preview || "request failed"}`);
  }
}

// Fetched briefings are sorted newest-first.
function sortBriefings(map) {
  return Object.values(map || {})
    .filter(Boolean)
    .sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));
}

function fmtRelative(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Tight markdown renderer for the structured output our prompt emits:
// h1 / h2 (## ...) / bold (**...**) / numbered lists (1. ...) /
// bulleted lists (- ...) / paragraph breaks. Doesn't try to handle
// code blocks, tables, links — the prompt doesn't ask for them.
function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split("\n");
  const blocks = [];
  let para = [];
  let list = null;  // { kind: "ul" | "ol", items: [] }

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      flushPara(); flushList();
      blocks.push({ kind: "h1", text: line.slice(2).trim() });
    } else if (line.startsWith("## ")) {
      flushPara(); flushList();
      blocks.push({ kind: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("### ")) {
      flushPara(); flushList();
      blocks.push({ kind: "h3", text: line.slice(4).trim() });
    } else if (/^\d+\.\s+/.test(line)) {
      flushPara();
      if (!list || list.kind !== "ol") { flushList(); list = { kind: "ol", items: [] }; }
      list.items.push(line.replace(/^\d+\.\s+/, ""));
    } else if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (!list || list.kind !== "ul") { flushList(); list = { kind: "ul", items: [] }; }
      list.items.push(line.replace(/^[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();

  // Inline formatting: **bold** → <strong>.
  const inline = (s) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) {
        return <strong key={i} style={{ color: "var(--fg)" }}>{p.slice(2, -2)}</strong>;
      }
      return <span key={i}>{p}</span>;
    });
  };

  return blocks.map((b, i) => {
    if (b.kind === "h1") return <h1 key={i} style={{ fontSize: 22, fontWeight: 800, color: "var(--fg)", marginTop: i === 0 ? 0 : 24, marginBottom: 12 }}>{inline(b.text)}</h1>;
    if (b.kind === "h2") return <h2 key={i} style={{ fontSize: 15, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 22, marginBottom: 10 }}>{inline(b.text)}</h2>;
    if (b.kind === "h3") return <h3 key={i} style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginTop: 16, marginBottom: 6 }}>{inline(b.text)}</h3>;
    if (b.kind === "ul") return (
      <ul key={i} style={{ paddingLeft: 22, marginBottom: 12 }}>
        {b.items.map((it, j) => <li key={j} style={{ marginBottom: 6, color: "var(--fg)", lineHeight: 1.55 }}>{inline(it)}</li>)}
      </ul>
    );
    if (b.kind === "ol") return (
      <ol key={i} style={{ paddingLeft: 22, marginBottom: 12 }}>
        {b.items.map((it, j) => <li key={j} style={{ marginBottom: 8, color: "var(--fg)", lineHeight: 1.55 }}>{inline(it)}</li>)}
      </ol>
    );
    return <p key={i} style={{ marginBottom: 10, color: "var(--fg)", lineHeight: 1.55 }}>{inline(b.text)}</p>;
  });
}

export function FoundersAdvisor() {
  const [briefings, setBriefings] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [running, setRunning] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);

  // Listen to /foundersBriefings live so the latest run lands without
  // a refresh. Latest is auto-selected when the listener pumps.
  useEffect(() => {
    const unsub = fbListenSafe("/foundersBriefings", (data) => {
      const map = data || {};
      setBriefings(map);
      setSelectedId(prev => {
        if (prev && map[prev]) return prev;
        const sorted = sortBriefings(map);
        return sorted[0]?.id || null;
      });
    });
    return unsub;
  }, []);

  const list = sortBriefings(briefings);
  const selected = selectedId ? briefings[selectedId] : null;

  const runAnalysis = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await authFetch("/api/founders-advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "runAnalysis" }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Listener will pick up the new briefing; explicit select for snap UX.
      if (d.briefing?.id) setSelectedId(d.briefing.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const postToSlack = async () => {
    if (!selected) return;
    setPosting(true);
    setError(null);
    try {
      const r = await authFetch("/api/founders-advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "postToSlack", briefingId: selected.id }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div>
      {/* Header / CTA */}
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        marginBottom: 16, gap: 12, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Advisor</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2, lineHeight: 1.5, maxWidth: 640 }}>
            Claude Opus 4.7 reads your dashboard insights, goals, and last 12 months of history, then writes a strategic briefing. Auto-runs every Monday and posts the executive summary to Slack; you can also run it on demand and re-post any past briefing.
          </div>
        </div>
        <button onClick={runAnalysis} disabled={running}
          style={{
            padding: "10px 20px", borderRadius: 8, border: "none",
            background: running ? "var(--bg)" : "var(--accent)",
            color: running ? "var(--muted)" : "#fff",
            fontSize: 12, fontWeight: 800, cursor: running ? "wait" : "pointer", fontFamily: "inherit",
            boxShadow: running ? "none" : "0 0 14px rgba(0,130,250,0.4)",
            minWidth: 160,
          }}>
          {running ? "Analysing…" : "▶ Run analysis"}
        </button>
      </div>

      {error && (
        <div style={{
          padding: "10px 14px", marginBottom: 16,
          background: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 8, fontSize: 12, color: "#EF4444",
          whiteSpace: "pre-wrap",
        }}>
          {error}
        </div>
      )}

      {list.length === 0 ? (
        <div style={{
          padding: 40, textAlign: "center", color: "var(--muted)",
          background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12, fontSize: 13,
        }}>
          No briefings yet. Click "Run analysis" to generate the first one.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
          {/* History list */}
          <div style={{
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 12, padding: 8, alignSelf: "flex-start",
            maxHeight: "70vh", overflowY: "auto",
          }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, padding: "6px 10px 8px" }}>
              History · {list.length}
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              {list.map(b => {
                const active = b.id === selectedId;
                return (
                  <button key={b.id} onClick={() => setSelectedId(b.id)}
                    style={{
                      padding: "10px 12px", borderRadius: 8,
                      border: "none",
                      background: active ? "rgba(0,130,250,0.15)" : "transparent",
                      color: active ? "var(--fg)" : "var(--muted)",
                      cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                      display: "flex", flexDirection: "column", gap: 2,
                    }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: active ? "var(--accent)" : "var(--fg)" }}>
                      {new Date(b.generatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>
                      {fmtRelative(b.generatedAt)}
                      {b.sentToSlack && <span style={{ color: "#10B981", marginLeft: 6 }}>· slack ✓</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Selected briefing */}
          <div style={{
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 12, padding: "20px 24px",
            minHeight: 400, maxHeight: "70vh", overflowY: "auto",
          }}>
            {!selected ? (
              <div style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 40 }}>
                Pick a briefing from the list.
              </div>
            ) : (
              <>
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  marginBottom: 14, gap: 12, flexWrap: "wrap",
                  paddingBottom: 12, borderBottom: "1px solid var(--border)",
                }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>
                    {new Date(selected.generatedAt).toLocaleString("en-AU")}
                    <span style={{ marginLeft: 10 }}>· {selected.model}</span>
                    {selected.durationMs && (
                      <span style={{ marginLeft: 10 }}>· {(selected.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                  <button onClick={postToSlack} disabled={posting}
                    title={selected.sentToSlack ? "Already posted — click to re-post" : "Post executive summary to Slack"}
                    style={{
                      padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)",
                      background: selected.sentToSlack ? "rgba(16,185,129,0.10)" : "var(--bg)",
                      color: selected.sentToSlack ? "#10B981" : "var(--muted)",
                      fontSize: 11, fontWeight: 700, cursor: posting ? "wait" : "pointer", fontFamily: "inherit",
                    }}>
                    {posting ? "Posting…" : selected.sentToSlack ? "✓ Posted to Slack · re-post" : "Post to Slack"}
                  </button>
                </div>
                <div style={{ fontSize: 13 }}>
                  {renderMarkdown(selected.content)}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
