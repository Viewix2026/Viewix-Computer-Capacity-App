import { useState } from "react";
import { normaliseImageUrl } from "../utils";

// Top-right "who's logged in" chip. Shows the signed-in user's name and
// avatar, sourced from the Team Roster (/editors) by matching the Google
// account email against each roster entry's `email`. Falls back to the
// Google profile (displayName / photoURL) when there's no roster match,
// then to the email local-part, so the chip never renders blank.
//
// Display-only — logout still lives in the sidebar. Fixed to the viewport
// top-right so it stays put across tabs (each tab renders its own
// left-aligned header, leaving the top-right corner free).
export function UserBadge({ editors, email, name, photoURL }) {
  const [imgFailed, setImgFailed] = useState(false);

  const lcEmail = (email || "").trim().toLowerCase();
  const roster = Array.isArray(editors) && lcEmail
    ? editors.find(e => e && (e.email || "").trim().toLowerCase() === lcEmail)
    : null;

  // Name: prefer the roster name, then the Google display name, then the
  // email local-part, then a neutral label.
  const displayName =
    (roster?.name || "").trim() ||
    (name || "").trim() ||
    (lcEmail ? lcEmail.split("@")[0] : "") ||
    "Account";

  // Avatar: prefer the roster's avatarUrl (run through normaliseImageUrl
  // so pasted Google Drive share links resolve), then the Google photo.
  const rosterSrc = normaliseImageUrl(roster?.avatarUrl || "", 96);
  const avatarSrc = !imgFailed ? (rosterSrc || photoURL || "") : "";

  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase();

  return (
    <div
      title={email || displayName}
      style={{
        position: "fixed",
        top: 12,
        right: 16,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "5px 12px 5px 5px",
        borderRadius: 999,
        background: "var(--card)",
        border: "1px solid var(--border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        maxWidth: 240,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: "50%",
          overflow: "hidden",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, var(--accent) 0%, #004F99 100%)",
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.04em",
        }}
      >
        {avatarSrc ? (
          <img
            src={avatarSrc}
            alt={displayName}
            onError={() => setImgFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <span>{initials || "?"}</span>
        )}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--fg)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {displayName}
      </span>
    </div>
  );
}
