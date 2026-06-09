import { useState } from "react";
import { signInWithGoogle } from "../firebase";
import { Logo } from "./Logo";

// Shown when the live Firebase session dies or is replaced while the
// dashboard is still rendering. App.jsx restores `role` once at startup
// and React state keeps the UI alive after that, so without this gate a
// mid-session auth loss left a zombie dashboard: header badge fell back
// to "Account", and every role-gated write (time logs included) was
// denied. Historic cause was the public share views' anonymous sign-in
// clobbering the staff Google session (fixed in firebase.js); any other
// mid-session auth loss (token revoked, account deactivated) lands here
// too instead of failing silently.
//
// On successful re-sign-in we reload the page rather than patching
// state: the RTDB server cancels every active listener when the auth
// token loses its role claim, and they're spread across App.jsx and the
// src/sync/ hooks with no re-attach path for an unchanged `role`. A
// reload boots clean off the freshly persisted Google session.
export function SessionExpiredOverlay({ onLogout }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await signInWithGoogle();
      window.location.reload();
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        setErr(e.message || "Sign-in failed");
      }
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(4,8,16,0.78)", backdropFilter: "blur(3px)", fontFamily: "'DM Sans',-apple-system,sans-serif" }}>
      <div style={{ width: 400, padding: "40px 36px", background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)", textAlign: "center" }}>
        <div style={{ marginBottom: 24, display: "flex", justifyContent: "center" }}><Logo h={30} /></div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Your session expired</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24, lineHeight: 1.5 }}>
          You've been signed out, so nothing you do here is saving. Sign back in to keep working.
          If a timer was running, add the missed minutes back with ± Time after you're in.
        </div>
        <button
          onClick={go}
          disabled={busy}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: 10,
            border: "1px solid var(--border)", background: "#FFFFFF", color: "#1F1F1F",
            fontSize: 14, fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "Signing in..." : "Sign back in with Google"}
        </button>
        {err && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 12, lineHeight: 1.4 }}>{err}</div>}
        <button onClick={onLogout} style={{ marginTop: 16, background: "none", border: "none", color: "var(--muted)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
          Go to the login screen instead
        </button>
      </div>
    </div>
  );
}
