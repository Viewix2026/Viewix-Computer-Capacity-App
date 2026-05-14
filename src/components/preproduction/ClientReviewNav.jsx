// Left sidebar nav: Viewix logo, project framing card with progress bar +
// reaction counts, section list with status dots, Submit / Save buttons.
import { C } from "./ClientReviewUI";
import { Logo } from "../Logo";

export function ClientReviewNav({ sections, active, onJump, progress, scriptStats, project, onSubmit, alreadySubmittedAt, autosavedNote }) {
  return (
    <aside style={{ width: 280, flex: "0 0 280px", borderRight: `1px solid ${C.rule}`, background: C.card, padding: "26px 22px", position: "sticky", top: 0, height: "100vh", overflowY: "auto", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 26 }}>
        <Logo h={26} />
        <div style={{ font: '500 10px/1.4 "Montserrat", sans-serif', color: C.mute, marginTop: 8, letterSpacing: "0.1em", textTransform: "uppercase" }}>Pre-production review</div>
      </div>

      <div style={{ padding: "16px 16px", background: C.bg, borderRadius: 12, marginBottom: 22, border: `1px solid ${C.rule}` }}>
        <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 8 }}>For</div>
        <div style={{ font: '700 17px/1.15 "Montserrat", sans-serif', color: C.ink, letterSpacing: "-0.01em" }}>{project.client}</div>
        {project.productLine && (
          <div style={{ font: '500 12px/1.4 "Montserrat", sans-serif', color: C.ink2, marginTop: 2 }}>{project.productLine}</div>
        )}
        <div style={{ height: 1, background: C.rule, margin: "14px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.12em", textTransform: "uppercase" }}>Scripts reviewed</div>
          <div style={{ font: '700 12px/1 "JetBrains Mono", monospace', color: C.blueDk }}>{progress.done}/{progress.total}</div>
        </div>
        <div style={{ height: 6, background: C.rule, borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${(progress.done / Math.max(1, progress.total)) * 100}%`, background: `linear-gradient(90deg, ${C.blueDk}, ${C.blue})`, transition: "width .3s" }} />
        </div>
        {scriptStats && (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, font: '500 11px/1.4 "Montserrat", sans-serif', color: C.mute, flexWrap: "wrap", gap: 6 }}>
            <span><span style={{ color: C.greenDk, fontWeight: 700 }}>{scriptStats.love}</span> love</span>
            <span><span style={{ color: C.orangeDk, fontWeight: 700 }}>{scriptStats.tweak}</span> tweak</span>
            <span><span style={{ color: C.red, fontWeight: 700 }}>{scriptStats.cut}</span> cut</span>
            <span><span style={{ color: C.blue, fontWeight: 700 }}>{scriptStats.comments}</span> comments</span>
          </div>
        )}
      </div>

      <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.16em", textTransform: "uppercase", margin: "0 6px 10px" }}>Sections</div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {sections.map((s) => {
          const isActive = active === s.id;
          const stat = s.status;
          const dot = stat === "approved" ? C.green : stat === "comments" ? C.blue : stat === "info" ? C.muteSoft : C.grey;
          return (
            <button
              key={s.id}
              onClick={() => onJump(s.id)}
              style={{
                display: "grid", gridTemplateColumns: "8px 1fr auto", alignItems: "center", gap: 12,
                padding: "11px 12px", borderRadius: 8, cursor: "pointer", textAlign: "left",
                background: isActive ? C.blueBg : "transparent",
                border: "none", color: isActive ? C.blueDk : C.ink2,
                font: '500 13.5px/1.2 "Montserrat", sans-serif',
                transition: "background .12s",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, boxShadow: stat === "approved" ? `0 0 0 3px ${C.greenBg}` : stat === "comments" ? `0 0 0 3px ${C.blueBg}` : "none" }} />
              <span style={{ fontWeight: isActive ? 700 : 500 }}>{s.label}</span>
              {s.count != null && <span style={{ font: '600 11px/1 "JetBrains Mono", monospace', color: isActive ? C.blueDk : C.mute }}>{s.count}</span>}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{ height: 1, background: C.rule, margin: "22px 0 18px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={onSubmit} style={{ font: '700 12px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: "#fff", background: C.orange, border: "none", padding: "13px 14px", borderRadius: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {alreadySubmittedAt ? "Resend feedback" : "Submit review"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6" /></svg>
        </button>
        {alreadySubmittedAt && (
          <div style={{ font: '500 11px/1.5 "Montserrat", sans-serif', color: C.greenDk, padding: "0 4px" }}>
            Submitted {new Date(alreadySubmittedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
          </div>
        )}
        {autosavedNote && (
          <div style={{ font: '500 11px/1.5 "Montserrat", sans-serif', color: C.mute, padding: "0 4px" }}>
            {autosavedNote}
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, font: '500 11px/1.5 "Montserrat", sans-serif', color: C.mute }}>
        Need help? Reply to your producer for a 15-minute walkthrough.
      </div>
    </aside>
  );
}
