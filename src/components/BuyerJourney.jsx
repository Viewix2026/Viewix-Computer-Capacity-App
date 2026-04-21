// Buyer Journey — renders the visual left-to-right customer pipeline plus
// an embedded Turnaround editor (both share the same time-between-stages
// data where a stage has been linked to a post-sale milestone).
//
// Top-level tab toggle (Journey / Turnaround) sits at the component head.
// The Journey view scrolls horizontally with no wrap — one long row of
// stage cards with connector arrows between them. Each connector shows
// the days-to-next-stage + % progression:
//   - days: pulled from /turnaround[milestoneKey] when the stage is linked,
//           otherwise the stage's own daysToNext field.
//   - %:    computed live from /accounts milestone data where both sides
//           of the gap are linked milestones; falls back to the stage's
//           manual pct text otherwise.
//
// The Turnaround sub-tab is the canonical editor for /turnaround — the
// same gap values AccountsDashboard uses to compute per-client milestone
// due dates. Edits in either place write back to the same Firebase path.

import { useState } from "react";
import { BTN, MILESTONE_DEFS, DEFAULT_MILESTONE_GAPS } from "../config";

const SECTION_COLORS = { "Lead Generation": "#0082FA", "Sales": "#F87700", "Pre Production": "#8B5CF6", "Production": "#10B981", "Delivery": "#F59E0B", "Retention": "#EC4899" };

// Milestone-to-default-stage hints used when the user first opens the
// editor — otherwise the dropdown is just "(none)" everywhere. Stored
// on the stage as `milestoneKey` once the user links it explicitly.
const DEFAULT_META = [
  { id: "m1", type: "section", label: "Lead Generation" },
  { id: "m2", type: "stage", title: "Meta ad", desc: "Prospect watches a video ad on Facebook or Instagram" },
  { id: "m3", type: "stage", title: "Click \"Learn more\"", desc: "CTA button takes them to the landing page" },
  { id: "m4", type: "stage", title: "Landing page", desc: "Complete a 5 step survey. They become a lead at this point." },
  { id: "m5", type: "stage", title: "Booked meeting", desc: "65% of leads book a meeting with the sales team. Lead is pushed to the LEADS Slack channel.", pct: "65% convert" },
  { id: "m6", type: "stage", title: "Closer calls immediately", desc: "As soon as the lead comes in, a closer calls them from the LEADS channel" },
  { id: "m7", type: "section", label: "Sales" },
  { id: "m8", type: "stage", title: "Discovery call", desc: "Further qualification. Understand their goals, budget, timeline. Present the content blueprint." },
  { id: "m9", type: "branch", left: { title: "Won", desc: "Send video sales letter explaining the process. Closer sends 50% invoice." }, right: { title: "Lost", desc: "Deal closed. Add to nurture sequence for future re-engagement." } },
  { id: "m10", type: "stage", title: "Invoice paid", desc: "First 50% invoice for their ad package is paid before production begins", diff: true, tag: "50% upfront", milestoneKey: "signing" },
  { id: "m11", type: "section", label: "Pre Production" },
  { id: "m12", type: "stage", title: "Pre production meeting", desc: "Client meets a founder and their project lead. Project lead asks questions to deeply understand the business.", milestoneKey: "preProductionMeeting" },
  { id: "m13", type: "stage", title: "Pre production prep", desc: "Team puts together the pre production plan with all creative ideas" },
  { id: "m14", type: "stage", title: "Pre production call", desc: "Run the client through all ideas and creative direction", milestoneKey: "preProductionPresentation" },
  { id: "m15", type: "branch", left: { title: "Revisions", desc: "Client has feedback. A couple of days to action, then another meeting to confirm." }, right: { title: "Approved", desc: "No changes needed. Go straight to booking the shoot." } },
  { id: "m16", type: "section", label: "Production" },
  { id: "m17", type: "stage", title: "Book shoot", desc: "Schedule the shoot date with the client and team" },
  { id: "m18", type: "stage", title: "Shoot day", desc: "Single shoot day with the full team on location", milestoneKey: "shoot" },
  { id: "m19", type: "stage", title: "Editing", desc: "Editor completes all videos and all aspect ratios" },
  { id: "m20", type: "section", label: "Delivery" },
  { id: "m21", type: "branch", left: { title: "Office review", desc: "Client comes in to review. Get a video testimonial and take feedback in person." }, right: { title: "Frame.io", desc: "Client reviews videos online via Frame.io and leaves feedback there." } },
  { id: "m22", type: "stage", title: "Action feedback", desc: "Make any requested changes from the review" },
  { id: "m23", type: "stage", title: "Final delivery", desc: "Deliver all videos in all ratios to the client. Client shares with their ad agency for deployment.", diff: true, milestoneKey: "posting" },
  { id: "m24", type: "section", label: "Retention" },
  { id: "m25", type: "stage", title: "Monthly performance review", desc: "Recurring monthly meeting to review ad performance in Meta Ads Manager with their agency", milestoneKey: "resultsReview" },
  { id: "m26", type: "stage", title: "Ongoing catch ups", desc: "Understand which ads are performing. Identify when new ads or a video sales letter is needed to increase landing page opt in rate.", milestoneKey: "partnershipReview" },
];

const DEFAULT_SOCIAL = [
  { id: "s1", type: "section", label: "Lead Generation" },
  { id: "s2", type: "stage", title: "Meta ad", desc: "Prospect watches a video ad on Facebook or Instagram" },
  { id: "s3", type: "stage", title: "Click \"Learn more\"", desc: "CTA button takes them to the landing page" },
  { id: "s4", type: "stage", title: "Landing page", desc: "Complete a 5 step survey. They become a lead at this point." },
  { id: "s5", type: "stage", title: "Booked meeting", desc: "65% of leads book a meeting with the sales team. Lead is pushed to the LEADS Slack channel.", pct: "65% convert" },
  { id: "s6", type: "stage", title: "Closer calls immediately", desc: "As soon as the lead comes in, a closer calls them from the LEADS channel" },
  { id: "s7", type: "section", label: "Sales" },
  { id: "s8", type: "stage", title: "Discovery call", desc: "Further qualification. Understand their goals, budget, timeline. Present the content blueprint." },
  { id: "s9", type: "branch", left: { title: "Won", desc: "Send video sales letter explaining the process. Closer sends first invoice." }, right: { title: "Lost", desc: "Deal closed. Add to nurture sequence for future re-engagement." } },
  { id: "s10", type: "stage", title: "Invoice paid", desc: "Retainer split into 3 invoices. First paid upfront, second after that, third paid one month after the second.", diff: true, tag: "3 payments", milestoneKey: "signing" },
  { id: "s11", type: "section", label: "Pre Production" },
  { id: "s12", type: "stage", title: "Pre production meeting", desc: "Client meets a founder and their project lead. Project lead asks questions to deeply understand the business.", milestoneKey: "preProductionMeeting" },
  { id: "s13", type: "stage", title: "Pre production prep", desc: "Team puts together the pre production plan with all creative ideas" },
  { id: "s14", type: "stage", title: "Pre production call", desc: "Run the client through all ideas and creative direction", milestoneKey: "preProductionPresentation" },
  { id: "s15", type: "branch", left: { title: "Revisions", desc: "Client has feedback. A couple of days to action, then another meeting to confirm." }, right: { title: "Approved", desc: "No changes needed. Go straight to booking the shoot." } },
  { id: "s16", type: "section", label: "Production" },
  { id: "s17", type: "stage", title: "Book shoot", desc: "Schedule the shoot date with the client and team" },
  { id: "s18", type: "stage", title: "Shoot day", desc: "Single shoot day with the full team on location", milestoneKey: "shoot" },
  { id: "s19", type: "stage", title: "Editing", desc: "Editor completes all videos and all aspect ratios" },
  { id: "s20", type: "section", label: "Delivery" },
  { id: "s21", type: "branch", left: { title: "Office review", desc: "Client comes in to review. Get a video testimonial and take feedback in person." }, right: { title: "Frame.io", desc: "Client reviews videos online via Frame.io and leaves feedback there." } },
  { id: "s22", type: "stage", title: "Action feedback", desc: "Make any requested changes from the review" },
  { id: "s23", type: "stage", title: "Upload to Metricool", desc: "Viewix takes the client's login credentials and uploads content directly to Metricool, scheduling and posting for them.", diff: true, milestoneKey: "posting" },
  { id: "s24", type: "section", label: "Retention" },
  { id: "s25", type: "stage", title: "Monthly performance review", desc: "Recurring monthly meeting to review content performance and engagement metrics", milestoneKey: "resultsReview" },
  { id: "s26", type: "stage", title: "Ongoing catch ups", desc: "Understand what content is performing. Identify when a new batch of content is needed for the next month.", milestoneKey: "partnershipReview" },
];

// Convert a stage + turnaround-gap map to a display-ready days value.
// Milestone-linked stages pull from /turnaround (editing them there
// writes back to /turnaround); unlinked stages store their own days
// on the stage object. Returns null when no value is set either way.
function getDaysToNext(stage, turnaround) {
  if (stage?.milestoneKey) {
    const v = turnaround?.[stage.milestoneKey];
    return v != null ? Number(v) : null;
  }
  if (stage?.daysToNext != null) return Number(stage.daysToNext);
  return null;
}

// Compute live conversion % from accounts data — what fraction of clients
// that completed `fromKey` also completed `toKey`. Skips gracefully when
// either milestone isn't linked on the surrounding stages, or when we
// have too few data points to be meaningful.
function computeLivePct(accounts, fromKey, toKey) {
  if (!fromKey || !toKey || !accounts) return null;
  const list = Object.values(accounts).filter(a => a && a.id);
  if (list.length === 0) return null;
  const fromDone = list.filter(a => a?.milestones?.[fromKey]?.status === "Completed");
  if (fromDone.length < 2) return null; // too few to bother showing
  const toDone = fromDone.filter(a => a?.milestones?.[toKey]?.status === "Completed");
  return Math.round((toDone.length / fromDone.length) * 100);
}

// Find the next linkable milestone after the stage at `stages[idx]`.
// Used by computeLivePct so we pair each linked stage with the
// soonest downstream linked stage — inline sections/branches don't
// break the chain.
function findNextMilestoneStage(stages, idx) {
  for (let j = idx + 1; j < stages.length; j++) {
    if (stages[j].type === "stage" && stages[j].milestoneKey) return stages[j];
  }
  return null;
}

export function BuyerJourney({ data, onChange, turnaround, setTurnaround, accounts }) {
  const [subTab, setSubTab] = useState("journey");      // journey | turnaround
  const [offer, setOffer] = useState("meta");
  const [editingId, setEditingId] = useState(null);
  // Inline connector editing — { stageId, field: "days" | "pct" } | null.
  // When set, the corresponding connector label renders an input instead
  // of the static pill. Blur or Enter writes + closes. Linked stages
  // can still inline-edit days (it flows to /turnaround), but pct for
  // linked stages stays read-only live data.
  const [inlineEdit, setInlineEdit] = useState(null);

  const metaStages = data?.meta?.length > 0 ? data.meta : DEFAULT_META;
  const socialStages = data?.social?.length > 0 ? data.social : DEFAULT_SOCIAL;
  const stages = offer === "meta" ? metaStages : socialStages;

  const save = (updated) => { onChange({ ...data, [offer]: updated }); };
  const updateItem = (id, patch) => { save(stages.map(s => s.id === id ? { ...s, ...patch } : s)); };
  const removeItem = (id) => { if (!confirm("Remove this item?")) return; save(stages.filter(s => s.id !== id)); };
  const moveItem = (id, dir) => { const idx = stages.findIndex(s => s.id === id); if (idx < 0) return; const si = idx + dir; if (si < 0 || si >= stages.length) return; const n = [...stages]; [n[idx], n[si]] = [n[si], n[idx]]; save(n); };

  const addStage = (afterId) => { const idx = stages.findIndex(s => s.id === afterId); const nid = `${offer[0]}${Date.now()}`; const n = [...stages]; n.splice(idx + 1, 0, { id: nid, type: "stage", title: "New stage", desc: "" }); save(n); setEditingId(nid); };
  const addBranch = (afterId) => { const idx = stages.findIndex(s => s.id === afterId); const nid = `${offer[0]}b${Date.now()}`; const n = [...stages]; n.splice(idx + 1, 0, { id: nid, type: "branch", left: { title: "Option A", desc: "" }, right: { title: "Option B", desc: "" } }); save(n); setEditingId(nid); };
  const addSection = (afterId) => { const idx = stages.findIndex(s => s.id === afterId); const n = [...stages]; n.splice(idx + 1, 0, { id: `${offer[0]}sec${Date.now()}`, type: "section", label: "New Section" }); save(n); };

  // Edit handler for per-stage days: linked stages push to /turnaround,
  // unlinked stages persist on the stage itself. Empty string clears.
  const updateStageDays = (stage, value) => {
    const num = value === "" || value == null ? null : Number(value);
    if (stage.milestoneKey) {
      setTurnaround(prev => ({ ...(prev || {}), [stage.milestoneKey]: num ?? 0 }));
    } else {
      updateItem(stage.id, { daysToNext: num });
    }
  };

  const inputSt = { width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", fontFamily: "'DM Sans',sans-serif" };
  const descSt = { ...inputSt, fontSize: 12, minHeight: 50, resize: "vertical" };
  const smallBtn = { background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 10, padding: "2px 4px" };

  // Enhanced connector between two stages — shows days-to-next and
  // optional % conversion stacked above the arrow. Both chips click-to-
  // edit: click days → numeric input; click pct → text input (unless
  // the pct is computed live from accounts data, in which case the pill
  // is read-only and shows a tooltip explaining why).
  const StageConnector = ({ stage, days, pctValue, pctSource }) => {
    const hasDays = days != null && !isNaN(days);
    const hasPct = pctValue != null && pctValue !== "";
    const daysEditing = inlineEdit?.stageId === stage?.id && inlineEdit?.field === "days";
    const pctEditing  = inlineEdit?.stageId === stage?.id && inlineEdit?.field === "pct";
    const canEditPct = pctSource !== "live"; // live % is derived — not editable
    const pctBgColor = pctSource === "live" ? "rgba(16,185,129,0.12)" : "rgba(0,130,250,0.12)";
    const pctFgColor = pctSource === "live" ? "#10B981" : "#0082FA";
    const pctTitle = pctSource === "live"
      ? "Live conversion from client milestone data (auto-computed — link/unlink milestones on the stages to change)"
      : (canEditPct ? "Click to edit manual % label" : "");

    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", alignSelf: "center", flexShrink: 0, gap: 2, padding: "0 6px", minWidth: 70 }}>
        {/* Percent pill (above arrow). Empty-state click-to-add when
            nothing is set but the stage is unlinked — gives producers
            a fast way to drop a "~30%" note without entering edit mode. */}
        {pctEditing ? (
          <input autoFocus type="text"
            defaultValue={typeof pctValue === "number" ? `${pctValue}%` : (pctValue || "")}
            onBlur={e => { updateItem(stage.id, { pct: e.target.value.trim() }); setInlineEdit(null); }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); }}
            placeholder="e.g. 65%"
            style={{ width: 70, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }}
          />
        ) : hasPct ? (
          <div
            onClick={() => { if (canEditPct) setInlineEdit({ stageId: stage.id, field: "pct" }); }}
            title={pctTitle}
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: pctBgColor, color: pctFgColor, whiteSpace: "nowrap", fontFamily: "'JetBrains Mono',monospace", cursor: canEditPct ? "pointer" : "help" }}>
            {typeof pctValue === "number" ? `${pctValue}%` : pctValue}
            {pctSource === "live" && <span style={{ marginLeft: 4, opacity: 0.6 }}>●</span>}
          </div>
        ) : (stage && canEditPct) ? (
          <button
            onClick={() => setInlineEdit({ stageId: stage.id, field: "pct" })}
            title="Add % conversion"
            style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "transparent", color: "var(--muted)", border: "1px dashed var(--border)", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>
            + %
          </button>
        ) : null}

        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ height: 2, width: 20, background: "var(--border)" }} />
          <div style={{ width: 0, height: 0, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: "6px solid var(--border)" }} />
        </div>

        {/* Days chip (below arrow). Linked stages show a subtle ↻ to
            remind producers that editing here also bumps /turnaround. */}
        {daysEditing ? (
          <input autoFocus type="number" min={0}
            defaultValue={hasDays ? days : ""}
            onBlur={e => { updateStageDays(stage, e.target.value); setInlineEdit(null); }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); }}
            placeholder="days"
            style={{ width: 55, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }}
          />
        ) : hasDays ? (
          <div
            onClick={() => setInlineEdit({ stageId: stage.id, field: "days" })}
            title={stage?.milestoneKey ? "Click to edit — also writes to /turnaround (syncs with client due dates)" : "Click to edit days to next stage"}
            style={{ fontSize: 10, fontWeight: 600, color: "var(--muted)", whiteSpace: "nowrap", fontFamily: "'JetBrains Mono',monospace", cursor: "pointer", padding: "1px 4px", borderRadius: 3 }}>
            {days}d{stage?.milestoneKey && <span style={{ marginLeft: 3, opacity: 0.6, color: "#0082FA" }}>↻</span>}
          </div>
        ) : stage ? (
          <button
            onClick={() => setInlineEdit({ stageId: stage.id, field: "days" })}
            title="Add days to next stage"
            style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3, background: "transparent", color: "var(--muted)", border: "1px dashed var(--border)", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>
            + d
          </button>
        ) : null}
      </div>
    );
  };

  // ─── JOURNEY SUB-TAB ─────────────────────────────────────────────
  const renderJourneyView = () => (
    <div style={{ padding: "24px 28px 60px", overflowX: "auto" }}>
      <div style={{
        display: "flex", flexDirection: "row", flexWrap: "nowrap",
        alignItems: "stretch", gap: 8, minWidth: "min-content",
      }}>
        {stages.map((item, i) => {
          const isEditing = editingId === item.id;
          const nextItem = stages[i + 1];

          // Only render a connector when this is a regular stage that
          // advances to another stage-like thing. Sections don't get
          // connectors either side (they're the dividers).
          const showConnector = item.type !== "section" && nextItem && nextItem.type !== "section";
          const connectorDays = item.type === "stage" ? getDaysToNext(item, turnaround) : null;
          // Live % lookup: pair this linked stage with the next linked one
          // downstream. If either end isn't linked, we fall back to the
          // stage's manual pct text below.
          let pctValue = null, pctSource = null;
          if (item.type === "stage") {
            const nextLinked = item.milestoneKey ? findNextMilestoneStage(stages, i) : null;
            if (item.milestoneKey && nextLinked?.milestoneKey) {
              const live = computeLivePct(accounts, item.milestoneKey, nextLinked.milestoneKey);
              if (live != null) { pctValue = live; pctSource = "live"; }
            }
            if (pctValue == null && item.pct) { pctValue = item.pct; pctSource = "manual"; }
          }

          if (item.type === "section") {
            const sc = SECTION_COLORS[item.label] || "var(--accent)";
            return (
              <div key={item.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, paddingLeft: i > 0 ? 8 : 0, paddingRight: 8, alignSelf: "stretch", flexShrink: 0 }}>
                {isEditing ? (
                  <input defaultValue={item.label} autoFocus onBlur={e => { updateItem(item.id, { label: e.target.value.trim() || item.label }); setEditingId(null); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                    style={{ ...inputSt, fontSize: 11, fontWeight: 700, textTransform: "uppercase", maxWidth: 140 }} />
                ) : (
                  <span onClick={() => setEditingId(item.id)}
                    style={{ fontSize: 11, fontWeight: 700, color: sc, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", writingMode: "vertical-rl", transform: "rotate(180deg)", padding: "4px 2px", whiteSpace: "nowrap" }}>
                    {item.label}
                  </span>
                )}
                <div style={{ flex: 1, width: 2, background: sc, opacity: 0.35, borderRadius: 2, minHeight: 40 }} />
                <div style={{ display: "flex", gap: 2 }}>
                  <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                  <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                  <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                </div>
              </div>
            );
          }

          if (item.type === "branch") {
            return (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                <div style={{ display: "flex", flexDirection: "column", width: 260 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {["left", "right"].map(side => {
                      const b = item[side];
                      const isWon = b.title.toLowerCase() === "won";
                      const isLost = b.title.toLowerCase() === "lost";
                      const bc = isWon ? "rgba(16,185,129,0.5)" : isLost ? "rgba(239,68,68,0.5)" : "var(--border)";
                      return (
                        <div key={side} style={{ background: "var(--card)", border: `1px solid ${bc}`, borderRadius: 10, padding: "12px 14px" }}>
                          {isEditing ? (<>
                            <input defaultValue={b.title} onBlur={e => updateItem(item.id, { [side]: { ...b, title: e.target.value.trim() || b.title } })} style={{ ...inputSt, fontSize: 12, fontWeight: 700, marginBottom: 4 }} />
                            <textarea defaultValue={b.desc} onBlur={e => updateItem(item.id, { [side]: { ...b, desc: e.target.value } })} style={descSt} />
                          </>) : (<>
                            <div style={{ fontSize: 12, fontWeight: 700, color: isWon ? "#10B981" : isLost ? "#EF4444" : "var(--fg)", marginBottom: 2 }}>{b.title}</div>
                            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{b.desc}</div>
                          </>)}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 4 }}>
                    <button onClick={() => setEditingId(isEditing ? null : item.id)} style={{ ...smallBtn, color: "var(--accent)", fontWeight: 600 }}>{isEditing ? "Done" : "Edit"}</button>
                    <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                    <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                    <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                  </div>
                  {isEditing && (
                    <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <button onClick={() => addStage(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Stage</button>
                      <button onClick={() => addBranch(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Branch</button>
                      <button onClick={() => addSection(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Section</button>
                    </div>
                  )}
                </div>
                {showConnector && <StageConnector />}
              </div>
            );
          }

          // Plain stage card
          return (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", width: 240 }}>
                <div style={{ background: "var(--card)", border: `1px solid ${item.diff ? "var(--accent)" : "var(--border)"}`, borderRadius: item.diff ? 0 : 10, padding: "14px 18px", borderLeft: item.diff ? "3px solid var(--accent)" : undefined }}>
                  {isEditing ? (<>
                    <input defaultValue={item.title} onBlur={e => updateItem(item.id, { title: e.target.value.trim() || item.title })} style={{ ...inputSt, fontSize: 14, fontWeight: 700, marginBottom: 6 }} autoFocus />
                    <textarea defaultValue={item.desc} onBlur={e => updateItem(item.id, { desc: e.target.value })} style={descSt} />

                    {/* Milestone linker — ties this stage's days to
                        /turnaround so changes sync with the Turnaround
                        sub-tab and AccountsDashboard due dates. */}
                    <div style={{ marginTop: 8 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 }}>Linked Milestone</label>
                      <select value={item.milestoneKey || ""} onChange={e => updateItem(item.id, { milestoneKey: e.target.value || null, daysToNext: e.target.value ? null : item.daysToNext })}
                        style={{ ...inputSt, fontSize: 12 }}>
                        <option value="">(none — standalone stage)</option>
                        {MILESTONE_DEFS.map(m => (
                          <option key={m.key} value={m.key}>{m.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Per-stage time — numeric days, writes to either
                        /turnaround or the stage itself depending on link. */}
                    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", flex: 1 }}>Days to next stage</label>
                      <input type="number" min={0}
                        defaultValue={getDaysToNext(item, turnaround) ?? ""}
                        onBlur={e => updateStageDays(item, e.target.value)}
                        style={{ ...inputSt, width: 70, fontSize: 12, textAlign: "center", fontFamily: "'JetBrains Mono',monospace" }} />
                    </div>
                    {item.milestoneKey && (
                      <div style={{ fontSize: 10, color: "var(--accent)", marginTop: 4 }}>
                        ↻ Synced with Turnaround tab · shared with client due dates
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <input defaultValue={item.pct || ""} onBlur={e => updateItem(item.id, { pct: e.target.value.trim() })} placeholder="Manual % (e.g. 65% convert)" style={{ ...inputSt, fontSize: 11 }} />
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={!!item.diff} onChange={e => updateItem(item.id, { diff: e.target.checked })} /> Differs between offers</label>
                    </div>
                  </>) : (<>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>{item.title}</span>
                      {item.milestoneKey && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(0,130,250,0.12)", color: "#0082FA", letterSpacing: "0.04em" }} title={`Linked to ${MILESTONE_DEFS.find(m => m.key === item.milestoneKey)?.label || item.milestoneKey} milestone`}>↻</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{item.desc}</div>
                    {item.tag && !item.milestoneKey && getDaysToNext(item, turnaround) == null && (
                      <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "var(--bg)", color: "var(--muted)", display: "inline-block" }}>{item.tag}</div>
                    )}
                  </>)}
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 6 }}>
                    <button onClick={() => setEditingId(isEditing ? null : item.id)} style={{ ...smallBtn, color: "var(--accent)", fontWeight: 600 }}>{isEditing ? "Done" : "Edit"}</button>
                    <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                    <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                    <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                  </div>
                </div>
                {isEditing && (
                  <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button onClick={() => addStage(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Stage</button>
                    <button onClick={() => addBranch(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Branch</button>
                    <button onClick={() => addSection(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Section</button>
                  </div>
                )}
              </div>
              {showConnector && <StageConnector stage={item} days={connectorDays} pctValue={pctValue} pctSource={pctSource} />}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── TURNAROUND SUB-TAB ─────────────────────────────────────────
  // Moved verbatim from AccountsDashboard. Reads /turnaround (merged
  // with DEFAULT_MILESTONE_GAPS for first-load bootstrap), edits write
  // back via setTurnaround. Same data as journey-view's linked stages.
  const renderTurnaroundView = () => {
    const gaps = { ...DEFAULT_MILESTONE_GAPS, ...(turnaround || {}) };
    const offsets = {};
    let cumulative = 0;
    offsets.signing = 0;
    for (let i = 1; i < MILESTONE_DEFS.length; i++) {
      const key = MILESTONE_DEFS[i].key;
      cumulative += (gaps[key] || DEFAULT_MILESTONE_GAPS[key] || 0);
      offsets[key] = cumulative;
    }
    const updateGap = (key, val) => {
      const v = parseInt(val, 10);
      if (isNaN(v) || v < 0) return;
      setTurnaround(prev => ({ ...(prev || {}), [key]: v }));
    };
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 28px 60px" }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Standard Turnaround Times</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
            Days between each post-sale milestone. These values sync to linked stages in the Journey tab and drive client milestone due-dates in Accounts.
          </div>
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
    );
  };

  return (<>
    <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Buyer Journey</span>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          <button onClick={() => setSubTab("journey")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "journey" ? "var(--card)" : "transparent", color: subTab === "journey" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Journey</button>
          <button onClick={() => setSubTab("turnaround")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "turnaround" ? "var(--card)" : "transparent", color: subTab === "turnaround" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Turnaround</button>
        </div>
      </div>
      {subTab === "journey" && (
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          {[{ key: "meta", label: "Meta Ads Offer" }, { key: "social", label: "Social Media Retainer" }].map(t => (
            <button key={t.key} onClick={() => { setOffer(t.key); setEditingId(null); }} style={{ padding: "7px 16px", borderRadius: 6, border: "none", background: offer === t.key ? "var(--card)" : "transparent", color: offer === t.key ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
          ))}
        </div>
      )}
    </div>
    {subTab === "journey" ? renderJourneyView() : renderTurnaroundView()}
  </>);
}
