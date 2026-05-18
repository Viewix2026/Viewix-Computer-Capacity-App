// "What this includes" — a small, collapsed drawer low on the page.
// No caveat dump up top, but the client must never feel tricked if
// they later learn stories / saves / shares weren't included. The
// honest line is server-authored (meta.whatThisIncludes).

import { useState } from "react";
import { WHAT_THIS_INCLUDES_TITLE } from "../portalCopy";

export function WhatThisIncludes({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: "var(--muted)", fontSize: 13, fontWeight: 700,
          fontFamily: "inherit", padding: "6px 2px",
          display: "inline-flex", alignItems: "center", gap: 6,
        }}>
        {WHAT_THIS_INCLUDES_TITLE}
        <span aria-hidden style={{ fontSize: 11 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 6, fontSize: 13, color: "var(--muted)",
          lineHeight: 1.6, maxWidth: 560, padding: "0 2px",
        }}>
          {text}
        </div>
      )}
    </div>
  );
}
