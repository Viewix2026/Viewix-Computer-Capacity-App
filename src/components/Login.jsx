import { useState } from "react";
import { signInWithGoogle } from "../firebase";
import { Logo } from "./Logo";

export function Login({ onLogin }) {
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const role = await signInWithGoogle();
      onLogin(role);
    } catch (e) {
      console.warn("Google sign-in failed:", e.message);
      // Popup closed by user — silent.
      if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
        // no-op
      } else {
        setErr(e.message || "Sign-in failed");
        setShake(true);
        setTimeout(() => setShake(false), 500);
      }
      onLogin(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", fontFamily: "'DM Sans',-apple-system,sans-serif" }}>
      <div style={{ width: 380, padding: "48px 40px", background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)", textAlign: "center", animation: shake ? "shake 0.5s ease" : "none" }}>
        <div style={{ marginBottom: 32, display: "flex", justifyContent: "center" }}><Logo h={36} /></div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Viewix Tools</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 28 }}>Sign in with your Google account</div>
        <button
          onClick={go}
          disabled={busy}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: 10,
            border: "1px solid var(--border)", background: "#FFFFFF", color: "#1F1F1F",
            fontSize: 14, fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          }}
        >
          <GoogleG />
          {busy ? "Signing in..." : "Sign in with Google"}
        </button>
        {err && <div style={{ fontSize: 12, color: "#EF4444", marginTop: 14, lineHeight: 1.4 }}>{err}</div>}
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 24, lineHeight: 1.5 }}>
          Access is by invite only. Ask a founder to add your email.
        </div>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
      <path fill="#FBBC04" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/>
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
    </svg>
  );
}
