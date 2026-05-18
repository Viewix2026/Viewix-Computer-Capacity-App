import { useState, useRef, useEffect } from "react";
import { Pill, Label, Icon, BtnPrimary, BtnGhost, BtnSubtle } from "./ui";
import { writeDeliveryLeaf, createRevisionNotifier } from "../deliveryReview/deliveryWrites";

const REV_OPTS = ["", "Approved", "Need Revisions"];
const VSTATUS_TONE = {
  "Completed": "green",
  "Ready for Review": "blue",
  "Need Revisions": "red",
  "In Development": "amber",
};

function RevisionSelect({ value, editable, onChange }) {
  const tone = value === "Approved" ? { fg: "var(--ok)", bd: "rgba(27,155,110,0.34)", bg: "rgba(27,155,110,0.08)" }
    : value === "Need Revisions" ? { fg: "var(--danger)", bd: "var(--orange-line)", bg: "var(--orange-soft)" }
      : { fg: "var(--text-3)", bd: editable ? "var(--accent-line)" : "var(--line-2)", bg: editable ? "var(--accent-soft)" : "transparent" };
  return (
    <select
      value={value || ""}
      disabled={!editable}
      onChange={e => onChange(e.target.value)}
      className="mono"
      style={{
        minWidth: 150, padding: "8px 10px", borderRadius: 8,
        border: `1.5px solid ${tone.bd}`, background: tone.bg, color: tone.fg,
        fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600,
        cursor: editable ? "pointer" : "not-allowed", appearance: "auto",
      }}
    >
      {REV_OPTS.map(o => <option key={o || "none"} value={o}>{o === "" ? "—  Pending" : o}</option>)}
    </select>
  );
}

const PostedBox = ({ checked, onChange }) => (
  <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)}
    title={checked ? "Posted — click to unmark" : "Mark as posted"}
    style={{ cursor: "pointer", accentColor: "var(--accent)", width: 18, height: 18 }} />
);

function HowTo({ narrow }) {
  return (
    <details open={!narrow} style={{ border: "1px solid var(--line)", borderRadius: 14, background: "var(--surface)", overflow: "hidden" }}>
      <summary style={{ listStyle: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 24, height: 24, borderRadius: 6, background: "var(--accent-soft)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon.info /></span>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text)" }}>How to use this page</h3>
        </div>
        <Icon.chev style={{ color: "var(--text-3)" }} />
      </summary>
      <div style={{ padding: "4px 20px 20px" }}>
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            <>When a new video is ready, it appears here and its Viewix status changes to <span style={{ color: "var(--accent)", fontWeight: 600 }}>Ready for Review</span>.</>,
            <>Watch the cut, then set <span style={{ color: "var(--accent)", fontWeight: 600 }}>Revision Round 1</span> to either <span style={{ color: "var(--ok)", fontWeight: 600 }}>Approved</span> or <span style={{ color: "var(--danger)", fontWeight: 600 }}>Need Revisions</span> right here in the table.</>,
            <>If it needs changes, we'll action them and flip the status back to Ready for Review for your Round 2 pass.</>,
            <>Once a video is live, tick <span style={{ color: "var(--accent)", fontWeight: 600 }}>Posted</span> so we both know it's out in the world.</>,
          ].map((t, i) => (
            <li key={i} style={{ display: "flex", gap: 14 }}>
              <span className="mono" style={{ flex: "0 0 24px", height: 24, borderRadius: 6, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--text-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, marginTop: 1 }}>{i + 1}</span>
              <span style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.55 }}>{t}</span>
            </li>
          ))}
        </ol>
        <div style={{ marginTop: 16, padding: "12px 16px", borderRadius: 10, border: "1px solid var(--accent-line)", background: "var(--accent-soft)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--accent)" }}><Icon.info /></span>
          <span style={{ fontSize: 13, color: "var(--accent-2)", fontWeight: 600 }}>Every video includes 2 rounds of revisions.</span>
        </div>
      </div>
    </details>
  );
}

function NextStep({ am }) {
  const firstName = (am?.name || "your account manager").split(" ")[0];
  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: 18, border: "1px solid var(--accent-line)", background: "radial-gradient(120% 100% at 0% 0%, rgba(0,130,250,0.10), transparent 60%), var(--surface)", padding: "28px 30px", marginTop: 28 }}>
      <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 11px", borderRadius: 999, border: "1px solid var(--accent-line)", background: "var(--accent-soft)", color: "var(--accent-2)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        <Icon.check /> Everything's approved & posted
      </span>
      <h3 style={{ margin: "14px 0 10px", fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--heading)" }}>Time to put them to work.</h3>
      <p style={{ margin: "0 0 18px", fontSize: 14, color: "var(--text-2)", lineHeight: 1.55, maxWidth: 520 }}>
        Your videos are live. {firstName} can line up what's next - a sustained organic run, or cutting your top performers into Meta ad variants.
      </p>
      <a href={`mailto:${am?.email || "hello@viewix.com.au"}`} style={{ textDecoration: "none", display: "inline-block" }}>
        <BtnPrimary style={{ height: 44 }}><Icon.cal /> Talk about what's next</BtnPrimary>
      </a>
    </div>
  );
}

export function Deliveries({ deliveries, accountManager, narrow }) {
  const [rows, setRows] = useState(() => deliveries?.rows || []);
  const [saving, setSaving] = useState(false);
  const deliveryId = deliveries?.deliveryId;

  const notifier = useRef(null);
  if (!notifier.current) {
    notifier.current = createRevisionNotifier({
      getClientName: () => deliveries?.orgName || "Client",
      getDeliveryId: () => deliveryId,
    });
  }
  useEffect(() => () => notifier.current?.dispose(), []);
  useEffect(() => { setRows(deliveries?.rows || []); }, [deliveries]);

  if (!deliveries || !deliveries.available) {
    return (
      <div style={{ padding: narrow ? "40px 20px" : "64px 40px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--surface-2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", color: "var(--text-3)" }}><Icon.film /></div>
        <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: "var(--heading)" }}>No deliveries yet</h3>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>Your videos will land here the moment the first cut is ready for you.</p>
      </div>
    );
  }

  const setField = (row, field, value) => {
    if (!deliveryId || row.idx == null) return;
    const prev = row[field];
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, [field]: value } : r));
    setSaving(true);
    writeDeliveryLeaf(deliveryId, row.idx, field, value)
      .then(() => setTimeout(() => setSaving(false), 600))
      .catch(() => {
        setSaving(false);
        setRows(rs => rs.map(r => r.id === row.id ? { ...r, [field]: prev } : r)); // revert
      });
    if (field === "revision1" || field === "revision2") {
      notifier.current.queue({ videoName: row.title || "Video", field, oldValue: prev || "", newValue: value });
    }
  };

  const counts = {
    completed: rows.filter(r => r.viewixStatus === "Completed").length,
    review: rows.filter(r => r.viewixStatus === "Ready for Review").length,
    changes: rows.filter(r => r.viewixStatus === "Need Revisions").length,
    posted: rows.filter(r => r.posted).length,
  };
  const total = rows.length;
  const allDone = total > 0 && rows.every(r => (r.revision1 === "Approved" || r.revision2 === "Approved") && r.posted);

  return (
    <div style={{ padding: narrow ? "18px 16px 40px" : "28px 32px 60px", display: "flex", flexDirection: "column", gap: 20 }}>
      <HowTo narrow={narrow} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px" }}>
        <div style={{ width: 16, height: 16, borderRadius: 4, border: "1.5px solid var(--accent)" }} />
        <span style={{ fontSize: 13, color: "var(--text-3)" }}>Fields with a blue border can be edited by you{saving ? " · Saving..." : ""}</span>
      </div>

      {narrow ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map(r => {
            const r2editable = r.revision1 === "Need Revisions";
            return (
              <div key={r.id} style={{ padding: "14px", borderRadius: 12, border: `1px solid ${r.viewixStatus === "Ready for Review" ? "var(--accent-line)" : "var(--line)"}`, background: r.viewixStatus === "Ready for Review" ? "rgba(0,130,250,0.04)" : "var(--surface)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Label style={{ fontSize: 10 }}>Video {String(r.n).padStart(2, "0")}</Label>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 4, lineHeight: 1.35 }}>{r.title}</div>
                  </div>
                  {r.link && <a href={r.link} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, color: "var(--accent)", fontSize: 11, fontWeight: 600, textDecoration: "none", border: "1px solid var(--accent-line)", background: "var(--accent-soft)" }}>View <Icon.external /></a>}
                </div>
                <Pill tone={VSTATUS_TONE[r.viewixStatus] || "muted"}>{r.viewixStatus || "—"}</Pill>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><Label style={{ fontSize: 9 }}>Round 1</Label><div style={{ marginTop: 6 }}><RevisionSelect value={r.revision1} editable onChange={v => setField(r, "revision1", v)} /></div></div>
                  <div><Label style={{ fontSize: 9 }}>Round 2</Label><div style={{ marginTop: 6 }}><RevisionSelect value={r.revision2} editable={r2editable} onChange={v => setField(r, "revision2", v)} /></div></div>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 10, marginTop: 2, borderTop: "1px solid var(--line)" }}>
                  <Label color={r.posted ? "var(--accent)" : "var(--text-3)"} style={{ fontSize: 10 }}>{r.posted ? "Posted" : "Not posted yet"}</Label>
                  <PostedBox checked={r.posted} onChange={v => setField(r, "posted", v)} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--surface)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "40px minmax(0,1fr) 80px 170px 170px 170px 80px", gap: 16, padding: "14px 22px", background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
            {["#", "Video name", "Link", "Viewix status", "Revision round 1", "Revision round 2", "Posted"].map((c, i) => (
              <span key={i} className="mono" style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase", justifySelf: i === 6 ? "center" : "flex-start" }}>{c}</span>
            ))}
          </div>
          {rows.map(r => {
            const r2editable = r.revision1 === "Need Revisions";
            return (
              <div key={r.id} style={{ display: "grid", gridTemplateColumns: "40px minmax(0,1fr) 80px 170px 170px 170px 80px", alignItems: "center", gap: 16, padding: "14px 22px", borderTop: "1px solid var(--line)", background: r.viewixStatus === "Ready for Review" ? "rgba(0,130,250,0.04)" : "transparent" }}>
                <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{String(r.n).padStart(2, "0")}</span>
                <div style={{ minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div></div>
                {r.link
                  ? <a href={r.link} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--accent)", fontSize: 13, fontWeight: 500, textDecoration: "none" }}>View <Icon.external /></a>
                  : <span style={{ color: "var(--text-3)" }}>—</span>}
                <div><Pill tone={VSTATUS_TONE[r.viewixStatus] || "muted"}>{r.viewixStatus || "—"}</Pill></div>
                <div><RevisionSelect value={r.revision1} editable onChange={v => setField(r, "revision1", v)} /></div>
                <div><RevisionSelect value={r.revision2} editable={r2editable} onChange={v => setField(r, "revision2", v)} /></div>
                <div style={{ justifySelf: "center" }}><PostedBox checked={r.posted} onChange={v => setField(r, "posted", v)} /></div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "16px 20px", border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface)" }}>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--text-2)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="vx-dot" style={{ background: "var(--ok)" }} /><span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>{counts.completed}</span> completed</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="vx-dot" style={{ background: "var(--accent)" }} /><span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>{counts.review}</span> ready for review</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="vx-dot" style={{ background: "var(--danger)" }} /><span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>{counts.changes}</span> need revisions</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon.check style={{ color: "var(--accent)" }} /><span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>{counts.posted}</span> posted</span>
        </div>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{counts.posted}/{total} posted</span>
      </div>

      {allDone && <NextStep am={accountManager} />}
    </div>
  );
}
