// Staff-side "Portal access" admin for one account. Rendered inside the
// AccountsDashboard expanded panel. Uses the staff dark theme (this is
// internal UI, NOT the .vx client portal). All mutations go through
// /api/admin-client-access (Admin SDK, founder-gated) — never RTDB:
// the registry nodes are .read:false/.write:false.
import { useState, useEffect, useCallback } from "react";
import { authFetch } from "../../firebase";

const box = { padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
const btn = (bg, fg) => ({ padding: "5px 10px", borderRadius: 4, border: "none", background: bg, color: fg, fontSize: 11, fontWeight: 700, cursor: "pointer" });

// Map the server's inviteEmail state + reason (send() result, or one of the
// grant-path markers) to a founder-readable line. Returns null when there's
// nothing worth surfacing. `skipped` and `failed` carry distinct reasons, so
// we branch on reason rather than collapsing every skip into one (false) line.
function inviteMessage(stateVal, reason = "") {
  switch (stateVal) {
    case "sent":              return { text: "Invite sent to the client.", tone: "ok" };
    case "dryRun":            return { text: "Invite previewed to Slack (dry-run mode).", tone: "info" };
    case "noop":              return { text: "Emails are paused (kill switch) — invite not sent.", tone: "warn" };
    case "skipped_regrant":   return { text: "Already invited to this org — not re-sent. Use Resend to send again.", tone: "info" };
    case "skipped_notifyOff": return { text: "Access granted. Invite not sent (you unchecked notify).", tone: "info" };
    case "skipped":
      switch (reason) {
        case "already_sent":    return { text: "Already invited — not re-sent. Use Resend to send again.", tone: "info" };
        case "in_flight":       return { text: "Invite is already sending…", tone: "info" };
        case "missing_base_url":return { text: "Invite not sent — portal URL not configured (PUBLIC_BASE_URL).", tone: "warn" };
        case "account_not_found":return { text: "Invite not sent — account record not found.", tone: "warn" };
        case "missing_to":
        case "missing_subject":
        case "missing_account":
        case "missing_key":     return { text: "Invite not sent — missing recipient or required data.", tone: "warn" };
        default:                return { text: `Invite skipped${reason ? ` (${reason})` : ""}.`, tone: "warn" };
      }
    case "failed":            return { text: `Invite failed to send${reason ? `: ${reason}` : " — check the email log."}`, tone: "warn" };
    case undefined:
    case null:                return null;
    default:                  return { text: `Invite status: ${stateVal}`, tone: "info" };
  }
}

const noticeColor = { ok: "#10B981", info: "var(--muted)", warn: "#F59E0B" };

export function AccountPortalAccess({ accountId }) {
  const [state, setState] = useState({ loading: true, error: "", live: {}, candidates: {} });
  const [busy, setBusy] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [notify, setNotify] = useState(true);
  const [notice, setNotice] = useState(null); // { text, tone } from inviteMessage

  const call = useCallback(async (body) => {
    const r = await authFetch("/api/admin-client-access", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, accountId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }, [accountId]);

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: "" }));
    try {
      const j = await call({ action: "list" });
      setState({ loading: false, error: "", live: j.live || {}, candidates: j.candidates || {} });
    } catch (e) {
      setState({ loading: false, error: e.message, live: {}, candidates: {} });
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);

  const act = async (key, body) => {
    setBusy(key);
    try { const j = await call(body); await refresh(); return j; }
    catch (e) { setState(s => ({ ...s, error: e.message })); return null; }
    finally { setBusy(""); }
  };

  const live = Object.entries(state.live || {});
  const cands = Object.entries(state.candidates || {});

  return (
    <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Client portal access
        </div>
        <button onClick={() => act("backfill", { action: "backfill" })} disabled={busy === "backfill"}
          style={{ ...btn("var(--bg)", "var(--accent)"), border: "1px solid var(--border)" }}>
          {busy === "backfill" ? "Seeding…" : "Seed candidates from project contacts"}
        </button>
      </div>

      {state.loading ? (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div>
      ) : (
        <>
          {state.error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 8 }}>{state.error}</div>}
          {notice && <div style={{ fontSize: 12, color: noticeColor[notice.tone] || "var(--muted)", marginBottom: 8 }}>{notice.text}</div>}

          {/* Add form */}
          <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="client@company.com" style={{ ...box, flex: "1 1 200px" }} />
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Display name (optional)" style={{ ...box, flex: "1 1 160px" }} />
            <button
              onClick={async () => {
                if (!email.includes("@")) return;
                const j = await act("add", { action: "add", email, displayName: name, notify });
                if (j) { setEmail(""); setName(""); setNotice(inviteMessage(j.inviteEmail, j.inviteEmailReason)); }
              }}
              disabled={busy === "add"} style={btn("var(--accent)", "#fff")}>
              {busy === "add" ? "Adding…" : "Grant access"}
            </button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", marginBottom: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} style={{ cursor: "pointer" }} />
            Notify the client now
          </label>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.4 }}>
            Granting access emails the client a portal invite (from their account manager, if one is set). Uncheck to grant silently — you can send it later with Resend.
          </div>

          {/* Live access list */}
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
            Has access ({live.length})
          </div>
          {live.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>No one yet.</div>}
          {live.map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: "var(--fg)", fontWeight: 600 }}>{v.displayName || v.email}</span>
                <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8, fontFamily: "'JetBrains Mono',monospace" }}>{v.email}</span>
              </div>
              <button
                onClick={async () => {
                  const j = await act(`re:${k}`, { action: "resend", email: v.email, displayName: v.displayName });
                  if (j) setNotice(inviteMessage(j.inviteEmail, j.inviteEmailReason));
                }}
                disabled={busy === `re:${k}`} style={{ ...btn("var(--bg)", "var(--accent)"), border: "1px solid var(--border)" }}>
                {busy === `re:${k}` ? "…" : "Resend invite"}
              </button>
              <button onClick={() => act(`rm:${k}`, { action: "remove", email: v.email })} disabled={busy === `rm:${k}`} style={btn("var(--bg)", "#EF4444")}>
                {busy === `rm:${k}` ? "…" : "Revoke"}
              </button>
            </div>
          ))}

          {/* Candidate review queue */}
          {cands.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
                Awaiting review ({cands.length}) — seeded from project contacts, grants nothing until approved
              </div>
              {cands.map(([k, v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, color: "var(--fg)", fontFamily: "'JetBrains Mono',monospace" }}>{v.email}</span>
                    <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 8 }}>{v.source || "candidate"}</span>
                  </div>
                  <button
                    onClick={async () => {
                      const j = await act(`ap:${k}`, { action: "approve", email: v.email, notify });
                      if (j) setNotice(inviteMessage(j.inviteEmail, j.inviteEmailReason));
                    }}
                    disabled={busy === `ap:${k}`} style={btn("#10B981", "#fff")}>
                    {busy === `ap:${k}` ? "…" : "Approve"}
                  </button>
                  <button onClick={() => act(`dm:${k}`, { action: "dismiss", email: v.email })} disabled={busy === `dm:${k}`} style={btn("var(--bg)", "var(--muted)")}>
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
