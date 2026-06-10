// Home page — read-only dashboard everyone sees on login.
// Displays Team Quote (founders edit), Next Team Lunch, Video of the Week
// (embedded + a short note — editable from the Capacity tab), and Quick Links.
// Editing lives in Capacity → Video of the Week / Team Lunch; Team Quote
// is edited inline on Home by founders.
//
// Skinned to the Unified Design Language (docs: design handoff bundle,
// ds/tabs-b.jsx HomeTab + ds/tabs-h.jsx VideoOfWeekTab): quote hero with
// the spark watermark, icon-tile card headers, inset wells, mono accents.
// One deliberate departure from the mock: Video of the Week is a
// full-width card (not half-width beside Team Lunch) so the Frame.io
// player fills the content column, and it carries reactions + comments.
//
// Public team-home content lives at /teamHome (rule: read by any auth
// user, write by founder/founders). Used to live at /foundersData,
// which only role=founders could read — leads / editors / closers /
// trial all saw the empty state for both fields. We fall back to
// foundersData during the migration window so founder users with
// legacy data still see their headline + video while the App's
// migration effect copies it across to /teamHome.

import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { VideoEmbed } from "./shared/VideoEmbed";
import { VotwReactions } from "./shared/VotwReactions";
import { VotwComments } from "./shared/VotwComments";

const SANS = "'DM Sans', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// Icon-tile + title/sub header row shared by the cards on this page.
function CardHeader({ icon, tint, tintSoft, title, sub, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: tintSoft, color: tint, flex: "0 0 auto",
        display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name={icon} size={19} sw={1.8} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>{title}</div>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: "var(--muted)" }}>{sub}</div>
      </div>
      {right}
    </div>
  );
}

function QuickLink({ icon, label, host, url }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{
      display: "flex", alignItems: "center", gap: 11, padding: "13px 15px", background: "var(--inset)",
      border: "1px solid var(--border)", borderRadius: "var(--r3)", textDecoration: "none",
    }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", flex: "0 0 auto",
        display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-bright)" }}>
        <Icon name={icon} size={17} sw={1.8} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>{label}</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{host}</div>
      </div>
      <Icon name="external" size={15} sw={1.7} stroke="var(--muted)" />
    </a>
  );
}

export function Home({ teamHome, setTeamHome, foundersData, setFoundersData, teamLunch, isFounder, isFounders, editors }) {
  const th = teamHome || {};
  const fd = foundersData || {};
  const teamQuote = th.teamQuote || fd.teamQuote || "";
  const votw = th.videoOfTheWeek || fd.videoOfTheWeek || null;
  // Edits go to /teamHome (publicly-readable) regardless of where the
  // value was originally read from. setFoundersData is kept as a prop
  // for compatibility with the legacy edit path during rollout but
  // isn't called from this component any more.
  void setFoundersData;
  void isFounders;
  const updateTeamQuote = (next) => {
    if (typeof setTeamHome === "function") setTeamHome(p => ({ ...(p || {}), teamQuote: next }));
  };

  const today = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });

  // Auto-grow the founder quote textarea to fit the text — a fixed rows
  // count clips anything longer than two lines.
  const quoteRef = useRef(null);
  useEffect(() => {
    const el = quoteRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [teamQuote, isFounder]);

  return (
    <>
      {/* Header — title + date eyebrow, per the design shell */}
      <div style={{ display: "flex", alignItems: "center", height: 60, padding: "0 24px", borderBottom: "1px solid var(--border)", background: "var(--rail)" }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 19, fontWeight: 800, color: "var(--fg)", letterSpacing: "-0.02em" }}>Home</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{today}</div>
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "22px 26px 60px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Team Quote hero */}
        <div style={{ position: "relative", overflow: "hidden", borderRadius: "var(--r5)", padding: "30px 36px",
          background: "linear-gradient(135deg, #11203a 0%, var(--card) 60%)", border: "1px solid var(--border)" }}>
          <div style={{ position: "absolute", right: -30, top: -30, color: "rgba(0,130,250,0.10)", pointerEvents: "none" }}>
            <Icon name="spark" size={180} sw={1} />
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em",
            textTransform: "uppercase", color: "var(--accent-bright)", marginBottom: 12 }}>Team Quote</div>
          {isFounder ? (
            <div style={{ position: "relative" }}>
              <textarea ref={quoteRef} value={teamQuote} onChange={e => updateTeamQuote(e.target.value)}
                placeholder="Add an inspiring quote or message for the team..." rows={1}
                style={{ width: "100%", fontFamily: SANS, fontSize: 21, fontWeight: 600, fontStyle: "italic",
                  color: "var(--fg)", background: "transparent", border: "none", overflow: "hidden",
                  borderBottom: "1px dashed var(--faint)", outline: "none", resize: "none", lineHeight: 1.45 }} />
              <div style={{ fontFamily: SANS, fontSize: 10, color: "var(--muted)", marginTop: 8 }}>Only founders can edit this</div>
            </div>
          ) : (
            teamQuote ? (
              <div style={{ fontFamily: SANS, fontSize: 23, fontWeight: 600, fontStyle: "italic", color: "var(--fg)",
                lineHeight: 1.45, maxWidth: 720, position: "relative" }}>"{teamQuote}"</div>
            ) : (
              <div style={{ fontFamily: SANS, fontSize: 15, color: "var(--muted)", fontStyle: "italic" }}>Welcome to Viewix Tools</div>
            )
          )}
        </div>

        {/* Team Lunch + Quick Links */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r4)", padding: "20px 22px" }}>
            <CardHeader icon="calendar" tint="var(--orange)" tintSoft="var(--orange-soft)"
              title="Next Team Lunch" sub="Get together & celebrate wins" />
            {teamLunch ? (
              <div style={{ background: "var(--inset)", border: "1px solid var(--border)", borderRadius: "var(--r3)", padding: "16px 18px" }}>
                <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: "var(--accent-bright)", marginBottom: 6 }}>
                  {teamLunch.date ? new Date(teamLunch.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" }) : "Date TBC"}
                </div>
                {teamLunch.time && <div style={{ fontFamily: SANS, fontSize: 13, color: "var(--fg)", marginBottom: 8 }}>{teamLunch.time}</div>}
                {teamLunch.location && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: SANS, fontSize: 12.5, color: "var(--muted)" }}>
                    <Icon name="home" size={14} sw={1.7} stroke="var(--muted)" />{teamLunch.location}
                  </div>
                )}
                {teamLunch.notes && <div style={{ fontFamily: SANS, fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>{teamLunch.notes}</div>}
              </div>
            ) : (
              <div style={{ padding: "28px 18px", textAlign: "center", color: "var(--muted)", background: "var(--inset)", borderRadius: "var(--r3)", border: "1px dashed var(--border)" }}>
                <div style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No team lunch scheduled</div>
                <div style={{ fontFamily: SANS, fontSize: 12 }}>Founders can set the next lunch from the Capacity tab</div>
              </div>
            )}
          </div>

          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r4)", padding: "20px 22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }} />
              <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--fg)" }}>Quick Links</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <QuickLink icon="play" label="Frame.io" host="app.frame.io" url="https://app.frame.io" />
              <QuickLink icon="external" label="Viewix Website" host="viewix.com.au" url="https://viewix.com.au" />
              <QuickLink icon="home" label="Studio — Maps" host="google.com/maps" url="https://www.google.com/maps/place/?q=place_id:ChIJ87p3vJ9QRAIRRkX7FtSsJTo" />
            </div>
          </div>
        </div>

        {/* Video of the Week — full-width so the Frame.io player fills the column */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r4)", padding: "20px 22px" }}>
          <CardHeader icon="play" tint="var(--purple)" tintSoft="var(--purple-soft)"
            title="Video of the Week" sub="The week's standout piece of work"
            right={votw?.videoUrl ? (
              <a href={votw.videoUrl} target="_blank" rel="noopener noreferrer" title="Open in Frame.io" style={{
                display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: "var(--r2)",
                border: "1px solid var(--border)", textDecoration: "none", fontFamily: SANS, fontSize: 12,
                fontWeight: 700, color: "var(--fg)", flex: "0 0 auto",
              }}>
                <Icon name="external" size={15} sw={2} />Open
              </a>
            ) : null} />
          {votw?.videoUrl ? (
            <div>
              <VideoEmbed url={votw.videoUrl} />
              {votw.note && (
                <div style={{ marginTop: 14, padding: "14px 16px", background: "var(--purple-soft)", border: "1px solid rgba(155,123,240,0.3)",
                  borderRadius: "var(--r3)", fontFamily: SANS, fontSize: 13, color: "#C9B6F5", lineHeight: 1.55, fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                  {votw.note}
                </div>
              )}
              {votw.creator && (
                <div style={{ marginTop: 12, fontFamily: SANS, fontSize: 12, fontWeight: 700, color: "var(--accent-bright)" }}>
                  — {votw.creator}
                </div>
              )}
              <VotwReactions videoUrl={votw.videoUrl} editors={editors} />
              <VotwComments videoUrl={votw.videoUrl} editors={editors} />
            </div>
          ) : (
            <div style={{ padding: "30px 20px", textAlign: "center", color: "var(--muted)", background: "var(--inset)", borderRadius: "var(--r3)", border: "1px dashed var(--border)" }}>
              <div style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Nothing this week yet</div>
              <div style={{ fontFamily: SANS, fontSize: 12 }}>
                {isFounder ? "Post one from Capacity → Video of the Week" : "Check back soon — updated weekly"}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
