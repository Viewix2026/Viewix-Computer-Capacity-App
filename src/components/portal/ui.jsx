// Viewix Client Portal — shared atoms. Recreated 1:1 from the Claude
// Design handoff (project/src/tokens.jsx) as real React modules.
// Light theme via the `.vx` token layer (portalTheme.js).
import { Fragment, useState, useEffect } from "react";

// Shared responsive switch — inline-style components can't use media
// queries, so layouts branch on this.
export function useIsNarrow(bp = 900) {
  const [n, setN] = useState(typeof window !== "undefined" ? window.innerWidth < bp : false);
  useEffect(() => {
    const on = () => setN(window.innerWidth < bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return n;
}

const LOGO_SRC = "/portal/viewix-logo.png";
const LOGO_AR = 2400 / 638; // ≈ 3.76
const MARK_SRC = "/portal/viewix-mark.png";

export const ViewixLogo = ({ size = 22, style }) => (
  <img src={LOGO_SRC} alt="Viewix"
    style={{ height: size, width: size * LOGO_AR, display: "block", ...style }} />
);

export const ViewixMark = ({ size = 18, style }) => (
  <img src={MARK_SRC} alt="Viewix"
    style={{ width: size, height: size, display: "block", ...style }} />
);

export const Pill = ({ tone = "muted", children, dot = true, style }) => {
  const tones = {
    blue:  { bg: "var(--accent-soft)",  fg: "var(--accent-2)", d: "var(--accent)" },
    green: { bg: "var(--ok-soft)",      fg: "var(--ok)",       d: "var(--ok)" },
    amber: { bg: "var(--warn-soft)",    fg: "var(--warn)",     d: "var(--warn)" },
    red:   { bg: "var(--danger-soft)",  fg: "var(--danger)",   d: "var(--danger)" },
    muted: { bg: "rgba(15,18,26,0.05)", fg: "var(--text-2)",   d: "var(--text-3)" },
    ghost: { bg: "transparent",         fg: "var(--text-3)",   d: "var(--text-3)" },
  };
  const t = tones[tone] || tones.muted;
  return (
    <span className="mono" style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 9px 4px 8px", borderRadius: 999,
      background: t.bg, color: t.fg,
      fontSize: 11, lineHeight: 1, letterSpacing: "0.04em", textTransform: "uppercase",
      border: tone === "ghost" ? "1px solid var(--line)" : "1px solid transparent",
      ...style,
    }}>
      {dot && <span className="vx-dot" style={{ background: t.d }} />}
      {children}
    </span>
  );
};

export const SectionTag = ({ n, children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
    <span className="mono" style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 36, height: 24, borderRadius: 6,
      background: "var(--accent-soft)", color: "var(--accent)",
      fontSize: 12, letterSpacing: "0.04em",
    }}>{n}</span>
    <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--heading, var(--text))" }}>{children}</h2>
  </div>
);

export const Label = ({ children, color = "var(--text-3)", style }) => (
  <span style={{
    fontFamily: "Montserrat", fontWeight: 600,
    fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase",
    color, ...style,
  }}>{children}</span>
);

export const BtnPrimary = ({ children, style, ...rest }) => (
  <button {...rest} style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    height: 44, padding: "0 18px", borderRadius: 10,
    background: "var(--accent)", color: "#fff",
    fontWeight: 600, fontSize: 14, letterSpacing: "-0.005em",
    boxShadow: "0 1px 0 rgba(255,255,255,0.2) inset, 0 8px 22px -10px rgba(28,132,237,0.55)",
    transition: "transform .12s, box-shadow .12s",
    ...style,
  }}>{children}</button>
);

export const BtnGhost = ({ children, style, ...rest }) => (
  <button {...rest} style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    height: 40, padding: "0 14px", borderRadius: 10,
    border: "1px solid var(--line-2)", color: "var(--text)",
    fontWeight: 500, fontSize: 13, background: "var(--surface)",
    ...style,
  }}>{children}</button>
);

export const BtnSubtle = ({ children, style, ...rest }) => (
  <button {...rest} style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    height: 32, padding: "0 12px", borderRadius: 8,
    border: "1px solid var(--line)", color: "var(--text-2)",
    fontWeight: 500, fontSize: 12, background: "transparent",
    ...style,
  }}>{children}</button>
);

export const Icon = {
  arrow:   (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  back:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  check:   (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  chev:    (p = {}) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  x:       (p = {}) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  play:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M7 5v14l12-7z" /></svg>,
  comment: (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 5h16v11H8l-4 4V5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  cut:     (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><circle cx="6" cy="6" r="3" stroke="currentColor" strokeWidth="1.6" /><circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M20 4L8.5 15.5M20 20L8.5 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  heart:   (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 20s-7-4.5-9-9c-1.2-2.7.6-6 3.6-6 1.8 0 3.2 1.1 4 2.4l1.4 1.6 1.4-1.6c.8-1.3 2.2-2.4 4-2.4 3 0 4.8 3.3 3.6 6-2 4.5-9 9-9 9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  tweak:   (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  film:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M3 9h18M3 15h18M8 5v14M16 5v14" stroke="currentColor" strokeWidth="1.6" /></svg>,
  doc:     (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 3h9l4 4v14H6V3zM15 3v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  search:  (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" /><path d="M20 20l-4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  user:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" /><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  external:(p = {}) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M14 4h6v6M20 4l-9 9M9 5H4v15h15v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  shield:  (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  spark:   (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l4 4M14 14l4 4M18 6l-4 4M10 14l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  bell:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  dl:      (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 4v12M7 11l5 5 5-5M4 20h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  cal:     (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  phone:   (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M5 4h4l2 5-3 2c1.5 3 3.5 5 6.5 6.5l2-3 5 2v4c0 1-1 2-2 2-9 0-16-7-16-16 0-1 1-2 2-2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  mail:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.6" /></svg>,
  rocket:  (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M14 3c3 0 7 4 7 7l-5 5-3-1-2-2-1-3 4-6zM10 14l-3 3M7 13l-3 1 1 5 5 1 1-3M14 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  signout: (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M15 16l4-4-4-4M19 12H9M9 4H5v16h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  inbox:   (p = {}) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none" {...p}><path d="M3 7l9 6 9-6M3 7v10h18V7M3 7l9-3 9 3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  info:    (p = {}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 8h.01M11 12h1v4h1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /></svg>,
};

export const PHASES = ["Kickoff", "Shooting", "Editing", "Review"];

export const PhaseTrack = ({ steps = PHASES, current, compact = false }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 0, width: "100%" }}>
    {steps.map((s, i) => {
      const done = i < current;
      const active = i === current;
      const dotRing = done || active ? "var(--accent)" : "var(--line-3)";
      const lineBg = i < current ? "var(--accent)" : "var(--line-2)";
      const size = active ? (compact ? 18 : 24) : (compact ? 14 : 20);
      return (
        <Fragment key={s}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", flexDirection: "column" }}>
            <div style={{
              width: size, height: size, borderRadius: 999,
              background: done || active ? "var(--accent)" : "#fff",
              border: `1.5px solid ${dotRing}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 11, fontWeight: 600,
              boxShadow: active ? "0 0 0 4px rgba(28,132,237,0.14)" : "none",
              transition: "all .2s",
            }}>
              {done && <Icon.check style={{ width: 10, height: 10 }} />}
              {active && <span className="mono" style={{ fontSize: compact ? 9 : 11 }}>{i + 1}</span>}
            </div>
            {!compact && (
              <div style={{
                position: "absolute", top: size + 8, whiteSpace: "nowrap",
                fontSize: 12, fontWeight: active ? 600 : 500,
                color: active ? "var(--text)" : done ? "var(--text-2)" : "var(--text-3)",
              }}>{s}</div>
            )}
          </div>
          {i < steps.length - 1 && (
            <div style={{ flex: 1, height: 2, background: lineBg, margin: "0 4px", borderRadius: 99 }} />
          )}
        </Fragment>
      );
    })}
  </div>
);

export const ImagePh = ({ w = "100%", h = 160, label, style }) => (
  <div style={{
    width: w, height: h, borderRadius: 10,
    background: "repeating-linear-gradient(135deg, rgba(15,18,26,0.045) 0 8px, rgba(15,18,26,0.015) 8px 16px), var(--surface-2)",
    border: "1px solid var(--line)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "var(--text-3)", ...style,
  }}>
    <span className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
  </div>
);

export const ManagerPhoto = ({ size = 72, initials = "VX", style }) => (
  <div style={{
    width: size, height: size, borderRadius: size * 0.22,
    overflow: "hidden", position: "relative",
    background: "repeating-linear-gradient(135deg, #cbd5e1 0 6px, #e2e8f0 6px 12px)",
    border: "1px solid var(--line-2)", flex: "0 0 auto", ...style,
  }}>
    <div style={{
      position: "absolute", inset: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#475569", fontWeight: 600, fontSize: size * 0.34,
      background: "rgba(255,255,255,0.55)", backdropFilter: "blur(4px)",
    }}>{initials}</div>
  </div>
);

export const UserMenu = ({ user = {}, onSignOut = () => {}, anchor = "right", style = {} }) => {
  const name = user.displayName || user.email || "You";
  const initials = (name.match(/\b\w/g) || ["Y"]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{
      position: "absolute", top: "calc(100% + 8px)", [anchor]: 0,
      width: 304, background: "var(--surface)",
      border: "1px solid var(--line-2)", borderRadius: 14,
      boxShadow: "0 24px 56px -16px rgba(15,18,26,0.28), 0 1px 0 rgba(255,255,255,0.6) inset",
      padding: 8, zIndex: 70, ...style,
    }}>
      <div style={{ padding: "12px 12px 14px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--line)", marginBottom: 6 }}>
        <div style={{
          width: 42, height: 42, borderRadius: 999,
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          color: "#fff", fontSize: 14, fontWeight: 700,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{name}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email || ""}</div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--line)", marginTop: 6, paddingTop: 6 }}>
        <button onClick={onSignOut} style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "10px 12px", borderRadius: 8,
          color: "var(--orange-2)", textAlign: "left", fontSize: 13, fontWeight: 600,
        }}>
          <span style={{ color: "var(--orange)" }}><Icon.signout /></span>
          <span style={{ flex: 1 }}>Sign out</span>
        </button>
      </div>
    </div>
  );
};

export const PortalNav = ({ active = "Projects", context, user, brand = null, menuOpen = false, onMenu = () => {}, onSignOut = () => {}, onNav = () => {} }) => {
  const name = user?.displayName || user?.email || "You";
  const initials = (name.match(/\b\w/g) || ["Y"]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{
      // position+z so the user menu dropdown layers ABOVE the sticky AM
      // rail card in the scroll area below (which has its own z-context).
      position: "relative", zIndex: 60,
      height: 64, display: "flex", alignItems: "center", gap: 24,
      padding: "0 28px", borderBottom: "1px solid var(--line)",
      background: "rgba(255,255,255,0.78)", backdropFilter: "blur(10px)", flex: "0 0 auto",
    }}>
      <ViewixLogo size={22} />
      <div style={{ width: 1, height: 20, background: "var(--line-2)" }} />
      <nav style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {["Projects", "Analytics"].map(t => (
          <button key={t} onClick={t === active ? undefined : () => onNav(t)} style={{
            padding: "8px 12px", borderRadius: 7,
            fontSize: 13, fontWeight: t === active ? 600 : 500,
            color: t === active ? "var(--text)" : "var(--text-3)",
            background: t === active ? "rgba(15,18,26,0.04)" : "transparent",
            cursor: t === active ? "default" : "pointer",
          }}>{t}</button>
        ))}
      </nav>
      {context && (
        <>
          <div style={{ width: 1, height: 20, background: "var(--line-2)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)" }}>{context}</div>
        </>
      )}
      <div style={{ flex: 1 }} />
      {brand && (
        <>
          <ClientBrand brand={brand} />
          <div style={{ width: 1, height: 26, background: "var(--line-2)" }} />
        </>
      )}
      <div style={{ position: "relative" }}>
        <div onClick={onMenu} style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "4px 12px 4px 4px", borderRadius: 999,
          border: menuOpen ? "1px solid var(--accent-line)" : "1px solid var(--line)",
          background: menuOpen ? "var(--accent-soft)" : "var(--surface)", cursor: "pointer",
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 999,
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600,
          }}>{initials}</div>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>{name}</span>
          <Icon.chev style={{ color: "var(--text-3)", marginLeft: 2, transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
        </div>
        {menuOpen && <UserMenu user={user} onSignOut={onSignOut} />}
      </div>
    </div>
  );
};

// The signed-in client's own brand mark + name, shown top-right of the
// nav next to the user. Logo image when set, else an initials chip
// (also falls back to initials if the logo URL fails to load).
export const ClientBrand = ({ brand }) => {
  const [broken, setBroken] = useState(false);
  if (!brand) return null;
  const initials = (String(brand.name || "?").match(/\b\w/g) || ["?"]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      {brand.logo?.url && !broken
        ? <div style={{ width: 30, height: 30, borderRadius: 8, background: brand.logo.bg || "#fff", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flex: "0 0 auto" }}>
            <img src={brand.logo.url} alt={brand.name} onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "contain", padding: 4 }} />
          </div>
        : <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--text-2)", flex: "0 0 auto" }}>{initials}</div>}
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{brand.name}</span>
    </div>
  );
};

export const MobileStatusBar = () => (
  <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 22px", fontSize: 14, fontWeight: 600, color: "var(--text)", flex: "0 0 auto" }}>
    <span>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    <span style={{ width: 18, height: 10, border: "1.5px solid var(--text)", borderRadius: 2, position: "relative" }}>
      <span style={{ position: "absolute", inset: 1, background: "var(--text)" }} />
    </span>
  </div>
);

export const MobileTopBar = ({ title, back, onBack, user, brand = null, menuOpen = false, onMenu = () => {}, onSignOut = () => {} }) => {
  const name = user?.displayName || user?.email || "You";
  const initials = (name.match(/\b\w/g) || ["Y"]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", borderBottom: "1px solid var(--line)", background: "var(--surface)", flex: "0 0 auto", position: "relative", zIndex: 60 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
        {back && (
          <button onClick={onBack} style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-2)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon.back /></button>
        )}
        {title
          ? <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          : <ViewixLogo size={20} />}
      </div>
      {brand && !back && !title && <ClientBrand brand={brand} />}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={onMenu} style={{
          width: 34, height: 34, borderRadius: 999,
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          color: "#fff", fontSize: 12, fontWeight: 600,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          border: menuOpen ? "2px solid var(--accent-2)" : "none",
        }}>{initials}</button>
        {menuOpen && (
          <UserMenu user={user} onSignOut={onSignOut} anchor="right" style={{ top: "calc(100% + 10px)", right: 8, width: 296 }} />
        )}
      </div>
    </div>
  );
};

// Bottom tab bar from the design's mobile shell. Two live tabs only:
// Library is a dead placeholder in the design (its own ship checklist
// says pull it) and Account already lives in the top-bar avatar menu.
export const MobileTabBar = ({ active = "Projects", onNav = () => {} }) => (
  <div style={{
    display: "flex", justifyContent: "space-around", alignItems: "center",
    borderTop: "1px solid var(--line)", background: "var(--surface)",
    padding: "10px 0 18px", flex: "0 0 auto",
    position: "sticky", bottom: 0, zIndex: 5,
  }}>
    {[
      { lbl: "Projects", icon: <Icon.film /> },
      { lbl: "Analytics", icon: <Icon.spark /> },
    ].map(t => (
      <button key={t.lbl} onClick={t.lbl === active ? undefined : () => onNav(t.lbl)} style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        padding: "0 28px",
        color: t.lbl === active ? "var(--accent)" : "var(--text-3)",
        cursor: t.lbl === active ? "default" : "pointer",
      }}>
        {t.icon}
        <span style={{ fontSize: 10, fontWeight: t.lbl === active ? 700 : 500 }}>{t.lbl}</span>
      </button>
    ))}
  </div>
);

export const MobileShell = ({ title, back, onBack, user, brand = null, menuOpen = false, onMenu = () => {}, onSignOut = () => {}, showStatusBar = true, activeTab = "Projects", onNav = null, children }) => (
  <div style={{ width: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    {showStatusBar && <MobileStatusBar />}
    <MobileTopBar title={title} back={back} onBack={onBack} user={user} brand={brand} menuOpen={menuOpen} onMenu={onMenu} onSignOut={onSignOut} />
    <div className="vx-scroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
    {onNav && <MobileTabBar active={activeTab} onNav={onNav} />}
  </div>
);
