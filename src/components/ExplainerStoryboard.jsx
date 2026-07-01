// ════════════════════════════════════════════════════════════════════
// Editors · Explainer Storyboard — interactive subtab.
//
// Stage 1 of the Vox-style explainer pipeline
// (docs/plans/vox-explainer-remotion-scope-packet.md). Describe a topic (and
// optionally paste a rough script); Claude returns a STRUCTURED storyboard — a
// locked visual system + one scene per narration beat, each mapping the
// voiceover line to a foreground/midground asset and an image-gen prompt. The
// table is editable, exportable (Markdown / JSON), and saveable to a shared
// library — it's the artifact a later Remotion build consumes.
//
// Output is plain data (no model-authored HTML), so unlike the Motion Graphics
// generator there is no iframe / CSP / sandbox surface here — just a table.
// Pairs with api/explainer-storyboard.js (generate / save / archive).
// ════════════════════════════════════════════════════════════════════
import { useState, useRef, useEffect, useCallback } from "react";
import { BTN, NB } from "../config";
import { Icon } from "./Icon";
import { ViewixLoader } from "./shared/ViewixLoader";
import { authFetch, fbListenSafe, fbGet } from "../firebase";

const TONES = [
  { key: "vox", label: "Vox explainer" },
  { key: "documentary", label: "Documentary" },
  { key: "punchy", label: "Punchy / social" },
  { key: "corporate", label: "Corporate" },
  { key: "educational", label: "Educational" },
];

const inputStyle = {
  width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "'DM Sans',sans-serif", boxSizing: "border-box",
};

async function readJsonResponse(r) {
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; }
  catch {
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(r.ok ? `Non-JSON response: ${preview}` : `HTTP ${r.status} — ${preview || "request failed"}`);
  }
}

// Build a copy-pasteable Markdown table — the "script in a table" the video shows.
function storyboardToMarkdown(sb) {
  if (!sb) return "";
  const vs = sb.visualSystem || {};
  const lines = [];
  if (sb.title) lines.push(`# ${sb.title}`, "");
  lines.push("**Locked visual system**");
  if (vs.background) lines.push(`- Background (shared): ${vs.background}`);
  if (vs.palette) lines.push(`- Palette: ${vs.palette}`);
  if (vs.fonts) lines.push(`- Fonts: ${vs.fonts}`);
  if (vs.treatment) lines.push(`- Treatment: ${vs.treatment}`);
  lines.push("", `**Scenes** (${sb.sceneCount} · ~${sb.totalSec}s)`, "");
  lines.push("| # | Sec | Voiceover | Midground | Foreground | Midground prompt | Foreground prompt |");
  lines.push("|---|-----|-----------|-----------|------------|------------------|-------------------|");
  for (const s of sb.scenes || []) {
    const cell = (v) => String(v || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${s.n} | ${s.durationSec} | ${cell(s.voiceover)} | ${cell(s.midground)} | ${cell(s.foreground)} | ${cell(s.midgroundPrompt)} | ${cell(s.foregroundPrompt)} |`);
  }
  return lines.join("\n");
}

export function ExplainerStoryboard() {
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [tone, setTone] = useState("vox");
  const [targetSec, setTargetSec] = useState(45);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { id, storyboard, cost, model }
  const [refineText, setRefineText] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedNote, setSavedNote] = useState(null);

  const [library, setLibrary] = useState([]);
  const abortRef = useRef(null);

  useEffect(() => {
    const off = fbListenSafe("/storyboardLibrary/meta", (val) => {
      const list = Object.values(val || {})
        .filter(m => m && !m.archived)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      setLibrary(list);
    }, () => setLibrary([]));
    return () => { try { off && off(); } catch { /* noop */ } };
  }, []);

  // Abort any in-flight request on unmount.
  useEffect(() => () => { try { abortRef.current?.abort(); } catch { /* noop */ } }, []);

  const runGenerate = useCallback(async (payload, label) => {
    if (loading) return;
    setError(null); setSavedNote(null); setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const t = setTimeout(() => controller.abort(), 115000);
    try {
      const r = await authFetch("/api/explainer-storyboard", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
      if (!d.storyboard) throw new Error("No storyboard returned");
      setResult({ id: d.id, storyboard: d.storyboard, cost: d.cost, model: d.model });
      setSaveName(d.storyboard.title || "");
      setRefineText("");
    } catch (e) {
      if (e.name === "AbortError") setError("That took too long — try again with a shorter script.");
      else setError(e.message || `${label} failed`);
    } finally {
      clearTimeout(t);
      abortRef.current = null;
      setLoading(false);
    }
  }, [loading]);

  const generate = () => {
    if (!topic.trim() && !script.trim()) { setError("Describe a topic or paste a script first."); return; }
    runGenerate({ action: "generate", topic, script, tone, targetSec }, "Generate");
  };
  const refine = () => {
    if (!refineText.trim() || !result) return;
    runGenerate({ action: "generate", refineInstruction: refineText, previous: result.storyboard, tone, targetSec }, "Refine");
  };

  // Inline edits to the current storyboard (local only until re-generated/saved).
  const editScene = (idx, field, value) => {
    setResult(prev => {
      if (!prev) return prev;
      const scenes = prev.storyboard.scenes.map((s, i) => i === idx ? { ...s, [field]: value } : s);
      const totalSec = Number(scenes.reduce((a, s) => a + (Number(s.durationSec) || 0), 0).toFixed(1));
      return { ...prev, storyboard: { ...prev.storyboard, scenes, totalSec } };
    });
    setSavedNote(null);
  };
  const editVisual = (field, value) => {
    setResult(prev => prev ? { ...prev, storyboard: { ...prev.storyboard, visualSystem: { ...prev.storyboard.visualSystem, [field]: value } } } : prev);
    setSavedNote(null);
  };

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(storyboardToMarkdown(result?.storyboard));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { setError("Couldn't copy to clipboard"); }
  };
  const downloadJson = () => {
    const sb = result?.storyboard; if (!sb) return;
    const blob = new Blob([JSON.stringify(sb, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(sb.title || "storyboard").replace(/[^\w-]+/g, "-").toLowerCase()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const save = async () => {
    if (!result || saving) return;
    setSaving(true); setError(null);
    try {
      const r = await authFetch("/api/explainer-storyboard", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", generationId: result.id, storyboard: result.storyboard, name: saveName }),
      });
      const d = await readJsonResponse(r);
      if (!r.ok) throw new Error(d.error || "Save failed");
      setSavedNote(`Saved “${d.name}” to the library`);
    } catch (e) {
      setError(e.message || "Save failed");
    } finally { setSaving(false); }
  };

  const loadFromLibrary = async (id) => {
    setError(null); setSavedNote(null);
    try {
      const sb = await fbGet(`/storyboardLibrary/data/${id}`);
      if (!sb) { setError("That storyboard couldn't be loaded"); return; }
      setResult({ id, storyboard: sb, cost: null, model: null });
      setSaveName(sb.title || "");
    } catch { setError("That storyboard couldn't be loaded"); }
  };

  const sb = result?.storyboard;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px", fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 24, alignItems: "start" }}>

        {/* ─── Control panel ─── */}
        <div style={{ display: "grid", gap: 14, position: "sticky", top: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Explainer Storyboard</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
              Turn a topic into a scene-by-scene Vox-style storyboard — the script that acts as your timeline.
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Topic / angle</label>
            <textarea value={topic} onChange={e => setTopic(e.target.value)} rows={3} placeholder="e.g. Why the US dollar is quietly losing its grip on the world economy" style={{ ...inputStyle, marginTop: 6, resize: "vertical" }} />
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Rough script / notes <span style={{ fontWeight: 500, textTransform: "none" }}>(optional)</span></label>
            <textarea value={script} onChange={e => setScript(e.target.value)} rows={5} placeholder="Paste a rough voiceover or bullet points. The storyboard builds its beats from this if provided." style={{ ...inputStyle, marginTop: 6, resize: "vertical" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 96px", gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Tone</label>
              <select value={tone} onChange={e => setTone(e.target.value)} style={{ ...inputStyle, marginTop: 6, cursor: "pointer" }}>
                {TONES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Length (s)</label>
              <input type="number" min={10} max={180} value={targetSec} onChange={e => setTargetSec(Math.max(10, Math.min(180, Number(e.target.value) || 45)))} style={{ ...inputStyle, marginTop: 6 }} />
            </div>
          </div>

          <button onClick={generate} disabled={loading} style={{ ...NB, background: "var(--accent)", color: "#fff", border: "none", height: 42, fontSize: 14, opacity: loading ? 0.6 : 1, cursor: loading ? "default" : "pointer" }}>
            {loading ? "Generating…" : sb ? "Regenerate" : "Generate storyboard"}
          </button>
          {error && <div style={{ fontSize: 12, color: "#EF4444", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "8px 10px" }}>{error}</div>}

          {/* Library */}
          {library.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Saved storyboards</div>
              <div style={{ display: "grid", gap: 6 }}>
                {library.map(m => (
                  <button key={m.id} onClick={() => loadFromLibrary(m.id)} style={{ textAlign: "left", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", color: "var(--fg)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{m.sceneCount} scenes · ~{m.totalSec}s</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ─── Storyboard ─── */}
        <div>
          {loading && !sb && (
            <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
              <ViewixLoader caption="Storyboarding your explainer…" />
            </div>
          )}

          {!loading && !sb && (
            <div style={{ padding: "60px 24px", textAlign: "center", background: "var(--card)", borderRadius: 12, border: "1px dashed var(--border)", color: "var(--muted)" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🎬</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Your storyboard will appear here</div>
              <div style={{ fontSize: 12, lineHeight: 1.6, maxWidth: 460, margin: "0 auto" }}>
                Describe a topic on the left and Generate. You'll get a locked visual system plus one editable scene per voiceover beat — each with its foreground/midground assets and image-generation prompts, ready to feed a Remotion build.
              </div>
            </div>
          )}

          {sb && (
            <>
              {/* Header + actions */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)" }}>{sb.title || "Untitled explainer"}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                    {sb.sceneCount} scenes · ~{sb.totalSec}s
                    {result.cost != null && <> · ${Number(result.cost).toFixed(4)}</>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={copyMarkdown} style={{ ...BTN, height: 32, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" }}>{copied ? "Copied ✓" : "Copy table"}</button>
                  <button onClick={downloadJson} style={{ ...BTN, height: 32, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" }}>Download JSON</button>
                </div>
              </div>

              {/* Locked visual system */}
              <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Locked visual system — shared across every scene</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[["background", "Shared background"], ["treatment", "Cutout treatment"], ["palette", "Palette"], ["fonts", "Fonts"]].map(([field, label]) => (
                    <div key={field}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>{label}</label>
                      <textarea value={sb.visualSystem?.[field] || ""} onChange={e => editVisual(field, e.target.value)} rows={2} style={{ ...inputStyle, marginTop: 4, fontSize: 12, resize: "vertical" }} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Scenes */}
              <div style={{ display: "grid", gap: 12 }}>
                {sb.scenes.map((s, idx) => (
                  <div key={idx} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", background: "var(--accent)", borderRadius: 6, minWidth: 26, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono',monospace" }}>{s.n}</span>
                      <input value={s.beat || ""} onChange={e => editScene(idx, "beat", e.target.value)} placeholder="Beat / scene title" style={{ ...inputStyle, fontSize: 13, fontWeight: 700, flex: 1 }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="number" min={1} max={20} step={0.5} value={s.durationSec} onChange={e => editScene(idx, "durationSec", Math.max(1, Math.min(20, Number(e.target.value) || 1)))} style={{ ...inputStyle, width: 62, fontSize: 12, textAlign: "center" }} />
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>s</span>
                      </div>
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Voiceover</label>
                      <textarea value={s.voiceover || ""} onChange={e => editScene(idx, "voiceover", e.target.value)} rows={2} style={{ ...inputStyle, marginTop: 4, fontSize: 13, resize: "vertical" }} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Midground (cutout)</label>
                        <textarea value={s.midground || ""} onChange={e => editScene(idx, "midground", e.target.value)} rows={2} style={{ ...inputStyle, marginTop: 4, fontSize: 12, resize: "vertical" }} />
                        <textarea value={s.midgroundPrompt || ""} onChange={e => editScene(idx, "midgroundPrompt", e.target.value)} rows={2} placeholder="Image-gen prompt…" style={{ ...inputStyle, marginTop: 6, fontSize: 11, fontFamily: "'JetBrains Mono',monospace", resize: "vertical", color: "var(--muted)" }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Foreground</label>
                        <textarea value={s.foreground || ""} onChange={e => editScene(idx, "foreground", e.target.value)} rows={2} style={{ ...inputStyle, marginTop: 4, fontSize: 12, resize: "vertical" }} />
                        <textarea value={s.foregroundPrompt || ""} onChange={e => editScene(idx, "foregroundPrompt", e.target.value)} rows={2} placeholder="Image-gen prompt…" style={{ ...inputStyle, marginTop: 6, fontSize: 11, fontFamily: "'JetBrains Mono',monospace", resize: "vertical", color: "var(--muted)" }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Refine + Save */}
              <div style={{ marginTop: 18, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", display: "grid", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Refine in plain English</label>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <input value={refineText} onChange={e => setRefineText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") refine(); }} placeholder="e.g. make it 6 scenes, punchier, end on the debt stat" style={{ ...inputStyle, flex: 1 }} disabled={loading} />
                    <button onClick={refine} disabled={loading || !refineText.trim()} style={{ ...NB, background: "var(--bg)", color: "var(--accent)", opacity: loading || !refineText.trim() ? 0.5 : 1 }}>Refine</button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Name for the library…" style={{ ...inputStyle, flex: 1, minWidth: 180 }} />
                  <button onClick={save} disabled={saving} style={{ ...NB, background: "#10B981", color: "#fff", border: "none", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save to library"}</button>
                </div>
                {savedNote && <div style={{ fontSize: 12, color: "#10B981" }}>{savedNote}</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
