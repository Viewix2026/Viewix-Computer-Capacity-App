import { useState } from "react";
import { sendClientSignInLink } from "../../firebase";
import { ViewixLogo, ViewixMark, BtnPrimary, BtnGhost, Label, Icon, useIsNarrow } from "./ui";

const Art = () => (
  <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
    <div style={{ position: "absolute", right: "-15%", top: "-25%", width: "70%", height: "90%", background: "radial-gradient(circle, rgba(28,132,237,0.10), transparent 60%)", filter: "blur(20px)" }} />
    <div style={{ position: "absolute", left: "-15%", bottom: "-30%", width: "55%", height: "80%", background: "radial-gradient(circle, rgba(255,94,54,0.06), transparent 60%)", filter: "blur(20px)" }} />
    <div className="vx-grid-bg" style={{ position: "absolute", inset: 0, opacity: 0.45 }} />
  </div>
);

const KineticHeadline = ({ size = 66 }) => (
  <h1 style={{ margin: "24px 0 18px", fontSize: size, lineHeight: 1.02, fontWeight: 700, letterSpacing: "-0.035em", color: "var(--text)" }}>
    Your work,<br />
    <span style={{ background: "linear-gradient(120deg, #0e6fd1 0%, #1c84ed 50%, #5dbcff 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontStyle: "italic", fontWeight: 700 }}>
      in motion.
    </span>
  </h1>
);

const Footer = () => (
  <div style={{ position: "relative", zIndex: 2, display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "center", padding: "20px 32px", borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--text-3)" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <ViewixMark size={18} />
      <span className="mono" style={{ letterSpacing: "0.02em", textTransform: "uppercase" }}>Performance marketers that only make video.</span>
    </div>
    <div style={{ display: "flex", gap: 24 }}>
      <span>© Viewix Studio · Sydney</span>
      <span>hello@viewix.com.au</span>
    </div>
  </div>
);

function EnterForm({ narrow, needEmail, completeError, onCompleteWithEmail }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (needEmail) {
        await onCompleteWithEmail(email);
      } else {
        await sendClientSignInLink(email);
        setSent(true);
      }
    } catch (ex) {
      setErr(ex?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (sent) return <SentCard email={email} narrow={narrow} onReset={() => setSent(false)} />;

  return (
    <div style={{
      width: narrow ? "100%" : 440, padding: narrow ? "24px 22px" : "40px 36px",
      background: "#ffffff", border: "1px solid var(--line-2)", borderRadius: 18,
      boxShadow: "0 30px 60px -28px rgba(15,18,26,0.18), 0 1px 0 rgba(255,255,255,0.6) inset",
    }}>
      <Label>{needEmail ? "Confirm email" : "Sign in"}</Label>
      <h2 style={{ margin: "8px 0 6px", fontSize: narrow ? 22 : 28, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--heading)" }}>
        {needEmail ? "One more step." : "Welcome back."}
      </h2>
      <p style={{ margin: "0 0 22px", fontSize: 14, color: "var(--text-2)", lineHeight: 1.5 }}>
        {needEmail
          ? "You opened the link on a different device. Confirm the email it was sent to and you're in."
          : "Pop your email in - we'll send a signed link straight to your inbox."}
      </p>

      <form onSubmit={submit}>
        <Label style={{ display: "block", marginBottom: 8 }}>Email</Label>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 52, padding: "0 14px", borderRadius: 12, border: "1px solid var(--accent-line)", background: "#fff", boxShadow: "0 0 0 4px var(--accent-soft)" }}>
          <span style={{ color: "var(--accent)" }}><Icon.mail /></span>
          <input
            type="email" autoFocus required value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            style={{ flex: 1, fontSize: 15, color: "var(--text)" }}
          />
        </div>

        {(err || completeError) && (
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--orange-2)", background: "var(--orange-soft)", border: "1px solid var(--orange-line)", borderRadius: 8, padding: "8px 12px" }}>
            {err || completeError}
          </div>
        )}

        <BtnPrimary type="submit" disabled={busy} style={{ width: "100%", height: 52, marginTop: 18, fontSize: 15, opacity: busy ? 0.7 : 1 }}>
          {busy ? "One sec..." : needEmail ? "Finish signing in" : "Send me a sign-in link"}
          <Icon.arrow />
        </BtnPrimary>
      </form>

      <div style={{ marginTop: 22, paddingTop: 20, borderTop: "1px solid var(--line)", display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: "0 0 auto", color: "var(--text-3)", marginTop: 1 }}><Icon.shield /></div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)", lineHeight: 1.55 }}>
          Links expire in 15 minutes. No passwords, ever - they're the worst part of the internet.
        </p>
      </div>
    </div>
  );
}

function SentCard({ email, narrow, onReset }) {
  return (
    <div style={{
      width: narrow ? "100%" : 520, padding: narrow ? "32px 24px" : "48px 44px",
      background: "#ffffff", border: "1px solid var(--line-2)", borderRadius: 20,
      boxShadow: "0 30px 60px -28px rgba(15,18,26,0.18)",
    }}>
      <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24, color: "var(--accent)" }}>
        <Icon.inbox />
      </div>
      <Label>Check your inbox</Label>
      <h2 style={{ margin: "8px 0 10px", fontSize: narrow ? 24 : 30, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--heading)" }}>
        Link is on its way.
      </h2>
      <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--text-2)", lineHeight: 1.55 }}>
        We just sent a one-tap sign-in link to{" "}
        <span className="mono" style={{ color: "var(--text)" }}>{email}</span>. Click it from this device and you're in.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 12, border: "1px solid var(--line-2)", background: "var(--bg-2)" }}>
        <div className="vx-dot live-pulse" />
        <div style={{ flex: 1, fontSize: 13, color: "var(--text)" }}>Waiting for you to click the link...</div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <BtnGhost style={{ flex: 1 }} onClick={onReset}>Use a different email</BtnGhost>
      </div>
      <p style={{ margin: "22px 0 0", fontSize: 12, color: "var(--text-3)", lineHeight: 1.55 }}>
        Didn't get it? Check your spam folder, or message us at{" "}
        <span style={{ color: "var(--accent)" }}>hello@viewix.com.au</span>.
      </p>
    </div>
  );
}

export function SignIn({ needEmail = false, completeError = "", onCompleteWithEmail = () => {} }) {
  const narrow = useIsNarrow();
  return (
    <div style={{ width: "100%", minHeight: "100vh", position: "relative", display: "flex", flexDirection: "column", background: "#ffffff" }}>
      <Art />

      <div style={{ position: "relative", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "space-between", padding: narrow ? "16px 20px" : "24px 32px" }}>
        <ViewixLogo size={narrow ? 22 : 24} />
        <Label>Client portal</Label>
      </div>

      <div style={{
        position: "relative", zIndex: 2, flex: 1,
        display: narrow ? "flex" : "grid",
        flexDirection: "column",
        gridTemplateColumns: narrow ? undefined : "1.05fr 1fr",
        alignItems: narrow ? "stretch" : "center",
        gap: narrow ? 0 : 24,
        padding: narrow ? "8px 20px 24px" : "0 32px 32px",
      }}>
        <div style={{ padding: narrow ? "16px 0 24px" : "40px 60px 40px 28px", maxWidth: 660 }}>
          <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 11px", borderRadius: 999, border: "1px solid var(--accent-line)", background: "var(--accent-soft)", color: "var(--accent-2)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            <span className="vx-dot live-pulse" /> Sign in with email · no password
          </span>
          <KineticHeadline size={narrow ? 40 : 66} />
          <p style={{ margin: 0, fontSize: narrow ? 15 : 17, lineHeight: 1.55, color: "var(--text-2)", maxWidth: 500 }}>
            Your home for Video. Watch cuts, approve revisions, see what's coming - the studio, in your pocket.
          </p>
          {!narrow && (
            <div style={{ display: "flex", gap: 28, marginTop: 40, color: "var(--text-2)", fontSize: 13 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "var(--accent)" }}><Icon.shield /></span> Signed link · 15-min expiry</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "var(--accent)" }}><Icon.cal /></span> Your AM, one tap away</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "var(--accent)" }}><Icon.spark /></span> Bye, final_v3.mp4</span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: narrow ? "stretch" : "flex-end" }}>
          <EnterForm narrow={narrow} needEmail={needEmail} completeError={completeError} onCompleteWithEmail={onCompleteWithEmail} />
        </div>
      </div>

      <Footer />
    </div>
  );
}
