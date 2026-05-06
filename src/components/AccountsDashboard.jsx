import React, { useState } from "react";
import { fbSet } from "../firebase";
import { BTN, TH, TD, MILESTONE_DEFS, DEFAULT_MILESTONE_GAPS, CLIENT_GOAL_OPTIONS, CLIENT_GOAL_LABELS, CLIENT_GOAL_COLORS } from "../config";
import { logoBg, matchSherpaForName } from "../utils";
import { ClientGoalPill } from "./ClientGoalPill";

// Alias kept so local references to DEFAULT_GAPS inside this file read
// naturally — the canonical export in config.js is DEFAULT_MILESTONE_GAPS.
const DEFAULT_GAPS = DEFAULT_MILESTONE_GAPS;

const PARTNERSHIP_TYPES = [
  "Live Action", "Standard - Meta Ads", "Premium - Meta Ads", "Deluxe - Meta Ads",
  "Starter Pack - Social Media", "Brand Builder - Social Media", "Market Leader - Social Media",
  "Market Dominator - Social Media", "90 Day Gameplan", "Animation"
];

// Meta Ads partnerships don't get Final Live / Boosting Strategy /
// Many Chat — those columns are organic-funnel concerns, not paid-
// media concerns. We blank the cells (render an em-dash in muted
// grey) so producers can see at a glance that the columns
// intentionally don't apply to that row, vs. "we forgot to fill it
// in". Matches by substring rather than literal so all three Meta
// Ads tiers (Standard / Premium / Deluxe) share the rule.
const isMetaAdsAccount = (acct) =>
  String(acct?.partnershipType || "").includes("Meta Ads");

const META_ADS_BLANKED_KEYS = new Set(["finalLive", "boostingStrategy", "manyChat"]);

// Goal-driven highlight rings on the milestone columns. Tells
// producers at a glance which tool a client should be using based
// on what they're trying to achieve:
//   - leads      → Many Chat (red)         · comment-trigger DM funnel
//   - awareness  → Boosting Strategy (blue) · paid distribution to extend reach
//   - engagement → Many Chat (orange)       · DM-driven engagement signals
// Brand Building intentionally has no rule (Jeremy's call) — it's
// a goal where neither tool is a forced "should be using". The
// colours are pulled from CLIENT_GOAL_COLORS so the ring on the
// dropdown matches the goal pill in the company name cell.
const GOAL_RING_RULES = {
  leads:      { milestoneKey: "manyChat",         color: CLIENT_GOAL_COLORS.leads      },
  awareness:  { milestoneKey: "boostingStrategy", color: CLIENT_GOAL_COLORS.awareness  },
  engagement: { milestoneKey: "manyChat",         color: CLIENT_GOAL_COLORS.engagement },
};
const ringColorFor = (acct, milestoneKey) => {
  const rule = GOAL_RING_RULES[acct?.goal];
  return rule && rule.milestoneKey === milestoneKey ? rule.color : null;
};

const ACCOUNT_MANAGERS = ["Jeremy", "Steve", "Vish"];
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

export function AccountsDashboard({ accounts, setAccounts, turnaround, onSyncAttio, editors, clients, setClients, onDeletePath, highlightId }) {
  // Buyer Journey + Turnaround sub-tabs have moved to the Founders tab
  // (founders > buyerJourney). This component is now Clients-only; the
  // tab state is retained as a no-op to minimise downstream churn in
  // case anything else references it.
  const [tab] = useState("clients");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [filterManager, setFilterManager] = useState("all");
  const [expandedClientId, setExpandedClientId] = useState(null);

  const gaps = { ...DEFAULT_GAPS, ...(turnaround || {}) };
  const offsets = computeOffsets(gaps);

  const accountList = Object.values(accounts || {}).filter(a => a && a.id);
  const filtered = filterManager === "all" ? accountList : accountList.filter(a => a.accountManager === filterManager);
  const sorted = [...filtered].sort((a, b) => (a.companyName || "").localeCompare(b.companyName || ""));

  const syncToSherpas = (companyName, patch) => {
    if (!setClients || !companyName) return;
    const nameLC = companyName.toLowerCase();
    setClients(prev => {
      const existing = prev.find(c => (c.name || "").toLowerCase() === nameLC);
      if (existing) {
        return prev.map(c => c.id === existing.id ? { ...c, ...patch } : c);
      }
      return prev;
    });
  };

  const updateAccount = (id, patch) => {
    setAccounts(prev => {
      const acct = { ...prev[id], ...patch };
      // Sync to sherpas if manager or lead changed
      if (patch.accountManager !== undefined || patch.projectLead !== undefined) {
        const sherpaSync = {};
        if (patch.accountManager !== undefined) sherpaSync.accountManager = patch.accountManager;
        if (patch.projectLead !== undefined) sherpaSync.projectLead = patch.projectLead;
        syncToSherpas(acct.companyName, sherpaSync);
      }
      // Write immediately to Firebase to prevent skipRead race condition
      fbSet(`/accounts/${id}`, acct);
      return { ...prev, [id]: acct };
    });
  };

  const updateMilestone = (id, milestoneKey, patch) => {
    setAccounts(prev => {
      const acct = prev[id] || {};
      const milestones = { ...(acct.milestones || {}) };
      milestones[milestoneKey] = { ...(milestones[milestoneKey] || {}), ...patch };
      const updated = { ...acct, milestones };
      fbSet(`/accounts/${id}`, updated);
      return { ...prev, [id]: updated };
    });
  };

  const setSigningDate = (id, dateStr) => {
    setAccounts(prev => {
      const acct = prev[id] || {};
      const milestones = { ...(acct.milestones || {}) };
      // Signing is the anchor only — Go Live and Final Live are
      // manually entered when those events happen, not auto-computed
      // from a fixed gap. Leave the other milestones alone so we
      // don't bulk-overwrite producer entries on every signing edit.
      const existing = milestones.signing || {};
      milestones.signing = { ...existing, date: dateStr };
      const updated = { ...acct, milestones };
      fbSet(`/accounts/${id}`, updated);
      return { ...prev, [id]: updated };
    });
  };

  const addClient = () => {
    if (!newName.trim()) return;
    const id = "acct-" + Date.now();
    setAccounts(prev => ({
      ...prev,
      [id]: { id, companyName: newName.trim(), attioId: "", accountManager: "", projectLead: "", partnershipType: "", lastContact: "", milestones: {}, logoUrl: "" }
    }));
    setNewName("");
    setAdding(false);
  };

  const removeClient = (id) => {
    if (!window.confirm("Remove this client from accounts?")) return;
    if(onDeletePath)onDeletePath("/accounts/"+id);
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
              const created = { id, companyName: c.name || "", attioId: c.id || "", accountManager: "", projectLead: "", partnershipType: c.videoType || "", lastContact: "", milestones: {}, logoUrl: "" };
              next[id] = created;
              // /accounts is no longer written by the App.jsx bulk-write
              // loop (it raced server writes and clobbered just-set
              // fields like goal), so push the new record directly.
              fbSet(`/accounts/${id}`, created);
              // Create sherpas client
              if (setClients && c.name) {
                const nameLC = c.name.toLowerCase();
                setClients(prev2 => {
                  if (prev2.find(cl => (cl.name || "").toLowerCase() === nameLC)) return prev2;
                  return [...prev2, { id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name: c.name, projectLead: "", accountManager: "", docUrl: "" }];
                });
              }
            } else if (c.videoType && !existing.partnershipType) {
              const updated = { ...existing, partnershipType: c.videoType };
              next[existing.id] = updated;
              fbSet(`/accounts/${existing.id}`, updated);
            }
          });
          return next;
        });
      }
    } catch (e) { console.error("Attio sync error:", e); }
    setSyncing(false);
  };

  const inputSt = { padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "'DM Sans',sans-serif" };
  const selectSt = { padding: "4px 6px", borderRadius: 4, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer", outline: "none", appearance: "auto" };
  const managerCounts = {};
  ACCOUNT_MANAGERS.forEach(m => { managerCounts[m] = accountList.filter(a => a.accountManager === m).length; });

  return (<>
    <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Accounts</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Sub-tab bar removed — Turnaround and Buyer Journey now live under
            the Founders tab. This view is Clients-only. */}
        <button onClick={() => setAdding(true)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ Add Client</button>
      </div>
    </div>

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
            <div style={{ fontSize: 13 }}>Clients appear here automatically when a deal is won in Attio, or add one manually above.</div>
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
                  const isExpanded = expandedClientId === acct.id;
                  const isHighlighted = highlightId === acct.id;
                  // Columns = 3 sticky (client/manager/lead) + partnership + lastContact + milestones + action
                  const totalCols = 5 + MILESTONE_DEFS.length + 1;
                  return (
                    <React.Fragment key={acct.id}>
                    <tr id={`account-row-${acct.id}`} style={isHighlighted ? { outline: "2px solid #F59E0B", outlineOffset: -2 } : undefined}>
                      <td style={{ ...TD, position: "sticky", left: 0, zIndex: 5, background: "var(--card)", fontWeight: 700, color: "var(--fg)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button
                            onClick={() => setExpandedClientId(isExpanded ? null : acct.id)}
                            title={isExpanded ? "Hide details" : "Show details"}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 11, padding: "2px 4px", lineHeight: 1, transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
                            ▸
                          </button>
                          {acct.logoUrl && <img key={acct.logoUrl + (acct.logoBg || "")} src={acct.logoUrl} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 28, borderRadius: 4, objectFit: "contain", background: logoBg(acct.logoBg), padding: 3 }} />}
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {acct.companyName}
                            {/* Client-goal pill — set per account in the
                                expanded detail panel below; shown here so
                                the producer scanning the account list sees
                                what the client is actually trying to
                                achieve at a glance. */}
                            <ClientGoalPill goal={acct.goal} />
                          </span>
                        </div>
                      </td>
                      <td style={{ ...TD, position: "sticky", left: 160, zIndex: 5, background: "var(--card)", textAlign: "center" }}>
                        <select value={acct.accountManager || ""} onChange={e => updateAccount(acct.id, { accountManager: e.target.value })} style={{ ...selectSt, background: mc.bg, color: mc.color }}>
                          <option value="">Assign</option>
                          {ACCOUNT_MANAGERS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td style={{ ...TD, position: "sticky", left: 250, zIndex: 5, background: "var(--card)", textAlign: "center" }}>
                        <select value={acct.projectLead || ""} onChange={e => updateAccount(acct.id, { projectLead: e.target.value })} style={{ ...selectSt, background: acct.projectLead ? "var(--accent-soft)" : "var(--bg)", color: acct.projectLead ? "var(--fg)" : "var(--muted)" }}>
                          <option value="">Assign</option>
                          {(editors||[]).map(e => <option key={e.id||e.name} value={e.name}>{e.name}</option>)}
                          {/* Fallback: surface the stored projectLead even
                              when it no longer matches a name in the
                              current editor roster (e.g. someone left the
                              team and was removed from /editors). Without
                              this the dropdown rendered empty and made
                              the data look "deleted" when it was still in
                              /accounts/{id}.projectLead all along. */}
                          {acct.projectLead && !((editors||[]).some(e => e.name === acct.projectLead)) && (
                            <option value={acct.projectLead}>{acct.projectLead}</option>
                          )}
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
                        const isDate = m.type === "date";
                        const isStatus = m.type === "status";
                        const isSigningCol = m.key === "signing";
                        // Meta Ads tiers don't get Final Live / Boosting
                        // Strategy / Many Chat — paid-media partnerships
                        // run an entirely different workflow. Render a
                        // muted em-dash so producers see "this cell
                        // doesn't apply" instead of "this cell is blank
                        // because we forgot to fill it in".
                        const isBlankedForMeta = isMetaAdsAccount(acct) && META_ADS_BLANKED_KEYS.has(m.key);
                        // Goal-driven ring around the dropdown / input.
                        // null → no ring. See GOAL_RING_RULES at module
                        // top. Skipped on Meta-blanked cells so the ring
                        // doesn't paint around an em-dash that isn't
                        // even editable.
                        const ringColor = isBlankedForMeta ? null : ringColorFor(acct, m.key);
                        // Status colour palette — pulls from the global
                        // STATUS_COLORS for the canonical "Scheduled" /
                        // "Done" / etc. labels, falling back to neutral
                        // when the milestone uses a value we don't have
                        // a colour for. Specific overrides for the new
                        // workflow status set ("Not started" reads as
                        // muted, "Done" reads as accent green).
                        const statusColour = (val) => {
                          if (val === "Done") return { bg: "rgba(16,185,129,0.12)", color: "#10B981" };
                          if (val === "Scheduled") return STATUS_COLORS["Scheduled"] || { bg: "var(--bg)", color: "var(--muted)" };
                          if (val === "Not started") return { bg: "var(--bg)", color: "var(--muted)" };
                          return STATUS_COLORS[val] || { bg: "var(--bg)", color: "var(--muted)" };
                        };
                        // Wrapping span carries the ring so both the
                        // date input and the status select get the same
                        // treatment without re-stating the box-shadow on
                        // each branch. inline-block + a small padding
                        // gap lets the shadow paint cleanly without
                        // clipping at the cell edge.
                        const ringStyle = ringColor
                          ? { boxShadow: `0 0 0 2px ${ringColor}`, borderRadius: 4, display: "inline-block" }
                          : null;
                        return (
                          <td key={m.key} style={{ ...TD, textAlign: "center", padding: "4px 6px" }}>
                            {isBlankedForMeta && (
                              <span style={{ color: "var(--muted)", fontSize: 12, opacity: 0.6 }} title="Not applicable for Meta Ads partnerships">
                                —
                              </span>
                            )}
                            {!isBlankedForMeta && isDate && (
                              <span style={ringStyle || undefined}>
                                <input
                                  type="date"
                                  value={ms.date || ""}
                                  onChange={e => {
                                    // Signing still flows through the
                                    // dedicated handler so any side-effects
                                    // (other milestone bootstraps, Sherpa
                                    // sync, etc.) keep firing centrally.
                                    if (isSigningCol) setSigningDate(acct.id, e.target.value);
                                    else updateMilestone(acct.id, m.key, { date: e.target.value });
                                  }}
                                  style={{ ...inputSt, fontSize: 11, padding: "3px 4px", textAlign: "center", width: "100%" }}
                                />
                              </span>
                            )}
                            {!isBlankedForMeta && isStatus && (() => {
                              const sc = statusColour(ms.status);
                              return (
                                <span style={ringStyle || undefined}>
                                  <select
                                    value={ms.status || ""}
                                    onChange={e => updateMilestone(acct.id, m.key, { status: e.target.value })}
                                    style={{ ...selectSt, background: sc.bg, color: sc.color, fontSize: 10, textTransform: "uppercase" }}>
                                    <option value="">Set Status</option>
                                    {(m.statuses || []).map(s => <option key={s} value={s}>{s}</option>)}
                                  </select>
                                </span>
                              );
                            })()}
                          </td>
                        );
                      })}
                      <td style={{ ...TD, textAlign: "center" }}>
                        <button onClick={() => removeClient(acct.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 14, padding: "2px 6px" }}>x</button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={totalCols} style={{ padding: 0, background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
                          {/* Resizable wrapper — producer can drag the bottom-right corner
                              to expand the panel in any direction (CSS resize: both covers
                              bottom + right; combined with min/max width+height it's
                              effectively omnidirectional at the active corner). */}
                          <div style={{
                            padding: "16px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start",
                            resize: "both", overflow: "auto",
                            minHeight: 160, maxHeight: "70vh",
                            minWidth: 360, maxWidth: "100%",
                            position: "relative",
                          }}>
                            <div style={{ position: "absolute", bottom: 2, right: 2, fontSize: 9, color: "var(--muted)", pointerEvents: "none", opacity: 0.5 }}>↘ drag to resize</div>
                            {/* Logo section */}
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Client Logo</div>
                              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                                {/* Preview */}
                                <div style={{ width: 72, height: 72, borderRadius: 8, border: "1px solid var(--border)", background: logoBg(acct.logoBg), display: "flex", alignItems: "center", justifyContent: "center", padding: 6, flexShrink: 0, overflow: "hidden" }}>
                                  {acct.logoUrl ? (
                                    <img key={acct.logoUrl + (acct.logoBg || "")} src={acct.logoUrl} alt="" onError={e => { e.target.style.display = "none"; }} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                                  ) : (
                                    <span style={{ fontSize: 10, color: "var(--muted)", textAlign: "center" }}>No logo</span>
                                  )}
                                </div>
                                <div style={{ flex: 1, display: "grid", gap: 6, minWidth: 0 }}>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 3 }}>URL</label>
                                    <input type="text" value={acct.logoUrl || ""} onChange={e => updateAccount(acct.id, { logoUrl: e.target.value })} placeholder="https://..." style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", width: "100%", fontFamily: "inherit", boxSizing: "border-box" }} />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 3 }}>Background</label>
                                    <select value={acct.logoBg || "white"} onChange={e => updateAccount(acct.id, { logoBg: e.target.value })} style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "inherit", cursor: "pointer", width: "100%" }}>
                                      <option value="white">⬜ White</option>
                                      <option value="dark">⬛ Dark</option>
                                      <option value="transparent">▢ Transparent</option>
                                    </select>
                                  </div>
                                </div>
                              </div>
                            </div>
                            {/* Client business goal — drives the goal pill
                                rendered next to the company name above and
                                rolls through to project rows + editor task
                                rows so everyone touching the work sees the
                                client's intent at a glance. */}
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Client Goal</div>
                              <select
                                value={acct.goal || ""}
                                onChange={e => updateAccount(acct.id, { goal: e.target.value })}
                                style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", width: "100%", fontFamily: "inherit", boxSizing: "border-box" }}>
                                <option value="">Not set</option>
                                {CLIENT_GOAL_OPTIONS.map(g => (
                                  <option key={g} value={g}>{CLIENT_GOAL_LABELS[g]}</option>
                                ))}
                              </select>
                            </div>
                            {/* Room for future details — Attio ID, notes, etc. */}
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Attio ID</div>
                              <input type="text" value={acct.attioId || ""} onChange={e => updateAccount(acct.id, { attioId: e.target.value })} placeholder="(not linked)" style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", width: "100%", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }} />
                            </div>
                            {/* Sherpa Doc — the project-brief Google Doc that
                                used to live in the now-removed Sherpas tab.
                                Lookup is by case-insensitive name match
                                between the account and a /clients record.
                                If no record exists yet, "Save URL" creates
                                one keyed by the account's companyName. */}
                            <div style={{ gridColumn: "1 / -1" }}>
                              <SherpaDocField acct={acct} clients={clients || []} setClients={setClients} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
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

// ─── Sherpa doc field ────────────────────────────────────────────
// Surfaces the matching /clients record's docUrl as an editable URL.
// Click "Open" to launch the Google Doc; the "Save URL" button
// upserts to /clients (creates a record if none exists for this
// account name yet, otherwise patches in place).
function SherpaDocField({ acct, clients, setClients }) {
  // Match by name with the shared fuzzy matcher: exact → bidirectional
  // startsWith → first-word. Catches the common "Canva" (typed manually
  // in the old Sherpas tab) ↔ "Canva Pty Ltd" (Attio's registered name)
  // mismatch so existing docs surface against the matching Account row.
  const existing = matchSherpaForName(acct.companyName, clients);
  const [draft, setDraft] = React.useState(existing?.docUrl || "");
  React.useEffect(() => { setDraft(existing?.docUrl || ""); }, [existing?.id, existing?.docUrl]);

  const save = () => {
    const url = (draft || "").trim();
    if (existing) {
      setClients(prev => prev.map(c => c.id === existing.id ? { ...c, docUrl: url } : c));
    } else {
      const id = `cl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      setClients(prev => [
        ...(prev || []),
        { id, name: acct.companyName, docUrl: url, projectLead: "", accountManager: "" },
      ]);
    }
  };

  return (
    <>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
        Sherpa Doc
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
          placeholder="https://docs.google.com/..."
          style={{
            flex: 1, minWidth: 260,
            padding: "6px 10px", borderRadius: 4,
            border: "1px solid var(--border)", background: "var(--input-bg)",
            color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        {(existing?.docUrl || "").trim() && (
          <a
            href={existing.docUrl}
            target="_blank" rel="noopener noreferrer"
            style={{
              padding: "6px 12px", borderRadius: 4,
              background: "var(--accent-soft)", color: "var(--accent)",
              fontSize: 11, fontWeight: 700, textDecoration: "none",
              display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: "inherit", whiteSpace: "nowrap",
            }}>
            📄 Open ↗
          </a>
        )}
      </div>
    </>
  );
}
