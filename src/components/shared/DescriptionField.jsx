// Textarea with a Whisper-powered voice-to-text mic button.
// Extracted from SocialOrganicResearch.jsx so Tab 5 (Shortlist) and any
// other surface that wants voice-dictated fields can share the same UX.
//
// Workflow: user hits 🎤 → browser records via MediaRecorder → hits ■ to
// stop → blob is POSTed to /api/whisper → text is appended to the textarea.
// Recorder auto-stops at a 3-min soft cap (see useAudioRecorder).

import { useEffect, useRef, useState } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { authFetch } from "../../firebase";

const inputSt = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  fontFamily: "inherit", width: "100%", boxSizing: "border-box",
};

function Label({ children }) {
  return (
    <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 5 }}>
      {children}
    </label>
  );
}

export function DescriptionField({ label, hint, value, onChange, rows = 3, required = false }) {
  const { status, elapsed, blob, error, start, stop, reset, softCapSeconds } = useAudioRecorder();
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState(null);

  // Refs to the latest value + onChange. The blob-transcribe effect fires
  // asynchronously (fetch + round trip to /api/whisper takes seconds), and
  // if the user typed into the textarea in the meantime the closure's
  // `value` would be stale — we'd overwrite their edits with the pre-dictation
  // state + appended transcript. Reading via ref always picks up the latest.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Auto-transcribe on blob — matches the "tap mic / speak / tap mic / see
  // text" mental model. Skip sub-500B blobs (usually a mis-tap).
  const handledBlobRef = useRef(null);
  useEffect(() => {
    if (!blob || blob === handledBlobRef.current) return;
    if (blob.size < 500) { reset(); return; }
    handledBlobRef.current = blob;
    (async () => {
      setTranscribing(true);
      setTranscribeError(null);
      try {
        const form = new FormData();
        form.append("file", blob, "audio.webm");
        form.append("model", "whisper-1");
        const r = await authFetch("/api/whisper", { method: "POST", body: form });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
        const text = (d.text || "").trim();
        if (text) {
          // Append to whatever's in the textarea *right now* (fresh ref),
          // not the snapshot from when recording started.
          const current = valueRef.current || "";
          const join = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
          onChangeRef.current(`${current}${join}${text}`);
        } else {
          // Whisper returned nothing — let the user know rather than silently
          // closing the recorder; they may have recorded with a dead mic.
          setTranscribeError("No speech detected.");
        }
      } catch (e) {
        setTranscribeError(e.message);
      } finally {
        setTranscribing(false);
        reset();
      }
    })();
  }, [blob]);  // eslint-disable-line react-hooks/exhaustive-deps

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <Label>{label}{required && <span style={{ color: "#EF4444", marginLeft: 4 }}>*</span>}</Label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {transcribing && <span style={{ fontSize: 10, color: "var(--accent)" }}>Transcribing…</span>}
          {status === "recording" && (
            <span style={{ fontSize: 10, color: "#EF4444", fontFamily: "'JetBrains Mono',monospace" }}>
              ● REC {mm}:{ss} / {Math.floor(softCapSeconds / 60)}:00
            </span>
          )}
          <button
            onClick={() => status === "recording" ? stop() : start()}
            disabled={transcribing}
            title={status === "recording" ? "Stop recording" : "Record voice memo"}
            style={{
              width: 28, height: 28, borderRadius: "50%",
              border: "1px solid var(--border)",
              background: status === "recording" ? "#EF4444" : "var(--bg)",
              color: status === "recording" ? "#fff" : "var(--fg)",
              fontSize: 13, cursor: transcribing ? "wait" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
            {status === "recording" ? "■" : "🎤"}
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={hint}
        rows={rows}
        style={{ ...inputSt, resize: "vertical", fontFamily: "inherit", fontSize: 12 }} />
      {error && (
        <div style={{ fontSize: 10, color: "#EF4444", marginTop: 3 }}>Mic error: {error}</div>
      )}
      {transcribeError && (
        <div style={{ fontSize: 10, color: "#EF4444", marginTop: 3 }}>Whisper error: {transcribeError}</div>
      )}
    </div>
  );
}
