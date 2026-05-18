// Staff-side "Portal access" admin for one account. Rendered inside the
// AccountsDashboard expanded panel. Uses the staff dark theme (this is
// internal UI, NOT the .vx client portal). All mutations go through
// /api/admin-client-access (Admin SDK, founder-gated) — never RTDB:
// the registry nodes are .read:false/.write:false.
import { useState, useEffect, useCallback } from "react";
import { authFetch } from "../../firebase";

const box = { padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
const btn = (bg, fg) => ({ padding: "5px 10px", borderRadius: 4, border: "none", background: bg, color: fg, fontSize: 11, fontWeight: 700, cursor: "pointer" });

export function AccountPortalAccess({ accountId }) {
  const [state, setState] = useState({ loading: true, error: "", live: {}, candidates: {} });
  const [busy, setBusy] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

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
    try { await call(body); await refresh(); }
    catch (e) { setState(s => ({ ...s, error: e.message })); }
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

          {/* Add form */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="client@company.com" style={{ ...box, flex: "1 1 200px" }} />
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Display name (optional)" style={{ ...box, flex: "1 1 160px" }} />
            <button
              onClick={async () => { if (!email.includes("@")) return; await act("add", { action: "add", email, displayName: name }); setEmail(""); setName(""); }}
              disabled={busy === "add"} style={btn("var(--accent)", "#fff")}>
              {busy === "add" ? "Adding…" : "Grant access"}
            </button>
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
                  <button onClick={() => act(`ap:${k}`, { action: "approve", email: v.email })} disabled={busy === `ap:${k}`} style={btn("#10B981", "#fff")}>
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
