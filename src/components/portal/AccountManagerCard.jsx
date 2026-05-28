// Shared, presentational Account-Manager card (and the small AmAvatar
// helper). Used by the portal Dashboard sidebar AND the public /d/
// delivery link. Dumb on purpose: it accepts a resolved `am` block
// ({ name, photo, phone, email, bookingUrl }) and renders gracefully —
// it never fetches. The caller (Dashboard data layer, or the public
// delivery shell) is responsible for resolving `am`.

import { ManagerPhoto, Icon, BtnPrimary } from "./ui";

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
      {/* Header chip + "Here for you" pulse removed — the name + role
          line below speaks for itself; the card already reads as "your AM"
          from context (sidebar of /d/ + portal Dashboard). */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {am?.photo
          ? <img src={am.photo} alt={name} style={{ width: 72, height: 72, borderRadius: 16, objectFit: "cover" }} />
          : <ManagerPhoto size={72} initials={(name.match(/\b\w/g) || ["V"]).slice(0, 2).join("").toUpperCase()} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--text)" }}>{name}</div>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 2 }}>Account Manager</div>
        </div>
      </div>
      {/* Phone + email are information rows, not links. The actionable
          channel is the booking button below — keep one clear call-to-
          action; the contact details are reference-only. */}
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {am?.phone && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)" }}>
            <span style={{ color: "var(--accent)" }}><Icon.phone /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600 }}>Phone</div>
              <div className="mono" style={{ fontSize: 14, color: "var(--text)", marginTop: 2 }}>{am.phone}</div>
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)" }}>
          <span style={{ color: "var(--accent)" }}><Icon.mail /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600 }}>Email</div>
            <div className="mono" style={{ fontSize: 14, color: "var(--text)", marginTop: 2 }}>{am?.email || "hello@viewix.com.au"}</div>
          </div>
        </div>
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
