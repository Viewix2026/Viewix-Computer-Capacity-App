// Scripts section: format group headers + script rows with reactions
// + threaded comments. Ported from the handover's cockpit-scripts.jsx.
import { useState } from "react";
import { C } from "./ClientReviewUI";

// Format group header — coloured stripe, hero "reference" tile that
// links to the format's first example URL (Instagram or TikTok),
// blurb, and a Watch reference CTA on the right.
export function FormatGroupHeader({ format, color, count }) {
  const ref = format.ref || "@reference";
  const url = format.refUrl;
  const Wrapper = ({ children, ...rest }) => (
    url
      ? <a href={url} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>
      : <div {...rest}>{children}</div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "96px 1fr auto", gap: 18, alignItems: "center", padding: "16px 18px", background: C.card, border: `1px solid ${color.fg}33`, borderLeft: `4px solid ${color.fg}`, borderRadius: 12, marginTop: 22, marginBottom: 10 }}>
      <Wrapper
        title={url ? `Watch ${ref} reference` : "No reference linked"}
        style={{ display: "block", textDecoration: "none", cursor: url ? "pointer" : "default", position: "relative", aspectRatio: "9 / 16", width: "100%", borderRadius: 8, overflow: "hidden", background: `linear-gradient(135deg, ${color.bg} 0%, ${C.bgDim} 100%)`, border: `1px solid ${C.rule}`, transition: "border-color .12s, transform .12s" }}
        onMouseEnter={url ? (e) => { e.currentTarget.style.borderColor = color.fg + "88"; e.currentTarget.style.transform = "translateY(-1px)"; } : undefined}
        onMouseLeave={url ? (e) => { e.currentTarget.style.borderColor = C.rule; e.currentTarget.style.transform = "none"; } : undefined}
      >
        <div style={{ position: "absolute", inset: 0, opacity: 0.4, background: `repeating-linear-gradient(45deg, transparent 0 10px, ${color.fg}10 10px 11px)` }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 36, height: 36, borderRadius: 999, background: "rgba(255,255,255,0.96)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 12px rgba(11,18,32,0.18)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill={color.fg}><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "8px 6px 5px", background: "linear-gradient(to top, rgba(11,18,32,0.7), transparent)" }}>
          <div style={{ font: '600 9.5px/1.2 "JetBrains Mono", monospace', color: "#fff", letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ref}</div>
        </div>
      </Wrapper>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
          <h3 style={{ font: '700 17px/1.2 "Montserrat", sans-serif', color: C.ink, margin: 0, letterSpacing: "-0.01em" }}>{format.title}</h3>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 4, background: color.bg, color: color.fg, font: '700 10.5px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase" }}>
            <span style={{ width: 5, height: 5, borderRadius: 999, background: color.fg }} />
            {count} script{count === 1 ? "" : "s"} in this style
          </span>
        </div>
        <p style={{ font: '400 13px/1.55 "Montserrat", sans-serif', color: C.ink2, margin: 0, textWrap: "pretty", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{format.blurb}</p>
      </div>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.08em", textTransform: "uppercase", color: color.fg, padding: "9px 12px", borderRadius: 6, border: `1px solid ${color.fg}55`, background: color.bg, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", alignSelf: "center" }}>
          Watch reference
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M7 17 17 7M7 7h10v10" /></svg>
        </a>
      )}
    </div>
  );
}

// Reactions and comments are written via two granular callbacks
// (onReaction, onAddComment) rather than a single onState. Rapid
// "click love → type comment" used to merge from a stale `state`
// snapshot before Firebase echoed back, so the comment write could
// overwrite the reaction. Granular writes to `scriptFeedback/{id}/
// reaction` and `scriptFeedback/{id}/comments/{cid}` can't race
// because they touch different paths.
export function ScriptRow({ s, expanded, onToggle, color, state, onReaction, onAddComment }) {
  const reaction = state?.reaction || null;
  // Object-shape comments → array for rendering; sorted by `at` ascending.
  const commentMap = state?.comments || {};
  const comments = Object.entries(commentMap)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  function setReaction(r) {
    onReaction(r === reaction ? null : r);
  }
  function addComment(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAddComment(newCommentId(), { text: trimmed, at: Date.now(), resolved: false, resolvedAt: null });
  }

  const hasFeedback = !!reaction || comments.length > 0;

  return (
    <div data-script={s.n} style={{ background: C.card, border: `1px solid ${hasFeedback ? color.fg + "55" : C.rule}`, borderRadius: 12, overflow: "hidden", transition: "border-color .15s, box-shadow .15s", boxShadow: hasFeedback ? `0 0 0 3px ${color.fg}10` : "none" }}>
      <div style={{ display: "grid", gridTemplateColumns: "44px 1.1fr 1.1fr 1.1fr", gap: 22, alignItems: "start", padding: "20px 22px" }}>
        <div style={{ width: 38, height: 38, borderRadius: 8, background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", font: '700 14px/1 "JetBrains Mono", monospace', color: C.ink, position: "relative" }}>
          {String(s.n).padStart(2, "0")}
          {hasFeedback && <span style={{ position: "absolute", top: -4, right: -4, width: 12, height: 12, borderRadius: 999, background: reaction === "cut" ? C.red : reaction === "love" ? C.green : color.fg, border: "2px solid #fff" }} />}
        </div>
        <HookCell label="Spoken Hook" value={s.hookSpoken} italic />
        <HookCell label="Text Hook"   value={s.textHook}   uppercase />
        <HookCell label="Visual Hook" value={s.visualHook} />
      </div>

      <div style={{ borderTop: `1px solid ${C.ruleSoft}` }}>
        <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 22px", background: expanded ? C.bg : "transparent", border: "none", cursor: "pointer", font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.1em", textTransform: "uppercase", color: C.ink2, transition: "background .12s" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            {expanded ? "Hide full script & props" : "View full script & props"}
          </span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)", transition: "transform .15s" }}><path d="m6 9 6 6 6-6" /></svg>
        </button>

        {expanded && (
          <div style={{ background: C.bg, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 0, borderTop: `1px solid ${C.ruleSoft}` }}>
            <div style={{ padding: "22px 24px", borderRight: `1px solid ${C.rule}` }}>
              <DetailLabel><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg> Script & shot notes</DetailLabel>
              <p style={{ font: '400 13.5px/1.7 "Montserrat", sans-serif', color: C.ink2, margin: 0, whiteSpace: "pre-wrap", textWrap: "pretty" }}>{s.notes || "—"}</p>
            </div>
            <div style={{ padding: "22px 24px" }}>
              <DetailLabel><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg> Props & requirements</DetailLabel>
              <p style={{ font: '400 13px/1.65 "Montserrat", sans-serif', color: C.ink2, margin: 0 }}>{s.props || "—"}</p>
            </div>
          </div>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${C.rule}`, background: C.card, padding: "18px 22px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.14em", textTransform: "uppercase", marginRight: 4 }}>Quick take</div>
          <ReactionPill active={reaction === "love"} color={C.green} bg={C.greenBg} onClick={() => setReaction("love")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
            Love it
          </ReactionPill>
          <ReactionPill active={reaction === "tweak"} color={C.orangeDk} bg={C.orangeBg} onClick={() => setReaction("tweak")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            Tweak this
          </ReactionPill>
          <ReactionPill active={reaction === "cut"} color={C.red} bg={C.redBg} onClick={() => setReaction("cut")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
            Cut it
          </ReactionPill>
          {comments.length > 0 && (
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, font: '600 11px/1 "Montserrat", sans-serif', color: color.fg, padding: "4px 9px", background: color.bg, borderRadius: 999 }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              {comments.length} {comments.length === 1 ? "comment" : "comments"}
            </span>
          )}
        </div>

        <div style={{ height: 1, background: C.ruleSoft, margin: "18px 0" }} />

        <CommentThread comments={comments} onAdd={addComment} />
      </div>
    </div>
  );
}

function HookCell({ label, value, italic, uppercase }) {
  const trimmed = (value || "").trim();
  const isEmpty = !trimmed || trimmed === "—";
  return (
    <div>
      <div style={{ font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      {isEmpty ? (
        <div style={{ font: '500 13px/1.5 "Montserrat", sans-serif', color: C.mute }}>—</div>
      ) : italic ? (
        <div style={{ font: '500 14px/1.5 "Montserrat", sans-serif', color: C.ink, fontStyle: "italic" }}>&ldquo;{trimmed}&rdquo;</div>
      ) : uppercase ? (
        <div style={{ font: '600 13.5px/1.4 "Montserrat", sans-serif', color: C.ink2, letterSpacing: "0.02em" }}>{trimmed}</div>
      ) : (
        <div style={{ font: '400 13.5px/1.55 "Montserrat", sans-serif', color: C.ink2 }}>{trimmed}</div>
      )}
    </div>
  );
}

function DetailLabel({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, font: '600 10px/1 "Montserrat", sans-serif', color: C.mute, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 12 }}>
      {children}
    </div>
  );
}

function ReactionPill({ active, color, bg, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase",
      color: active ? color : C.ink2,
      background: active ? bg : C.card,
      border: `1px solid ${active ? color : C.rule}`,
      padding: "8px 11px", borderRadius: 999, cursor: "pointer", transition: "all .12s",
    }}>{children}</button>
  );
}

function CommentThread({ comments, onAdd }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(comments.length === 0);

  function submit() {
    onAdd(draft);
    setDraft("");
  }

  return (
    <div>
      {comments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
          {comments.map((c) => (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "30px 1fr", gap: 10, alignItems: "start" }}>
              <div style={{ width: 30, height: 30, borderRadius: 999, background: C.blueBg, color: C.blueDk, display: "flex", alignItems: "center", justifyContent: "center", font: '700 12px/1 "Montserrat", sans-serif' }}>YOU</div>
              <div style={{ padding: "10px 14px", background: C.bg, borderRadius: 10, border: `1px solid ${C.ruleSoft}`, opacity: c.resolved ? 0.55 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ font: '600 11.5px/1 "Montserrat", sans-serif', color: C.ink }}>You{c.resolved && <span style={{ marginLeft: 6, color: C.greenDk }}>· Resolved</span>}</div>
                  <div style={{ font: '500 11px/1 "Montserrat", sans-serif', color: C.mute }}>{c.at ? new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</div>
                </div>
                <div style={{ font: '400 13.5px/1.55 "Montserrat", sans-serif', color: C.ink2, whiteSpace: "pre-wrap", textDecoration: c.resolved ? "line-through" : "none" }}>{c.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!open && comments.length > 0 ? (
        <button onClick={() => setOpen(true)} style={{ font: '600 11px/1 "Montserrat", sans-serif', color: C.blue, background: "transparent", border: "none", cursor: "pointer", padding: 0, letterSpacing: "0.04em" }}>+ Add another comment</button>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "30px 1fr", gap: 10, alignItems: "start" }}>
          <div style={{ width: 30, height: 30, borderRadius: 999, background: C.blueBg, color: C.blueDk, display: "flex", alignItems: "center", justifyContent: "center", font: '700 12px/1 "Montserrat", sans-serif' }}>YOU</div>
          <div style={{ border: `1px solid ${C.rule}`, borderRadius: 10, overflow: "hidden", background: C.card }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a comment on this script…"
              rows={2}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
              style={{ width: "100%", border: "none", padding: "10px 14px", font: '400 13.5px/1.55 "Montserrat", sans-serif', color: C.ink, background: "#fff", resize: "vertical", outline: "none", boxSizing: "border-box", minHeight: 60 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderTop: `1px solid ${C.ruleSoft}`, background: C.bg }}>
              <div style={{ font: '500 11px/1 "Montserrat", sans-serif', color: C.muteSoft }}>⌘ + Enter to submit</div>
              <button onClick={submit} disabled={!draft.trim()} style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: "#fff", background: !draft.trim() ? C.muteSoft : C.ink, border: "none", padding: "8px 14px", borderRadius: 6, cursor: !draft.trim() ? "not-allowed" : "pointer" }}>Comment</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Generate a short, sortable id for a new comment. Uses
// crypto.randomUUID when available (all modern browsers do) and falls
// back to a Math.random-based stamp otherwise — only the *uniqueness*
// matters, not cryptographic strength, because these keys go straight
// into a Firebase object next to the parent script's reviewId.
function newCommentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `c_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
