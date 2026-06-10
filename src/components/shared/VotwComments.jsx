// Comments for the Video of the Week card (Home page). Sits below the
// emoji reactions — same idea: everyone on the team can comment, each
// user owns their own comments (author-only edit/delete, enforced by
// rules), and the thread naturally resets when a founder posts a new
// video because the storage key is hashed from the video URL.
//
// Storage: /votwComments/<videoKey>/<commentId> = { uid, name, text, ts }
// (Rules: readable by any team member; create requires uid === auth.uid,
// edit/delete only by the author — see firebase-rules.json.)
//
// Visual language: the Unified Design System's discussion pattern —
// avatar circle + name + relative time on a nested inset card, with an
// inset composer row and an accent send button.
import { useEffect, useState } from "react";
import {
  fbListen, onFB, fbSet,
  getCurrentUserUid, getCurrentUserName, getCurrentUserEmail,
} from "../../firebase";
import { Icon } from "../Icon";
import { videoKeyFromUrl } from "./VotwReactions";
import { rosterNameForEmail } from "../../utils";

const SANS = "'DM Sans', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// Same hue trick as the kit's Monogram — stable colour per name.
function hueFor(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function VotwComments({ videoUrl, editors }) {
  const videoKey = videoKeyFromUrl(videoUrl);
  // Shape: { id: { uid, name, text, ts }, ... }
  const [comments, setComments] = useState({});
  const [draft, setDraft] = useState("");
  const [hoverId, setHoverId] = useState(null);
  const uid = getCurrentUserUid();
  // Same name resolution as the header UserBadge: Team Roster name first
  // ("Jeremy"), then the Google display name, then the email.
  const myName = rosterNameForEmail(editors, getCurrentUserEmail())
    || getCurrentUserName() || getCurrentUserEmail() || "Someone";

  useEffect(() => {
    setComments({});
    if (!videoUrl) return;
    // Plain fbListen (not fbListenSafe) for the same reason as reactions:
    // an empty node is meaningful — when the last comment is deleted the
    // node goes null and every open client must clear its list.
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(`/votwComments/${videoKey}`, d => setComments(d || {}), () => {});
    });
    return () => { cancelled = true; try { off(); } catch {} };
  }, [videoKey, videoUrl]);

  if (!videoUrl) return null;

  const post = () => {
    const text = draft.trim();
    if (!text || !uid) return;
    const id = `c${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const comment = { uid, name: myName, text, ts: Date.now() };
    // Optimistic — the listener reconciles on round-trip.
    setComments(prev => ({ ...prev, [id]: comment }));
    fbSet(`/votwComments/${videoKey}/${id}`, comment);
    setDraft("");
  };

  const remove = (id) => {
    setComments(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    fbSet(`/votwComments/${videoKey}/${id}`, null);
  };

  const ordered = Object.entries(comments || {})
    .filter(([, c]) => c && c.text)
    .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));

  return (
    <div style={{ marginTop: 18 }}>
      {/* dotted section header, kit-style */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--purple)" }} />
        <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--fg)" }}>Comments</span>
        {ordered.length > 0 && <>
          <span style={{ color: "var(--faint)" }}>·</span>
          <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{ordered.length}</span>
        </>}
      </div>

      {ordered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {ordered.map(([id, c]) => {
            const hue = hueFor(c.name || "");
            const mine = c.uid === uid;
            return (
              <div key={id} onMouseEnter={() => setHoverId(id)} onMouseLeave={() => setHoverId(null)}
                style={{ background: "var(--inset)", border: "1px solid var(--border-soft)", borderRadius: "var(--r3)", padding: "11px 13px", position: "relative" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: "50%", flex: "0 0 auto",
                    background: `linear-gradient(145deg, oklch(0.45 0.13 ${hue}) 0%, oklch(0.32 0.10 ${hue + 22}) 100%)`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: SANS, fontWeight: 800, fontSize: 10, color: "rgba(255,255,255,0.94)",
                  }}>{(c.name || "?").trim()[0]?.toUpperCase() || "?"}</div>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 700, color: "var(--fg)" }}>{c.name}</span>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: "var(--muted)" }}>· {relTime(c.ts)}</span>
                  {mine && hoverId === id && (
                    <button onClick={() => remove(id)} title="Delete comment" style={{
                      marginLeft: "auto", width: 20, height: 20, borderRadius: 6, border: "none", cursor: "pointer",
                      background: "rgba(242,84,91,0.14)", color: "var(--danger)", fontSize: 12, lineHeight: 1,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>×</button>
                  )}
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* composer — inset row + accent send, per the design's discussion pattern */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, height: 44, padding: "0 6px 0 14px", borderRadius: "var(--r3)", border: "1px solid var(--border)", background: "var(--inset)" }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); } }}
          placeholder="Add a comment…"
          maxLength={2000}
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: SANS, fontSize: 13, color: "var(--fg)" }}
        />
        <button onClick={post} disabled={!draft.trim()} title="Post comment" style={{
          width: 32, height: 32, borderRadius: 8, border: "none", flex: "0 0 auto",
          background: draft.trim() ? "var(--accent)" : "var(--card-2)",
          color: draft.trim() ? "#fff" : "var(--muted)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: draft.trim() ? "pointer" : "default", transition: "all 0.15s",
        }}><Icon name="arrowup" size={15} sw={2.2} /></button>
      </div>
    </div>
  );
}
