// Capacity planner — founder-only tool with seven sub-tabs covering team roster,
// weekly schedule, workload forecast, time logs, team lunch, and the weekly win
// editor. All the capacity-specific helpers (what-if mode, utilisation calcs,
// roster edits) live here to keep App.jsx focused on routing + global state.

import { useState, useEffect, useMemo, useRef } from "react";
import { fbListenSafe } from "../firebase";
import {
  DK, DL, QT, TH, TD, BTN, NB,
  CONTENT_CATEGORIES, CAT_COLORS,
} from "../config";
import {
  todayKey, getMonday, wKey, addW, fmtRange, fmtLabel,
  doCalc, pct, dayVal, categorizeContent, normaliseImageUrl,
} from "../utils";
import { Badge, Metric, NumIn, UBar, FChart } from "./UIComponents";
import { Grid } from "./Grid";
import { VideoEmbed } from "./shared/VideoEmbed";

export function Capacity({
  capTab, setCapTab,
  scMode, setScMode, scIn, setScIn,
  inputs, setInputs,
  editors, setEditors,
  curW, setCurW, weekData, setWeekData,
  mondayEditorList,
  teamLunch, setTeamLunch,
  foundersData, setFoundersData,
  isFounder,
}) {
  // ─── Local UI state ───
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpDate, setJumpDate] = useState("");
  const [rosterAdding, setRosterAdding] = useState(false);
  const [rosterNewName, setRosterNewName] = useState("");
  const [rosterEditId, setRosterEditId] = useState(null);
  const [rosterEditName, setRosterEditName] = useState("");
  const rosterAddRef = useRef(null);
  const rosterEditRef = useRef(null);

  const [timeLogDate, setTimeLogDate] = useState(todayKey());
  const [timeLogLoading, setTimeLogLoading] = useState(false);
  const [allTimeLogs, setAllTimeLogs] = useState({});

  // Focus refs when add/edit rows appear
  useEffect(() => { if (rosterAdding && rosterAddRef.current) rosterAddRef.current.focus(); }, [rosterAdding]);
  useEffect(() => { if (rosterEditId && rosterEditRef.current) rosterEditRef.current.focus(); }, [rosterEditId]);

  // Time logs listener — only fires when Time Logs tab is viewed
  useEffect(() => {
    if (capTab !== "timelogs") return;
    setTimeLogLoading(true);
    return fbListenSafe("/timeLogs", (data) => {
      setAllTimeLogs(data || {});
      setTimeLogLoading(false);
    });
  }, [capTab]);

  // ─── Capacity helpers ───
  const goW = dir => setCurW(wKey(addW(new Date(curW + "T00:00:00"), dir)));
  const goToday = () => setCurW(wKey(getMonday(new Date())));
  const jumpTo = () => {
    if (!jumpDate) return;
    setCurW(wKey(getMonday(new Date(jumpDate + "T00:00:00"))));
    setJumpOpen(false);
    setJumpDate("");
  };
  const upWeek = (wk, data) => setWeekData(p => ({ ...p, [wk]: data }));
  const rosterToggle = (eid, day) => setEditors(prev => prev.map(e => e.id === eid ? { ...e, defaultDays: { ...e.defaultDays, [day]: !e.defaultDays[day] } } : e));
  const rosterAdd = () => {
    if (!rosterNewName.trim()) return;
    setEditors(prev => [...prev, { id: `ed-${Date.now()}`, name: rosterNewName.trim(), phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } }]);
    setRosterNewName("");
    setRosterAdding(false);
  };
  const rosterRemove = id => setEditors(prev => prev.filter(e => e.id !== id));
  const rosterRename = () => {
    if (!rosterEditName.trim()) { setRosterEditId(null); return; }
    setEditors(prev => prev.map(e => e.id === rosterEditId ? { ...e, name: rosterEditName.trim() } : e));
    setRosterEditId(null);
  };

  // Filter editors that don't need an edit suite OUT of the schedule/capacity calcs.
  // Team members with role "crew" (producers, founders, etc.) are shown in roster
  // but don't appear in the weekly schedule grid or count toward suite occupancy.
  const scheduleEditors = editors.filter(e => !e.role || e.role === "editor");
  const ai = scMode && scIn ? scIn : inputs;
  const cwEds = weekData[curW]?.editors || scheduleEditors.map(e => ({ ...e, days: { ...e.defaultDays } }));
  const occ = cwEds.reduce((s, e) => s + DK.filter(d => dayVal(e.days[d]) === "in").length, 0);
  const c = useMemo(() => doCalc(ai, occ), [ai, occ]);
  const upIn = (k, v) => {
    if (scMode) setScIn(p => ({ ...(p || inputs), [k]: v }));
    else setInputs(p => ({ ...p, [k]: v }));
  };
  const monD = new Date(curW + "T00:00:00");

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Capacity Planner</span>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          {[{ key: "dashboard", label: "Dashboard" }, { key: "roster", label: "Team Roster" }, { key: "schedule", label: "Weekly Schedule" }, { key: "forecast", label: "Forecast" }, { key: "timelogs", label: "Time Logs" }, { key: "lunch", label: "Team Lunch" }, { key: "videoOfTheWeek", label: "Video of the Week" }].map(t => (
            <button key={t.key} onClick={() => setCapTab(t.key)} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: capTab === t.key ? "var(--card)" : "transparent", color: capTab === t.key ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
          ))}
        </div>
      </div>

      {scMode && (
        <div style={{ padding: "10px 28px", background: "#1A1510", borderBottom: "1px solid #3D2E10", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#F59E0B" }}>WHAT-IF MODE</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { if (scIn) setInputs(scIn); setScMode(false); setScIn(null); }} style={{ ...BTN, background: "#10B981", color: "white" }}>Apply</button>
            <button onClick={() => { setScMode(false); setScIn(null); }} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Discard</button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px" }}>

        {capTab === "dashboard" && (<>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, padding: "20px 24px", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Current Capacity Status</div>
              <Badge util={c.realUtil} large />
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>{c.realUtil >= 0.85 ? `Hire ${c.editorsNeeded} editor(s) NOW` : c.realUtil >= 0.7 ? "Monitor closely - plan hire" : "No action needed"}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 40, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: c.realUtil >= 0.85 ? "#EF4444" : "var(--fg)" }}>{pct(c.realUtil)}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Real utilisation</div>
            </div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 10 }}>This Week's Stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 24 }}>
            <Metric label="Active Projects" value={ai.currentActiveProjects} />
            <Metric label="Weekly Workload" value={`${Math.round(c.workload)}h`} sub={`of ${c.realCapacity}h capacity`} />
            <Metric label="Spare Hours" value={`${c.spareHours}h`} accent={c.spareHours <= 10 ? "#EF4444" : "#10B981"} />
            <Metric label="Suites Occupied" value={`${c.occupiedSuiteDays}/${c.maxSuiteDays}`} sub="suite-days/week" />
            <Metric label="Editors to Fill" value={c.editorsNeeded} accent={c.editorsNeeded > 0 ? "#F59E0B" : "#10B981"} />
            <Metric label="Filled Util" value={pct(c.filledUtil)} sub="if all suites staffed" />
          </div>
          <div style={{ background: scMode ? "#1A1510" : "var(--card)", border: `1px solid ${scMode ? "#3D2E10" : "var(--border)"}`, borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Model Inputs</span>
              {!scMode && <button onClick={() => { setScIn({ ...inputs }); setScMode(true); }} style={{ ...BTN, border: "1px solid var(--border)", background: "transparent", color: "var(--accent)" }}>What-If Mode</button>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 16 }}>
              <NumIn label="Total Edit Suites" value={ai.totalSuites} onChange={v => upIn("totalSuites", v)} min={1} />
              <NumIn label="Hours / Suite / Day" value={ai.hoursPerSuitePerDay} onChange={v => upIn("hoursPerSuitePerDay", v)} min={1} step={0.5} />
              <NumIn label="Active Projects" value={ai.currentActiveProjects} onChange={v => upIn("currentActiveProjects", v)} min={0} />
              <NumIn label="Avg Edit Hrs / Project / Wk" value={ai.avgEditHoursPerProject} onChange={v => upIn("avgEditHoursPerProject", v)} min={0} step={0.5} />
              <NumIn label="New Projects / Week" value={ai.newProjectsPerWeek} onChange={v => upIn("newProjectsPerWeek", v)} min={0} />
              <NumIn label="Avg Project Duration" value={ai.avgProjectDuration} onChange={v => upIn("avgProjectDuration", v)} min={1} suffix="weeks" />
              <NumIn label="Target Utilisation" value={Math.round(ai.targetUtilisation * 100)} onChange={v => upIn("targetUtilisation", v / 100)} min={10} max={100} suffix="%" />
            </div>
          </div>
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Queueing Theory</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{QT.map(q => {
              const on = c.realUtil >= q.util - 0.025 && c.realUtil < q.util + 0.05;
              return (<div key={q.util} style={{ padding: "8px 14px", borderRadius: 8, textAlign: "center", minWidth: 75, background: on ? "var(--accent-soft)" : "var(--bg)", border: on ? "1px solid var(--accent)" : "1px solid var(--border)" }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: on ? "var(--accent)" : "var(--fg)", fontFamily: "'JetBrains Mono',monospace" }}>{pct(q.util)}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>{q.wait} wait</div>
              </div>);
            })}</div>
          </div>
        </>)}

        {capTab === "roster" && (
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ marginBottom: 4, fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Team Roster</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 20 }}>Default working days for all future weeks. Override specific weeks in Weekly Schedule. Toggle "Edit suite" off for team members who don't need a computer (producers, founders, etc.) — they won't affect computer capacity.</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead><tr>
                  <th style={{ ...TH, width: 50, textAlign: "center" }}>Photo</th>
                  <th style={{ ...TH, width: 150, textAlign: "left" }}>Name</th>
                  <th style={{ ...TH, width: 90, textAlign: "center" }}>Edit suite</th>
                  <th style={{ ...TH, width: 130, textAlign: "left" }}>Phone</th>
                  <th style={{ ...TH, width: 170, textAlign: "left" }}>Email</th>
                  {DL.map(d => <th key={d} style={{ ...TH, textAlign: "center", minWidth: 60 }}>{d}</th>)}
                  <th style={{ ...TH, width: 45, textAlign: "center" }}>Days</th>
                  <th style={{ ...TH, width: 40 }}></th>
                </tr></thead>
                <tbody>
                  {editors.map(ed => {
                    const dn = DK.filter(d => ed.defaultDays[d]).length;
                    const isE = rosterEditId === ed.id;
                    const edRole = ed.role || "editor";
                    // Avatar src — normaliseImageUrl handles Google Drive share
                    // links (converts /file/d/.../view to /thumbnail?id=... so
                    // they actually render in <img>). Falls through for
                    // Imgur / Cloudinary / direct https URLs.
                    const avatarSrc = normaliseImageUrl(ed.avatarUrl, 96);
                    const avatarInitials = (ed.name || "").split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
                    return (
                      <tr key={ed.id} style={{ opacity: edRole === "crew" ? 0.75 : 1 }}>
                        <td style={{ ...TD, textAlign: "center" }}>
                          <AvatarCell avatarSrc={avatarSrc} initials={avatarInitials}
                            currentUrl={ed.avatarUrl || ""}
                            onSave={(url) => setEditors(prev => prev.map(x => x.id === ed.id ? { ...x, avatarUrl: url } : x))}
                            name={ed.name} />
                        </td>
                        <td style={{ ...TD, fontWeight: 700, color: "var(--fg)", cursor: "pointer" }} onClick={() => { if (!isE) { setRosterEditId(ed.id); setRosterEditName(ed.name); } }}>
                          {isE ? <input ref={rosterEditRef} type="text" value={rosterEditName} onChange={e => setRosterEditName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") rosterRename(); if (e.key === "Escape") setRosterEditId(null); }} onBlur={rosterRename} style={{ width: "100%", padding: "3px 6px", borderRadius: 4, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, fontWeight: 700, outline: "none" }} /> : <span style={{ borderBottom: "1px dashed #3A4558" }}>{ed.name}</span>}
                        </td>
                        <td style={{ ...TD, textAlign: "center" }}>
                          <button onClick={() => setEditors(prev => prev.map(e => e.id === ed.id ? { ...e, role: edRole === "editor" ? "crew" : "editor" } : e))} title={edRole === "editor" ? "Occupies an edit suite — counted in weekly schedule" : "No edit suite — hidden from weekly schedule"} style={{ padding: "3px 10px", borderRadius: 10, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: edRole === "editor" ? "rgba(34,197,94,0.15)" : "rgba(90,107,133,0.15)", color: edRole === "editor" ? "#22C55E" : "#5A6B85" }}>{edRole === "editor" ? "✓ Yes" : "— No"}</button>
                        </td>
                        <td style={TD}><input type="text" value={ed.phone || ""} onChange={e => setEditors(prev => prev.map(x => x.id === ed.id ? { ...x, phone: e.target.value } : x))} placeholder="Phone..." style={{ width: "100%", padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "inherit" }} /></td>
                        <td style={TD}><input type="text" value={ed.email || ""} onChange={e => setEditors(prev => prev.map(x => x.id === ed.id ? { ...x, email: e.target.value } : x))} placeholder="Email..." style={{ width: "100%", padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none", fontFamily: "inherit" }} /></td>
                        {DK.map(day => <td key={day} onClick={() => rosterToggle(ed.id, day)} style={{ ...TD, textAlign: "center", cursor: "pointer", userSelect: "none", background: ed.defaultDays[day] ? "var(--accent-soft)" : "transparent", color: ed.defaultDays[day] ? "var(--accent)" : "#3A4558", fontWeight: 700 }}>{ed.defaultDays[day] ? "IN" : "-"}</td>)}
                        <td style={{ ...TD, textAlign: "center", fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{dn}</td>
                        <td style={{ ...TD, textAlign: "center" }}><button onClick={() => rosterRemove(ed.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 16 }}>x</button></td>
                      </tr>
                    );
                  })}
                  {rosterAdding && (
                    <tr>
                      <td style={TD}></td>
                      <td style={TD}><input ref={rosterAddRef} type="text" value={rosterNewName} onChange={e => setRosterNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") rosterAdd(); if (e.key === "Escape") { setRosterAdding(false); setRosterNewName(""); } }} placeholder="Name..." style={{ width: "100%", padding: "5px 8px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, fontWeight: 600, outline: "none" }} /></td>
                      <td style={TD} colSpan={7}></td>
                      <td style={{ ...TD, textAlign: "center" }}><button onClick={rosterAdd} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Add</button></td>
                      <td style={{ ...TD, textAlign: "center" }}><button onClick={() => { setRosterAdding(false); setRosterNewName(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 16 }}>x</button></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {!rosterAdding && <button onClick={() => setRosterAdding(true)} style={{ marginTop: 12, padding: "8px 16px", borderRadius: 8, border: "1px dashed var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Add Team Member</button>}
          </div>
        )}

        {capTab === "schedule" && (
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => goW(-1)} style={NB}>&larr;</button>
                <div style={{ textAlign: "center", minWidth: 220 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Week of {fmtLabel(monD)}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{fmtRange(monD)}</div>
                </div>
                <button onClick={() => goW(1)} style={NB}>&rarr;</button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={goToday} style={{ ...NB, fontSize: 11, fontWeight: 600 }}>Today</button>
                <div style={{ position: "relative" }}>
                  <button onClick={() => setJumpOpen(!jumpOpen)} style={{ ...NB, fontSize: 11, fontWeight: 600 }}>Jump to Date</button>
                  {jumpOpen && (
                    <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                      <input type="date" value={jumpDate} onChange={e => setJumpDate(e.target.value)} style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", colorScheme: "dark" }} />
                      <button onClick={jumpTo} style={{ marginTop: 8, width: "100%", padding: "7px", borderRadius: 6, border: "none", background: "var(--accent)", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Go</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <Grid wk={curW} weekData={weekData} onUpdate={upWeek} masterEds={scheduleEditors} inputs={ai} onUpdateSuites={v => { if (scMode) setScIn(p => ({ ...(p || inputs), totalSuites: v })); else setInputs(p => ({ ...p, totalSuites: v })); }} />
          </div>
        )}

        {capTab === "forecast" && (<>
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>12-Week Workload Forecast</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>{ai.newProjectsPerWeek} new/week, {ai.avgProjectDuration}-week duration, {ai.avgEditHoursPerProject}h avg edit</div>
            <FChart forecast={c.forecast} />
          </div>
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", overflowX: "auto" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>Forecast Detail</div>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
              <thead><tr>{["Week", "Projects", "Workload", "Real Util", "Filled Util", "Suites", "Status"].map(h => <th key={h} style={{ ...TH, textAlign: h === "Week" ? "left" : "center" }}>{h}</th>)}</tr></thead>
              <tbody>{c.forecast.map(f => (
                <tr key={f.week}>
                  <td style={{ ...TD, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>W{f.week}{f.week === 0 ? " (now)" : ""}</td>
                  <td style={{ ...TD, textAlign: "center", fontFamily: "'JetBrains Mono',monospace" }}>{f.projects}</td>
                  <td style={{ ...TD, textAlign: "center", fontFamily: "'JetBrains Mono',monospace" }}>{f.workload}h</td>
                  <td style={{ ...TD, textAlign: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}><div style={{ width: 60 }}><UBar value={f.realUtil} height={8} /></div><span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 11, color: f.realUtil >= 0.95 ? "#EF4444" : "var(--fg)" }}>{pct(f.realUtil)}</span></div></td>
                  <td style={{ ...TD, textAlign: "center", fontFamily: "'JetBrains Mono',monospace" }}>{pct(f.filledUtil)}</td>
                  <td style={{ ...TD, textAlign: "center", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{f.suitesNeeded}</td>
                  <td style={{ ...TD, textAlign: "center" }}><Badge util={f.realUtil} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>)}

        {capTab === "timelogs" && <TimeLogsView allTimeLogs={allTimeLogs} mondayEditorList={mondayEditorList} timeLogDate={timeLogDate} setTimeLogDate={setTimeLogDate} timeLogLoading={timeLogLoading} />}

        {capTab === "lunch" && (
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "24px" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 16 }}>Team Lunch</div>
              {isFounder ? (
                <div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <input type="date" value={teamLunch?.date || ""} onChange={e => setTeamLunch(p => ({ ...p, date: e.target.value }))} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", colorScheme: "dark" }} />
                    <input value={teamLunch?.time || ""} onChange={e => setTeamLunch(p => ({ ...p, time: e.target.value }))} placeholder="Time (e.g. 12:30pm)" style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", width: 160 }} />
                    <input value={teamLunch?.location || ""} onChange={e => setTeamLunch(p => ({ ...p, location: e.target.value }))} placeholder="Location" style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", flex: 1, minWidth: 180 }} />
                  </div>
                  <input value={teamLunch?.notes || ""} onChange={e => setTeamLunch(p => ({ ...p, notes: e.target.value }))} placeholder="Notes" style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", width: "100%" }} />
                </div>
              ) : (
                teamLunch ? (
                  <div style={{ padding: "16px 20px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: "var(--accent)", fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>{teamLunch.date ? new Date(teamLunch.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Date TBC"}</div>
                    {teamLunch.time && <div style={{ fontSize: 14, color: "var(--fg)", marginBottom: 4 }}>{teamLunch.time}</div>}
                    {teamLunch.location && <div style={{ fontSize: 13, color: "var(--muted)" }}>📍 {teamLunch.location}</div>}
                    {teamLunch.notes && <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>{teamLunch.notes}</div>}
                  </div>
                ) : (
                  <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No team lunch scheduled. Founders can set one.</div>
                )
              )}
            </div>
          </div>
        )}

        {capTab === "videoOfTheWeek" && (
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 22 }}>🎬</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Video of the Week</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                    Paste a Frame.io / YouTube / Instagram URL. Auto-embedded on the home page with the creator note below.
                  </div>
                </div>
              </div>

              {/* Video URL */}
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Video URL</label>
              <input
                type="url"
                value={foundersData.videoOfTheWeek?.videoUrl || ""}
                onChange={e => setFoundersData(p => ({
                  ...p,
                  videoOfTheWeek: {
                    ...(p.videoOfTheWeek || {}),
                    videoUrl: e.target.value,
                    updatedAt: new Date().toISOString(),
                  },
                }))}
                placeholder="https://youtube.com/watch?v=... or frame.io/... or instagram.com/reel/..."
                style={{ width: "100%", padding: "10px 14px", fontSize: 13, color: "var(--fg)", background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, outline: "none", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }}
              />

              {/* Preview — live re-renders as producer types so they can
                  confirm the embed works before walking away. */}
              {foundersData.videoOfTheWeek?.videoUrl && (
                <div style={{ marginTop: 14, padding: 12, background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Preview</div>
                  <VideoEmbed url={foundersData.videoOfTheWeek.videoUrl} />
                </div>
              )}

              {/* Creator */}
              <div style={{ marginTop: 16 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Who made it</label>
                <input
                  type="text"
                  value={foundersData.videoOfTheWeek?.creator || ""}
                  onChange={e => setFoundersData(p => ({
                    ...p,
                    videoOfTheWeek: {
                      ...(p.videoOfTheWeek || {}),
                      creator: e.target.value,
                      updatedAt: new Date().toISOString(),
                    },
                  }))}
                  placeholder="e.g. Vish + Steve"
                  style={{ width: "100%", padding: "10px 14px", fontSize: 13, color: "var(--fg)", background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </div>

              {/* Note */}
              <div style={{ marginTop: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Note about the video</label>
                <textarea
                  value={foundersData.videoOfTheWeek?.note || ""}
                  onChange={e => setFoundersData(p => ({
                    ...p,
                    videoOfTheWeek: {
                      ...(p.videoOfTheWeek || {}),
                      note: e.target.value,
                      updatedAt: new Date().toISOString(),
                    },
                  }))}
                  placeholder="What's great about this one? Client, project, technique, whatever."
                  rows={3}
                  style={{ width: "100%", padding: "12px 14px", fontSize: 13, fontWeight: 500, color: "var(--fg)", background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, outline: "none", resize: "vertical", fontFamily: "'DM Sans',sans-serif", lineHeight: 1.5, boxSizing: "border-box" }}
                />
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>
                  Saves automatically.
                  {foundersData.videoOfTheWeek?.updatedAt && ` Last updated ${new Date(foundersData.videoOfTheWeek.updatedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.`}
                </div>
                {foundersData.videoOfTheWeek?.videoUrl && (
                  <button
                    onClick={() => { if (window.confirm("Clear the current Video of the Week?")) setFoundersData(p => ({ ...p, videoOfTheWeek: null })); }}
                    style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--muted)", fontSize: 11, padding: "5px 12px", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}

// ─── Time logs sub-view ───
// Self-contained so the data transforms only run when this tab is mounted.
function TimeLogsView({ allTimeLogs, mondayEditorList, timeLogDate, setTimeLogDate, timeLogLoading }) {
  const fmtHM = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    if (m > 0) return `${m}m`;
    if (secs > 0) return `${secs}s`;
    return "0m";
  };
  const editorMap = {};
  mondayEditorList.forEach(ed => { editorMap[ed.id] = ed.name; });

  // Data for selected date
  const dateData = {};
  Object.entries(allTimeLogs).forEach(([edId, dates]) => {
    if (!dates || typeof dates !== "object") return;
    const dayData = dates[timeLogDate];
    if (!dayData || typeof dayData !== "object") return;
    const edName = editorMap[edId] || `Editor ${edId}`;
    const tasks = [];
    let edTotal = 0;
    Object.entries(dayData).forEach(([taskId, val]) => {
      const secs = typeof val === "number" ? val : (val?.secs || 0);
      const name = typeof val === "object" ? (val?.name || taskId) : taskId;
      const parentName = typeof val === "object" ? (val?.parentName || "") : "";
      const stage = typeof val === "object" ? (val?.stage || "") : "";
      const category = typeof val === "object" ? (val?.category || categorizeContent(parentName, val?.type)) : categorizeContent(parentName, "");
      if (secs > 0) {
        tasks.push({ taskId, secs, name, parentName, stage, category });
        edTotal += secs;
      }
    });
    if (tasks.length > 0) dateData[edId] = { name: edName, tasks, total: edTotal };
  });
  const grandTotal = Object.values(dateData).reduce((s, ed) => s + ed.total, 0);
  const datePrev = () => { const d = new Date(timeLogDate + "T00:00:00"); d.setDate(d.getDate() - 1); setTimeLogDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`); };
  const dateNext = () => { const d = new Date(timeLogDate + "T00:00:00"); d.setDate(d.getDate() + 1); setTimeLogDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`); };
  const dateLabel = new Date(timeLogDate + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // Category averages (all time)
  const catStats = {};
  CONTENT_CATEGORIES.forEach(cat => { catStats[cat] = {}; });
  Object.entries(allTimeLogs).forEach(([edId, dates]) => {
    if (!dates || typeof dates !== "object") return;
    Object.entries(dates).forEach(([date, tasks2]) => {
      if (!tasks2 || typeof tasks2 !== "object") return;
      const parentTotals = {};
      Object.entries(tasks2).forEach(([tid, val]) => {
        const secs = typeof val === "number" ? val : (val?.secs || 0);
        if (secs <= 0) return;
        const cat = typeof val === "object" ? (val?.category || "Other") : "Other";
        const pName = typeof val === "object" ? (val?.parentName || tid) : tid;
        const key = `${cat}|||${pName}|||${date}`;
        if (!parentTotals[key]) parentTotals[key] = { cat, secs: 0 };
        parentTotals[key].secs += secs;
      });
      Object.values(parentTotals).forEach(({ cat, secs }) => {
        if (!catStats[cat]) catStats[cat] = {};
        if (!catStats[cat][edId]) catStats[cat][edId] = { totalSecs: 0, count: 0 };
        catStats[cat][edId].totalSecs += secs;
        catStats[cat][edId].count += 1;
      });
    });
  });
  const hasCatData = CONTENT_CATEGORIES.some(cat => Object.keys(catStats[cat]).length > 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={datePrev} style={NB}>&larr;</button>
          <div style={{ textAlign: "center", minWidth: 260 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>{dateLabel}</div>
            {timeLogDate === todayKey() && <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, marginTop: 2 }}>Today</div>}
          </div>
          <button onClick={dateNext} style={NB}>&rarr;</button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setTimeLogDate(todayKey())} style={{ ...NB, fontSize: 11, fontWeight: 600 }}>Today</button>
          <div style={{ padding: "8px 16px", borderRadius: 8, background: grandTotal > 0 ? "rgba(16,185,129,0.12)" : "var(--bg)", border: "1px solid var(--border)" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total </span>
            <span style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: grandTotal > 0 ? "#10B981" : "var(--fg)", marginLeft: 8 }}>{fmtHM(grandTotal)}</span>
          </div>
        </div>
      </div>

      {timeLogLoading ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>Loading time logs...</div>
      ) : Object.keys(dateData).length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⏱</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No time logged</div>
          <div style={{ fontSize: 13 }}>No editors have logged time for this date</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {Object.entries(dateData).sort((a, b) => b[1].total - a[1].total).map(([edId, ed]) => (
            <div key={edId} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{ed.name.split(" ").map(n => n[0]).join("")}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{ed.name}</span>
                </div>
                <span style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#10B981" }}>{fmtHM(ed.total)}</span>
              </div>
              <div style={{ padding: "8px 12px" }}>
                {ed.tasks.sort((a, b) => b.secs - a.secs).map(t => {
                  const stageColors = { "Edit": "#0082FA", "Shoot": "#F87700", "Pre Production": "#8B5CF6", "Revisions": "#EF4444", "Delivery": "#10B981" };
                  const stageCol = stageColors[t.stage] || "var(--accent)";
                  return (
                    <div key={t.taskId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border-light)" }}>
                      <div style={{ flex: 1 }}>
                        {t.parentName && <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{t.parentName}</div>}
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, color: "var(--fg)", fontWeight: 500 }}>{t.name}</span>
                          {t.stage && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 3, background: `${stageCol}20`, color: stageCol, textTransform: "uppercase" }}>{t.stage}</span>}
                          {t.category && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 3, background: `${CAT_COLORS[t.category] || "#5A6B85"}15`, color: CAT_COLORS[t.category] || "#5A6B85" }}>{t.category}</span>}
                        </div>
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fmtHM(t.secs)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Category Averages (all time) */}
      {Object.keys(allTimeLogs).length > 0 && hasCatData && (
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)", marginBottom: 16 }}>Average Time by Content Type</div>
          <div style={{ display: "grid", gap: 16 }}>
            {CONTENT_CATEGORIES.map(cat => {
              const editors2 = catStats[cat];
              const edEntries = Object.entries(editors2).filter(([_, v]) => v.count > 0);
              if (edEntries.length === 0) return null;
              const allTotal = edEntries.reduce((s, [_, v]) => s + v.totalSecs, 0);
              const allCount = edEntries.reduce((s, [_, v]) => s + v.count, 0);
              const allAvg = allCount > 0 ? Math.round(allTotal / allCount) : 0;
              const catColor = CAT_COLORS[cat] || "#5A6B85";
              return (
                <div key={cat} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: catColor }} />
                      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{cat}</span>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{allCount} task{allCount !== 1 ? "s" : ""} logged</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Avg per task</div>
                      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: catColor }}>{fmtHM(allAvg)}</div>
                    </div>
                  </div>
                  <div style={{ padding: "8px 12px" }}>
                    {edEntries.sort((a, b) => b[1].count - a[1].count).map(([edId2, v]) => {
                      const edName2 = editorMap[edId2] || `Editor ${edId2}`;
                      const avg = v.count > 0 ? Math.round(v.totalSecs / v.count) : 0;
                      return (
                        <div key={edId2} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--border-light)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800 }}>{edName2.split(" ").map(n => n[0]).join("")}</span>
                            <span style={{ fontSize: 12, color: "var(--fg)", fontWeight: 500 }}>{edName2}</span>
                            <span style={{ fontSize: 10, color: "var(--muted)" }}>{v.count} task{v.count !== 1 ? "s" : ""}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <span style={{ fontSize: 10, color: "var(--muted)" }}>avg</span>
                            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "var(--fg)" }}>{fmtHM(avg)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// AvatarCell — click to reveal URL input, live preview while editing.
// Lives on the Team Roster table. Sits in its own cell so the rest of
// the row layout doesn't reflow when the input opens.
function AvatarCell({ avatarSrc, initials, currentUrl, onSave, name }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(currentUrl);
  useEffect(() => { setUrl(currentUrl); }, [currentUrl]);
  const save = () => { onSave(url.trim()); setEditing(false); };
  const cancel = () => { setUrl(currentUrl); setEditing(false); };
  if (editing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center", width: 160 }}>
        <input type="text" value={url} autoFocus onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          placeholder="Paste photo URL..."
          style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 11, outline: "none", fontFamily: "inherit" }} />
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={save} style={{ padding: "2px 8px", borderRadius: 4, border: "none", background: "var(--accent)", color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
          <button onClick={cancel} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        </div>
      </div>
    );
  }
  // Display state — click the thumb to edit. Falls back to initials
  // circle if no avatarSrc. onError hides the <img> so a broken URL
  // doesn't render a spacer.
  return (
    <button onClick={() => setEditing(true)} title={currentUrl ? "Click to change photo URL" : "Click to add a photo URL"}
      style={{ width: 36, height: 36, borderRadius: "50%", border: "none", padding: 0, cursor: "pointer", overflow: "hidden", background: "linear-gradient(135deg, var(--accent) 0%, #004F99 100%)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em" }}>
      {avatarSrc ? (
        <img src={avatarSrc} alt={name || ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
      ) : (
        <span>{initials}</span>
      )}
    </button>
  );
}

