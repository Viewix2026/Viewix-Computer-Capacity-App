// Shared, presentational Account-Manager card (and the small AmAvatar
// helper). Used by the portal Dashboard sidebar AND the public /d/
// delivery link. Dumb on purpose: it accepts a resolved `am` block
// ({ name, photo, phone, email, bookingUrl }) and renders gracefully —
// it never fetches. The caller (Dashboard data layer, or the public
// delivery shell) is responsible for resolving `am`.

import { Label, ManagerPhoto, Icon, BtnPrimary } from "./ui";

export const AmAvatar = ({ am, size = 32 }) => {
  const initials = (String(am?.name || "VX").match(/\b\w/g) || ["V"]).slice(0, 2).join("").toUpperCase();
  return am?.photo ? (
    <img src={am.photo} alt={am.name} style={{ width: size, height: size, borderRadius: 999, objectFit: "cover", border: "2px solid var(--surface)", boxShadow: "0 0 0 1px var(--line-2)" }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: 999, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", fontSize: size * 0.4, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "2px solid var(--surface)", boxShadow: "0 0 0 1px var(--line-2)" }}>{initials}</div>
  );
};

export function AccountManagerCard({ am }) {
  const name = am?.name || "Your Viewix team";
  return (
    <div style={{ position: "relative", padding: 24, borderRadius: 16, border: "1px solid var(--line)", background: "var(--surface)", boxShadow: "0 1px 0 rgba(15,18,26,0.02)", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--orange) 0%, var(--accent) 100%)" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <Label style={{ fontSize: 10 }}>Your account manager</Label>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ok)" }}>
          <span className="vx-dot live-pulse" /><span className="mono" style={{ letterSpacing: "0.05em", textTransform: "uppercase" }}>Here for you</span>
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {am?.photo
          ? <img src={am.photo} alt={name} style={{ width: 72, height: 72, borderRadius: 16, objectFit: "cover" }} />
          : <ManagerPhoto size={72} initials={(name.match(/\b\w/g) || ["V"]).slice(0, 2).join("").toUpperCase()} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--text)" }}>{name}</div>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 2 }}>Viewix Studio</div>
        </div>
      </div>
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {am?.phone && (
          <a href={`tel:${String(am.phone).replace(/\s/g, "")}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)", textDecoration: "none" }}>
            <span style={{ color: "var(--accent)" }}><Icon.phone /></span>
            <div style={{ flex: 1, minWidth: 0 }}><Label style={{ fontSize: 10 }}>Phone</Label><div className="mono" style={{ fontSize: 14, color: "var(--text)", marginTop: 2 }}>{am.phone}</div></div>
            <Icon.arrow style={{ color: "var(--text-3)" }} />
          </a>
        )}
        <a href={`mailto:${am?.email || "hello@viewix.com.au"}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)", textDecoration: "none" }}>
          <span style={{ color: "var(--accent)" }}><Icon.mail /></span>
          <div style={{ flex: 1, minWidth: 0 }}><Label style={{ fontSize: 10 }}>Email</Label><div className="mono" style={{ fontSize: 14, color: "var(--text)", marginTop: 2 }}>{am?.email || "hello@viewix.com.au"}</div></div>
          <Icon.arrow style={{ color: "var(--text-3)" }} />
        </a>
      </div>
      {am?.bookingUrl && (
        <a href={am.bookingUrl} target="_blank" rel="noopener" style={{ textDecoration: "none", display: "block", marginTop: 14 }}>
          <BtnPrimary style={{ width: "100%", height: 48 }}>
            <Icon.cal /> Book a call with {String(name).split(" ")[0]}
            <span style={{ marginLeft: "auto", opacity: 0.85 }}><Icon.external /></span>
          </BtnPrimary>
        </a>
      )}
    </div>
  );
}
