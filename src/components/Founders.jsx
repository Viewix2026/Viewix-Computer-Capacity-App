// Founders Dashboard — revenue tracker, north-star metrics, Attio deals sync,
// per-month revenue chart, plus Data + AI Learnings sub-tabs (which are their
// own components). Only the dual-founder role (password "Sanpel") sees this tab.

import { useState } from "react";
import { BTN } from "../config";
import { pct, fmtCur } from "../utils";
import { fbSet } from "../firebase";
import { FoundersData } from "./FoundersData";
import { FoundersLearnings } from "./FoundersLearnings";

export function Founders({
  foundersData, setFoundersData,
  foundersMetrics, setFoundersMetrics,
  foundersTab, setFoundersTab,
  attioDeals, setAttioDeals,
}) {
  const [attioLoading, setAttioLoading] = useState(false);
  const [revenueTableExpanded, setRevenueTableExpanded] = useState(false);

  const REVENUE_TARGET = foundersData.revenueTarget || 3000000;
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
  const daysInYear = 365;
  const yearProgress = dayOfYear / daysInYear;

  const currentRevenue = foundersData.currentRevenue || 0;
  const revenueProgress = REVENUE_TARGET > 0 ? currentRevenue / REVENUE_TARGET : 0;
  const onTrackRevenue = REVENUE_TARGET * yearProgress;
  const revenueDelta = currentRevenue - onTrackRevenue;

  const updateRevenue = val => setFoundersData(p => ({ ...p, currentRevenue: parseFloat(val) || 0 }));
  const updateMetric = (key, val) => setFoundersData(p => ({ ...p, [key]: val }));

  // ─── Attio sync: pulls all deals, auto-fills north-star metrics, caches in Firebase ───
  const syncAttio = () => {
    setAttioLoading(true);
    fetch("/api/attio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "all_deals" }) })
      .then(r => r.json())
      .then(data => {
        const lastSyncedAt = new Date().toISOString();
        setAttioDeals({ ...data, lastSyncedAt });
        // Persist cache so data survives reloads. Same /attioCache path the
        // deal-won webhook writes to (admin SDK).
        if (data?.data) {
          fbSet("/attioCache", { data: data.data, total: data.total || data.data.length, lastSyncedAt, lastSyncTrigger: "manual" });
        }
        // Auto-calculate north-star metrics from deals
        if (data?.data) {
          const extractVal = d => { const v = d.values; const candidates = [v?.deal_value, v?.amount, v?.value, v?.revenue, v?.contract_value]; for (const c of candidates) { if (c?.[0] != null) { const n = c[0].currency_value ?? c[0].value; if (n != null) return typeof n === "number" ? n : parseFloat(n) || 0; } } return 0; };
          const extractDate = d => { const v = d.values; const candidates = [v?.close_date, v?.closed_at, v?.won_date, v?.created_at]; for (const c of candidates) { if (c?.[0]?.value) return c[0].value; } return d.created_at || null; };
          const extractStage = d => { const v = d.values; const candidates = [v?.stage, v?.status, v?.deal_stage, v?.pipeline_stage]; for (const c of candidates) { const t = c?.[0]?.status?.title || c?.[0]?.value; if (t) return (typeof t === "string" ? t : "").toLowerCase(); } return ""; };
          const extractCompany = d => { const v = d.values; const candidates = [v?.company, v?.client, v?.account, v?.organisation, v?.name, v?.deal_name]; for (const c of candidates) { const t = c?.[0]?.value; if (t) { if (typeof t === "string") return t; if (t?.name) return t.name; } } return null; };

          const thisYear = now.getFullYear();
          const thisMonth = now.getMonth();
          const wonKeywords = ["won", "closed won", "closed", "completed", "signed"];
          const lostKeywords = ["lost", "closed lost", "rejected", "cancelled"];

          let ytdRevenue = 0;
          let currentMonthRevenue = 0;
          let activeCompanies = new Set();
          let pipelineValue = 0;
          let wonCount = 0;
          let totalClosed = 0;
          let activeRetainerTotal = 0;
          let activeRetainerCount = 0;
          let recentWon = 0;
          let recentClosed = 0;
          const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

          data.data.forEach(d => {
            const val = extractVal(d);
            const dateStr = extractDate(d);
            const stage = extractStage(d);
            const company = extractCompany(d);
            const isWon = wonKeywords.some(k => stage.includes(k));
            const isLost = lostKeywords.some(k => stage.includes(k));
            const isOpen = !isWon && !isLost;

            if (isWon || isLost) totalClosed++;
            if (isWon) wonCount++;

            if ((isWon || isLost) && dateStr) {
              const dt = new Date(dateStr);
              if (!isNaN(dt) && dt >= threeMonthsAgo) {
                recentClosed++;
                if (isWon) recentWon++;
              }
            }

            if (isWon && dateStr) {
              const dt = new Date(dateStr);
              if (!isNaN(dt)) {
                if (dt.getFullYear() === thisYear) ytdRevenue += val;
                if (dt.getFullYear() === thisYear && dt.getMonth() === thisMonth) currentMonthRevenue += val;
              }
            }
            if (isOpen) {
              pipelineValue += val;
              if (company) activeCompanies.add(company);
            }
            if (isWon && val > 0) { activeRetainerTotal += val; activeRetainerCount++; }
          });

          const closingRate = recentClosed > 0 ? Math.round((recentWon / recentClosed) * 100) : 0;
          const avgRetainer = activeRetainerCount > 0 ? Math.round(activeRetainerTotal / activeRetainerCount) : 0;

          setFoundersData(p => ({
            ...p,
            monthlyRevenue: currentMonthRevenue || p.monthlyRevenue,
            activeClients: activeCompanies.size || p.activeClients,
            avgRetainerValue: avgRetainer || p.avgRetainerValue,
            leadPipelineValue: pipelineValue || p.leadPipelineValue,
            closingRate: closingRate || p.closingRate,
          }));
          if (ytdRevenue > 0) updateRevenue(ytdRevenue);
        }
        setAttioLoading(false);
      })
      .catch(e => { console.error("Attio fetch error:", e); setAttioLoading(false); });
  };

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Founders Dashboard</span>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          {[{ key: "dashboard", label: "Dashboard" }, { key: "data", label: "Data" }, { key: "learnings", label: "AI Learnings" }].map(t => (
            <button key={t.key} onClick={() => setFoundersTab(t.key)} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: foundersTab === t.key ? "var(--card)" : "transparent", color: foundersTab === t.key ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
          ))}
        </div>
      </div>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px" }}>

        {foundersTab === "dashboard" && (<>

          {/* Revenue Tracker */}
          <div style={{ marginBottom: 20, padding: "24px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Revenue Target {now.getFullYear()}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 14, color: "var(--muted)" }}>$</span>
                  <input type="number" value={REVENUE_TARGET || ""} onChange={e => updateMetric("revenueTarget", parseFloat(e.target.value) || 0)} style={{ fontSize: 32, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px dashed #3A4558", outline: "none", width: 260 }} />
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Current Revenue (YTD)</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>$</span>
                  <input type="number" value={currentRevenue || ""} onChange={e => updateRevenue(e.target.value)} placeholder="0" style={{ fontSize: 28, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#10B981", background: "transparent", border: "none", borderBottom: "1px dashed #3A4558", outline: "none", width: 200, textAlign: "right" }} />
                </div>
              </div>
            </div>
            {/* Progress bar */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Progress: {pct(revenueProgress)}</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Year: {pct(yearProgress)} through</span>
              </div>
              <div style={{ width: "100%", height: 20, background: "var(--bar-bg)", borderRadius: 10, overflow: "hidden", position: "relative" }}>
                <div style={{ width: `${Math.min(revenueProgress * 100, 100)}%`, height: "100%", borderRadius: 10, background: revenueProgress >= yearProgress ? "#10B981" : "#EF4444", transition: "width 0.4s" }} />
                <div style={{ position: "absolute", left: `${yearProgress * 100}%`, top: 0, bottom: 0, width: 2, background: "#F59E0B" }} title="Where you should be" />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>On Track Amount</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fmtCur(onTrackRevenue)}</div>
              </div>
              <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>Delta</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: revenueDelta >= 0 ? "#10B981" : "#EF4444" }}>{revenueDelta >= 0 ? "+" : ""}{fmtCur(revenueDelta)}</div>
              </div>
              <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>Monthly Run Rate Needed</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fmtCur(Math.max(0, (REVENUE_TARGET - currentRevenue) / (12 - now.getMonth())))}</div>
              </div>
            </div>
          </div>

          {/* North Star Metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 20 }}>
            {[
              { key: "monthlyRevenue", label: "Monthly Revenue", prefix: "$" },
              { key: "activeClients", label: "Active Clients", prefix: "" },
              { key: "avgRetainerValue", label: "Avg Retainer Value", prefix: "$" },
              { key: "clientChurnRate", label: "Client Churn Rate", suffix: "%" },
              { key: "leadPipelineValue", label: "Lead Pipeline Value", prefix: "$" },
              { key: "closingRate", label: "Close Rate (3mo)", suffix: "%" },
            ].map(m => (
              <div key={m.key} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{m.label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {m.prefix && <span style={{ fontSize: 14, color: "var(--muted)" }}>{m.prefix}</span>}
                  <input type="number" value={foundersData[m.key] || ""} onChange={e => updateMetric(m.key, parseFloat(e.target.value) || 0)} placeholder="0" style={{ fontSize: 24, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px dashed #3A4558", outline: "none", width: "100%" }} />
                  {m.suffix && <span style={{ fontSize: 14, color: "var(--muted)" }}>{m.suffix}</span>}
                </div>
              </div>
            ))}
          </div>
          {attioDeals?.data && <div style={{ fontSize: 11, color: "var(--accent)", marginTop: -12, marginBottom: 16, padding: "0 4px" }}>✓ Auto-populated from Attio. Values are still editable.</div>}

          {/* Attio Monthly Revenue */}
          <div style={{ marginBottom: 20, padding: "20px 24px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Monthly Revenue (Attio)</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  All time deal revenue by month
                  {attioDeals?.lastSyncedAt && (() => {
                    const ms = Date.now() - new Date(attioDeals.lastSyncedAt).getTime();
                    const mins = Math.floor(ms / 60000);
                    const hrs = Math.floor(mins / 60);
                    const days = Math.floor(hrs / 24);
                    const label = days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 0 ? `${mins}m ago` : "just now";
                    return <span style={{ marginLeft: 8, color: "var(--accent)" }}>· Cached {label}</span>;
                  })()}
                </div>
              </div>
              <button onClick={syncAttio} style={{ ...BTN, background: "var(--accent)", color: "white", padding: "8px 16px" }}>{attioLoading ? "Syncing..." : "Sync from Attio"}</button>
            </div>
            {attioDeals?.data ? (() => {
              // Extract value and date from deals, trying multiple field name patterns
              const extractVal = d => { const v = d.values; const candidates = [v?.deal_value, v?.amount, v?.value, v?.revenue, v?.contract_value]; for (const c of candidates) { if (c?.[0] != null) { const n = c[0].currency_value ?? c[0].value; if (n != null) return typeof n === "number" ? n : parseFloat(n) || 0; } } return 0; };
              const extractDate = d => { const v = d.values; const candidates = [v?.close_date, v?.closed_at, v?.won_date, v?.created_at]; for (const c of candidates) { if (c?.[0]?.value) return c[0].value; } return d.created_at || null; };
              const extractStage2 = d => { const v = d.values; const candidates = [v?.stage, v?.status, v?.deal_stage, v?.pipeline_stage]; for (const c of candidates) { const t = c?.[0]?.status?.title || c?.[0]?.value; if (t) return (typeof t === "string" ? t : "").toLowerCase(); } return ""; };
              const wonKw = ["won", "closed won", "closed-won", "completed", "signed", "active"];

              // Build monthly totals (won deals only)
              const monthly = {};
              let allTimeTotal = 0;
              let dealCount = 0;
              attioDeals.data.forEach(d => {
                const val = extractVal(d);
                const dateStr = extractDate(d);
                const stage = extractStage2(d);
                const isWon = wonKw.some(k => stage.includes(k));
                if (val > 0 && dateStr && isWon) {
                  const dt = new Date(dateStr);
                  if (!isNaN(dt)) {
                    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
                    if (!monthly[key]) monthly[key] = { revenue: 0, count: 0, label: dt.toLocaleDateString("en-AU", { month: "short", year: "numeric" }) };
                    monthly[key].revenue += val;
                    monthly[key].count += 1;
                    allTimeTotal += val;
                    dealCount += 1;
                  }
                }
              });
              const sorted = Object.entries(monthly).sort((a, b) => b[0].localeCompare(a[0]));
              const maxRev = Math.max(...sorted.map(([_, m]) => m.revenue), 1);

              return (
                <div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
                    <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>All Time Revenue</div>
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#10B981" }}>{fmtCur(allTimeTotal)}</div>
                    </div>
                    <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>Total Deals</div>
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{dealCount}</div>
                    </div>
                    <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>Avg Deal Size</div>
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{dealCount > 0 ? fmtCur(allTimeTotal / dealCount) : "$0"}</div>
                    </div>
                  </div>

                  {/* Bar chart */}
                  {sorted.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 140, padding: "0 4px" }}>
                        {sorted.slice(0, 24).reverse().map(([key, m]) => {
                          const h = Math.max((m.revenue / maxRev) * 120, 4);
                          const isCurrentMonth = key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
                          return (
                            <div key={key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 0 }}>
                              <div style={{ fontSize: 8, fontWeight: 700, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden" }}>{fmtCur(m.revenue).replace("$", "")}</div>
                              <div style={{ width: "80%", height: h, background: isCurrentMonth ? "var(--accent)" : "#10B981", borderRadius: "3px 3px 0 0", opacity: isCurrentMonth ? 1 : 0.7 }} title={`${m.label}: ${fmtCur(m.revenue)} (${m.count} deals)`} />
                              <div style={{ fontSize: 7, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap" }}>{m.label.replace(" ", "\\n").split(" ")[0]}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Monthly table */}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead><tr>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left" }}>Month</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right" }}>Revenue</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "center" }}>Deals</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "right" }}>Avg Deal</th>
                        <th style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", borderBottom: "2px solid var(--border)", textAlign: "left", width: "40%" }}></th>
                      </tr></thead>
                      <tbody>{(revenueTableExpanded ? sorted : sorted.slice(0, 4)).map(([key, m]) => {
                        const barW = maxRev > 0 ? Math.max((m.revenue / maxRev) * 100, 2) : 0;
                        return (
                          <tr key={key}>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", color: "var(--fg)", fontWeight: 600 }}>{m.label}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#10B981", fontWeight: 700 }}>{fmtCur(m.revenue)}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center", fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{m.count}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "var(--muted)" }}>{fmtCur(m.count > 0 ? m.revenue / m.count : 0)}</td>
                            <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}><div style={{ width: `${barW}%`, height: 8, background: "#10B981", borderRadius: 4, opacity: 0.5 }} /></td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                    {sorted.length > 4 && <button onClick={() => setRevenueTableExpanded(!revenueTableExpanded)} style={{ width: "100%", padding: "10px", background: "transparent", border: "none", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>{revenueTableExpanded ? `Show less ▴` : `Show all ${sorted.length} months ▾`}</button>}
                  </div>
                  {attioDeals.data.length > 0 && sorted.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>Deals found but no revenue values detected. Field mapping may need adjusting.</div>}
                </div>
              );
            })() : attioDeals?.error ? (
              <div style={{ padding: "16px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.2)" }}>
                <div style={{ fontSize: 12, color: "#EF4444", fontWeight: 600 }}>Attio connection error</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{attioDeals.error}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Check the api/attio.js serverless function</div>
              </div>
            ) : (
              <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", background: "var(--bg)", borderRadius: 8 }}>
                <div style={{ fontSize: 13 }}>Click "Sync from Attio" to pull monthly revenue data</div>
              </div>
            )}
          </div>
        </>)}

        {foundersTab === "data" && <FoundersData metrics={foundersMetrics} setMetrics={setFoundersMetrics} />}
        {foundersTab === "learnings" && <FoundersLearnings />}
      </div>
    </>
  );
}
