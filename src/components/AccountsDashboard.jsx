import { useState } from "react";
import { BTN, TH, TD } from "../config";

const MILESTONE_DEFS = [
  { key: "signing", label: "Signing" },
  { key: "preProductionMeeting", label: "Pre Prod Meeting" },
  { key: "preProductionPresentation", label: "Pre Prod Presentation" },
  { key: "shoot", label: "Shoot" },
  { key: "posting", label: "Posting" },
  { key: "resultsReview", label: "Results Review" },
  { key: "partnershipReview", label: "Partnership Review" },
  { key: "growthStrategy", label: "Growth Strategy" },
];

const DEFAULT_GAPS = {
  preProductionMeeting: 3,
  preProductionPresentation: 7,
  shoot: 7,
  posting: 14,
  resultsReview: 28,
  partnershipReview: 28,
  growthStrategy: 28,
};

const PARTNERSHIP_TYPES = [
  "Live Action", "Standard - Meta Ads", "Premium - Meta Ads", "Deluxe - Meta Ads",
  "Starter Pack - Social Media", "Brand Builder - Social Media", "Market Leader - Social Media",
  "Market Dominator - Social Media", "90 Day Gameplan", "Animation"
];

const ACCOUNT_MANAGERS = ["Jeremy", "Steve", "Vish"];
const PROJECT_LEADS = ["Angus Roche", "Billy White", "David Esdaile", "Felipe Fuhr", "Jude Palmer Rowlands", "Luke Genovese-Kollar", "Matt Healey", "Mia Wolczak", "Vish Peiris", "Farah", "Steve Chestney"];
const MANAGER_COLORS = {
  "Jeremy": { bg: "rgba(0,130,250,0.12)", color: "#0082FA" },
  "Steve": { bg: "rgba(139,92,246,0.12)", color: "#8B5CF6" },
  "Vish": { bg: "rgba(16,185,129,0.12)", color: "#10B981" },
};

const STATUSES = ["Scheduled", "Completed", "Skipped", "TBC", "N/A"];
const STATUS_COLORS = {
  "Scheduled": { bg: "rgba(0,130,250,0.12)", color: "#0082FA" },
  "Completed": { bg: "rgba(16,185,129,0.12)", color: "#10B981" },
  "Skipped": { bg: "rgba(245,158,11,0.12)", color: "#F59E0B" },
  "TBC": { bg: "rgba(139,92,246,0.12)", color: "#8B5CF6" },
  "N/A": { bg: "rgba(90,107,133,0.12)", color: "#5A6B85" },
};

function addDays(dateStr, days) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function contactColor(dateStr) {
  const days = daysSince(dateStr);
  if (days <= 7) return { bg: "rgba(16,185,129,0.12)", color: "#10B981", label: days === 0 ? "Today" : days + "d ago" };
  if (days <= 14) return { bg: "rgba(245,158,11,0.12)", color: "#F59E0B", label: days + "d ago" };
  return { bg: "rgba(239,68,68,0.12)", color: "#EF4444", label: days === Infinity ? "Never" : days + "d ago" };
}

function computeOffsets(gaps) {
  const offsets = { signing: 0 };
  let cumulative = 0;
  for (let i = 1; i < MILESTONE_DEFS.length; i++) {
    const key = MILESTONE_DEFS[i].key;
    cumulative += (gaps[key] || DEFAULT_GAPS[key] || 0);
    offsets[key] = cumulative;
  }
  return offsets;
}

export function AccountsDashboard({ accounts, setAccounts, turnaround, setTurnaround, onSyncAttio }) {
  const [tab, setTab] = useState("clients");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [filterManager, setFilterManager] = useState("all");

  const gaps = { ...DEFAULT_GAPS, ...(turnaround || {}) };
  const offsets = computeOffsets(gaps);

  const accountList = Object.values(accounts || {}).filter(a => a && a.id);
  const filtered = filterManager === "all" ? accountList : accountList.filter(a => a.accountManager === filterManager);
  const sorted = [...filtered].sort((a, b) => (a.companyName || "").localeCompare(b.companyName || ""));

  const updateAccount = (id, patch) => {
    setAccounts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const updateMilestone = (id, milestoneKey, patch) => {
    setAccounts(prev => {
      const acct = prev[id] || {};
      const milestones = { ...(acct.milestones || {}) };
      milestones[milestoneKey] = { ...(milestones[milestoneKey] || {}), ...patch };
      return { ...prev, [id]: { ...acct, milestones } };
    });
  };

  const setSigningDate = (id, dateStr) => {
    setAccounts(prev => {
      const acct = prev[id] || {};
      const milestones = { ...(acct.milestones || {}) };
      MILESTONE_DEFS.forEach(m => {
        const existing = milestones[m.key] || {};
        milestones[m.key] = {
          ...existing,
          date: addDays(dateStr, offsets[m.key]),
          status: existing.status || "Scheduled"
        };
      });
      return { ...prev, [id]: { ...acct, milestones } };
    });
  };

  const addClient = () => {
    if (!newName.trim()) return;
    const id = "acct-" + Date.now();
    setAccounts(prev => ({
      ...prev,
      [id]: { id, companyName: newName.trim(), attioId: "", accountManager: "", projectLead: "", partnershipType: "", lastContact: "", milestones: {} }
    }));
    setNewName("");
    setAdding(false);
  };

  const removeClient = (id) => {
    if (!window.confirm("Remove this client from accounts?")) return;
    setAccounts(prev => { const next = { ...prev }; delete next[id]; return next; });
  };

  const logContact = (id) => {
    updateAccount(id, { lastContact: new Date().toISOString().split("T")[0] });
  };

  const doSync = async () => {
    if (!onSyncAttio) return;
    setSyncing(true);
    try {
      const companies = await onSyncAttio();
      if (companies && Array.isArray(companies)) {
        setAccounts(prev => {
          const next = { ...prev };
          companies.forEach(c => {
            const existing = Object.values(next).find(a => a.attioId === c.id);
            if (!existing) {
              const id = "acct-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
              next[id] = { id, companyName: c.name || "", attioId: c.id || "", accountManager: "", projectLead: "", partnershipType: c.videoType || "", lastContact: "", milestones: {} };
            } else if (c.videoType && !existing.partnershipType) {
              next[existing.id] = { ...existing, partnershipType: c.videoType };
            }
          });
          return next;
        });
      }
    } catch (e) { console.error("Attio sync error:", e); }
    setSyncing(false);
  };

  const updateGap = (key, val) => {
    const v = Math.max(0, parseInt(val) || 0);
    setTurnaround(prev => ({ ...prev, [key]: v }));
  };

  const inputSt = { padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "'DM Sans',sans-serif" };
  const selectSt = { padding: "4px 6px", borderRadius: 4, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer", outline: "none", appearance: "auto" };
  const managerCounts = {};
  ACCOUNT_MANAGERS.forEach(m => { managerCounts[m] = accountList.filter(a => a.accountManager === m).length; });

  return (<>
    <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Accounts</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          <button onClick={() => setTab("clients")} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: tab === "clients" ? "var(--card)" : "transparent", color: tab === "clients" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Clients</button>
          <button onClick={() => setTab("turnaround")} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: tab === "turnaround" ? "var(--card)" : "transparent", color: tab === "turnaround" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Turnaround</button>
        </div>
        {tab === "clients" && (<div style={{ display: "flex", gap: 6 }}>
          <button onClick={doSync} disabled={syncing} style={{ ...BTN, background: "transparent", color: "var(--accent)", border: "1px solid var(--border)" }}>{syncing ? "Syncing..." : "Sync from Attio"}</button>
          <button onClick={() => setAdding(true)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ Add Client</button>
        </div>)}
      </div>
    </div>

    {/* ═══ TURNAROUND TAB ═══ */}
    {tab === "turnaround" && (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 28px 60px" }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Standard Turnaround Times</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>Days between each stage. Used when a signing date is set.</div>
          <div style={{ display: "grid", gap: 0 }}>
            {MILESTONE_DEFS.slice(1).map((m, i) => {
              const prevLabel = MILESTONE_DEFS[i].label;
              return (
                <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ flex: 1, fontSize: 13, color: "var(--fg)" }}>{prevLabel} → {m.label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="number" value={gaps[m.key]} onChange={e => updateGap(m.key, e.target.value)} min={0} style={{ width: 48, padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }} />
                    <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 28 }}>days</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {MILESTONE_DEFS.map(m => (
              <div key={m.key} style={{ padding: "4px 8px", background: "var(--bg)", borderRadius: 4, display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>{m.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "var(--accent)" }}>{offsets[m.key]}d</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}

    {/* ═══ CLIENTS TAB ═══ */}
    {tab === "clients" && (
      <div style={{ padding: "16px 28px 60px" }}>
        {/* Summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
          <div onClick={() => setFilterManager("all")} style={{ background: "var(--card)", border: `1px solid ${filterManager === "all" ? "var(--accent)" : "var(--border)"}`, borderRadius: 10, padding: "16px 20px", cursor: "pointer" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Total Clients</div>
            <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: filterManager === "all" ? "var(--accent)" : "var(--fg)" }}>{accountList.length}</div>
          </div>
          {ACCOUNT_MANAGERS.map(m => {
            const mc = MANAGER_COLORS[m];
            return (
              <div key={m} onClick={() => setFilterManager(filterManager === m ? "all" : m)} style={{ background: "var(--card)", border: `1px solid ${filterManager === m ? mc.color : "var(--border)"}`, borderRadius: 10, padding: "16px 20px", cursor: "pointer" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: mc.color, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{m}</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: filterManager === m ? mc.color : "var(--fg)" }}>{managerCounts[m]}</div>
              </div>
            );
          })}
        </div>

        {/* Add client form */}
        {adding && (
          <div style={{ marginBottom: 16, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 10, display: "flex", gap: 8, alignItems: "center" }}>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addClient(); if (e.key === "Escape") { setAdding(false); setNewName(""); } }} placeholder="Company name..." autoFocus style={{ ...inputSt, flex: 1, fontSize: 14, fontWeight: 600, padding: "10px 12px" }} />
            <button onClick={addClient} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Add</button>
            <button onClick={() => { setAdding(false); setNewName(""); }} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Cancel</button>
          </div>
        )}

        {/* Table */}
        {sorted.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No accounts yet</div>
            <div style={{ fontSize: 13 }}>Sync from Attio or add clients manually</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ ...TH, position: "sticky", left: 0, zIndex: 10, background: "var(--card)", minWidth: 160, textAlign: "left" }}>Client</th>
                  <th style={{ ...TH, position: "sticky", left: 160, zIndex: 10, background: "var(--card)", minWidth: 90, textAlign: "center" }}>Manager</th>
                  <th style={{ ...TH, position: "sticky", left: 250, zIndex: 10, background: "var(--card)", minWidth: 110, textAlign: "center" }}>Project Lead</th>
                  <th style={{ ...TH, minWidth: 130, textAlign: "center" }}>Partnership</th>
                  <th style={{ ...TH, minWidth: 100, textAlign: "center" }}>Last Contact</th>
                  {MILESTONE_DEFS.map(m => (
                    <th key={m.key} style={{ ...TH, minWidth: 130, textAlign: "center" }}>{m.label}</th>
                  ))}
                  <th style={{ ...TH, width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(acct => {
                  const cc = contactColor(acct.lastContact);
                  const mc = MANAGER_COLORS[acct.accountManager] || { bg: "var(--bg)", color: "var(--muted)" };
                  return (
                    <tr key={acct.id}>
                      <td style={{ ...TD, position: "sticky", left: 0, zIndex: 5, background: "var(--card)", fontWeight: 700, color: "var(--fg)" }}>{acct.companyName}</td>
                      <td style={{ ...TD, position: "sticky", left: 160, zIndex: 5, background: "var(--card)", textAlign: "center" }}>
                        <select value={acct.accountManager || ""} onChange={e => updateAccount(acct.id, { accountManager: e.target.value })} style={{ ...selectSt, background: mc.bg, color: mc.color }}>
                          <option value="">Assign</option>
                          {ACCOUNT_MANAGERS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td style={{ ...TD, position: "sticky", left: 250, zIndex: 5, background: "var(--card)", textAlign: "center" }}>
                        <select value={acct.projectLead || ""} onChange={e => updateAccount(acct.id, { projectLead: e.target.value })} style={{ ...selectSt, background: acct.projectLead ? "var(--accent-soft)" : "var(--bg)", color: acct.projectLead ? "var(--fg)" : "var(--muted)" }}>
                          <option value="">Assign</option>
                          {PROJECT_LEADS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td style={{ ...TD, textAlign: "center" }}>
                        <select value={acct.partnershipType || ""} onChange={e => updateAccount(acct.id, { partnershipType: e.target.value })} style={{ ...selectSt, background: acct.partnershipType ? "rgba(248,119,0,0.12)" : "var(--bg)", color: acct.partnershipType ? "#F87700" : "var(--muted)", maxWidth: 120 }}>
                          <option value="">Select</option>
                          {PARTNERSHIP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td style={{ ...TD, textAlign: "center" }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: cc.bg, color: cc.color, textTransform: "uppercase" }}>{cc.label}</span>
                          <button onClick={() => logContact(acct.id)} style={{ fontSize: 10, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Log Contact</button>
                        </div>
                      </td>
                      {MILESTONE_DEFS.map(m => {
                        const ms = acct.milestones?.[m.key] || {};
                        const sc = STATUS_COLORS[ms.status] || { bg: "var(--bg)", color: "var(--muted)" };
                        const isSigningCol = m.key === "signing";
                        return (
                          <td key={m.key} style={{ ...TD, textAlign: "center", padding: "4px 6px" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <input type="date" value={ms.date || ""} onChange={e => {
                                if (isSigningCol) { setSigningDate(acct.id, e.target.value); }
                                else { updateMilestone(acct.id, m.key, { date: e.target.value }); }
                              }} style={{ ...inputSt, fontSize: 11, padding: "3px 4px", textAlign: "center", width: "100%" }} />
                              <select value={ms.status || ""} onChange={e => updateMilestone(acct.id, m.key, { status: e.target.value })} style={{ ...selectSt, background: sc.bg, color: sc.color, fontSize: 10, textTransform: "uppercase" }}>
                                <option value="">Set Status</option>
                                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                          </td>
                        );
                      })}
                      <td style={{ ...TD, textAlign: "center" }}>
                        <button onClick={() => removeClient(acct.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 14, padding: "2px 6px" }}>x</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )}
  </>);
}
