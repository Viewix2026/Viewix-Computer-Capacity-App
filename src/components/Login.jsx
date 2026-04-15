import { useState, useEffect, useRef } from "react";
import { signInWithRole } from "../firebase";
import { Logo } from "./Logo";

// Temporary fallback map — used if /api/auth is unreachable (e.g. FIREBASE_SERVICE_ACCOUNT
// env var not yet set on Vercel). Remove once Firebase auth setup is confirmed working.
const FALLBACK_PW_TO_ROLE = {
  "Sanpel": "founders",
  "Push": "founder",
  "Close": "closer",
  "Letsgo": "editor",
  "Lead": "lead",
  "Trial": "trial",
};

export function Login({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const role = await signInWithRole(pw);
      setErr(false);
      onLogin(role);
    } catch (e) {
      // Fallback: if Firebase auth isn't configured yet, use the old role map
      const fallbackRole = FALLBACK_PW_TO_ROLE[pw];
      if (fallbackRole) {
        console.warn("Firebase auth unavailable, using fallback:", e.message);
        setErr(false);
        onLogin(fallbackRole);
        setBusy(false);
        return;
      }
      setErr(true);
      setShake(true);
      setTimeout(() => setShake(false), 500);
      setPw("");
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
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 28 }}>Enter password to continue</div>
        <div>
          <input
            ref={ref}
            type="password"
            value={pw}
            disabled={busy}
            onChange={e => { setPw(e.target.value); setErr(false); }}
            onKeyDown={e => { if (e.key === "Enter") go(); }}
            placeholder="Password"
            style={{ width: "100%", padding: "12px 16px", borderRadius: 10, border: `1px solid ${err ? "#EF4444" : "var(--border)"}`, background: "var(--input-bg)", color: "var(--fg)", fontSize: 15, outline: "none", marginBottom: 12, textAlign: "center", letterSpacing: "0.15em" }}
          />
          {err && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>Wrong password</div>}
          <button onClick={go} disabled={busy} style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "#0082FA", color: "white", fontSize: 14, fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Signing in..." : "Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}
