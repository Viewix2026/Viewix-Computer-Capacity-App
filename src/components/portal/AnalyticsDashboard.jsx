// Desktop "Growth Intelligence" dashboard — the portal Analytics tab on
// wide screens. Implements the Claude Design section-04 desktop layout
// (multi-zone, proportioned) against the REAL /analytics/public
// projection, replacing the mobile-first single-column reuse.
//
// Honest degradation: the projection has no time-series, posting
// cadence, saves, best-post date, or raw niche numbers — so sparklines
// and cadence are omitted (never faked), the follower delta is derived
// from start/latest, and the format lift + niche ratio are parsed from
// the server-authored sentences. Every zone renders only what its data
// supports; empty/gathering zones show a calm placeholder.
//
// Renders in the .vx token layer (same shell as the rest of the portal)
// — NOT the .viewix-portal CSS_LIGHT wrapper the mobile /r/ body uses.

import { Icon, BtnGhost } from "./ui";

// ── helpers ──────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null || isNaN(n)) return null;
  const v = Number(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(v));
}
// Pull the "1.4×" multiplier out of a server-authored sentence.
function parseMultiple(sentence) {
  const m = String(sentence || "").match(/([\d.]+)\s*[×x]/);
  return m ? parseFloat(m[1]) : null;
}
function trimCaption(s, n = 90) {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
}

const Label = ({ children, color = "var(--text-3)", style }) => (
  <span style={{ fontWeight: 600, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color, ...style }}>{children}</span>
);

const ChangeBadge = ({ value, suffix = "%", baseline }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 999,
    background: value >= 0 ? "var(--accent-soft)" : "var(--orange-soft)",
    color: value >= 0 ? "var(--accent)" : "var(--orange)", fontSize: 12, fontWeight: 600,
  }}>
    <span style={{ fontSize: 14 }}>{value >= 0 ? "↑" : "↓"}</span>
    <span>{Math.abs(value)}{suffix}{baseline ? <span style={{ color: "var(--text-3)", fontWeight: 500 }}> vs {baseline}</span> : null}</span>
  </span>
);

// Real post thumbnail when present, else the design's branded placeholder.
const ReelThumb = ({ src, label, h = 180, tone = "blue" }) => {
  if (src) {
    return (
      <div style={{ width: "100%", height: h, borderRadius: 12, overflow: "hidden", border: "1px solid var(--line)", background: "var(--bg-2)" }}>
        <img src={src} alt={label || "Post"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div style={{
      width: "100%", height: h, borderRadius: 12, position: "relative", overflow: "hidden",
      border: "1px solid var(--line)", display: "flex", alignItems: "flex-end", padding: 12,
      background: tone === "orange"
        ? "linear-gradient(135deg, rgba(248,119,0,0.10), rgba(248,119,0,0.04)), var(--bg-2)"
        : "linear-gradient(135deg, rgba(0,130,250,0.10), rgba(0,130,250,0.04)), var(--bg-2)",
    }}>
      <span style={{ width: 36, height: 36, borderRadius: 999, background: "rgba(255,255,255,0.86)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", boxShadow: "0 8px 18px rgba(15,18,26,0.12)" }}><Icon.play /></span>
      {label && <Label color="var(--text-3)" style={{ fontSize: 10 }}>{label}</Label>}
    </div>
  );
};

const ZoneHead = ({ n, eyebrow, eyebrowColor, title, sub }) => (
  <header style={{ marginBottom: 26 }}>
    <Label color={eyebrowColor || "var(--accent)"}>{n} · {eyebrow}</Label>
    <h2 style={{ margin: "8px 0 6px", fontSize: 26, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.02em", lineHeight: 1.2 }}>{title}</h2>
    {sub && <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.55, maxWidth: 620 }}>{sub}</p>}
  </header>
);

const GatheringCard = ({ text }) => (
  <div style={{ padding: "20px 22px", borderRadius: 14, border: "1px dashed var(--line-2)", background: "var(--bg-2)", display: "flex", alignItems: "center", gap: 12, color: "var(--text-2)", fontSize: 14, lineHeight: 1.5 }}>
    <span className="vx-dot live-pulse" style={{ flex: "0 0 auto" }} />
    <span>{text}</span>
  </div>
);

// ── zones ────────────────────────────────────────────────────────────

function HeaderZone({ p }) {
  const company = p?.header?.companyName || "Your content";
  const gathering = p?.meta?.dataState?.header === "gathering" || p?.header?.gathering;
  const story = p?.story || {};
  const ft = story.followerTrajectory || {};

  // Stat cards from whatever the projection actually has. No sparklines
  // (no time-series), no cadence (not tracked), no delta-% badge (the
  // trajectory is all-time start→latest, not a 30-day change — a "↑X%"
  // pill would misrepresent it). We never fake or mislabel data.
  const cards = [];
  if (ft.latest != null) cards.push({ label: `${ft.label || "Followers"}`, value: fmtNum(ft.latest), sub: ft.start != null ? `from ${fmtNum(ft.start)}` : null });
  if (story.postsPublished != null) cards.push({ label: "Posts published", value: String(story.postsPublished), sub: story.sinceLabel || null });
  if (story.bestPost?.views != null) cards.push({ label: "Best post", value: fmtNum(story.bestPost.views) + " views", sub: trimCaption(story.bestPost.caption, 42) });

  return (
    <div style={{ padding: "26px 36px 24px", background: "radial-gradient(120% 100% at 100% 0%, rgba(0,130,250,0.08), transparent 60%), var(--surface)", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <Label color="var(--accent)">This month at a glance</Label>
        {p?.meta?.freshnessLine && <span style={{ fontSize: 12, color: "var(--text-3)" }}>{p.meta.freshnessLine}</span>}
      </div>
      <h1 style={{ margin: "12px 0 0", fontSize: 32, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.02em", lineHeight: 1.15, maxWidth: 860 }}>
        {gathering ? `We're building ${company}'s first read.` : (p?.header?.momentumSentence || `${company}'s content, this month.`)}
      </h1>
      {p?.header?.heroProof && !gathering && (
        <p style={{ margin: "14px 0 0", fontSize: 16, color: "var(--text-2)", lineHeight: 1.55, maxWidth: 760 }}>{p.header.heroProof}</p>
      )}
      {cards.length > 0 && (
        <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: `repeat(${Math.min(cards.length, 3)}, 1fr)`, gap: 14 }}>
          {cards.map((c, i) => (
            <div key={i} style={{ padding: "16px 18px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--bg-2)" }}>
              <Label>{c.label}</Label>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 26, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.01em" }}>{c.value}</span>
                {c.badge != null && <ChangeBadge value={c.badge} />}
              </div>
              {c.sub && <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-3)", lineHeight: 1.4 }}>{c.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const WinMetric = ({ l, v }) => v == null ? null : (
  <div><Label style={{ fontSize: 10 }}>{l}</Label><div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginTop: 2, letterSpacing: "-0.01em" }}>{fmtNum(v)}</div></div>
);

function WinningHero({ w }) {
  const inner = (
    <>
      <div style={{ position: "absolute", top: 14, right: 14, padding: "6px 12px", borderRadius: 999, background: "var(--orange)", color: "#fff", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Top winner</div>
      <ReelThumb src={w.thumbnail} label="Reel · 9:16" h={300} />
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Label>What's winning · No.1</Label>
        <h3 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.015em", lineHeight: 1.25 }}>{trimCaption(w.caption, 110)}</h3>
        {w.formatLabel && <div style={{ fontSize: 13, color: "var(--text-3)" }}>{w.formatLabel}</div>}
        {w.winLabel && (
          <div style={{ display: "inline-flex", alignItems: "center", padding: "12px 16px", borderRadius: 12, background: "var(--orange-soft)", border: "1px solid var(--orange-line)", alignSelf: "flex-start" }}>
            <span style={{ fontSize: 28, fontWeight: 700, color: "var(--orange-2)", letterSpacing: "-0.02em" }}>{w.winLabel}</span>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 15, color: "var(--text-2)", lineHeight: 1.55 }}>
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>Your strongest post this month.</strong>
        </p>
        {(w.views != null || w.likes != null || w.comments != null) && (
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 6, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <WinMetric l="Views" v={w.views} /><WinMetric l="Likes" v={w.likes} /><WinMetric l="Comments" v={w.comments} />
          </div>
        )}
      </div>
    </>
  );
  const style = { position: "relative", overflow: "hidden", padding: 28, borderRadius: 18, background: "linear-gradient(135deg, rgba(0,130,250,0.06), rgba(0,130,250,0.02)), var(--surface)", border: "1px solid var(--accent-line)", display: "grid", gridTemplateColumns: "minmax(0, 280px) 1fr", gap: 26 };
  return w.postUrl
    ? <a href={w.postUrl} target="_blank" rel="noopener noreferrer" style={{ ...style, textDecoration: "none", color: "inherit" }}>{inner}</a>
    : <div style={style}>{inner}</div>;
}

function WinningTile({ w, n }) {
  const inner = (
    <>
      <ReelThumb src={w.thumbnail} label={`No.${n}`} h={150} />
      {w.winLabel && <div style={{ display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 13, fontWeight: 700, alignSelf: "flex-start" }}>{w.winLabel}</div>}
      <h4 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.01em", lineHeight: 1.3 }}>{trimCaption(w.caption, 70)}</h4>
      {w.formatLabel && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{w.formatLabel}</div>}
      {w.views != null && (
        <div style={{ marginTop: "auto", paddingTop: 10, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
          <Label>Views</Label><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(w.views)}</span>
        </div>
      )}
    </>
  );
  const style = { padding: 16, borderRadius: 14, background: "var(--surface)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 12 };
  return w.postUrl
    ? <a href={w.postUrl} target="_blank" rel="noopener noreferrer" style={{ ...style, textDecoration: "none", color: "inherit" }}>{inner}</a>
    : <div style={style}>{inner}</div>;
}

function WinningZone({ p }) {
  const items = p?.winning;
  const gathering = p?.meta?.dataState?.winning === "gathering";
  return (
    <section style={{ padding: "34px 36px" }}>
      <ZoneHead n="01" eyebrow="What's winning" title="The posts pulling above your usual." sub="Ranked by what outperformed your usual results. Open any post on Instagram." />
      {(!items || !items.length)
        ? <GatheringCard text={gathering ? "We're still gathering enough posts to call your winners. Check back after your next few videos." : "No standout posts to show yet."} />
        : <>
            <WinningHero w={items[0]} />
            {items.length > 1 && (
              <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
                {items.slice(1, 4).map((w, i) => <WinningTile key={i} w={w} n={i + 2} />)}
              </div>
            )}
          </>}
    </section>
  );
}

function IdeaCard({ idea, n, hero }) {
  return (
    <div style={{ padding: hero ? 22 : 20, borderRadius: 16, position: "relative", display: "flex", flexDirection: "column", gap: 14, background: hero ? "linear-gradient(135deg, rgba(248,119,0,0.06), rgba(0,130,250,0.04)), var(--surface)" : "var(--surface)", border: hero ? "1px solid var(--orange-line)" : "1px solid var(--line)" }}>
      {hero && <div style={{ position: "absolute", top: -1, right: 18, padding: "4px 10px", borderRadius: "0 0 8px 8px", background: "var(--orange)", color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Up next</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: hero ? "var(--orange)" : "var(--accent-soft)", color: hero ? "#fff" : "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{n}</span>
        <Label color={hero ? "var(--orange-2)" : "var(--accent)"}>{hero ? "Worth making next" : "Idea"}</Label>
      </div>
      <h4 style={{ margin: 0, fontSize: hero ? 20 : 17, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.015em", lineHeight: 1.3 }}>{idea.idea}</h4>
      {idea.why && <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.55 }}>{idea.why}</p>}
      {idea.sourcePostUrl && (
        <a href={idea.sourcePostUrl} target="_blank" rel="noopener noreferrer" style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text)", textDecoration: "none" }}>
          <span style={{ width: 28, height: 28, borderRadius: 6, background: "var(--surface-2)", flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}><Icon.play /></span>
          <div style={{ flex: 1, minWidth: 0 }}><Label style={{ fontSize: 9 }}>Based on</Label><div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>See the post that's working</div></div>
          <Icon.arrow style={{ color: "var(--text-3)" }} />
        </a>
      )}
    </div>
  );
}

function NextVideoZone({ p }) {
  const items = p?.nextVideos;
  const gathering = p?.meta?.dataState?.nextVideos === "gathering";
  return (
    <section style={{ padding: "34px 36px", background: "var(--bg-2)" }}>
      <ZoneHead n="02" eyebrow="What to make next" eyebrowColor="var(--orange)" title="Videos we'd make next." sub="Each idea is grounded in a post that's already working — for you, or in your space. Mention one to your account manager when it sparks." />
      {(!items || !items.length)
        ? <GatheringCard text={gathering ? "Once we've seen a little more of your content, we'll line up the next smart videos to make." : "No ideas queued yet."} />
        : <div style={{ display: "grid", gridTemplateColumns: items.length >= 3 ? "1.2fr 1fr 1fr" : `repeat(${items.length}, 1fr)`, gap: 18, alignItems: "stretch" }}>
            {items.slice(0, 3).map((idea, i) => <IdeaCard key={i} idea={idea} n={i + 1} hero={i === 0} />)}
          </div>}
    </section>
  );
}

function FormatBar({ f, max }) {
  const lift = parseMultiple(f.comparisonSentence);
  const pct = lift != null ? Math.min((lift / max) * 100, 100) : null;
  const highlight = f.highlight;
  const fill = highlight ? "var(--orange)" : "var(--accent)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 70px", alignItems: "center", gap: 18, padding: "14px 0", borderTop: "1px solid var(--line)" }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", textTransform: "capitalize" }}>{f.format}</div>
        {f.comparisonSentence && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2, lineHeight: 1.4 }}>{f.comparisonSentence}</div>}
        {f.sampleWords && <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 2 }}>{f.sampleWords}</div>}
      </div>
      {pct != null ? (
        <div style={{ position: "relative", height: 18, borderRadius: 9, background: "var(--surface-3)", overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: fill, borderRadius: 9 }} />
          {/* 1.0× baseline — "your usual" reference line */}
          <div style={{ position: "absolute", left: `${(1 / max) * 100}%`, top: -3, bottom: -3, width: 1, background: "var(--text-3)", opacity: 0.5 }} />
        </div>
      ) : <div />}
      <div style={{ fontSize: 20, fontWeight: 700, color: highlight ? "var(--orange-2)" : "var(--heading)", letterSpacing: "-0.01em", textAlign: "right" }}>{lift != null ? `${lift}×` : ""}</div>
    </div>
  );
}

function FormatPlaybookZone({ p }) {
  const raw = p?.formatPlaybook;
  const gathering = p?.meta?.dataState?.formatPlaybook === "gathering";
  if (!raw || !raw.length) {
    return (
      <section style={{ padding: "34px 36px" }}>
        <ZoneHead n="03" eyebrow="Why it's working" title="Your format playbook." sub="Which formats pull above your usual — measured against your own baseline." />
        <GatheringCard text={gathering ? "Still finding your strongest format — a few more posts and this sharpens up." : "No format pattern yet."} />
      </section>
    );
  }
  const lifts = raw.map(f => parseMultiple(f.comparisonSentence)).filter(v => v != null);
  const max = (lifts.length ? Math.max(...lifts, 1) : 1) * 1.1;
  const topLift = lifts.length ? Math.max(...lifts) : null;
  const items = raw.map(f => ({ ...f, highlight: topLift != null && parseMultiple(f.comparisonSentence) === topLift }));
  return (
    <section style={{ padding: "34px 36px" }}>
      <ZoneHead n="03" eyebrow="Why it's working" title="Your format playbook." sub="Lift is measured against your own baseline — your usual views. The reference line marks your usual." />
      <div style={{ padding: "8px 24px 18px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)" }}>
        {items.map((f, i) => <FormatBar key={i} f={f} max={max} />)}
      </div>
    </section>
  );
}

function StoryZone({ p }) {
  const s = p?.story;
  if (!s) return null;
  const ft = s.followerTrajectory || {};
  const cards = [];
  if (s.postsPublished != null) cards.push({ lbl: "Posts published", v: String(s.postsPublished), sub: s.sinceLabel || "since we started" });
  if (s.bestPost?.views != null) cards.push({ lbl: "Best post", v: fmtNum(s.bestPost.views), sub: trimCaption(s.bestPost.caption, 40) });
  if (ft.latest != null) cards.push({ lbl: ft.label || "Followers", v: ft.start != null ? `${fmtNum(ft.start)} → ${fmtNum(ft.latest)}` : fmtNum(ft.latest), sub: "organic, no paid promo" });
  if (!cards.length) return null;
  return (
    <section style={{ padding: "34px 36px", background: "var(--bg-2)" }}>
      <ZoneHead n="04" eyebrow="Since we started working together" title="The facts, on record." />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(cards.length, 4)}, 1fr)`, gap: 14 }}>
        {cards.map((c, i) => (
          <div key={i} style={{ padding: "18px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 6 }}>
            <Label>{c.lbl}</Label>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.01em" }}>{c.v}</div>
            <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.45 }}>{c.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function NicheZone({ p }) {
  const niche = p?.niche;
  if (!niche || p?.meta?.dataState?.niche === "absent") return null;
  const ratio = parseMultiple(niche.comparisonSentence);
  const takeaways = niche.marketTakeaways || [];
  const reading = takeaways[0]?.takeaway || niche.comparisonSentence || "How your space is moving right now.";
  return (
    <section style={{ padding: "34px 36px" }}>
      <ZoneHead n="05" eyebrow="Your niche" title={trimCaption(reading, 90)} sub={niche.comparisonSentence && reading !== niche.comparisonSentence ? niche.comparisonSentence : undefined} />
      <div style={{ display: "grid", gridTemplateColumns: takeaways.length ? "1fr 1fr" : "1fr", gap: 18 }}>
        {/* You vs niche median — derived from the parsed ratio, no raw numbers needed. */}
        {ratio != null && (
          <div style={{ padding: 22, borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 18 }}>
            <Label>You vs the niche median</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>You</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "var(--accent)" }}>{ratio}× median</span>
                </div>
                <div style={{ height: 14, borderRadius: 99, background: "var(--surface-3)", overflow: "hidden" }}><div style={{ width: "100%", height: "100%", background: "var(--accent)", borderRadius: 99 }} /></div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Niche median</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-2)" }}>1.0×</span>
                </div>
                <div style={{ height: 14, borderRadius: 99, background: "var(--surface-3)", overflow: "hidden" }}><div style={{ width: `${Math.min((1 / ratio) * 100, 100)}%`, height: "100%", background: "var(--text-3)", borderRadius: 99 }} /></div>
              </div>
            </div>
            {niche.comparisonSentence && <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55, paddingTop: 10, borderTop: "1px solid var(--line)" }}>{niche.comparisonSentence}</div>}
          </div>
        )}
        {takeaways.length > 0 && (
          <div style={{ padding: 22, borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 14 }}>
            <Label>What the market is making</Label>
            {takeaways.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-2)" }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--surface)", border: "1px solid var(--line)", flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}><Icon.play /></div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{c.takeaway}</div>
                {c.sourcePostUrl && <a href={c.sourcePostUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap" }}>See →</a>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── full desktop dashboard ───────────────────────────────────────────
export function AnalyticsDashboard({ p, company }) {
  return (
    <div>
      <HeaderZone p={p} />
      <WinningZone p={p} />
      <NextVideoZone p={p} />
      <FormatPlaybookZone p={p} />
      <StoryZone p={p} />
      <NicheZone p={p} />
      <footer style={{ padding: "40px 36px 60px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-3)" }}>A monthly read on what's working for {company || p?.header?.companyName || "you"}. Made by Viewix.</span>
        <a href="mailto:?subject=Our Viewix growth report" style={{ textDecoration: "none" }}><BtnGhost>Email this to my team</BtnGhost></a>
      </footer>
    </div>
  );
}
