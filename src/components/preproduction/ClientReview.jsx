// Top-level entry for the redesigned client pre-production review.
// Maps a socialOrganic Firebase project record onto the design's
// data shape and orchestrates the three-section feedback model
// (section verdicts, per-script reactions, per-script comments)
// plus the explicit "Submit review" action.
//
// Only mounted from PreproductionPublicView.jsx when the resolved
// projectType === "socialOrganic". metaAds keeps its existing layout.
import { useEffect, useMemo, useRef, useState } from "react";
import { fbSet } from "../../firebase";
import {
  C, BRAND_ICON, BRAND_ACCENT, SectionHead, ChannelCard, Metric, BrandCard,
  FormatCard, FeedbackBox, TopBar, SubmitDock, SubmitModal, colorForFormat,
} from "./ClientReviewUI";
import { ClientReviewHero } from "./ClientReviewHero";
import { ClientReviewNav } from "./ClientReviewNav";
import { FormatGroupHeader, ScriptRow } from "./ClientReviewScripts";

const BRAND_TRUTH_DEFINITIONS = [
  { key: "brandTruths",             heading: "Brand Truths" },
  { key: "brandAmbitions",          heading: "Brand Ambitions" },
  { key: "clientGoals",             heading: "Overall Client Goals" },
  { key: "keyConsiderations",       heading: "Key Considerations" },
  { key: "targetViewerDemographic", heading: "Target Viewer" },
  { key: "painPoints",              heading: "Pain Points" },
  { key: "language",                heading: "Language" },
];

// Format big numbers consistently with the existing public view
// (matches the socialOrganic FollowerPill formatter).
function fmtBig(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// Multi-line brand truth strings → array of items. Strips leading
// bullet glyphs (•, -, *, –) the producer-side editor sometimes
// emits, so cards render cleanly regardless of source format.
function linesFrom(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[•\-*•–]\s*/, "").trim())
    .filter(Boolean);
}

// Pull an @handle out of an Instagram or TikTok URL when no
// `sourceAccount` is stored on the example. Falls back gracefully.
function handleFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // tiktok.com/@handle/video/123
    const tt = u.pathname.match(/^\/(@[A-Za-z0-9._]+)/);
    if (tt) return tt[1];
    // instagram.com/handle/reel/abc — first path segment, ignore reserved words
    const ig = u.pathname.split("/").filter(Boolean)[0];
    if (ig && !["reel", "reels", "p", "tv", "explore"].includes(ig)) return `@${ig}`;
  } catch { /* noop */ }
  return null;
}

export function ClientReview({ project, projectId, accountLogo, accountLogoBg }) {
  const doc = project?.preproductionDoc || {};
  const btFields = project?.brandTruth?.fields || {};
  const scrape = project?.clientScrape || {};
  const profile = scrape.profile || {};
  const followers = profile.followers || {};
  const handles = scrape.handles || {};
  const posts = Array.isArray(scrape.posts) ? scrape.posts : [];
  const takeaways = project?.clientResearch?.keyTakeaways || "";

  // ─── Design data shape ────────────────────────────────────────────────
  const designProject = {
    client: project?.companyName || "Client",
    productLine: project?.packageTier
      ? project.packageTier.charAt(0).toUpperCase() + project.packageTier.slice(1)
      : null,
    sentDate: doc.generatedAt
      ? new Date(doc.generatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
      : null,
    revision: doc.runId ? doc.runId.split("_").pop().slice(0, 4) : null,
  };

  const brandTruth = useMemo(() => {
    const out = {};
    for (const f of BRAND_TRUTH_DEFINITIONS) {
      const items = linesFrom(btFields[f.key]);
      if (items.length > 0) out[f.heading] = items;
    }
    return out;
  }, [btFields]);

  const formats = useMemo(() => (
    (doc.formats || []).map((f, i) => {
      const first = Array.isArray(f.examples) && f.examples[0] ? f.examples[0] : null;
      const ref = first?.sourceAccount
        ? (first.sourceAccount.startsWith("@") ? first.sourceAccount : `@${first.sourceAccount}`)
        : handleFromUrl(first?.url) || "@reference";
      return {
        n: String(i + 1).padStart(2, "0"),
        title: f.name || `Format ${i + 1}`,
        blurb: [f.videoAnalysis, f.filmingInstructions && `\nFilming: ${f.filmingInstructions}`, f.structureInstructions && `\nStructure: ${f.structureInstructions}`]
          .filter(Boolean).join("\n").trim() || "—",
        ref,
        refUrl: first?.url || null,
      };
    })
  ), [doc.formats]);

  const scripts = useMemo(() => (
    (doc.scriptTable || []).map((row, i) => ({
      reviewId: row.reviewId || `row_${i}`,
      n: row.videoNumber || i + 1,
      format: row.formatName || "Other",
      style: row.contentStyle || "",
      hookSpoken: row.hook || "",
      textHook: row.textHook || "",
      visualHook: row.visualHook || "",
      notes: row.scriptNotes || "",
      props: row.props || "",
    }))
  ), [doc.scriptTable]);

  // Defensive: producers can add a format library entry whose `name`
  // happens to match a script's `formatName` after the fact. So the
  // canonical group list is the union of format library entries and
  // any formatName strings present on the script rows.
  const allFormatTitles = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const f of formats) { if (!seen.has(f.title)) { seen.add(f.title); out.push(f.title); } }
    for (const s of scripts) { if (s.format && !seen.has(s.format)) { seen.add(s.format); out.push(s.format); } }
    return out;
  }, [formats, scripts]);

  // ─── State ────────────────────────────────────────────────────────────
  const sectionFeedback = doc.sectionFeedback || {};
  const scriptFeedback = doc.scriptFeedback || {};
  const reviewSubmittedAt = doc.reviewSubmittedAt || null;

  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});
  const [active, setActive] = useState("current");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [autosavedNote, setAutosavedNote] = useState(null);
  const scrollerRef = useRef(null);
  const notifyTimer = useRef(null);

  // Auto-expand the first script once the slate loads so the client
  // immediately sees what the row format looks like (the design's
  // defaultExpandFirst tweak, hard-wired on).
  useEffect(() => {
    if (scripts.length > 0 && Object.keys(expanded).length === 0) {
      setExpanded({ [scripts[0].reviewId]: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scripts.length]);

  // ─── Writes ───────────────────────────────────────────────────────────
  const fbBase = `/preproduction/socialOrganic/${projectId}/preproductionDoc`;

  // Slack notify is debounced 2 minutes after the LAST keystroke so a
  // flurry of edits only pings the producer once. Submit bypasses this
  // (see onSubmit below) — Slack fires synchronously instead.
  const scheduleNotify = () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => {
      fetch("/api/preproduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "notifyFeedback", projectId, type: "socialOrganic" }),
      }).catch(() => {});
    }, 120000);
  };

  function flashSaved() {
    setAutosavedNote("All feedback autosaved");
    setTimeout(() => setAutosavedNote(null), 3000);
  }

  function persistSectionFeedback(sectionId, next) {
    const now = new Date().toISOString();
    const payload = {
      verdict: next.verdict || null,
      text: (next.text || "").trim(),
      submittedAt: now,
    };
    fbSet(`${fbBase}/sectionFeedback/${sectionId}`, payload);
    fbSet(`/preproduction/feedbackLog/sec_${Date.now()}`, {
      type: "clientFeedback",
      kind: "section",
      projectType: "socialOrganic",
      projectId,
      companyName: project?.companyName || "",
      sectionId,
      verdict: payload.verdict,
      text: payload.text,
      timestamp: now,
    });
    scheduleNotify();
    flashSaved();
  }

  // Granular writes to scriptFeedback subpaths. Each operation touches
  // a single leaf (reaction or comments/{id}), so a "click reaction →
  // type comment" interleave can't overwrite the reaction by merging
  // from a pre-echo snapshot.
  function persistScriptReaction(reviewId, reaction) {
    const now = new Date().toISOString();
    fbSet(`${fbBase}/scriptFeedback/${reviewId}/reaction`, reaction || null);
    fbSet(`${fbBase}/scriptFeedback/${reviewId}/updatedAt`, now);
    fbSet(`/preproduction/feedbackLog/scr_${Date.now()}`, {
      type: "clientFeedback",
      kind: "scriptReaction",
      projectType: "socialOrganic",
      projectId,
      companyName: project?.companyName || "",
      reviewId,
      reaction: reaction || null,
      timestamp: now,
    });
    scheduleNotify();
    flashSaved();
  }

  function persistScriptComment(reviewId, commentId, comment) {
    const now = new Date().toISOString();
    fbSet(`${fbBase}/scriptFeedback/${reviewId}/comments/${commentId}`, comment);
    fbSet(`${fbBase}/scriptFeedback/${reviewId}/updatedAt`, now);
    fbSet(`/preproduction/feedbackLog/scr_${Date.now()}`, {
      type: "clientFeedback",
      kind: "scriptComment",
      projectType: "socialOrganic",
      projectId,
      companyName: project?.companyName || "",
      reviewId,
      commentId,
      text: comment.text,
      timestamp: now,
    });
    scheduleNotify();
    flashSaved();
  }

  // ─── Derived metrics ──────────────────────────────────────────────────
  const sectionStatus = (id) => {
    const f = sectionFeedback[id];
    if (!f) return "needs-review";
    if (f.verdict === "approve") return "approved";
    return "comments";
  };

  const scriptStats = useMemo(() => {
    let love = 0, tweak = 0, cut = 0, comments = 0;
    for (const s of Object.values(scriptFeedback || {})) {
      if (!s) continue;
      if (s.reaction === "love") love++;
      else if (s.reaction === "tweak") tweak++;
      else if (s.reaction === "cut") cut++;
      comments += Object.keys(s.comments || {}).length;
    }
    return { love, tweak, cut, comments };
  }, [scriptFeedback]);

  const scriptsReviewed = useMemo(() => (
    Object.values(scriptFeedback || {}).filter(
      (s) => s && (s.reaction || Object.keys(s.comments || {}).length > 0)
    ).length
  ), [scriptFeedback]);

  const sections = useMemo(() => [
    { id: "current", label: "Current content", status: "info" },
    { id: "brand",   label: "Brand truth",     status: sectionStatus("brand"),   count: Object.keys(brandTruth).length },
    { id: "formats", label: "Formats",         status: sectionStatus("formats"), count: formats.length },
    { id: "scripts", label: "Scripts",         status: sectionStatus("scripts"), count: scripts.length },
  ], [sectionFeedback, brandTruth, formats.length, scripts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const reviewableSections = sections.filter((s) => s.status !== "info");
  const sectionsReviewed = reviewableSections.filter((s) => s.status !== "needs-review").length;
  const hasAnyFeedback = sectionsReviewed > 0 || scriptStats.love + scriptStats.tweak + scriptStats.cut + scriptStats.comments > 0;

  const scriptCountsByFormat = useMemo(() => {
    const m = {};
    for (const s of scripts) m[s.format] = (m[s.format] || 0) + 1;
    return m;
  }, [scripts]);

  const filteredScripts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return scripts.filter((s) => {
      if (filter !== "All" && s.format !== filter) return false;
      if (!term) return true;
      const hay = `${s.format} ${s.style} ${s.hookSpoken} ${s.textHook} ${s.visualHook} ${s.notes} ${s.props}`.toLowerCase();
      return hay.includes(term);
    });
  }, [scripts, filter, search]);

  // ─── Nav helpers ──────────────────────────────────────────────────────
  // Section offsets are computed via getBoundingClientRect rather than
  // el.offsetTop because the sections sit inside an inner padding
  // container (`<div style={{padding: ..., maxWidth: 1240}}>`), and
  // offsetTop returns the distance to that wrapper instead of the
  // scrolling parent. Using rect math gives the true scroll-y target.
  const sectionOffsetTop = (el, scroller) => (
    el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const top = scroller.scrollTop;
      const ids = ["current", "brand", "formats", "scripts"];
      for (let i = ids.length - 1; i >= 0; i--) {
        const el = scroller.querySelector(`[data-sec="${ids[i]}"]`);
        if (el && sectionOffsetTop(el, scroller) - 140 <= top) { setActive(ids[i]); return; }
      }
      setActive(ids[0]);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  function jump(id) {
    setActive(id);
    const scroller = scrollerRef.current;
    const el = scroller?.querySelector(`[data-sec="${id}"]`);
    if (el && scroller) {
      scroller.scrollTo({ top: sectionOffsetTop(el, scroller) - 24, behavior: "smooth" });
    }
  }

  function expandAll() {
    const all = {};
    for (const s of filteredScripts) all[s.reviewId] = true;
    setExpanded(all);
  }
  function collapseAll() { setExpanded({}); }

  // ─── Submit ───────────────────────────────────────────────────────────
  async function confirmSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    if (notifyTimer.current) {
      clearTimeout(notifyTimer.current);
      notifyTimer.current = null;
    }
    try {
      const resp = await fetch("/api/preproduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submitReview", projectId }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Submission failed (${resp.status})`);
      }
      setSubmitOpen(false);
    } catch (e) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const showCurrent = followers.instagram != null || followers.tiktok != null || followers.youtube != null
    || profile.avgViews != null || profile.medianViews != null
    || posts.length > 0 || takeaways;
  const topByViews = Array.isArray(scrape.topByViews) ? scrape.topByViews : [];
  const topPost = topByViews.length > 0 ? posts.find((p) => p.id === topByViews[0]) : null;

  return (
    <div style={{ display: "flex", height: "100vh", background: C.bg, font: '400 14px/1.55 "Montserrat", sans-serif', color: C.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-thumb { background: #d4d6dc; border-radius: 999px; border: 2px solid #f4f5f9; }
        ::-webkit-scrollbar-thumb:hover { background: #b9bcc5; }
        ::-webkit-scrollbar-track { background: transparent; }
        @media print { aside, [data-sec] button { display: none !important; } body { background: #fff; } }
      `}</style>

      <ClientReviewNav
        sections={sections}
        active={active}
        onJump={jump}
        progress={{ done: scriptsReviewed, total: scripts.length }}
        scriptStats={scriptStats}
        project={designProject}
        onSubmit={() => setSubmitOpen(true)}
        alreadySubmittedAt={reviewSubmittedAt}
        autosavedNote={autosavedNote}
      />

      <div ref={scrollerRef} style={{ flex: 1, overflowY: "auto", scrollBehavior: "smooth" }}>
        <TopBar
          project={designProject}
          search={search}
          onSearch={(v) => { setSearch(v); if (v) jump("scripts"); }}
          onPrint={() => window.print()}
        />

        <div style={{ padding: "32px 40px 100px", maxWidth: 1240, margin: "0 auto" }}>
          <ClientReviewHero
            sections={sections}
            reviewed={scriptsReviewed}
            total={scripts.length}
            formatsCount={formats.length}
            project={designProject}
          />

          {accountLogo && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, padding: "12px 16px", background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12 }}>
              <img
                src={accountLogo}
                alt=""
                onError={(e) => { e.target.style.display = "none"; }}
                style={{ height: 40, borderRadius: 6, objectFit: "contain", background: accountLogoBg === "dark" ? "#0B1220" : "#FFFFFF", padding: 4 }}
              />
              <div style={{ font: '600 13px/1.3 "Montserrat", sans-serif', color: C.ink }}>{designProject.client}</div>
            </div>
          )}

          {/* CURRENT */}
          {showCurrent && (
            <section data-sec="current" style={{ marginBottom: 56, scrollMarginTop: 24 }}>
              <SectionHead
                idx="01"
                title="Your current content"
                sub="A snapshot of where your channels sit today. Reference only — no feedback needed here."
                status="info"
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 14 }}>
                <ChannelCard name="Instagram" handle={handles.instagram || project?.research?.clientHandle} followers={followers.instagram != null ? fmtBig(followers.instagram) : "—"} accent="#E1306C" />
                <ChannelCard name="TikTok"    handle={handles.tiktok}    followers={followers.tiktok != null ? fmtBig(followers.tiktok) : "—"}    accent={C.ink} />
                <ChannelCard name="YouTube"   handle={handles.youtube}   followers={followers.youtube != null ? fmtBig(followers.youtube) : "—"}   accent="#FF0000" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                <Metric label="Avg views"           value={fmtBig(profile.avgViews)} />
                <Metric label="Median views"        value={fmtBig(profile.medianViews)} />
                <Metric label="Total reels scraped" value={String(posts.length)} />
              </div>
              {takeaways && (
                <div style={{ marginTop: 16, padding: "20px 24px", background: `linear-gradient(135deg, ${C.card} 0%, ${C.orangeBg}40 100%)`, border: `1px solid ${C.orange}40`, borderRadius: 12, display: "grid", gridTemplateColumns: "180px 1fr", gap: 22, alignItems: "start" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 6, height: 26, background: C.orange, borderRadius: 2 }} />
                    <div>
                      <div style={{ font: '700 11px/1.2 "Montserrat", sans-serif', color: C.orangeDk, letterSpacing: "0.12em", textTransform: "uppercase" }}>Producer&apos;s read</div>
                      <div style={{ font: '500 11px/1.3 "Montserrat", sans-serif', color: C.mute, marginTop: 4 }}>From your producer</div>
                    </div>
                  </div>
                  <p style={{ font: '500 16px/1.6 "Montserrat", sans-serif', color: C.ink, margin: 0, textWrap: "pretty", whiteSpace: "pre-wrap" }}>{takeaways}</p>
                </div>
              )}
              {topPost && (
                <div style={{ marginTop: 16, fontSize: 12, color: C.mute }}>
                  Top performer: <a href={topPost.url} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{fmtBig(topPost.views)} views ↗</a>
                </div>
              )}
            </section>
          )}

          {/* BRAND TRUTH */}
          {Object.keys(brandTruth).length > 0 && (
            <section data-sec="brand" style={{ marginBottom: 56, scrollMarginTop: 24 }}>
              <SectionHead
                idx="02"
                title="Brand truth"
                sub="Foundational truths, ambitions, audience and tone agreed in the strategy session."
                status={sectionStatus("brand")}
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {Object.entries(brandTruth).map(([heading, items]) => (
                  <BrandCard
                    key={heading}
                    heading={heading}
                    items={items}
                    accent={BRAND_ACCENT[heading] || C.ink}
                    icon={BRAND_ICON[heading]}
                  />
                ))}
              </div>
              <FeedbackBox
                sectionLabel="Brand truth"
                state={sectionFeedback.brand}
                onSave={(next) => persistSectionFeedback("brand", next)}
              />
            </section>
          )}

          {/* FORMATS */}
          {formats.length > 0 && (
            <section data-sec="formats" style={{ marginBottom: 56, scrollMarginTop: 24 }}>
              <SectionHead
                idx="03"
                title="Formats we'll produce"
                count={formats.length}
                sub="Each script in the next section maps onto one of these — tap a format to jump to its scripts."
                status={sectionStatus("formats")}
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
                {formats.map((f) => (
                  <FormatCard
                    key={f.title}
                    f={f}
                    color={colorForFormat(f.title)}
                    scriptCount={scriptCountsByFormat[f.title] || 0}
                    onJump={() => { setFilter(f.title); jump("scripts"); }}
                  />
                ))}
              </div>
              <FeedbackBox
                sectionLabel="Formats"
                state={sectionFeedback.formats}
                onSave={(next) => persistSectionFeedback("formats", next)}
              />
            </section>
          )}

          {/* SCRIPTS */}
          <section data-sec="scripts" style={{ marginBottom: 56, scrollMarginTop: 24 }}>
            <SectionHead
              idx="04"
              title="Scripts"
              count={scripts.length}
              sub="Tap any card to expand the full notes and props. React with a quick take, leave a comment, or filter by format above."
              status={sectionStatus("scripts")}
              right={
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={expandAll} style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: C.ink2, background: C.card, border: `1px solid ${C.rule}`, padding: "8px 11px", borderRadius: 6, cursor: "pointer" }}>Expand all</button>
                  <button onClick={collapseAll} style={{ font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase", color: C.ink2, background: C.card, border: `1px solid ${C.rule}`, padding: "8px 11px", borderRadius: 6, cursor: "pointer" }}>Collapse all</button>
                </div>
              }
            />

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
              {["All", ...allFormatTitles].map((label) => {
                const isOn = filter === label;
                const c = label === "All" ? null : colorForFormat(label);
                return (
                  <button
                    key={label}
                    onClick={() => setFilter(label)}
                    style={{
                      font: '600 11px/1 "Montserrat", sans-serif', letterSpacing: "0.06em", textTransform: "uppercase",
                      padding: "9px 12px", borderRadius: 999, cursor: "pointer",
                      color: isOn ? "#fff" : (c?.fg || C.ink2),
                      background: isOn ? C.ink : (c?.bg || C.card),
                      border: `1px solid ${isOn ? C.ink : (c?.fg || C.rule)}`,
                      display: "inline-flex", alignItems: "center", gap: 6, transition: "all .12s",
                    }}
                  >
                    {label !== "All" && c && <span style={{ width: 6, height: 6, borderRadius: 999, background: isOn ? "#fff" : c.fg }} />}
                    {label}
                    {label !== "All" && <span style={{ opacity: isOn ? 0.75 : 0.6, fontWeight: 700 }}>{scriptCountsByFormat[label] || 0}</span>}
                  </button>
                );
              })}
            </div>

            {scripts.length === 0 ? (
              <div style={{ padding: "60px 24px", textAlign: "center", background: C.card, border: `1px dashed ${C.rule}`, borderRadius: 12 }}>
                <div style={{ font: '600 14px/1.4 "Montserrat", sans-serif', color: C.ink, marginBottom: 6 }}>Scripts coming soon</div>
                <div style={{ font: '400 13px/1.5 "Montserrat", sans-serif', color: C.mute }}>Your producer is still writing the scripts — check back shortly.</div>
              </div>
            ) : filteredScripts.length === 0 ? (
              <div style={{ padding: "60px 24px", textAlign: "center", background: C.card, border: `1px dashed ${C.rule}`, borderRadius: 12 }}>
                <div style={{ font: '600 14px/1.4 "Montserrat", sans-serif', color: C.ink, marginBottom: 6 }}>
                  {search ? `No scripts match "${search}"` : "No scripts in this format"}
                </div>
                <div style={{ font: '400 13px/1.5 "Montserrat", sans-serif', color: C.mute }}>
                  Try a different search term or{" "}
                  <button onClick={() => { setSearch(""); setFilter("All"); }} style={{ color: C.blue, background: "transparent", border: "none", cursor: "pointer", font: "inherit", padding: 0 }}>
                    clear filters
                  </button>.
                </div>
              </div>
            ) : (
              <div>
                {allFormatTitles.map((title) => {
                  const inGroup = filteredScripts.filter((s) => s.format === title);
                  if (inGroup.length === 0) return null;
                  const fmt = formats.find((f) => f.title === title) || { title, blurb: "", ref: "@reference", refUrl: null };
                  const color = colorForFormat(title);
                  return (
                    <div key={title}>
                      <FormatGroupHeader format={fmt} color={color} count={inGroup.length} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {inGroup.map((s) => (
                          <ScriptRow
                            key={s.reviewId}
                            s={s}
                            expanded={!!expanded[s.reviewId]}
                            onToggle={() => setExpanded((e) => ({ ...e, [s.reviewId]: !e[s.reviewId] }))}
                            color={color}
                            state={scriptFeedback[s.reviewId]}
                            onReaction={(r) => persistScriptReaction(s.reviewId, r)}
                            onAddComment={(cid, comment) => persistScriptComment(s.reviewId, cid, comment)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <FeedbackBox
              sectionLabel="Scripts overall"
              state={sectionFeedback.scripts}
              onSave={(next) => persistSectionFeedback("scripts", next)}
            />
          </section>

          {/* FOOTER WRAP */}
          <footer style={{ padding: "28px 32px", background: C.card, border: `1px solid ${C.rule}`, borderRadius: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div style={{ font: '700 15px/1.3 "Montserrat", sans-serif', color: C.ink }}>
                {reviewSubmittedAt ? "Review submitted" : "Ready to send your feedback?"}
              </div>
              <div style={{ font: '500 12.5px/1.55 "Montserrat", sans-serif', color: C.mute, marginTop: 6 }}>
                {reviewSubmittedAt
                  ? `Sent ${new Date(reviewSubmittedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. You can keep editing — resend any time.`
                  : "We'll respond within 1 business day with the next revision or a kickoff call."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setSubmitOpen(true)} style={{ font: '700 11px/1 "Montserrat", sans-serif', letterSpacing: "0.08em", textTransform: "uppercase", color: "#fff", background: C.orange, border: "none", padding: "13px 24px", borderRadius: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {reviewSubmittedAt ? "Resend feedback" : "Submit review"}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
          </footer>
        </div>
      </div>

      <SubmitDock
        visible={hasAnyFeedback && !submitOpen}
        reviewed={sectionsReviewed}
        total={reviewableSections.length}
        onSubmit={() => setSubmitOpen(true)}
      />
      <SubmitModal
        open={submitOpen}
        onClose={() => { if (!submitting) { setSubmitOpen(false); setSubmitError(null); } }}
        onConfirm={confirmSubmit}
        reviewed={sectionsReviewed}
        total={reviewableSections.length}
        scriptStats={scriptStats}
        submitting={submitting}
        error={submitError}
        alreadySubmittedAt={reviewSubmittedAt}
      />
    </div>
  );
}
