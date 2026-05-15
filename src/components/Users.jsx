// Users — founder-only admin tab for managing dashboard accounts.
//
// Lists every user record in /users (real + pending stubs), with controls
// to add new invites, change roles, deactivate/reactivate, and delete.
//
// All mutations go through /api/admin-users (Admin SDK). Direct client
// writes to /users are blocked by firebase-rules.json — this is by design,
// the server endpoint validates the operation and applies side effects
// (revokeRefreshTokens, setCustomUserClaims) that rules can't do.

import { useEffect, useMemo, useState } from "react";
import { fbListenSafe, authFetch, getCurrentUserUid } from "../firebase";
import { ROLES, ROLE_LABELS } from "../lib/roles";
import { BTN } from "../config";

const fmtDate = (ms) => {
  if (!ms) return "—";
  const d = new Date(ms);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};

export function Users() {
  const [users, setUsers] = useState({});
  const [busy, setBusy] = useState({});
  const [err, setErr] = useState("");

  // Add-user form
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("editor");
  const [inviting, setInviting] = useState(false);

  useEffect(() => fbListenSafe("/users", d => setUsers(d || {})), []);

  const myUid = getCurrentUserUid();

  const rows = useMemo(() => {
    return Object.entries(users)
      .map(([uid, rec]) => ({ uid, ...(rec || {}) }))
      .sort((a, b) => {
        // Pending stubs at the bottom; otherwise alphabetical by email.
        if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
        return (a.email || "").localeCompare(b.email || "");
      });
  }, [users]);

  const call = async (action, body, opKey) => {
    setErr("");
    setBusy(b => ({ ...b, [opKey]: true }));
    try {
      const r = await authFetch("/api/admin-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Failed (${r.status})`);
      return data;
    } catch (e) {
      setErr(e.message);
      throw e;
    } finally {
      setBusy(b => ({ ...b, [opKey]: false }));
    }
  };

  const onInvite = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) { setErr("Valid email required"); return; }
    setInviting(true);
    try {
      await call("invite", { email, role: newRole }, "_invite");
      setNewEmail("");
      setNewRole("editor");
    } catch {} finally {
      setInviting(false);
    }
  };

  const onChangeRole = async (uid, role) => {
    await call("setRole", { targetUid: uid, role }, `role:${uid}`).catch(() => {});
  };
  const onToggleActive = async (uid, active) => {
    await call("setActive", { targetUid: uid, active }, `active:${uid}`).catch(() => {});
  };
  const onDelete = async (uid, email) => {
    if (!window.confirm(`Delete ${email}? This removes their record and revokes their tokens.`)) return;
    await call("delete", { targetUid: uid }, `del:${uid}`).catch(() => {});
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 28px 60px" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Users</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24 }}>
        Add someone by email + role. They sign in with the same Google address — we don't email a link.
      </div>

      {/* Invite form */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20, padding: "14px 16px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <input
          type="email"
          value={newEmail}
          onChange={e => { setNewEmail(e.target.value); setErr(""); }}
          onKeyDown={e => { if (e.key === "Enter") onInvite(); }}
          placeholder="someone@example.com"
          disabled={inviting}
          style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 14, outline: "none" }}
        />
        <select
          value={newRole}
          onChange={e => setNewRole(e.target.value)}
          disabled={inviting}
          style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 14, outline: "none" }}
        >
          {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
        </select>
        <button
          onClick={onInvite}
          disabled={inviting || !newEmail.trim()}
          style={{ ...BTN, background: "var(--accent)", color: "white", opacity: (inviting || !newEmail.trim()) ? 0.6 : 1 }}
        >
          {inviting ? "Adding..." : "Add user"}
        </button>
      </div>

      {err && (
        <div style={{ marginBottom: 16, padding: "10px 14px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444", borderRadius: 8, fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* User table */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "var(--muted)" }}>User</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "var(--muted)" }}>Role</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "var(--muted)" }}>Status</th>
              <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "var(--muted)" }}>Last login</th>
              <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600, color: "var(--muted)" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: "24px 14px", textAlign: "center", color: "var(--muted)" }}>No users yet.</td></tr>
            )}
            {rows.map(u => {
              const isSelf = u.uid === myUid;
              const isPending = !!u.pending;
              const isInactive = u.active === false;
              return (
                <tr key={u.uid} style={{ borderBottom: "1px solid var(--border)", opacity: isInactive ? 0.55 : 1 }}>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {u.photoURL
                        ? <img src={u.photoURL} alt="" style={{ width: 28, height: 28, borderRadius: "50%" }} />
                        : <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--bg)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--muted)" }}>{(u.email || "?")[0].toUpperCase()}</div>}
                      <div>
                        <div style={{ fontWeight: 600, color: "var(--fg)" }}>{u.name || u.email} {isSelf && <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>(you)</span>}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <select
                      value={u.role || ""}
                      disabled={busy[`role:${u.uid}`]}
                      onChange={e => onChangeRole(u.uid, e.target.value)}
                      style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12 }}
                    >
                      {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    {isPending
                      ? <span style={{ fontSize: 11, fontWeight: 600, color: "#F59E0B" }}>PENDING FIRST LOGIN</span>
                      : isInactive
                        ? <span style={{ fontSize: 11, fontWeight: 600, color: "#EF4444" }}>DEACTIVATED</span>
                        : <span style={{ fontSize: 11, fontWeight: 600, color: "#10B981" }}>ACTIVE</span>}
                  </td>
                  <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12 }}>
                    {fmtDate(u.lastLoginAt)}
                  </td>
                  <td style={{ padding: "12px 14px", textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      {!isPending && (
                        <button
                          onClick={() => onToggleActive(u.uid, !!isInactive)}
                          disabled={busy[`active:${u.uid}`] || isSelf}
                          title={isSelf ? "Cannot change your own active status" : ""}
                          style={{ ...BTN, padding: "6px 10px", fontSize: 12, background: isInactive ? "#10B981" : "#374151", color: "white", opacity: isSelf ? 0.4 : 1 }}
                        >
                          {isInactive ? "Reactivate" : "Deactivate"}
                        </button>
                      )}
                      <button
                        onClick={() => onDelete(u.uid, u.email)}
                        disabled={busy[`del:${u.uid}`] || isSelf}
                        title={isSelf ? "Cannot delete yourself" : ""}
                        style={{ ...BTN, padding: "6px 10px", fontSize: 12, background: "#EF4444", color: "white", opacity: isSelf ? 0.4 : 1 }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
