// Gradient hero intro for the client review page. Shows the project
// framing on the left and a per-section status checklist on the right.
import { C } from "./ClientReviewUI";

export function ClientReviewHero({ sections, reviewed, total, formatsCount, project }) {
  const statusLabel = (s) => (
    s === "approved" ? "Approved"
    : s === "comments" ? "Feedback"
    : s === "info" ? "Reference"
    : "Pending"
  );
  const statusDot = (s) => (
    s === "approved" ? "#A6F4C5"
    : s === "comments" ? "#FFD9A8"
    : s === "info" ? "rgba(255,255,255,0.55)"
    : "rgba(255,255,255,0.35)"
  );

  return (
    <div style={{ marginBottom: 40, padding: "32px 36px", background: `linear-gradient(135deg, ${C.blueDeep} 0%, ${C.blueDk} 55%, ${C.blue} 100%)`, borderRadius: 18, color: "#fff", display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 36, alignItems: "center", position: "relative", overflow: "hidden", boxShadow: "0 16px 40px -16px rgba(0,43,87,0.4)" }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.08, background: "repeating-linear-gradient(0deg, transparent 0 40px, rgba(255,255,255,0.6) 40px 41px), repeating-linear-gradient(90deg, transparent 0 40px, rgba(255,255,255,0.6) 40px 41px)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: -120, right: -80, width: 320, height: 320, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,255,255,0.18) 0%, transparent 65%)", pointerEvents: "none" }} />

      <div style={{ position: "relative" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 11px", borderRadius: 999, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", marginBottom: 18 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "#A6F4C5" }} />
          <div style={{ font: '600 10px/1 "Montserrat", sans-serif', letterSpacing: "0.18em", textTransform: "uppercase" }}>Pre-production review · Round 1</div>
        </div>
        <h1 style={{ font: '700 38px/1.1 "Montserrat", sans-serif', margin: 0, letterSpacing: "-0.02em", textWrap: "balance" }}>
          Review your {project.productLine ? `${project.productLine} ` : ""}launch slate
        </h1>
        <p style={{ font: '400 15px/1.6 "Montserrat", sans-serif', margin: "14px 0 0", opacity: 0.9, maxWidth: 540 }}>
          Walk each section. Approve to lock it in, or leave comments and quick reactions — we&apos;ll address them in v2.
          Average reviewer takes <strong style={{ color: "#fff" }}>18 minutes</strong>.
        </p>
        <div style={{ display: "flex", gap: 22, marginTop: 22, font: '500 12px/1.4 "Montserrat", sans-serif', opacity: 0.85 }}>
          <div>
            <div style={{ font: '700 22px/1 "Montserrat", sans-serif', letterSpacing: "-0.02em", color: "#fff" }}>{total}</div>
            <div style={{ marginTop: 4 }}>Scripts to review</div>
          </div>
          <div style={{ width: 1, background: "rgba(255,255,255,0.2)" }} />
          <div>
            <div style={{ font: '700 22px/1 "Montserrat", sans-serif', letterSpacing: "-0.02em", color: "#fff" }}>{formatsCount}</div>
            <div style={{ marginTop: 4 }}>Format{formatsCount === 1 ? "" : "s"}</div>
          </div>
          <div style={{ width: 1, background: "rgba(255,255,255,0.2)" }} />
          <div>
            <div style={{ font: '700 22px/1 "Montserrat", sans-serif', letterSpacing: "-0.02em", color: "#fff" }}>1</div>
            <div style={{ marginTop: 4 }}>Business day to v2</div>
          </div>
        </div>
      </div>

      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 12, padding: 22, background: "rgba(255,255,255,0.1)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.18)", backdropFilter: "blur(6px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.85 }}>Scripts reviewed</div>
          <div style={{ font: '700 16px/1 "JetBrains Mono", monospace' }}>{reviewed}/{total}</div>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${(reviewed / Math.max(1, total)) * 100}%`, background: "#fff", transition: "width .3s" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {sections.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, font: '500 12.5px/1 "Montserrat", sans-serif' }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: statusDot(s.status), flexShrink: 0 }} />
              <span style={{ opacity: 0.95, flex: 1 }}>{s.label}</span>
              <span style={{ opacity: 0.6, fontSize: 11, fontWeight: 600 }}>{statusLabel(s.status)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
