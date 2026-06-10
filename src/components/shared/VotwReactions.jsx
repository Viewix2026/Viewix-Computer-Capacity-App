// Emoji reactions for the Video of the Week card (Home page).
// Slack-style: a row of reaction chips (emoji + count) plus a "+" picker.
// Everyone on the team can react; each user only ever writes their own
// uid, so one person can't clear another's reaction.
//
// Storage: /votwReactions/<videoKey>/<emoji>/<uid> = reactor's display
// name. videoKey is a stable hash of the current video URL, so when a
// founder posts a NEW video the reaction set is naturally fresh — last
// week's reactions live under the old key and simply aren't read.
// (Rules: votwReactions readable by any team member, each $uid leaf
// writable only by that user — see firebase-rules.json.)
import { useEffect, useState } from "react";
import {
  fbListen, onFB, fbSet,
  getCurrentUserUid, getCurrentUserName, getCurrentUserEmail,
} from "../../firebase";

// Quick palette in the "+" picker. The bar itself only shows emojis that
// have at least one reaction, so it stays compact until people engage.
const PALETTE = ["🎉", "😍", "🔥", "❤️", "👏", "👍", "🙌", "💯", "😂", "🤯", "🚀", "👀"];

// Deterministic, RTDB-key-safe id from the video URL (djb2 → base36).
// Emojis are valid RTDB keys; URLs are not (they contain . / # $ [ ]).
// Exported — VotwComments keys its threads off the same hash so comments
// and reactions roll over together when a new video is posted.
export function videoKeyFromUrl(url) {
  const s = String(url || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "v" + h.toString(36);
}

export function VotwReactions({ videoUrl }) {
  const videoKey = videoKeyFromUrl(videoUrl);
  // Shape: { "🎉": { uid: "Display Name", ... }, ... }
  const [reactions, setReactions] = useState({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const uid = getCurrentUserUid();
  const myName = getCurrentUserName() || getCurrentUserEmail() || "Someone";

  useEffect(() => {
    setReactions({});
    if (!videoUrl) return;
    // Plain fbListen, auth-gated via onFB — NOT fbListenSafe. An empty
    // node is a meaningful state here: when another user removes the
    // last reaction the node goes null, and the safe wrapper swallows
    // that fire, leaving the removed chips rendered on every other
    // open client until an unrelated write.
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(`/votwReactions/${videoKey}`, d => setReactions(d || {}), () => {});
    });
    return () => { cancelled = true; try { off(); } catch {} };
  }, [videoKey, videoUrl]);

  if (!videoUrl) return null;

  const toggle = (emoji) => {
    if (!uid) return;
    const mine = !!reactions?.[emoji]?.[uid];
    // Optimistic — the listener reconciles on round-trip.
    setReactions(prev => {
      const next = { ...prev };
      const users = { ...(next[emoji] || {}) };
      if (mine) {
        delete users[uid];
        if (Object.keys(users).length === 0) delete next[emoji];
        else next[emoji] = users;
      } else {
        users[uid] = myName;
        next[emoji] = users;
      }
      return next;
    });
    fbSet(`/votwReactions/${videoKey}/${emoji}/${uid}`, mine ? null : myName);
    setPickerOpen(false);
  };

  // Emojis with ≥1 reaction, in palette order first then any extras.
  const active = Object.keys(reactions || {})
    .filter(e => reactions[e] && Object.keys(reactions[e]).length > 0)
    .sort((a, b) => {
      const ia = PALETTE.indexOf(a), ib = PALETTE.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  const chip = (emoji) => {
    const users = reactions[emoji] || {};
    const names = Object.values(users);
    const count = names.length;
    const mine = !!users[uid];
    return (
      <button
        key={emoji}
        onClick={() => toggle(emoji)}
        title={names.join(", ")}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "3px 9px", borderRadius: 999, cursor: "pointer",
          fontSize: 13, lineHeight: 1, userSelect: "none",
          background: mine ? "rgba(139,92,246,0.18)" : "var(--bg)",
          border: `1px solid ${mine ? "var(--accent)" : "var(--border)"}`,
          color: "var(--fg)", transition: "all 0.12s",
        }}
      >
        <span style={{ fontSize: 14 }}>{emoji}</span>
        {count > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: mine ? "var(--accent)" : "var(--muted)" }}>{count}</span>}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 12, position: "relative" }}>
      {active.map(chip)}

      {/* "+" picker trigger */}
      <button
        onClick={() => setPickerOpen(o => !o)}
        title="Add reaction"
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "3px 9px", borderRadius: 999, cursor: "pointer",
          fontSize: 13, lineHeight: 1,
          background: "var(--bg)", border: "1px solid var(--border)",
          color: "var(--muted)",
        }}
      >
        <span style={{ fontSize: 14 }}>🙂</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>+</span>
      </button>

      {pickerOpen && (
        <>
          {/* click-away backdrop */}
          <div onClick={() => setPickerOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
          <div
            style={{
              position: "absolute", top: "100%", left: 0, marginTop: 6, zIndex: 31,
              display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 2,
              padding: 8, background: "var(--card)", border: "1px solid var(--border)",
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            }}
          >
            {PALETTE.map(emoji => (
              <button
                key={emoji}
                onClick={() => toggle(emoji)}
                style={{
                  width: 32, height: 32, fontSize: 18, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: reactions?.[emoji]?.[uid] ? "rgba(139,92,246,0.18)" : "transparent",
                  border: "none", borderRadius: 8, transition: "background 0.1s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--bg)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = reactions?.[emoji]?.[uid] ? "rgba(139,92,246,0.18)" : "transparent"; }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
