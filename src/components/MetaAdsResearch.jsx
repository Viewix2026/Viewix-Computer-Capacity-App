// Meta Ads preproduction — new tab-based flow.
//
// Phase 2 of the Meta Ads rebuild. Renders a tab bar matching Social
// Organic's structure but tailored for Meta Ads: Brand Truth → Format
// Research (FB Ad Library) → Video Review → Shortlist → Selection →
// Scripting. Only Brand Truth is live in this phase; the other five
// tabs render a "coming soon" placeholder with the intended summary.
//
// The parent (Preproduction.jsx) decides whether to render this or the
// legacy inline Meta Ads UI based on whether the project has a `tab`
// field. Webhook-deal-won now sets tab: "brandTruth" on all new metaAds
// records, so everything going forward lands here. Legacy records
// (those with scriptTable already generated but no tab field) keep the
// old single-page UI until their Scripting tab is ready to display
// them natively.

import { useState, useEffect, useRef } from "react";
import { fbSet, fbUpdate } from "../firebase";

// Tab registry — edit this list + a switch arm below to add/rename
// tabs. Each entry has a key (matches project.tab), label (shown in
// the tab bar), num (step number), and prev (the approval key that
// must be set before this tab unlocks — null for the first step).
export const META_TABS = [
  { key: "brandTruth",  label: "Brand Truth",     num: 1, prev: null },
  { key: "research",    label: "Ad Library",      num: 2, prev: "brandTruth" },
  { key: "videoReview", label: "Video Review",    num: 3, prev: "research" },
  { key: "shortlist",   label: "Shortlist",       num: 4, prev: "videoReview" },
  { key: "select",      label: "Selection",       num: 5, prev: "shortlist" },
  { key: "script",      label: "Scripting",       num: 6, prev: "select" },
];

function effectiveTab(project) {
  return project?.tab || "brandTruth";
}

export function MetaAdsResearch({ project, onBack, onPatch, onDelete }) {
  const tab = effectiveTab(project);
  const approvals = project?.approvals || {};

  const btn = (key) => {
    const t = META_TABS.find(x => x.key === key);
    if (!t) return null;
    const isActive = tab === key;
    const isDone = !!approvals[key];
    return (
      <button
        key={key}
        onClick={() => onPatch({ tab: key })}
        title={`Go to ${t.label}`}
        style={{
          flex: 1, minWidth: 110, padding: "8px 12px", borderRadius: 6,
          border: "none",
          background: isActive ? "var(--accent)" : "transparent",
          color: isActive ? "#fff" : isDone ? "#22C55E" : "var(--fg)",
          fontSize: 12, fontWeight: 700, cursor: "pointer",
          fontFamily: "inherit", opacity: 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          whiteSpace: "nowrap",
        }}>
        <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", opacity: 0.7 }}>
          {isDone ? "✓" : t.num}
        </span>
        {t.label}
      </button>
    );
  };

  return (
    <div>
      {/* Header — back button, company name, status pills */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button onClick={onBack}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            ← All Meta Ads projects
          </button>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)" }}>{project.companyName}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              Meta Ads · {project.packageTier || "(no package tier)"}
              {project.numberOfVideos ? ` · ${project.numberOfVideos} ads` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {project.status === "archived" && (
            <span style={{ padding: "3px 10px", fontSize: 10, fontWeight: 800, background: "rgba(90,107,133,0.2)", color: "var(--muted)", borderRadius: 3, letterSpacing: "0.04em" }}>ARCHIVED</span>
          )}
          {onDelete && (
            <button onClick={onDelete}
              style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "#EF4444", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              Delete project
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, overflowX: "auto" }}>
        {META_TABS.map(s => btn(s.key))}
      </div>

      {tab === "brandTruth" && (
        <BrandTruthStep project={project} onPatch={onPatch} />
      )}
      {tab === "research" && (
        <ResearchStep project={project} onPatch={onPatch} />
      )}
      {tab === "videoReview" && (
        <ComingSoonTab tabNum={3} title="Video Review"
          hint="Producer ticks / crosses each scraped or pasted ad to decide which go to the shortlist." />
      )}
      {tab === "shortlist" && (
        <ComingSoonTab tabNum={4} title="Shortlist"
          hint="Group ticked ads by format (Hook style, motivator angle, scene type). Add promising formats to the Meta Ads Format Library." />
      )}
      {tab === "select" && (
        <ComingSoonTab tabNum={5} title="Selection"
          hint="Pick the exact Meta Ads Format Library entries to script for this shoot. Pulls from shortlist + global Meta Ads library (including Hormozi)." />
      )}
      {tab === "script" && (
        <ComingSoonTab tabNum={6} title="Scripting"
          hint="Generate the full Hormozi-style script table (motivators × audience awareness × the 7-column blueprint) using the selected formats." />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 1 — Brand Truth
// ────────────────────────────────────────────────────────────────
// Meta Ads Brand Truth captures everything the Scripting tab (Phase 6)
// needs to generate the Hormozi-style motivators + 7-column script
// blueprint. Data lives at /preproduction/metaAds/{id}/brandTruth/*
// so it sits alongside the legacy top-level brandAnalysis / motivators
// / scriptTable fields without colliding.
function BrandTruthStep({ project, onPatch }) {
  const bt = project?.brandTruth?.fields || {};
  const [transcript, setTranscript] = useState(project?.brandTruth?.transcript || "");
  const [producerNotes, setProducerNotes] = useState(project?.brandTruth?.producerNotes || "");

  // Debounced writes for transcript + notes so the producer can type
  // without fighting the network. 500ms matches Social Organic's
  // Brand Truth step.
  useEffect(() => {
    if (transcript === (project?.brandTruth?.transcript || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/transcript`, transcript);
    }, 500);
    return () => clearTimeout(t);
  }, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (producerNotes === (project?.brandTruth?.producerNotes || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/producerNotes`, producerNotes);
    }, 500);
    return () => clearTimeout(t);
  }, [producerNotes]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateField = (fieldKey, value) => {
    fbSet(`/preproduction/metaAds/${project.id}/brandTruth/fields/${fieldKey}`, value);
  };

  const approve = () => {
    fbSet(`/preproduction/metaAds/${project.id}/approvals/brandTruth`, new Date().toISOString());
    onPatch({ tab: "research" });
  };

  const approvals = project?.approvals || {};
  const isApproved = !!approvals.brandTruth;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Brand Truth</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
          Capture everything the script generator needs: who this brand is, what they sell, who they're selling to, and what proof they've got. This replaces the single-shot onboarding transcript → generate-everything flow we used to use; you can still paste a transcript below and it'll feed into the Scripting step.
        </div>
      </div>

      {/* Paired transcript + producer notes at the top. Claude will
          read both when generating scripts in tab 6. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <FieldBox label="Onboarding transcript (optional)" hint="Paste the Fathom / meeting transcript from the client kickoff.">
          <textarea value={transcript} onChange={e => setTranscript(e.target.value)} rows={8} placeholder="Paste the full transcript here..."
            style={textareaSt} />
        </FieldBox>
        <FieldBox label="Producer notes (optional)" hint="Anything not in the transcript: gut reads, follow-up questions, extra context from emails.">
          <textarea value={producerNotes} onChange={e => setProducerNotes(e.target.value)} rows={8} placeholder="Notes for the script generator or future you..."
            style={textareaSt} />
        </FieldBox>
      </div>

      {/* Core brand fields — saved on blur so pasting / typing doesn't
          round-trip Firebase per keystroke. Each field writes its own
          leaf path so two producers editing different fields can't
          overwrite each other. */}
      <div style={{ display: "grid", gap: 14 }}>
        <BrandField label="Brand Truths" hint="What's actually true about this business? Not marketing fluff — the real version."
          fieldKey="brandTruths" initial={bt.brandTruths} onSave={updateField} />
        <BrandField label="Product / Offer" hint="What exactly is being sold in these ads? Be specific about the deliverable, format, and price point."
          fieldKey="productOffer" initial={bt.productOffer} onSave={updateField} />
        <BrandField label="Unique Value Proposition" hint="What makes this different from every other agency / provider in the space?"
          fieldKey="uniqueValueProp" initial={bt.uniqueValueProp} onSave={updateField} />
        <BrandField label="Target Customer" hint="Who is seeing these ads? Demographic + psychographic. Business owners 30-50 in trades, first-time founders, existing 7-figure ecomm brands — specifics."
          fieldKey="targetCustomer" initial={bt.targetCustomer} onSave={updateField} />
        <BrandField label="Pain Points" hint="What are they struggling with right now? What keeps them up at night about this problem?"
          fieldKey="painPoints" initial={bt.painPoints} onSave={updateField} />
        <BrandField label="Desired Outcome" hint="What do they want to be true after buying? The toward state — aspirational, concrete."
          fieldKey="desiredOutcome" initial={bt.desiredOutcome} onSave={updateField} />
        <BrandField label="Proof Points" hint="Specific case studies, numbers, named clients, testimonials the scripts can cite. Vague proof = weak ads."
          fieldKey="proofPoints" initial={bt.proofPoints} onSave={updateField} />
        <BrandField label="Competitors / Category" hint="Who are they up against? What does the prospect's Instagram look like filled with competitor content?"
          fieldKey="competitors" initial={bt.competitors} onSave={updateField} />
      </div>

      {/* Approve → unlocks Tab 2 */}
      <div style={{ marginTop: 20, padding: "14px 18px", background: "var(--card)", border: `1px solid ${isApproved ? "rgba(34,197,94,0.4)" : "var(--border)"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {isApproved
            ? <>Brand Truth approved {approvals.brandTruth ? `on ${new Date(approvals.brandTruth).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}. Move to Ad Library research next.</>
            : "When you're happy this captures the brand accurately, approve to unlock the next step."}
        </div>
        <button onClick={approve}
          style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isApproved ? "#22C55E" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          {isApproved ? "→ Ad Library" : "Approve Brand Truth"}
        </button>
      </div>
    </div>
  );
}

// Uncontrolled textarea that only writes to Firebase on blur — the
// React state is local until the producer tabs out or clicks elsewhere.
// Keeps the per-keystroke cost to local only.
function BrandField({ label, hint, fieldKey, initial, onSave }) {
  const [value, setValue] = useState(initial || "");
  const lastSavedRef = useRef(initial || "");

  // Keep local state in sync if Firebase updates from another tab.
  useEffect(() => {
    if ((initial || "") !== lastSavedRef.current) {
      setValue(initial || "");
      lastSavedRef.current = initial || "";
    }
  }, [initial]);

  const onBlur = () => {
    const trimmed = value;
    if (trimmed === lastSavedRef.current) return;
    lastSavedRef.current = trimmed;
    onSave(fieldKey, trimmed);
  };

  return (
    <FieldBox label={label} hint={hint}>
      <textarea value={value} onChange={e => setValue(e.target.value)} onBlur={onBlur} rows={3}
        style={textareaSt} />
    </FieldBox>
  );
}

function FieldBox({ label, hint, children }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--fg)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
        {label}
      </label>
      {hint && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>{hint}</div>}
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 2 — Ad Library Research
// ────────────────────────────────────────────────────────────────
// Collects competitor ad inspiration two ways:
//   (a) Scrape FB Ad Library by page-name or page-URL list. Producer
//       sets date range + country; we kick off an Apify actor run that
//       reports back ad metadata (creative, copy, headline, CTA, run
//       period). See api/meta-ads.js for the actor + input schema.
//   (b) Manual paste — producer pastes individual FB Ad Library URLs,
//       we extract the ad id and store as a lightweight record.
// Both sources land in /preproduction/metaAds/{id}/adLibraryResearch/ads
// keyed by adId, distinguished by `source` ("apify" | "manual").
//
// Tab 3 (Video Review) iterates this dictionary so producers can
// tick/cross each ad. Nothing here writes to Video Review directly —
// that routing happens at the Video Review level.
function ResearchStep({ project, onPatch }) {
  const research = project.adLibraryResearch || {};
  const ads = research.ads || {};
  const adList = Object.values(ads).filter(a => a && a.id);
  const approvals = project.approvals || {};
  const isApproved = !!approvals.research;
  const scrapeStatus = research.scrapeStatus || "idle";
  const isRunning = scrapeStatus === "running";

  // Inputs — local state while editing, persisted on save-handle /
  // run-scrape so producers don't have their partial typing written
  // mid-keystroke.
  const inputs = research.inputs || {};
  const [pageInput, setPageInput] = useState("");
  const [country, setCountry] = useState(inputs.country || "AU");
  const [dateFrom, setDateFrom] = useState(inputs.dateRange?.from || "");
  const [dateTo, setDateTo] = useState(inputs.dateRange?.to || "");
  const [manualUrl, setManualUrl] = useState("");
  const [scrapeError, setScrapeError] = useState(null);
  const [manualError, setManualError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const pages = Array.isArray(inputs.pages) ? inputs.pages : [];

  const patchInputs = (patch) => {
    fbSet(`/preproduction/metaAds/${project.id}/adLibraryResearch/inputs`, { ...inputs, ...patch });
  };

  const addPage = () => {
    const trimmed = pageInput.trim();
    if (!trimmed) return;
    // Accept either a bare page name or a facebook.com/... URL. Normalise
    // to a displayable name + keep the original string around for the
    // scraper (the Apify actor accepts both handle names and URLs).
    const pageName = trimmed.replace(/^https?:\/\/(?:www\.)?facebook\.com\//i, "").replace(/\/$/, "").split(/[?#]/)[0];
    if (pages.some(p => p.pageUrl === trimmed || p.pageName.toLowerCase() === pageName.toLowerCase())) {
      setPageInput("");
      return;
    }
    const next = [...pages, { pageName, pageUrl: trimmed.startsWith("http") ? trimmed : "" }];
    patchInputs({ pages: next });
    setPageInput("");
  };
  const removePage = (pageName) => {
    patchInputs({ pages: pages.filter(p => p.pageName !== pageName) });
  };

  const runScrape = async () => {
    setScrapeError(null);
    if (pages.length === 0) { setScrapeError("Add at least one competitor page before scraping."); return; }
    patchInputs({ country, dateRange: { from: dateFrom, to: dateTo } });
    setSubmitting(true);
    try {
      const r = await fetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "scrapeAdLibrary",
          projectId: project.id,
          pages,
          country,
          dateRange: { from: dateFrom, to: dateTo },
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      // Firebase listener will rehydrate with the scrape status + ads as they arrive.
    } catch (e) {
      setScrapeError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const addManualAd = async () => {
    setManualError(null);
    const trimmed = manualUrl.trim();
    if (!trimmed) return;
    // Extract ad id from a FB Ad Library URL. Common shapes:
    //   https://www.facebook.com/ads/library/?id=123456789
    //   https://www.facebook.com/ads/library/?active_status=...&id=123
    let adId = null;
    try {
      const u = new URL(trimmed);
      adId = u.searchParams.get("id");
    } catch {}
    if (!adId) {
      setManualError("Couldn't find an ad id in that URL. Paste the full FB Ad Library URL with the id= query param.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "addManualAd", projectId: project.id, adUrl: trimmed, adId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      setManualUrl("");
    } catch (e) {
      setManualError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const removeAd = (adId) => {
    if (!window.confirm("Remove this ad from the research pool?")) return;
    fbSet(`/preproduction/metaAds/${project.id}/adLibraryResearch/ads/${adId}`, null);
  };

  const approve = () => {
    fbSet(`/preproduction/metaAds/${project.id}/approvals/research`, new Date().toISOString());
    onPatch({ tab: "videoReview" });
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Ad Library Research</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
          Pull competitor ads two ways: scrape the Facebook Ad Library by page, or paste individual ad URLs. Both sources flow into the Video Review tab next, where you tick the ones worth shortlisting.
        </div>
      </div>

      {/* Scrape input panel */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 10 }}>Scrape Facebook Ad Library</div>

        {/* Page list */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 6 }}>Competitor Pages</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input type="text" value={pageInput} onChange={e => setPageInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addPage(); } }}
              placeholder="Page name or facebook.com/pagename URL"
              style={{ ...textareaSt, padding: "8px 12px", fontSize: 13 }} />
            <button onClick={addPage}
              style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              + Add
            </button>
          </div>
          {pages.length > 0 ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {pages.map(p => (
                <span key={p.pageName} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 11, color: "var(--fg)" }}>
                  {p.pageName}
                  <button onClick={() => removePage(p.pageName)} title="Remove"
                    style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>No pages yet. Add a few competitor page names to scrape their active ads.</div>
          )}
        </div>

        {/* Date range + country */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 }}>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ ...textareaSt, padding: "8px 12px", fontSize: 13, colorScheme: "dark" }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 }}>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ ...textareaSt, padding: "8px 12px", fontSize: 13, colorScheme: "dark" }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 }}>Country</label>
            <select value={country} onChange={e => setCountry(e.target.value)}
              style={{ ...textareaSt, padding: "8px 12px", fontSize: 13 }}>
              <option value="AU">AU · Australia</option>
              <option value="US">US · United States</option>
              <option value="GB">GB · United Kingdom</option>
              <option value="NZ">NZ · New Zealand</option>
              <option value="CA">CA · Canada</option>
              <option value="ALL">All countries</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button onClick={runScrape} disabled={submitting || isRunning || pages.length === 0}
            style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: (isRunning || pages.length === 0) ? "#374151" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: (submitting || isRunning || pages.length === 0) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1 }}>
            {isRunning ? "Scrape running…" : submitting ? "Submitting…" : "Run scrape"}
          </button>
          {scrapeStatus === "done" && research.scrapeFinishedAt && (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>Last scrape finished {new Date(research.scrapeFinishedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
          )}
          {scrapeStatus === "error" && research.scrapeError && (
            <span style={{ fontSize: 11, color: "#EF4444" }}>Error: {research.scrapeError}</span>
          )}
        </div>
        {scrapeError && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
            {scrapeError}
          </div>
        )}
      </div>

      {/* Manual URL paste panel */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Or paste an ad URL manually</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
          Paste a full FB Ad Library URL (the one with <code style={{ background: "var(--bg)", padding: "1px 5px", borderRadius: 3 }}>?id=...</code>) to add a single ad without running a scrape. Useful when you've already found a specific ad you want to reference.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" value={manualUrl} onChange={e => setManualUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addManualAd(); } }}
            placeholder="https://www.facebook.com/ads/library/?id=1234567890"
            style={{ ...textareaSt, padding: "8px 12px", fontSize: 13 }} />
          <button onClick={addManualAd} disabled={submitting || !manualUrl.trim()}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 12, fontWeight: 700, cursor: (submitting || !manualUrl.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap", opacity: !manualUrl.trim() ? 0.5 : 1 }}>
            + Add
          </button>
        </div>
        {manualError && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
            {manualError}
          </div>
        )}
      </div>

      {/* Ad list */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span>Research pool</span>
          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500, fontFamily: "'JetBrains Mono',monospace" }}>
            {adList.length} ad{adList.length === 1 ? "" : "s"}
          </span>
        </div>
        {adList.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", fontSize: 12, color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 10 }}>
            {isRunning ? "Scrape running — ads will appear here as they're pulled." : "No ads yet. Run a scrape above, or paste individual URLs."}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {adList.map(ad => <AdCard key={ad.id} ad={ad} onRemove={() => removeAd(ad.id)} />)}
          </div>
        )}
      </div>

      {/* Approve → unlocks Video Review */}
      <div style={{ padding: "14px 18px", background: "var(--card)", border: `1px solid ${isApproved ? "rgba(34,197,94,0.4)" : "var(--border)"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {isApproved
            ? "Research approved. Move to Video Review next."
            : adList.length < 3
              ? `You've got ${adList.length} ad${adList.length === 1 ? "" : "s"} in the pool — usually 10+ is a good minimum for Video Review. Add more before approving.`
              : "When you've got a good pool of ads to review, approve to unlock Video Review."}
        </div>
        <button onClick={approve} disabled={adList.length === 0}
          style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isApproved ? "#22C55E" : adList.length === 0 ? "#374151" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: adList.length === 0 ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
          {isApproved ? "→ Video Review" : "Approve Research"}
        </button>
      </div>
    </div>
  );
}

// Compact card for a single ad. Shows thumbnail if the scrape got one,
// otherwise a placeholder + page name + ad snippet. Manual entries
// typically only have an ad URL until the producer visits it — they
// render with a FB-logo placeholder.
function AdCard({ ad, onRemove }) {
  const thumb = ad.thumbnailUrl || ad.snapshotUrl || null;
  const pageName = ad.pageName || ad.advertiserName || "Unknown advertiser";
  const body = (ad.bodyText || ad.headline || "").slice(0, 160);
  const adLink = ad.adUrl || (ad.adId ? `https://www.facebook.com/ads/library/?id=${ad.adId}` : null);

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", aspectRatio: "9 / 16", background: "#0F1520", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {thumb ? (
          <img src={thumb} alt={pageName} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
        ) : (
          <div style={{ fontSize: 32, color: "#374151" }}>📘</div>
        )}
        <div style={{ position: "absolute", top: 6, left: 6, padding: "3px 8px", background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {ad.source === "manual" ? "MANUAL" : "SCRAPED"}
        </div>
        {onRemove && (
          <button onClick={onRemove} title="Remove from research pool"
            style={{ position: "absolute", top: 6, right: 6, padding: "2px 8px", background: "rgba(0,0,0,0.6)", color: "#fff", border: "none", borderRadius: 3, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>×</button>
        )}
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pageName}</div>
        {body && (
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {body}{(ad.bodyText || "").length > 160 ? "…" : ""}
          </div>
        )}
        {adLink && (
          <a href={adLink} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", marginTop: 6, fontSize: 10, color: "var(--accent)", textDecoration: "none", fontFamily: "'JetBrains Mono',monospace" }}>
            View on FB Ad Library →
          </a>
        )}
      </div>
    </div>
  );
}

function ComingSoonTab({ tabNum, title, hint }) {
  return (
    <div style={{ padding: 50, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.08em", marginBottom: 8 }}>TAB {tabNum}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg)", marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 560, margin: "0 auto 16px", lineHeight: 1.5 }}>{hint}</div>
      <div style={{ fontSize: 11, color: "#F59E0B", fontWeight: 700 }}>Coming soon</div>
    </div>
  );
}

const textareaSt = {
  width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)",
  background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, lineHeight: 1.5,
  fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box",
};
