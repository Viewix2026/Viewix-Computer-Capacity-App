import { useState } from "react";
import { BTN } from "../config";

const SECTION_COLORS = { "Lead Generation": "#0082FA", "Sales": "#F87700", "Pre Production": "#8B5CF6", "Production": "#10B981", "Delivery": "#F59E0B", "Retention": "#EC4899" };

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
  { id: "m10", type: "stage", title: "Invoice paid", desc: "First 50% invoice for their ad package is paid before production begins", diff: true, tag: "50% upfront" },
  { id: "m11", type: "section", label: "Pre Production" },
  { id: "m12", type: "stage", title: "Pre production meeting", desc: "Client meets a founder and their project lead. Project lead asks questions to deeply understand the business." },
  { id: "m13", type: "stage", title: "Pre production prep", desc: "Team puts together the pre production plan with all creative ideas", tag: "7 to 10 days" },
  { id: "m14", type: "stage", title: "Pre production call", desc: "Run the client through all ideas and creative direction" },
  { id: "m15", type: "branch", left: { title: "Revisions", desc: "Client has feedback. A couple of days to action, then another meeting to confirm." }, right: { title: "Approved", desc: "No changes needed. Go straight to booking the shoot." } },
  { id: "m16", type: "section", label: "Production" },
  { id: "m17", type: "stage", title: "Book shoot", desc: "Schedule the shoot date with the client and team", tag: "~7 to 14 days" },
  { id: "m18", type: "stage", title: "Shoot day", desc: "Single shoot day with the full team on location" },
  { id: "m19", type: "stage", title: "Editing", desc: "Editor completes all videos and all aspect ratios", tag: "2 to 3 weeks" },
  { id: "m20", type: "section", label: "Delivery" },
  { id: "m21", type: "branch", left: { title: "Office review", desc: "Client comes in to review. Get a video testimonial and take feedback in person." }, right: { title: "Frame.io", desc: "Client reviews videos online via Frame.io and leaves feedback there." } },
  { id: "m22", type: "stage", title: "Action feedback", desc: "Make any requested changes from the review" },
  { id: "m23", type: "stage", title: "Final delivery", desc: "Deliver all videos in all ratios to the client. Client shares with their ad agency for deployment.", diff: true },
  { id: "m24", type: "section", label: "Retention" },
  { id: "m25", type: "stage", title: "Monthly performance review", desc: "Recurring monthly meeting to review ad performance in Meta Ads Manager with their agency" },
  { id: "m26", type: "stage", title: "Ongoing catch ups", desc: "Understand which ads are performing. Identify when new ads or a video sales letter is needed to increase landing page opt in rate." },
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
  { id: "s10", type: "stage", title: "Invoice paid", desc: "Retainer split into 3 invoices. First paid upfront, second after that, third paid one month after the second.", diff: true, tag: "3 payments" },
  { id: "s11", type: "section", label: "Pre Production" },
  { id: "s12", type: "stage", title: "Pre production meeting", desc: "Client meets a founder and their project lead. Project lead asks questions to deeply understand the business." },
  { id: "s13", type: "stage", title: "Pre production prep", desc: "Team puts together the pre production plan with all creative ideas", tag: "7 to 10 days" },
  { id: "s14", type: "stage", title: "Pre production call", desc: "Run the client through all ideas and creative direction" },
  { id: "s15", type: "branch", left: { title: "Revisions", desc: "Client has feedback. A couple of days to action, then another meeting to confirm." }, right: { title: "Approved", desc: "No changes needed. Go straight to booking the shoot." } },
  { id: "s16", type: "section", label: "Production" },
  { id: "s17", type: "stage", title: "Book shoot", desc: "Schedule the shoot date with the client and team", tag: "~7 to 14 days" },
  { id: "s18", type: "stage", title: "Shoot day", desc: "Single shoot day with the full team on location" },
  { id: "s19", type: "stage", title: "Editing", desc: "Editor completes all videos and all aspect ratios", tag: "2 to 3 weeks" },
  { id: "s20", type: "section", label: "Delivery" },
  { id: "s21", type: "branch", left: { title: "Office review", desc: "Client comes in to review. Get a video testimonial and take feedback in person." }, right: { title: "Frame.io", desc: "Client reviews videos online via Frame.io and leaves feedback there." } },
  { id: "s22", type: "stage", title: "Action feedback", desc: "Make any requested changes from the review" },
  { id: "s23", type: "stage", title: "Upload to Metricool", desc: "Viewix takes the client's login credentials and uploads content directly to Metricool, scheduling and posting for them.", diff: true },
  { id: "s24", type: "section", label: "Retention" },
  { id: "s25", type: "stage", title: "Monthly performance review", desc: "Recurring monthly meeting to review content performance and engagement metrics" },
  { id: "s26", type: "stage", title: "Ongoing catch ups", desc: "Understand what content is performing. Identify when a new batch of content is needed for the next month." },
];

export function BuyerJourney({ data, onChange }) {
  const [offer, setOffer] = useState("meta");
  const [editingId, setEditingId] = useState(null);

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

  const inputSt = { width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", fontFamily: "'DM Sans',sans-serif" };
  const descSt = { ...inputSt, fontSize: 12, minHeight: 50, resize: "vertical" };
  const smallBtn = { background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 10, padding: "2px 4px" };

  // Horizontal right-pointing arrow between stages. Aligns with the
  // vertical midpoint of the surrounding stage cards via flex alignSelf.
  const Arrow = () => (
    <div style={{ display: "flex", alignItems: "center", alignSelf: "center", flexShrink: 0 }}>
      <div style={{ height: 2, width: 16, background: "var(--border)" }} />
      <div style={{ width: 0, height: 0, borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid var(--border)" }} />
    </div>
  );

  return (<>
    <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Buyer Journey</span>
      <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
        {[{ key: "meta", label: "Meta Ads Offer" }, { key: "social", label: "Social Media Retainer" }].map(t => (
          <button key={t.key} onClick={() => { setOffer(t.key); setEditingId(null); }} style={{ padding: "7px 16px", borderRadius: 6, border: "none", background: offer === t.key ? "var(--card)" : "transparent", color: offer === t.key ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t.label}</button>
        ))}
      </div>
    </div>
    {/* Horizontal swim-lane — stages flow left-to-right; wraps when the
        viewport runs out of width so we don't force a long horizontal
        scrollbar on smaller screens. Sections insert as inline labelled
        dividers between stage groups. Branches keep their internal two-
        column split (they're already horizontal within). */}
    <div style={{ padding: "24px 28px 60px", overflowX: "auto" }}>
      <div style={{
        display: "flex", flexDirection: "row", flexWrap: "wrap",
        alignItems: "stretch", gap: 8, minWidth: "min-content",
      }}>
        {stages.map((item, i) => {
          const isEditing = editingId === item.id;
          const nextItem = stages[i + 1];

          if (item.type === "section") {
            const sc = SECTION_COLORS[item.label] || "var(--accent)";
            // Section becomes a vertical labelled divider between stage
            // groups. Writing-mode rotates the label 90° so it reads up the
            // divider; small up/down buttons stay inline above the label.
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
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
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
                {i < stages.length - 1 && nextItem?.type !== "section" && <Arrow />}
              </div>
            );
          }

          // Plain stage card — fixed width so the horizontal flow stays
          // tidy. Description wraps within.
          return (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", width: 240 }}>
                <div style={{ background: "var(--card)", border: `1px solid ${item.diff ? "var(--accent)" : "var(--border)"}`, borderRadius: item.diff ? 0 : 10, padding: "14px 18px", borderLeft: item.diff ? "3px solid var(--accent)" : undefined }}>
                  {isEditing ? (<>
                    <input defaultValue={item.title} onBlur={e => updateItem(item.id, { title: e.target.value.trim() || item.title })} style={{ ...inputSt, fontSize: 14, fontWeight: 700, marginBottom: 6 }} autoFocus />
                    <textarea defaultValue={item.desc} onBlur={e => updateItem(item.id, { desc: e.target.value })} style={descSt} />
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <input defaultValue={item.tag || ""} onBlur={e => updateItem(item.id, { tag: e.target.value.trim() })} placeholder="Tag (e.g. 7 to 10 days)" style={{ ...inputSt, fontSize: 11 }} />
                      <input defaultValue={item.pct || ""} onBlur={e => updateItem(item.id, { pct: e.target.value.trim() })} placeholder="Percentage (e.g. 65% convert)" style={{ ...inputSt, fontSize: 11 }} />
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={!!item.diff} onChange={e => updateItem(item.id, { diff: e.target.checked })} /> Differs between offers</label>
                    </div>
                  </>) : (<>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>{item.title}</span>
                      {item.pct && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "rgba(0,130,250,0.12)", color: "#0082FA" }}>{item.pct}</span>}
                      {item.tag && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "var(--bg)", color: "var(--muted)" }}>{item.tag}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{item.desc}</div>
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
              {i < stages.length - 1 && nextItem?.type !== "section" && <Arrow />}
            </div>
          );
        })}
      </div>
    </div>
  </>);
}
