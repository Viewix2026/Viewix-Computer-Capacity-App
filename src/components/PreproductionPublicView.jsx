import { useState, useEffect, useRef } from "react";
import { initFB, onFB, fbSet, fbListen, fbGetOnce, signInAnonymouslyForPublic } from "../firebase";
import { Logo } from "./Logo";
import { logoBg } from "../utils";
import { ClientReview } from "./preproduction/ClientReview";

const MOTIVATOR_COLORS = {
  toward: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.25)", fg: "#22C55E", label: "Toward" },
  awayFrom: { bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.25)", fg: "#EF4444", label: "Away From" },
  triedBefore: { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.25)", fg: "#3B82F6", label: "Tried Before" },
};

// Tier colours come from the canonical list at api/_tiers.js so adding
// a new package tier is a single-place change.
import { tierColor } from "../config";

// Keys must match the actual scriptTable field names written by
// api/meta-ads.js:handleScriptGenerate. The pre-rename column names
// (explainThePain, theOffer, whyTheOffer, metaAdHeadline, metaAdCopy)
// were left here when the schema shifted, so the public view was
// rendering blank for those columns even though the data was right
// there under the new keys.
const SCRIPT_COLUMNS = [
  { key: "videoName", label: "Video Name", width: 140 },
  { key: "hook", label: "Hook", width: 200 },
  { key: "explainPain", label: "Explain the Pain", width: 180 },
  { key: "results", label: "Results", width: 180 },
  { key: "offer", label: "The Offer", width: 200 },
  { key: "whyOffer", label: "Why the Offer", width: 180 },
  { key: "cta", label: "CTA", width: 150 },
  { key: "headline", label: "Meta Ad Headline", width: 160 },
  { key: "adCopy", label: "Meta Ad Copy", width: 240 },
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
    // Track every listener + timer so the cleanup can tear them all
    // down on unmount. Previously this effect attached up to 4 Firebase
    // listeners with NO cleanup and a bare setTimeout that also leaked —
    // every share-link visit pinned the whole preproduction tree in
    // memory for the life of the tab.
    const unsubs = [];
    let cancelled = false;
    let fallbackTimer = null;
    onFB(async () => {
      try { await signInAnonymouslyForPublic(); }
      catch (e) { console.warn("Anonymous auth failed, continuing:", e.message); }
      if (cancelled) return;

      // Single per-record listener — the preproduction collections now
      // require a role claim at the root, so we resolve via
      // /api/resolve-short-id (returns {id, type}) and attach exactly
      // one listener at the resolved path. The previous dual-listener
      // pattern could flip projectType under us if a shortId existed in
      // both collections; this resolves that asymmetry too.
      const attachPerRecordListener = (type, id) => {
        unsubs.push(fbListen(`/preproduction/${type}/${id}`, (data) => {
          if (data) { setProject(data); setProjectType(type); setLoading(false); }
        }));
      };

      if (projectId) {
        // Caller knows the id but not the type — probe metaAds, then
        // socialOrganic. Per-record reads are role-free under the new
        // rules, so this works for anonymous clients. fbGetOnce gives
        // us a clean Promise-based probe (no listener-then-off dance).
        for (const t of ["metaAds", "socialOrganic"]) {
          if (cancelled) return;
          let snap = null;
          try {
            // eslint-disable-next-line no-await-in-loop
            snap = await fbGetOnce(`/preproduction/${t}/${projectId}`);
          } catch { /* rules denial / network — try next type */ }
          if (snap) {
            if (cancelled) return;
            attachPerRecordListener(t, projectId);
            break;
          }
        }
      } else if (shortId) {
        try {
          const r = await fetch(`/api/resolve-short-id?type=preproduction&shortId=${encodeURIComponent(shortId)}`);
          if (cancelled) return;
          if (!r.ok) {
            // 404 falls through to the loading-timeout path which
            // surfaces the "not found" error state.
            setLoading(false);
            return;
          }
          const { id, type } = await r.json();
          if (cancelled || !id || !type) { setLoading(false); return; }
          attachPerRecordListener(type, id);
        } catch (e) {
          console.warn("resolve-short-id failed:", e.message);
          setLoading(false);
        }
      }
      // Loading timeout — 3s should be more than enough to see if the
      // resolved listener has data. After that, show the "not found"
      // error state. Cleared inline once any path resolves.
      fallbackTimer = setTimeout(() => { setLoading(false); }, 3000);
    });
    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      // notifyTimer fires 2 minutes after the last feedback submit to
      // ping /api/preproduction. Without this clear, a client who
      // submits then closes the tab triggers a stray network call
      // against a stale project — and the closure still holds the
      // project ref, so it isn't even safely a no-op.
      if (notifyTimer.current) { clearTimeout(notifyTimer.current); notifyTimer.current = null; }
      unsubs.forEach(u => { try { u(); } catch {} });
    };
  }, [projectId, shortId]);

  // Resolve account logo
  useEffect(() => {
    if (!project?.companyName) return;
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen("/accounts", (acctData) => {
        if (!acctData) return;
        const nameLC = project.companyName.toLowerCase();
        const match = Object.values(acctData).find(a => a && (a.companyName || "").toLowerCase() === nameLC);
        setAccountLogo(match?.logoUrl || null);
        setAccountLogoBg(match?.logoBg || "white");
      });
    });
    return () => { cancelled = true; unsub(); };
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

  // Social Organic projects use the redesigned ClientReview cockpit —
  // section verdicts, per-script reactions, threaded comments, explicit
  // Submit. The metaAds branch below is unchanged.
  if (projectType === "socialOrganic") {
    return (
      <ClientReview
        project={project}
        projectId={project?.id || projectId}
        accountLogo={accountLogo}
        accountLogoBg={accountLogoBg}
      />
    );
  }


  const p = project;
  const hasScripts = p.scriptTable && p.scriptTable.length > 0;
  // Local rename — the imported helper is `tierColor` and we want a
  // single object here for the badge below.
  const tc = tierColor(p.packageTier);

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
          <span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: tc.bg, color: tc.fg, textTransform: "capitalize" }}>
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
