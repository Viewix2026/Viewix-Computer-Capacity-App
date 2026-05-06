// Home page — read-only dashboard everyone sees on login.
// Displays Team Quote (founders edit), Next Team Lunch, Video of the Week
// (embedded + a short note — editable from the Capacity tab), and Quick Links.
// Editing lives in Capacity → Video of the Week / Team Lunch; Team Quote
// is edited inline on Home by founders.
//
// Public team-home content lives at /teamHome (rule: read by any auth
// user, write by founder/founders). Used to live at /foundersData,
// which only role=founders could read — leads / editors / closers /
// trial all saw the empty state for both fields. We fall back to
// foundersData during the migration window so founder users with
// legacy data still see their headline + video while the App's
// migration effect copies it across to /teamHome.

import { VideoEmbed } from "./shared/VideoEmbed";

export function Home({ teamHome, setTeamHome, foundersData, setFoundersData, teamLunch, isFounder, isFounders }) {
  const th = teamHome || {};
  const fd = foundersData || {};
  const teamQuote = th.teamQuote || fd.teamQuote || "";
  const votw = th.videoOfTheWeek || fd.videoOfTheWeek || null;
  // Edits go to /teamHome (publicly-readable) regardless of where the
  // value was originally read from. setFoundersData is kept as a prop
  // for compatibility with the legacy edit path during rollout but
  // isn't called from this component any more.
  void setFoundersData;
  const updateTeamQuote = (next) => {
    if (typeof setTeamHome === "function") setTeamHome(p => ({ ...(p || {}), teamQuote: next }));
  };

  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Home</span>
      </div>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 28px 60px" }}>

        {/* Team Quote */}
        <div style={{ marginBottom: 20, padding: "28px 32px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, textAlign: "center" }}>
          {isFounder ? (
            <div>
              <textarea value={teamQuote} onChange={e => updateTeamQuote(e.target.value)} placeholder="Add an inspiring quote or message for the team..." rows={2} style={{ width: "100%", textAlign: "center", fontSize: 18, fontWeight: 600, fontStyle: "italic", color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px dashed #3A4558", outline: "none", resize: "none", fontFamily: "'DM Sans',sans-serif", lineHeight: 1.6 }} />
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8 }}>Only founders can edit this</div>
            </div>
          ) : (
            teamQuote ? (
              <div style={{ fontSize: 18, fontWeight: 600, fontStyle: "italic", color: "var(--fg)", lineHeight: 1.6 }}>"{teamQuote}"</div>
            ) : (
              <div style={{ fontSize: 14, color: "var(--muted)", fontStyle: "italic" }}>Welcome to Viewix Tools</div>
            )
          )}
        </div>

        {/* Next Team Lunch */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "24px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 24 }}>🍕</span>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Next Team Lunch</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Get together and celebrate wins</div>
            </div>
          </div>
          {teamLunch ? (
            <div style={{ padding: "16px 20px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "var(--accent)", fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>{teamLunch.date ? new Date(teamLunch.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Date TBC"}</div>
              {teamLunch.time && <div style={{ fontSize: 14, color: "var(--fg)", marginBottom: 4 }}>{teamLunch.time}</div>}
              {teamLunch.location && <div style={{ fontSize: 13, color: "var(--muted)" }}>📍 {teamLunch.location}</div>}
              {teamLunch.notes && <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>{teamLunch.notes}</div>}
            </div>
          ) : (
            <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", background: "var(--bg)", borderRadius: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>No team lunch scheduled</div>
              <div style={{ fontSize: 12 }}>Founders can set the next lunch from the Founders tab</div>
            </div>
          )}
        </div>

        {/* Video of the Week — embedded from Frame.io / YouTube / Instagram. */}
        <div style={{ marginBottom: 20, padding: "24px", background: "linear-gradient(135deg, rgba(139,92,246,0.08) 0%, rgba(59,130,246,0.08) 100%)", border: "1px solid var(--border)", borderRadius: 12, position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: -20, right: -20, fontSize: 120, opacity: 0.06, pointerEvents: "none" }}>🎬</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, position: "relative" }}>
            <span style={{ fontSize: 24 }}>🎬</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>Video of the Week</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                The week's standout piece of work
              </div>
            </div>
          </div>
          {votw?.videoUrl ? (
            <div style={{ padding: "18px", background: "var(--card)", borderRadius: 10, border: "1px solid var(--border)" }}>
              <div style={{ marginBottom: 14 }}>
                <VideoEmbed url={votw.videoUrl} />
              </div>
              {votw.note && (
                <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: votw.creator ? 10 : 0 }}>
                  {votw.note}
                </div>
              )}
              {votw.creator && (
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                  — {votw.creator}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: "30px 20px", textAlign: "center", color: "var(--muted)", background: "var(--card)", borderRadius: 10, border: "1px dashed var(--border)" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Nothing this week yet</div>
              <div style={{ fontSize: 12 }}>
                {isFounder ? "Post one from Capacity → Video of the Week" : "Check back soon — updated weekly"}
              </div>
            </div>
          )}
        </div>

        {/* Quick Links */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "24px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 16 }}>Quick Links</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[
              { icon: "🎬", label: "Frame.io", url: "https://app.frame.io" },
              { icon: "📊", label: "Viewix Website", url: "https://viewix.com.au" },
              { icon: "📍", label: "Google Maps", url: "https://www.google.com/maps/place/?q=place_id:ChIJ87p3vJ9QRAIRRkX7FtSsJTo" },
            ].map(link => (
              <a key={link.label} href={link.url} target="_blank" rel="noopener noreferrer" style={{ padding: "14px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, textDecoration: "none", display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s" }}>
                <span style={{ fontSize: 18 }}>{link.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{link.label}</span>
                <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>↗</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
