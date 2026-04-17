// src/hooks/useAudioRecorder.js
// Thin wrapper around the browser's MediaRecorder API for one-shot voice memos.
// Exposes status + elapsed seconds + the final Blob + helper start/stop/reset.
//
// Why a hook, not a component: the Shortlist form wraps a <textarea> and a
// mic button — keeping recorder state out of the textarea lets us expose
// both "transcribe" (auto-fill the textarea) and "raw blob" (if we ever want
// to save the audio itself) from the same primitive.
//
// Limits:
//   - Soft cap 3 min per clip. Keeps the webm blob under Vercel's 4.5MB body
//     limit for the Whisper proxy (MediaRecorder webm at default bitrate is
//     roughly 12kbps = ~270KB/min — plenty of headroom up to 5-6 min in
//     practice but 3 min is a safe ceiling).
//   - Assumes modern Chrome/Safari/Firefox. Fails softly with an error
//     string if MediaRecorder or getUserMedia isn't available.

import { useEffect, useRef, useState } from "react";

const SOFT_CAP_SECONDS = 3 * 60;

// Pick the first mimeType that this browser supports. Whisper accepts
// webm, ogg, mp4, and m4a — webm with opus is the safest default.
function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return null;  // browser will pick its default
}

export function useAudioRecorder({ softCapSeconds = SOFT_CAP_SECONDS } = {}) {
  const [status, setStatus] = useState("idle");  // idle | requesting | recording | stopped | error
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState(null);
  const [error, setError] = useState(null);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);

  // Cleanup on unmount — releases the mic so the browser tab doesn't hold it.
  useEffect(() => {
    return () => {
      try { intervalRef.current && clearInterval(intervalRef.current); } catch { /* noop */ }
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
      try { recorderRef.current?.state === "recording" && recorderRef.current.stop(); } catch { /* noop */ }
    };
  }, []);

  const start = async () => {
    setError(null);
    setBlob(null);
    setElapsed(0);
    setStatus("requesting");

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError("Microphone access not supported in this browser");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const finalBlob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setBlob(finalBlob);
        setStatus("stopped");
        // Release the mic immediately after stop. Without this the browser
        // tab shows a persistent recording indicator even after we've stopped.
        try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
        streamRef.current = null;
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      };

      recorder.start();
      setStatus("recording");

      // Elapsed counter + soft cap. We auto-stop at the cap rather than just
      // warning so we never exceed the Whisper proxy's body limit.
      const startedAt = Date.now();
      intervalRef.current = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        setElapsed(secs);
        if (secs >= softCapSeconds) {
          stop();
        }
      }, 250);
    } catch (e) {
      setStatus("error");
      setError(e?.message || "Microphone permission denied");
    }
  };

  const stop = () => {
    try {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }
    } catch (e) {
      console.warn("recorder stop failed:", e);
    }
  };

  const reset = () => {
    setBlob(null);
    setElapsed(0);
    setError(null);
    setStatus("idle");
  };

  return { status, elapsed, blob, error, start, stop, reset, softCapSeconds };
}
