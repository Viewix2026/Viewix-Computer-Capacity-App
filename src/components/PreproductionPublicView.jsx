import { useState, useEffect, useRef } from "react";
import { initFB, onFB, fbSet, fbListen, signInAnonymouslyForPublic } from "../firebase";
import { Logo } from "./Logo";
import { ReelPreview } from "./shared/ReelPreview";
import { logoBg } from "../utils";

const MOTIVATOR_COLORS = {
  toward: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.25)", fg: "#22C55E", label: "Toward" },
  awayFrom: { bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.25)", fg: "#EF4444", label: "Away From" },
  triedBefore: { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.25)", fg: "#3B82F6", label: "Tried Before" },
};

const TIER_COLORS = {
  standard: "#3B82F6", premium: "#F59E0B", deluxe: "#8B5CF6",
};

const SCRIPT_COLUMNS = [
  { key: "videoName", label: "Video Name", width: 140 },
  { key: "hook", label: "Hook", width: 200 },
  { key: "explainThePain", label: "Explain the Pain", width: 180 },
  { key: "results", label: "Results", width: 180 },
  { key: "theOffer", label: "The Offer", width: 200 },
  { key: "whyTheOffer", label: "Why the Offer", width: 180 },
  { key: "cta", label: "CTA", width: 150 },
  { key: "metaAdHeadline", label: "Meta Ad Headline", width: 160 },
  { key: "metaAdCopy", label: "Meta Ad Copy", width: 240 },
];

export function PreproductionPublicView() {
  const [project, setProject] = useState(null);
  // projectType lets us render different layouts depending on where the
  // record was found. "metaAds" = existing full layout; "socialOrganic" =
  // minimal script-table view (introduced by the Tab-7 client feedback flow).
  const [projectType, setProjectType] = useState(null);
  const [loading, setLoading] = useState(true);
  const [feedbackCell, setFeedbackCell] = useState(null); // { cellId, column } or { cellId, column: "_row" } for row feedback
  const [feedbackText, setFeedbackText] = useState("");
  const [saving, setSaving] = useState(false);
  const [accountLogo, setAccountLogo] = useState(null);
  const [accountLogoBg, setAccountLogoBg] = useState("white");
  const notifyTimer = useRef(null);

  // Support both pretty paths (/p/HASH/slug) and legacy ?p=ID
  const projectId = new URLSearchParams(window.location.search).get("p");
  const prettyMatch = window.location.pathname.match(/^\/p\/([a-z0-9]{4,12})/i);
  const shortId = prettyMatch ? prettyMatch[1].toLowerCase() : null;

  useEffect(() => {
    if (!projectId && !shortId) return;
    document.title = "Viewix - Script Review";
    initFB();
    onFB(async () => {
      try { await signInAnonymouslyForPublic(); }
      catch (e) { console.warn("Anonymous auth failed, continuing:", e.message); }

      // Try metaAds first (legacy default). If we don't find a match within
      // a reasonable window, fall back to socialOrganic. We wire both
      // listeners so hot-swaps land live — whichever responds with a real
      // match wins.
      let foundAny = false;

      if (projectId) {
        fbListen(`/preproduction/metaAds/${projectId}`, (data) => {
          if (data) { setProject(data); setProjectType("metaAds"); foundAny = true; setLoading(false); }
        });
        fbListen(`/preproduction/socialOrganic/${projectId}`, (data) => {
          if (data && !foundAny) { setProject(data); setProjectType("socialOrganic"); foundAny = true; setLoading(false); }
        });
      } else if (shortId) {
        fbListen(`/preproduction/metaAds`, (allProjects) => {
          if (!allProjects) return;
          const match = Object.values(allProjects).find(p => p && p.shortId && p.shortId.toLowerCase() === shortId);
          if (match) { setProject(match); setProjectType("metaAds"); foundAny = true; setLoading(false); }
        });
        fbListen(`/preproduction/socialOrganic`, (allProjects) => {
          if (!allProjects) return;
          const match = Object.values(allProjects).find(p => p && p.shortId && p.shortId.toLowerCase() === shortId);
          if (match && !foundAny) { setProject(match); setProjectType("socialOrganic"); foundAny = true; setLoading(false); }
        });
      }
      // Loading timeout — 3s should be more than enough to see if either
      // path has data. After that, show the "not found" error state.
      setTimeout(() => { if (!foundAny) setLoading(false); }, 3000);
    });
  }, [projectId, shortId]);

  // Resolve account logo
  useEffect(() => {
    if (!project?.companyName) return;
    let unsub = () => {};
    onFB(() => {
      unsub = fbListen("/accounts", (acctData) => {
        if (!acctData) return;
        const nameLC = project.companyName.toLowerCase();
        const match = Object.values(acctData).find(a => a && (a.companyName || "").toLowerCase() === nameLC);
        setAccountLogo(match?.logoUrl || null);
        setAccountLogoBg(match?.logoBg || "white");
      });
    });
    return () => unsub();
  }, [project?.companyName]);

  // Send Slack notification 2 minutes after last feedback submission
  const scheduleNotify = () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => {
      fetch("/api/preproduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "notifyFeedback", projectId: project?.id || projectId, type: projectType }),
      }).catch(() => {});
    }, 120000); // 2 minutes
  };

  const submitFeedback = () => {
    const pid = project?.id || projectId;
    if (!feedbackCell || !feedbackText.trim() || !pid) return;
    setSaving(true);
    // Key convention differs by project type:
    //   metaAds        → `{rowId}_{col}` or `{rowId}__row`
    //   socialOrganic  → `scriptTable.{i}.{col}` (dot-path of the field)
    const key = projectType === "socialOrganic"
      ? feedbackCell.cellKey
      : (feedbackCell.column === "_row"
          ? `${feedbackCell.cellId}__row`
          : `${feedbackCell.cellId}_${feedbackCell.column}`);
    const now = new Date().toISOString();
    const basePath = projectType === "socialOrganic"
      ? `/preproduction/socialOrganic/${pid}/preproductionDoc/clientFeedback`
      : `/preproduction/metaAds/${pid}/clientFeedback`;
    fbSet(`${basePath}/${key.replace(/\./g, "_")}`, {
      text: feedbackText.trim(),
      submittedAt: now,
      cellId: feedbackCell.cellId || null,
      column: feedbackCell.column || null,
      cellKey: feedbackCell.cellKey || null,
    });
    // Log to central feedback log for prompt refinement
    fbSet(`/preproduction/feedbackLog/cf_${Date.now()}`, {
      type: "clientFeedback",
      projectType,
      projectId: pid,
      companyName: project?.companyName || "",
      cellKey: key,
      text: feedbackText.trim(),
      timestamp: now,
    });
    setFeedbackCell(null);
    setFeedbackText("");
    setTimeout(() => setSaving(false), 800);
    scheduleNotify();
  };

  const getFeedback = (cellId, column) => {
    if (projectType === "socialOrganic") {
      const fb = project?.preproductionDoc?.clientFeedback;
      if (!fb) return null;
      // Producer-side writes path-style keys; we translate back here.
      const key = (cellId || "").replace(/\./g, "_");
      return fb[key] || null;
    }
    if (!project?.clientFeedback) return null;
    return project.clientFeedback[`${cellId}_${column}`] || null;
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0B0F1A", fontFamily: "'DM Sans',-apple-system,sans-serif" }}>
      <div style={{ color: "#5A6B85", fontSize: 14 }}>Loading...</div>
    </div>
  );

  if (!project) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0B0F1A", fontFamily: "'DM Sans',-apple-system,sans-serif" }}>
      <div style={{ color: "#5A6B85", fontSize: 14 }}>Project not found</div>
    </div>
  );

  // Social Organic projects have a different data shape — render a
  // minimal script-table view with per-cell feedback boxes.
  if (projectType === "socialOrganic") {
    return renderSocialOrganic();
  }

  // eslint-disable-next-line no-inner-declarations
  function renderSocialOrganic() {
    const doc = project?.preproductionDoc || {};
    const rows = Array.isArray(doc.scriptTable) ? doc.scriptTable : [];
    const formats = Array.isArray(doc.formats) ? doc.formats : [];
    const bt = project?.brandTruth?.fields || {};
    const takeaways = project?.clientResearch?.keyTakeaways || "";
    const fb = doc.clientFeedback || {};

    const SO_COLS = [
      { key: "formatName",   label: "Format",        editable: false },
      { key: "contentStyle", label: "Content Style" },
      { key: "hook",         label: "Hook (spoken)" },
      { key: "textHook",     label: "Text Hook" },
      { key: "visualHook",   label: "Visual Hook" },
      { key: "scriptNotes",  label: "Script / Notes" },
      { key: "props",        label: "Props" },
    ];

    // Brand Truth fields the client can comment on — same shape as the
    // producer-side Brand Truth editor but read-only here + feedback-only.
    const BT_FIELDS = [
      { key: "brandTruths",             label: "Brand Truths" },
      { key: "brandAmbitions",          label: "Brand Ambitions" },
      { key: "clientGoals",             label: "Overall Client Goals" },
      { key: "keyConsiderations",       label: "Key Considerations" },
      { key: "targetViewerDemographic", label: "Target Viewer" },
      { key: "painPoints",              label: "Pain Points" },
      { key: "language",                label: "Language" },
    ];

    // Helper: render a feedback-capable block. cellKey is the dot-path we
    // write under preproductionDoc.clientFeedback; same convention as the
    // producer-side Clickable so yellow-dot indicators line up.
    const FeedbackCell = ({ cellKey, label, value, multi }) => {
      const existing = fb[cellKey.replace(/\./g, "_")];
      return (
        <div
          onClick={() => setFeedbackCell({ cellKey, cellId: cellKey, column: label })}
          style={{
            padding: "10px 14px", borderRadius: 6, minHeight: 28,
            background: existing ? "rgba(245,158,11,0.08)" : "#0B0F1A",
            border: existing ? "1px solid rgba(245,158,11,0.4)" : "1px solid #1E2A3A",
            cursor: "pointer",
            color: value ? "#E8ECF4" : "#5A6B85",
            fontSize: 13, lineHeight: 1.6, whiteSpace: multi ? "pre-wrap" : "normal",
            fontStyle: value ? "normal" : "italic",
            transition: "background 0.15s, border 0.15s",
          }}>
          {value || "(empty)"}
          {existing && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#F59E0B", fontStyle: "italic", lineHeight: 1.5 }}>
              Your feedback: "{existing.text}"
            </div>
          )}
        </div>
      );
    };

    const Section = ({ title, children }) => (
      <div style={{ background: "#141A26", border: "1px solid #1E2A3A", borderRadius: 12, padding: 24, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 16 }}>{title}</div>
        {children}
      </div>
    );

    return (
      <div style={{ minHeight: "100vh", background: "#0B0F1A", fontFamily: "'DM Sans',-apple-system,sans-serif", color: "#E8ECF4" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0;}`}</style>

        <div style={{ padding: "24px 40px", borderBottom: "1px solid #1E2A3A", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {accountLogo && <img src={accountLogo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 36, borderRadius: 4, objectFit: "contain", background: logoBg(accountLogoBg), padding: 4 }} />}
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#E8ECF4" }}>{project.companyName}</div>
              <div style={{ fontSize: 12, color: "#5A6B85", marginTop: 2 }}>Social preproduction brief · click any section to leave feedback</div>
            </div>
          </div>
          <Logo />
        </div>

        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "30px 40px" }}>

          {/* Brand Truth — the context Claude extracted from the preproduction
              meeting. Client reviews it here, flags anything off before scripts
              get locked in. */}
          {BT_FIELDS.some(f => bt[f.key]) && (
            <Section title="Brand Truth">
              {BT_FIELDS.map(f => (
                <div key={f.key} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>{f.label}</div>
                  <FeedbackCell cellKey={`brandTruth.fields.${f.key}`} label={f.label} value={bt[f.key]} multi />
                </div>
              ))}
            </Section>
          )}

          {/* Client Research — the producer's scrape of the client's existing
              reels. Shows follower counts, engagement stats, and the current
              best-performing reel. Helps the client understand the baseline
              we're working from before they look at the new format plan. */}
          {(() => {
            const scrape = project?.clientScrape || {};
            const profile = scrape.profile || {};
            const followers = profile.followers || {};
            const posts = Array.isArray(scrape.posts) ? scrape.posts : [];
            const topIds = Array.isArray(scrape.topByViews) ? scrape.topByViews : [];
            const topPost = topIds.length > 0 ? posts.find(p => p.id === topIds[0]) : null;
            const hasAny =
              followers.instagram != null || followers.tiktok != null || followers.youtube != null
              || profile.avgViews != null || profile.medianViews != null
              || posts.length > 0 || topPost;
            if (!hasAny) return null;

            // Local big-number formatter (matches the producer-side formatBig).
            const fmtBig = n => {
              if (n == null) return "—";
              if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
              if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
              return String(n);
            };
            const FollowerPill = ({ platform, count, handle }) => (
              <div style={{ flex: 1, minWidth: 140, background: "#0B0F1A", border: "1px solid #1E2A3A", borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{platform}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#E8ECF4", fontFamily: "'JetBrains Mono',monospace" }}>{count != null ? fmtBig(count) : "—"}</div>
                {handle && <div style={{ fontSize: 10, color: "#5A6B85", marginTop: 3 }}>{handle.startsWith("@") ? handle : `@${handle}`}</div>}
              </div>
            );
            const StatPill = ({ label, value }) => (
              <div style={{ padding: "10px 14px", background: "#0B0F1A", border: "1px solid #1E2A3A", borderRadius: 8, flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#E8ECF4", fontFamily: "'JetBrains Mono',monospace" }}>{value}</div>
              </div>
            );
            const handles = scrape.handles || {};
            return (
              <Section title="Your current content">
                {/* Follower cards */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
                  <FollowerPill platform="Instagram" count={followers.instagram} handle={handles.instagram || project?.research?.clientHandle} />
                  <FollowerPill platform="TikTok"    count={followers.tiktok}    handle={handles.tiktok} />
                  <FollowerPill platform="YouTube"   count={followers.youtube}   handle={handles.youtube} />
                </div>

                {/* Engagement stats */}
                {(profile.avgViews != null || profile.medianViews != null || posts.length > 0) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
                    <StatPill label="Avg views"          value={fmtBig(profile.avgViews)} />
                    <StatPill label="Median views"       value={fmtBig(profile.medianViews)} />
                    <StatPill label="Total reels scraped" value={String(posts.length)} />
                  </div>
                )}

                {/* Top reel by views + producer takeaway side by side on wide,
                    stacked on narrow. */}
                <div style={{ display: "grid", gridTemplateColumns: topPost ? "minmax(220px, 300px) 1fr" : "1fr", gap: 16, alignItems: "start" }}>
                  {topPost && (
                    <div style={{ background: "#0B0F1A", border: "1px solid #1E2A3A", borderRadius: 8, overflow: "hidden" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", padding: "10px 12px 6px" }}>Top performer</div>
                      <ReelPreview shortCode={topPost.shortCode} url={topPost.url} thumbnail={topPost.thumbnail} aspectRatio="9 / 16" />
                      <a href={topPost.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", padding: "10px 12px", textDecoration: "none", borderTop: "1px solid #1E2A3A" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#8B5CF6", fontFamily: "'JetBrains Mono',monospace" }}>👁 {fmtBig(topPost.views)} views</div>
                        {topPost.caption && (
                          <div style={{ fontSize: 10, color: "#5A6B85", marginTop: 3, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {topPost.caption}
                          </div>
                        )}
                      </a>
                    </div>
                  )}
                  {takeaways && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Producer's read</div>
                      <FeedbackCell cellKey="clientResearch.keyTakeaways" label="Key takeaways" value={takeaways} multi />
                    </div>
                  )}
                </div>
              </Section>
            );
          })()}

          {/* Fallback: if there's no scrape data but a takeaway was written,
              still render it as a standalone section (legacy projects). */}
          {takeaways && !project?.clientScrape && (
            <Section title="Producer's read on your current content">
              <FeedbackCell cellKey="clientResearch.keyTakeaways" label="Key takeaways" value={takeaways} multi />
            </Section>
          )}

          {/* Selected formats — so the client knows what's being produced.
              Each format shows up to 3 example reel embeds so the client
              can watch live examples of the style being proposed. */}
          {formats.length > 0 && (
            <Section title={`Formats we'll produce (${formats.length})`}>
              {/* Compact 2-column grid. Each format is a horizontal row:
                  small portrait thumbnail on the left (first example, with
                  play overlay + click-through to all examples), name +
                  truncated analysis on the right. Click the analysis to
                  expand + leave feedback. Keeps the whole section skimmable
                  at a glance — a 5-format brief used to take up ~2 screens,
                  now fits in one. */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
                {formats.map((f, i) => {
                  const examples = Array.isArray(f.examples) ? f.examples.slice(0, 3) : [];
                  const first = examples[0] || null;
                  const hasFeedback = !!doc.clientFeedback?.[`formats.${i}.videoAnalysis`.replace(/\./g, "_")];
                  return (
                    <div key={f.formatLibraryId || i} style={{
                      display: "flex", gap: 10, padding: 10,
                      background: "#0B0F1A", border: `1px solid ${hasFeedback ? "rgba(245,158,11,0.4)" : "#1E2A3A"}`,
                      borderRadius: 8,
                    }}>
                      {first && (
                        <a href={first.url} target="_blank" rel="noopener noreferrer"
                          style={{ width: 64, flexShrink: 0, borderRadius: 4, overflow: "hidden", textDecoration: "none" }}>
                          <ReelPreview url={first.url} thumbnail={first.thumbnail} aspectRatio="9 / 16" compact />
                        </a>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 10, color: "#5A6B85", fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{String(i + 1).padStart(2, "0")}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#E8ECF4", lineHeight: 1.2 }}>{f.name}</span>
                        </div>
                        {f.videoAnalysis && (
                          <div
                            onClick={() => setFeedbackCell({ cellKey: `formats.${i}.videoAnalysis`, cellId: `formats.${i}.videoAnalysis`, column: `${f.name} — analysis` })}
                            style={{
                              fontSize: 11, color: "#8A9BB4", lineHeight: 1.45, cursor: "pointer",
                              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                              overflow: "hidden", textOverflow: "ellipsis",
                            }}
                            title="Click to leave feedback on this format"
                          >
                            {f.videoAnalysis}
                          </div>
                        )}
                        {examples.length > 1 && (
                          <div style={{ fontSize: 10, color: "#5A6B85", marginTop: 4 }}>
                            {examples.length} example{examples.length === 1 ? "" : "s"}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Script table — the actual per-video content plan. */}
          <Section title={`Scripts (${rows.length})`}>
          {rows.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "#5A6B85", fontSize: 13 }}>
              The producer is still writing the scripts — check back shortly.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#0B0F1A" }}>
                    <th style={{ textAlign: "left", padding: "10px 12px", fontSize: 11, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", width: 40 }}>#</th>
                    {SO_COLS.map(c => (
                      <th key={c.key} style={{ textAlign: "left", padding: "10px 12px", fontSize: 11, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 160 }}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #1E2A3A" }}>
                      <td style={{ padding: "8px 12px", color: "#5A6B85", fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>{row.videoNumber || i + 1}</td>
                      {SO_COLS.map(c => {
                        const cellKey = `scriptTable.${i}.${c.key}`;
                        const existing = fb[cellKey.replace(/\./g, "_")];
                        const editable = c.editable !== false;
                        const value = row[c.key] || "";
                        return (
                          <td key={c.key} style={{ padding: "4px 6px", verticalAlign: "top", position: "relative" }}>
                            <div
                              onClick={() => editable && setFeedbackCell({ cellKey, cellId: `row_${i}`, column: c.key })}
                              style={{
                                padding: "6px 8px", borderRadius: 4, minHeight: 24,
                                background: existing ? "rgba(245,158,11,0.08)" : "transparent",
                                outline: existing ? "1px solid rgba(245,158,11,0.4)" : "1px solid transparent",
                                cursor: editable ? "pointer" : "default",
                                color: value ? "#E8ECF4" : "#5A6B85",
                                fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap",
                              }}>
                              {value || (editable ? "(empty)" : "—")}
                              {existing && (
                                <div style={{ marginTop: 4, fontSize: 10, color: "#F59E0B", fontStyle: "italic" }}>
                                  Your feedback: "{existing.text}"
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </Section>

          {feedbackCell && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setFeedbackCell(null)}>
              <div style={{ background: "#141A26", borderRadius: 12, padding: 22, maxWidth: 520, width: "92%", border: "1px solid #1E2A3A" }} onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#E8ECF4", marginBottom: 10 }}>Leave feedback</div>
                <div style={{ fontSize: 11, color: "#5A6B85", marginBottom: 10 }}>{SO_COLS.find(c => c.key === feedbackCell.column)?.label}</div>
                <textarea value={feedbackText} onChange={e => setFeedbackText(e.target.value)} autoFocus rows={4}
                  placeholder="What would you like changed?"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 6, border: "1px solid #1E2A3A", background: "#0B0F1A", color: "#E8ECF4", fontSize: 13, fontFamily: "inherit", resize: "vertical", marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setFeedbackCell(null)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #1E2A3A", background: "transparent", color: "#5A6B85", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                  <button onClick={submitFeedback} disabled={!feedbackText.trim() || saving}
                    style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "#8B5CF6", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: (!feedbackText.trim() || saving) ? 0.5 : 1 }}>
                    {saving ? "Saving…" : "Submit"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const p = project;
  const hasScripts = p.scriptTable && p.scriptTable.length > 0;
  const tierColor = TIER_COLORS[p.packageTier] || "#3B82F6";

  return (
    <div style={{ minHeight: "100vh", background: "#0B0F1A", fontFamily: "'DM Sans',-apple-system,sans-serif", color: "#E8ECF4" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0;}::-webkit-scrollbar{width:6px;height:6px;}::-webkit-scrollbar-track{background:#0B0F1A;}::-webkit-scrollbar-thumb{background:#1E2A3A;border-radius:3px;}`}</style>

      {/* Header */}
      <div style={{ padding: "24px 40px", borderBottom: "1px solid #1E2A3A", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {accountLogo && <img key={accountLogo+accountLogoBg} src={accountLogo} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 40, borderRadius: 6, objectFit: "contain", background: logoBg(accountLogoBg), padding: 4 }} />}
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#E8ECF4" }}>{p.companyName}</div>
            <div style={{ fontSize: 13, color: "#5A6B85" }}>Meta Ads Script Review</div>
          </div>
          <span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: `${tierColor}20`, color: tierColor, textTransform: "capitalize" }}>
            {p.packageTier}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {saving && <span style={{ fontSize: 11, color: "#10B981", fontWeight: 600 }}>Saved</span>}
          <Logo h={20} />
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 40px" }}>

        {/* Instructions */}
        <div style={{ marginBottom: 24, padding: "16px 20px", background: "#131825", border: "1px solid #1E2A3A", borderRadius: 12, fontSize: 13, color: "#8899AB", lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, color: "#E8ECF4", marginBottom: 8 }}>How to review</div>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#0082FA", fontWeight: 800, fontSize: 14, minWidth: 20 }}>1.</span>
              <span>Review the brand analysis and script table below. Everything here was generated from your onboarding call.</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#0082FA", fontWeight: 800, fontSize: 14, minWidth: 20 }}>2.</span>
              <span>Click any script cell to <span style={{ color: "#0082FA", fontWeight: 600 }}>leave feedback</span>. Your comments will be reviewed by the production team.</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#0082FA", fontWeight: 800, fontSize: 14, minWidth: 20 }}>3.</span>
              <span>Cells you've already commented on will show a <span style={{ color: "#F59E0B", fontWeight: 600 }}>yellow dot</span>.</span>
            </div>
          </div>
        </div>

        {/* Brand Analysis */}
        {p.brandAnalysis && (
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#E8ECF4", marginBottom: 16 }}>Brand Analysis</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { key: "brandAnalysis_brandTruths", label: "Brand Truths", items: p.brandAnalysis.brandTruths },
                { key: "brandAnalysis_brandAmbitions", label: "Brand Ambitions", items: p.brandAnalysis.brandAmbitions },
                { key: "brandAnalysis_brandPersonality", label: "Brand Personality", text: p.brandAnalysis.brandPersonality?.summary, types: p.brandAnalysis.brandPersonality?.types },
                { key: "targetCustomer", label: "Target Customer", items: p.targetCustomer },
              ].map(sec => {
                const fb = getFeedback(sec.key, "section");
                const isActive = feedbackCell?.cellId === sec.key && feedbackCell?.column === "section";
                return (
                  <div key={sec.key} onClick={() => { setFeedbackCell({ cellId: sec.key, column: "section" }); setFeedbackText(fb?.text || ""); }} style={{ background: "#131825", border: `1px solid ${isActive ? "#0082FA" : "#1E2A3A"}`, borderRadius: 10, padding: 16, cursor: "pointer", transition: "border-color 0.15s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      {fb && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#F59E0B", flexShrink: 0 }} />}
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#5A6B85", textTransform: "uppercase", letterSpacing: "0.5px" }}>{sec.label}</div>
                    </div>
                    {sec.types && <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>{sec.types.map((t, i) => <span key={i} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "rgba(0,130,250,0.12)", color: "#0082FA" }}>{t}</span>)}</div>}
                    {sec.items ? (
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "#C8D2DE", lineHeight: 1.7 }}>{sec.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
                    ) : (
                      <div style={{ fontSize: 13, color: "#C8D2DE", lineHeight: 1.5 }}>{sec.text || ""}</div>
                    )}
                    {isActive && (
                      <div onClick={e => e.stopPropagation()} style={{ marginTop: 10, padding: 12, background: "#0B0F1A", border: "1px solid #0082FA", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
                        <div style={{ fontSize: 11, color: "#5A6B85", marginBottom: 6 }}>{fb ? "Update your feedback:" : "Leave feedback on this section:"}</div>
                        <textarea autoFocus value={feedbackText} onChange={e => setFeedbackText(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setFeedbackCell(null); }} placeholder="e.g. These brand truths don't quite capture our core values" rows={3} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #1E2A3A", background: "#131825", color: "#E8ECF4", fontSize: 12, fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <button onClick={submitFeedback} disabled={!feedbackText.trim()} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#0082FA", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: !feedbackText.trim() ? 0.5 : 1 }}>Submit</button>
                          <button onClick={() => setFeedbackCell(null)} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #1E2A3A", background: "transparent", color: "#5A6B85", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                        </div>
                        {fb && <div style={{ marginTop: 8, fontSize: 10, color: "#5A6B85" }}>Last submitted: {new Date(fb.submittedAt).toLocaleString("en-AU")}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Motivators */}
            {p.motivators && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                {["toward", "awayFrom", "triedBefore"].map(type => {
                  const mc = MOTIVATOR_COLORS[type];
                  const motKey = `motivators_${type}`;
                  const fb = getFeedback(motKey, "section");
                  const isActive = feedbackCell?.cellId === motKey && feedbackCell?.column === "section";
                  return (
                    <div key={type} onClick={() => { setFeedbackCell({ cellId: motKey, column: "section" }); setFeedbackText(fb?.text || ""); }} style={{ background: mc.bg, border: `1px solid ${isActive ? "#0082FA" : mc.border}`, borderRadius: 10, padding: 16, cursor: "pointer", transition: "border-color 0.15s" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                        {fb && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#F59E0B", flexShrink: 0 }} />}
                        <div style={{ fontSize: 11, fontWeight: 700, color: mc.fg, textTransform: "uppercase", letterSpacing: "0.5px" }}>{mc.label}</div>
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "#C8D2DE", lineHeight: 1.7 }}>
                        {(p.motivators[type] || []).map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                      {isActive && (
                        <div onClick={e => e.stopPropagation()} style={{ marginTop: 10, padding: 12, background: "#0B0F1A", border: "1px solid #0082FA", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
                          <div style={{ fontSize: 11, color: "#5A6B85", marginBottom: 6 }}>{fb ? "Update your feedback:" : "Leave feedback:"}</div>
                          <textarea autoFocus value={feedbackText} onChange={e => setFeedbackText(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setFeedbackCell(null); }} placeholder="e.g. These motivators need to be more specific" rows={3} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #1E2A3A", background: "#131825", color: "#E8ECF4", fontSize: 12, fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
                          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button onClick={submitFeedback} disabled={!feedbackText.trim()} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#0082FA", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: !feedbackText.trim() ? 0.5 : 1 }}>Submit</button>
                            <button onClick={() => setFeedbackCell(null)} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #1E2A3A", background: "transparent", color: "#5A6B85", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                          </div>
                          {fb && <div style={{ marginTop: 8, fontSize: 10, color: "#5A6B85" }}>Last submitted: {new Date(fb.submittedAt).toLocaleString("en-AU")}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Visuals */}
        {p.visuals && (
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#E8ECF4", marginBottom: 16 }}>Visual Direction</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
              {[
                { key: "onCameraPresence", label: "On-Camera Presence" },
                { key: "location", label: "Location" },
                { key: "visualLanguage", label: "Visual Language" },
                { key: "motionGraphics", label: "Motion Graphics" },
              ].map(v => (
                <div key={v.key} style={{ background: "#131825", border: "1px solid #1E2A3A", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#5A6B85", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{v.label}</div>
                  <div style={{ fontSize: 13, color: "#C8D2DE", lineHeight: 1.5 }}>{p.visuals[v.key] || ""}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Script Table */}
        {hasScripts && (
          <div style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#E8ECF4" }}>Script Table ({p.scriptTable.length} ads)</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#F59E0B" }} />
                <span style={{ fontSize: 11, color: "#5A6B85" }}>Has your feedback</span>
              </div>
            </div>

            <div style={{ overflowX: "auto", background: "#131825", borderRadius: 12, border: "1px solid #1E2A3A" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {SCRIPT_COLUMNS.map(col => (
                      <th key={col.key} style={{
                        padding: "12px 14px", textAlign: "left", fontWeight: 700,
                        color: "#5A6B85", borderBottom: "2px solid #1E2A3A",
                        fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
                        minWidth: col.width, whiteSpace: "nowrap",
                      }}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.scriptTable.map((row, rowIdx) => {
                    const mc = MOTIVATOR_COLORS[row.motivatorType] || MOTIVATOR_COLORS.toward;
                    return (
                      <tr key={row.id || rowIdx}>
                        {SCRIPT_COLUMNS.map(col => {
                          const isVideoName = col.key === "videoName";
                          const cellId = row.id || row.videoName;
                          const feedback = getFeedback(cellId, col.key);
                          const isActive = feedbackCell?.cellId === cellId && feedbackCell?.column === col.key;

                          const rowFeedback = isVideoName ? getFeedback(cellId, "_row") : null;
                          const isRowFbActive = isVideoName && feedbackCell?.cellId === cellId && feedbackCell?.column === "_row";

                          return (
                            <td
                              key={col.key}
                              onClick={() => {
                                if (isVideoName) {
                                  setFeedbackCell({ cellId, column: "_row" });
                                  setFeedbackText(rowFeedback?.text || "");
                                } else {
                                  setFeedbackCell({ cellId, column: col.key });
                                  setFeedbackText(feedback?.text || "");
                                }
                              }}
                              style={{
                                padding: "12px 14px",
                                borderBottom: "1px solid #1E2A3A",
                                background: isVideoName ? mc.bg : (isActive ? "rgba(0,130,250,0.08)" : "transparent"),
                                color: isVideoName ? mc.fg : "#C8D2DE",
                                fontWeight: isVideoName ? 700 : 400,
                                cursor: "pointer",
                                verticalAlign: "top",
                                lineHeight: 1.6,
                                minWidth: col.width,
                                position: "relative",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                                {feedback && !isVideoName && (
                                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#F59E0B", flexShrink: 0, marginTop: 4 }} />
                                )}
                                {rowFeedback && isVideoName && (
                                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#F59E0B", flexShrink: 0, marginTop: 4 }} />
                                )}
                                <span>{row[col.key] || ""}</span>
                              </div>
                              {isVideoName && isRowFbActive && (
                                <div onClick={e => e.stopPropagation()} style={{
                                  marginTop: 10, padding: 12, background: "#0B0F1A",
                                  border: "1px solid #0082FA", borderRadius: 8,
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                                }}>
                                  <div style={{ fontSize: 11, color: "#5A6B85", marginBottom: 6 }}>
                                    {rowFeedback ? "Update feedback for this video:" : "Leave feedback for this entire video:"}
                                  </div>
                                  <textarea
                                    autoFocus
                                    value={feedbackText}
                                    onChange={e => setFeedbackText(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Escape") setFeedbackCell(null); }}
                                    placeholder="e.g. This whole ad concept doesn't resonate with our brand"
                                    rows={3}
                                    style={{
                                      width: "100%", padding: "8px 10px", borderRadius: 6,
                                      border: "1px solid #1E2A3A", background: "#131825",
                                      color: "#E8ECF4", fontSize: 12, fontFamily: "inherit",
                                      outline: "none", resize: "vertical", boxSizing: "border-box",
                                    }}
                                  />
                                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                                    <button onClick={submitFeedback} disabled={!feedbackText.trim()} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#0082FA", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: !feedbackText.trim() ? 0.5 : 1 }}>Submit</button>
                                    <button onClick={() => setFeedbackCell(null)} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #1E2A3A", background: "transparent", color: "#5A6B85", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                                  </div>
                                  {rowFeedback && <div style={{ marginTop: 8, fontSize: 10, color: "#5A6B85" }}>Last submitted: {new Date(rowFeedback.submittedAt).toLocaleString("en-AU")}</div>}
                                </div>
                              )}

                              {isActive && (
                                <div onClick={e => e.stopPropagation()} style={{
                                  marginTop: 10, padding: 12, background: "#0B0F1A",
                                  border: "1px solid #0082FA", borderRadius: 8,
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                                }}>
                                  <div style={{ fontSize: 11, color: "#5A6B85", marginBottom: 6 }}>
                                    {feedback ? "Update your feedback:" : "Leave feedback:"}
                                  </div>
                                  <textarea
                                    autoFocus
                                    value={feedbackText}
                                    onChange={e => setFeedbackText(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Escape") setFeedbackCell(null); }}
                                    placeholder="e.g. Can we make this less aggressive?"
                                    rows={3}
                                    style={{
                                      width: "100%", padding: "8px 10px", borderRadius: 6,
                                      border: "1px solid #1E2A3A", background: "#131825",
                                      color: "#E8ECF4", fontSize: 12, fontFamily: "inherit",
                                      outline: "none", resize: "vertical", boxSizing: "border-box",
                                    }}
                                  />
                                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                                    <button
                                      onClick={submitFeedback}
                                      disabled={!feedbackText.trim()}
                                      style={{
                                        padding: "6px 14px", borderRadius: 6, border: "none",
                                        background: "#0082FA", color: "#fff", fontSize: 12,
                                        fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                                        opacity: !feedbackText.trim() ? 0.5 : 1,
                                      }}
                                    >Submit</button>
                                    <button
                                      onClick={() => setFeedbackCell(null)}
                                      style={{
                                        padding: "6px 14px", borderRadius: 6,
                                        border: "1px solid #1E2A3A", background: "transparent",
                                        color: "#5A6B85", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                                      }}
                                    >Cancel</button>
                                  </div>
                                  {feedback && (
                                    <div style={{ marginTop: 8, fontSize: 10, color: "#5A6B85" }}>
                                      Last submitted: {new Date(feedback.submittedAt).toLocaleString("en-AU")}
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!hasScripts && (
          <div style={{ textAlign: "center", padding: 60, color: "#5A6B85" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#9881;</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Scripts are being prepared</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Check back soon.</div>
          </div>
        )}

        <div style={{ marginTop: 40, textAlign: "center", color: "#3A4558", fontSize: 11 }}>
          Powered by <span style={{ color: "#0082FA", fontWeight: 700 }}>Viewix</span>
        </div>
      </div>
    </div>
  );
}
