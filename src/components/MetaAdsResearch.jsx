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
import { authFetch, fbSet, fbUpdate, fbListenSafe } from "../firebase";
import { CellRewriteModal, EditableField } from "./shared/CellRewriteModal";
import { SherpaStatusRow } from "./shared/SherpaStatusRow";
import { matchSherpaForName, preproductionShareUrl } from "../utils";

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

export function MetaAdsResearch({ project, accounts, clients, sherpaCacheMeta, onBack, onPatch, onDelete }) {
  const tab = effectiveTab(project);
  const approvals = project?.approvals || {};
  // Resolve the /clients record that owns this project's Sherpa Google Doc.
  // Same fuzzy-match logic the server uses, so the status row reflects the
  // same client record the AI handlers will read from.
  const linkedClient = matchSherpaForName(project?.companyName, clients);
  const sherpaMeta = linkedClient ? (sherpaCacheMeta?.[linkedClient.id] || null) : null;

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
        <BrandTruthStep
          project={project}
          linkedClient={linkedClient}
          sherpaMeta={sherpaMeta}
          onPatch={onPatch}
        />
      )}
      {tab === "research" && (
        <ResearchStep project={project} onPatch={onPatch} />
      )}
      {tab === "videoReview" && (
        <VideoReviewStep project={project} onPatch={onPatch} />
      )}
      {tab === "shortlist" && (
        <ShortlistStep project={project} onPatch={onPatch} />
      )}
      {tab === "select" && (
        <SelectStep project={project} onPatch={onPatch} />
      )}
      {tab === "script" && (
        <ScriptStep project={project} onPatch={onPatch} />
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
const META_BRAND_TRUTH_FIELDS = [
  { key: "brandTruths",     label: "Brand Truths",            hint: "What's actually true about this business? Not marketing fluff — the real version." },
  { key: "productOffer",    label: "Product / Offer",         hint: "What exactly is being sold in these ads? Deliverable, format, price point." },
  { key: "uniqueValueProp", label: "Unique Value Proposition", hint: "What makes this different from every other agency / provider in the space?" },
  { key: "targetCustomer",  label: "Target Customer",          hint: "Who is seeing these ads? Demographic + psychographic. Be specific." },
  { key: "painPoints",      label: "Pain Points",              hint: "What are they struggling with right now? What keeps them up at night?" },
  { key: "desiredOutcome",  label: "Desired Outcome",          hint: "What do they want to be true after buying? The toward state — aspirational, concrete." },
  { key: "proofPoints",     label: "Proof Points",             hint: "Specific case studies, numbers, named clients, testimonials the scripts can cite." },
  { key: "competitors",     label: "Competitors / Category",   hint: "Who are they up against? What does the prospect's feed look like filled with competitor content?" },
];

function BrandTruthStep({ project, linkedClient, sherpaMeta, onPatch }) {
  const bt = project?.brandTruth || {};
  const fields = bt.fields || {};
  const [transcript, setTranscript] = useState(bt.transcript || "");
  const [producerNotes, setProducerNotes] = useState(bt.producerNotes || "");
  // `processing` is now derived from Firebase (bt.processingAt). When the
  // server starts the Claude call it writes a timestamp; when it finishes
  // it writes null. Means producers can click Begin Processing, navigate
  // away, come back, and the state reflects what the server's actually
  // doing — not whatever React unmounted with.
  // `localProcError` captures network errors client-side so they show
  // even when the Firebase flag returns to null.
  const processingAt = bt.processingAt || null;
  const processing = !!processingAt && (Date.now() - new Date(processingAt).getTime() < 5 * 60 * 1000);
  const [localProcError, setLocalProcError] = useState(null);
  const [rewriteTarget, setRewriteTarget] = useState(null);
  const [refreshingSherpa, setRefreshingSherpa] = useState(false);
  const [sherpaRefreshError, setSherpaRefreshError] = useState(null);

  const refreshSherpa = async () => {
    setSherpaRefreshError(null);
    setRefreshingSherpa(true);
    try {
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refreshSherpa", projectId: project.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      if (d.ok === false && d.error) {
        throw new Error(d.error.message || d.error.code || "Sherpa fetch failed");
      }
      // Firebase listener on /sherpaCacheMeta rehydrates the status row.
    } catch (e) {
      setSherpaRefreshError(e.message);
    } finally {
      setRefreshingSherpa(false);
    }
  };

  // Debounced writes for transcript + notes so the producer can type
  // without fighting the network. 500ms matches Social Organic.
  useEffect(() => {
    if (transcript === (bt.transcript || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/transcript`, transcript);
    }, 500);
    return () => clearTimeout(t);
  }, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (producerNotes === (bt.producerNotes || "")) return;
    const t = setTimeout(() => {
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/producerNotes`, producerNotes);
    }, 500);
    return () => clearTimeout(t);
  }, [producerNotes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Begin Processing — sends transcript + notes to Claude via
  // /api/meta-ads action=generateBrandTruth. Server writes the 8 fields
  // to /preproduction/metaAds/{id}/brandTruth/fields/*, and also sets
  // bt.processingAt (clearing it on completion). Means navigating
  // between tabs during the ~15s Claude call doesn't lose state — the
  // processing indicator lives in Firebase.
  const beginProcessing = async () => {
    setLocalProcError(null);
    try {
      // Flip processingAt on client-side too so the UI snaps to the
      // processing state immediately (don't wait for the server round-
      // trip to mark it). Server overwrites with its own timestamp.
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/processingAt`, new Date().toISOString());
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/transcript`, transcript);
      fbSet(`/preproduction/metaAds/${project.id}/brandTruth/producerNotes`, producerNotes);
      await new Promise(res => setTimeout(res, 150));

      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generateBrandTruth", projectId: project.id }),
      });
      const d = await r.json();
      if (!r.ok) {
        // Server should clear processingAt on its own error path, but
        // mirror it here in case the server died before the finally
        // block (e.g. Vercel timeout).
        fbSet(`/preproduction/metaAds/${project.id}/brandTruth/processingAt`, null);
        throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      }
      // Firebase listener rehydrates fields automatically. Server
      // clears processingAt before responding, so the indicator goes
      // away as soon as the listener picks up the write.
    } catch (e) {
      setLocalProcError(e.message);
    }
  };

  const updateField = (fieldKey, value) => {
    fbSet(`/preproduction/metaAds/${project.id}/brandTruth/fields/${fieldKey}`, value);
  };

  const approve = () => {
    fbSet(`/preproduction/metaAds/${project.id}/approvals/brandTruth`, new Date().toISOString());
    onPatch({ tab: "research" });
  };

  const approvals = project?.approvals || {};
  const isApproved = !!approvals.brandTruth;
  const hasGenerated = !!bt.generatedAt;
  const canProcess = transcript.trim().length > 0;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Brand Truth</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
          Paste the pre-production meeting transcript plus any producer notes, then click <strong>Begin Processing</strong>. Claude reads both and fills the 8 brand fields below with bullet-pointed truths drawn directly from the transcript. Edit any cell after generation to refine.
        </div>
      </div>

      {/* Input card: transcript + notes + Begin Processing */}
      <div style={{ marginBottom: 20, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 18 }}>
        <SherpaStatusRow
          linkedClient={linkedClient}
          meta={sherpaMeta}
          refreshing={refreshingSherpa}
          refreshError={sherpaRefreshError}
          onRefresh={refreshSherpa}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <FieldBox label="Pre-production transcript" hint="Paste the Fathom / meeting transcript from the client kickoff. Required.">
            <textarea value={transcript} onChange={e => setTranscript(e.target.value)} rows={8} placeholder="Paste the full transcript here..."
              style={textareaSt} />
          </FieldBox>
          <FieldBox label="Producer notes (optional)" hint="Anything not in the transcript: gut reads, follow-up questions, extra context from emails.">
            <textarea value={producerNotes} onChange={e => setProducerNotes(e.target.value)} rows={8} placeholder="Notes for the script generator or future you..."
              style={textareaSt} />
          </FieldBox>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            {hasGenerated
              ? <>Generated {new Date(bt.generatedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · click Begin Processing again to regenerate (replaces current fields).</>
              : "Transcript is required. Producer notes are optional but useful."}
          </div>
          <button onClick={beginProcessing}
            disabled={processing || !canProcess}
            style={{ padding: "10px 22px", borderRadius: 8, border: "none", background: processing ? "#4B5563" : (!canProcess ? "#374151" : "var(--accent)"), color: "#fff", fontSize: 13, fontWeight: 700, cursor: (processing || !canProcess) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (processing || !canProcess) ? 0.6 : 1 }}>
            {processing ? "Processing…" : hasGenerated ? "Regenerate Brand Truth" : "Begin Processing"}
          </button>
        </div>
        {localProcError && (
          <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
            {localProcError}
          </div>
        )}
      </div>

      {/* 8 brand fields — populated by Begin Processing, each
          rendered as bullet points via the shared Clickable. Click
          any field to open the CellRewriteModal (AI rewrite OR
          manual edit tabs). */}
      {processing && (
        <div style={{ marginBottom: 14, padding: "14px 18px", background: "rgba(0,130,250,0.08)", border: "1px solid rgba(0,130,250,0.3)", borderRadius: 10, display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--fg)" }}>
          <div style={{ width: 16, height: 16, border: "2px solid rgba(0,130,250,0.3)", borderTopColor: "#0082FA", borderRadius: "50%", animation: "metaSpin 0.8s linear infinite" }} />
          <div>
            <div style={{ fontWeight: 700 }}>Processing…</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Claude is reading the transcript + notes. Usually takes 15–30 seconds. Safe to switch tabs — the fields will populate when ready.</div>
          </div>
          <style>{`@keyframes metaSpin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, display: "grid", gap: 16 }}>
        {META_BRAND_TRUTH_FIELDS.map(f => (
          <EditableField
            key={f.key}
            label={f.label}
            path={f.key}
            value={fields[f.key]}
            multi={true}
            onEdit={(path, label, currentValue) => setRewriteTarget({ path, label, currentValue: currentValue || "" })}
          />
        ))}
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

      {/* Cell-level rewrite modal — opens with two tabs:
              AI — tell Claude what to change
              Manual — edit the raw value
          Both write back to /preproduction/metaAds/{id}/brandTruth/fields/{path}. */}
      {rewriteTarget && (
        <CellRewriteModal
          target={rewriteTarget}
          fbPathPrefix={`/preproduction/metaAds/${project.id}/brandTruth/fields`}
          apiEndpoint="/api/meta-ads"
          apiAction="rewriteBrandTruthField"
          extraPayload={{ projectId: project.id }}
          updatedAtPath={`/preproduction/metaAds/${project.id}/updatedAt`}
          onClose={() => setRewriteTarget(null)}
        />
      )}
    </div>
  );
}

// Uncontrolled textarea that only writes to Firebase on blur — the
// React state is local until the producer tabs out or clicks elsewhere.
// Keeps the per-keystroke cost to local only.
function BrandField({ label, hint, fieldKey, initial, onSave, emptyPlaceholder }) {
  const [value, setValue] = useState(initial || "");
  const lastSavedRef = useRef(initial || "");

  // Keep local state in sync if Firebase updates from another tab —
  // but ONLY when the local value matches the last-saved baseline
  // (i.e. no unsaved edits in progress). Without this, typing a local
  // edit could get clobbered when a concurrent tab saved a different
  // value.
  useEffect(() => {
    const remote = initial || "";
    if (remote === lastSavedRef.current) return;
    setValue(prev => {
      if (prev !== lastSavedRef.current) return prev;  // has unsaved local edit; preserve it
      lastSavedRef.current = remote;
      return remote;
    });
  }, [initial]);

  const onBlur = () => {
    const trimmed = value;
    if (trimmed === lastSavedRef.current) return;
    lastSavedRef.current = trimmed;
    onSave(fieldKey, trimmed);
  };

  return (
    <FieldBox label={label} hint={hint}>
      <textarea value={value} onChange={e => setValue(e.target.value)} onBlur={onBlur} rows={4}
        placeholder={emptyPlaceholder || ""}
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
  // Default date range: last 90 days. Producers almost always want
  // "recent" ads — a ~3 month window gives enough creative variety
  // without drowning the library in stale stuff.
  const defaultFrom = (() => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  })();
  const defaultTo = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(inputs.dateRange?.from || defaultFrom);
  const [dateTo, setDateTo] = useState(inputs.dateRange?.to || defaultTo);
  const [manualUrl, setManualUrl] = useState("");
  const [scrapeError, setScrapeError] = useState(null);
  const [manualError, setManualError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(null);
  // Unmount guard — avoids setState-on-unmount when the producer
  // leaves the Research tab while a scrape or manual-add fetch is
  // still in flight. `inFlightRef` separately gates double-click
  // on the scrape button (see runScrape below).
  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const pages = Array.isArray(inputs.pages) ? inputs.pages : [];

  // fbUpdate merges at the RTDB level — fast consecutive edits
  // (add page → change country) each read `inputs` from the closure,
  // so with fbSet+spread the second call's payload clobbered the
  // first's changes. fbUpdate writes only the provided keys.
  const patchInputs = (patch) => {
    fbUpdate(`/preproduction/metaAds/${project.id}/adLibraryResearch/inputs`, patch);
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

  // AI-suggest competitor pages from the brand-truth transcript +
  // competitors field. Pops the returned names straight into the
  // pages list (deduped against anything already there). Producers
  // can edit the chip list afterwards — this is a head-start, not a
  // lock-in.
  const suggestPages = async () => {
    setSuggestError(null);
    setSuggesting(true);
    try {
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggestAdLibraryInputs", projectId: project.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error || `HTTP ${r.status}`) + (d.detail ? ` — ${d.detail}` : ""));
      const suggestions = Array.isArray(d.pages) ? d.pages : [];
      if (suggestions.length === 0) {
        setSuggestError("Claude didn't pick up any competitor page names from the brand truth. Fill in the Competitors field on the Brand Truth tab and try again.");
        return;
      }
      // Merge into existing pages — dedupe on name (case-insensitive).
      const existingNames = new Set(pages.map(p => p.pageName.toLowerCase()));
      const merged = [...pages];
      for (const s of suggestions) {
        if (!s.pageName) continue;
        if (existingNames.has(s.pageName.toLowerCase())) continue;
        merged.push(s);
        existingNames.add(s.pageName.toLowerCase());
      }
      patchInputs({ pages: merged });
    } catch (e) {
      if (isMountedRef.current) setSuggestError(e.message);
    } finally {
      if (isMountedRef.current) setSuggesting(false);
    }
  };

  const runScrape = async () => {
    if (inFlightRef.current || isRunning) return;  // ref-gate covers the narrow window between click and Firebase propagating scrapeStatus: "running"
    setScrapeError(null);
    if (pages.length === 0) { setScrapeError("Add at least one competitor page before scraping."); return; }
    inFlightRef.current = true;
    patchInputs({ country, dateRange: { from: dateFrom, to: dateTo } });
    setSubmitting(true);
    try {
      const r = await authFetch("/api/meta-ads", {
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
      if (isMountedRef.current) setScrapeError(e.message);
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setSubmitting(false);
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
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "addManualAd", projectId: project.id, adUrl: trimmed, adId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      if (isMountedRef.current) setManualUrl("");
    } catch (e) {
      if (isMountedRef.current) setManualError(e.message);
    } finally {
      if (isMountedRef.current) setSubmitting(false);
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Competitor Pages</label>
            <button onClick={suggestPages} disabled={suggesting}
              title="Extract competitor page names from the brand truth transcript + competitors field"
              style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: suggesting ? "#374151" : "var(--bg)", color: "var(--accent)", fontSize: 11, fontWeight: 700, cursor: suggesting ? "wait" : "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 5 }}>
              {suggesting ? "Suggesting…" : "✨ Suggest with AI"}
            </button>
          </div>
          {suggestError && (
            <div style={{ marginBottom: 8, padding: "8px 10px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
              {suggestError}
            </div>
          )}
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
        {research.scrapeWarning && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(245,158,11,0.08)", borderRadius: 6, border: "1px solid rgba(245,158,11,0.3)", fontSize: 11, color: "#F59E0B" }}>
            ⚠ {research.scrapeWarning}
          </div>
        )}
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
  const thumb = ad.thumbnailUrl || null;
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

// ────────────────────────────────────────────────────────────────
// TAB 3 — Video Review
// ────────────────────────────────────────────────────────────────
// Producer works through every ad in the research pool deciding
// which are worth shortlisting. Mirrors Social Organic's Video Review
// but adapted for the ad-shape records — no overperformance scoring
// (FB Ad Library doesn't expose engagement metrics), so sort is
// limited to recency and source (manual first, then scraped).
function VideoReviewStep({ project, onPatch }) {
  const research = project.adLibraryResearch || {};
  const ads = research.ads || {};
  const review = project.adReview || {};
  const ticked = new Set(review.ticked || []);
  const crossed = new Set(review.crossed || []);
  const approvals = project.approvals || {};
  const isApproved = !!approvals.videoReview;

  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("recent");
  const [maxPerPage, setMaxPerPage] = useState(
    typeof project.adReview?.maxPerPage === "number" ? project.adReview.maxPerPage : 8
  );

  const adList = Object.values(ads).filter(a => a && a.id);

  // Sort — manual entries first (producer cared enough to paste them
  // individually), then by startedRunning desc, then by adId.
  const sorted = (() => {
    const arr = [...adList];
    if (sortBy === "recent") {
      arr.sort((a, b) => {
        if ((a.source === "manual") !== (b.source === "manual")) return a.source === "manual" ? -1 : 1;
        const aD = a.startedRunning ? new Date(a.startedRunning).getTime() : 0;
        const bD = b.startedRunning ? new Date(b.startedRunning).getTime() : 0;
        return bD - aD;
      });
    } else if (sortBy === "advertiser") {
      arr.sort((a, b) => (a.pageName || "").localeCompare(b.pageName || ""));
    }
    return arr;
  })();

  // Per-page cap — prevents one advertiser dominating. Same pattern as
  // Social Organic's Video Review. Zero = unlimited.
  const capped = (() => {
    if (!maxPerPage || maxPerPage <= 0) return sorted;
    const counts = new Map();
    const out = [];
    for (const ad of sorted) {
      const h = (ad.pageName || "unknown").toLowerCase();
      const n = counts.get(h) || 0;
      if (n >= maxPerPage) continue;
      counts.set(h, n + 1);
      out.push(ad);
    }
    return out;
  })();
  const droppedByCap = sorted.length - capped.length;

  // Filter chips
  const filtered = capped.filter(a => {
    if (filter === "ticked") return ticked.has(a.id);
    if (filter === "crossed") return crossed.has(a.id);
    if (filter === "unreviewed") return !ticked.has(a.id) && !crossed.has(a.id);
    return true;
  });

  const setStatus = (adId, status) => {
    const nextTicked = new Set(ticked);
    const nextCrossed = new Set(crossed);
    nextTicked.delete(adId);
    nextCrossed.delete(adId);
    if (status === "ticked") nextTicked.add(adId);
    else if (status === "crossed") nextCrossed.add(adId);
    fbUpdate(`/preproduction/metaAds/${project.id}/adReview`, {
      ticked: Array.from(nextTicked),
      crossed: Array.from(nextCrossed),
    });
  };

  const saveMaxPerPage = (v) => {
    setMaxPerPage(v);
    fbSet(`/preproduction/metaAds/${project.id}/adReview/maxPerPage`, v);
  };

  const approve = () => {
    fbSet(`/preproduction/metaAds/${project.id}/approvals/videoReview`, new Date().toISOString());
    onPatch({ tab: "shortlist" });
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Video Review</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
          Work through each ad in the pool — tick the ones worth shortlisting, cross the rest. Ticked ads carry forward to the Shortlist tab where you'll label them as formats.
        </div>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <FilterChip label={`All (${adList.length})`} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterChip label={`✓ Ticked (${ticked.size})`} active={filter === "ticked"} colour="#22C55E" onClick={() => setFilter("ticked")} />
          <FilterChip label={`✗ Crossed (${crossed.size})`} active={filter === "crossed"} colour="#EF4444" onClick={() => setFilter("crossed")} />
          <FilterChip label={`Unreviewed`} active={filter === "unreviewed"} onClick={() => setFilter("unreviewed")} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }} title="Max ads to show from any single advertiser. Prevents one brand dominating the pool.">
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Max / page</label>
            <select value={maxPerPage} onChange={e => saveMaxPerPage(parseInt(e.target.value, 10))}
              style={{ ...textareaSt, width: "auto", fontSize: 12, padding: "5px 8px" }}>
              <option value={0}>Unlimited</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={8}>8</option>
              <option value={12}>12</option>
              <option value={20}>20</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Sort</label>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              style={{ ...textareaSt, width: "auto", fontSize: 12, padding: "5px 8px" }}>
              <option value="recent">Recency</option>
              <option value="advertiser">Advertiser</option>
            </select>
          </div>
        </div>
      </div>
      {droppedByCap > 0 && (
        <div style={{ marginBottom: 10, fontSize: 11, color: "var(--muted)" }}>
          {droppedByCap} ad{droppedByCap === 1 ? "" : "s"} hidden by per-page cap.
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", fontSize: 12, color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 10 }}>
          {adList.length === 0
            ? "No ads in the research pool yet. Run a scrape or paste URLs on the Ad Library tab first."
            : `No ${filter === "all" ? "" : filter + " "}ads match the current filter.`}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 20 }}>
          {filtered.map(ad => {
            const status = ticked.has(ad.id) ? "ticked" : crossed.has(ad.id) ? "crossed" : null;
            return (
              <ReviewAdCard key={ad.id} ad={ad} status={status}
                onTick={() => setStatus(ad.id, status === "ticked" ? null : "ticked")}
                onCross={() => setStatus(ad.id, status === "crossed" ? null : "crossed")}
              />
            );
          })}
        </div>
      )}

      {/* Approve */}
      <div style={{ padding: "14px 18px", background: "var(--card)", border: `1px solid ${isApproved ? "rgba(34,197,94,0.4)" : "var(--border)"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {isApproved
            ? "Video Review approved. Move to Shortlist next."
            : `${ticked.size} ticked · ${crossed.size} crossed · ${adList.length - ticked.size - crossed.size} unreviewed.`}
        </div>
        <button onClick={approve}
          style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isApproved ? "#22C55E" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          {isApproved ? "→ Shortlist" : "Approve Video Review"}
        </button>
      </div>
    </div>
  );
}

function ReviewAdCard({ ad, status, onTick, onCross }) {
  const thumb = ad.thumbnailUrl || null;
  const adLink = ad.adUrl || (ad.adId ? `https://www.facebook.com/ads/library/?id=${ad.adId}` : null);
  const border = status === "ticked" ? "rgba(34,197,94,0.6)" : status === "crossed" ? "rgba(239,68,68,0.6)" : "var(--border)";
  return (
    <div style={{ background: "var(--card)", border: `1px solid ${border}`, borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", aspectRatio: "9 / 16", background: "#0F1520", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {thumb ? (
          <img src={thumb} alt={ad.pageName} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
        ) : (
          <div style={{ fontSize: 32, color: "#374151" }}>📘</div>
        )}
        {/* Tick / Cross quick actions */}
        <div style={{ position: "absolute", bottom: 6, left: 6, right: 6, display: "flex", gap: 6 }}>
          <button onClick={onTick} title="Shortlist this ad"
            style={{ flex: 1, padding: "5px 8px", background: status === "ticked" ? "#22C55E" : "rgba(0,0,0,0.6)", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            ✓
          </button>
          <button onClick={onCross} title="Skip this ad"
            style={{ flex: 1, padding: "5px 8px", background: status === "crossed" ? "#EF4444" : "rgba(0,0,0,0.6)", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            ✗
          </button>
        </div>
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ad.pageName || "Unknown"}</div>
        {(ad.bodyText || ad.headline) && (
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {(ad.bodyText || ad.headline || "").slice(0, 200)}
          </div>
        )}
        {adLink && (
          <a href={adLink} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", marginTop: 6, fontSize: 10, color: "var(--accent)", textDecoration: "none", fontFamily: "'JetBrains Mono',monospace" }}>
            View on FB →
          </a>
        )}
      </div>
    </div>
  );
}

function FilterChip({ label, active, colour, onClick }) {
  return (
    <button onClick={onClick}
      style={{ padding: "5px 10px", borderRadius: 4, border: "1px solid var(--border)", background: active ? (colour || "var(--accent)") : "var(--bg)", color: active ? "#fff" : "var(--muted)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
      {label}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 4 — Shortlist
// ────────────────────────────────────────────────────────────────
// Producer labels each ticked ad as a named format. Formats can be
// saved directly to the Meta Ads Format Library (for reuse across
// future projects) or kept project-local. Either way, they flow
// forward into Selection as source="project".
function ShortlistStep({ project, onPatch }) {
  const ads = project.adLibraryResearch?.ads || {};
  const review = project.adReview || {};
  const ticked = review.ticked || [];
  const shortlisted = project.shortlistedFormats || {};
  const approvals = project.approvals || {};
  const isApproved = !!approvals.shortlist;

  const tickedAds = ticked.map(id => ads[id]).filter(Boolean);

  const approve = () => {
    fbSet(`/preproduction/metaAds/${project.id}/approvals/shortlist`, new Date().toISOString());
    onPatch({ tab: "select" });
  };

  const shortlistedCount = Object.keys(shortlisted).length;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Shortlist</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
          For each ticked ad, write what format it represents: what's the hook pattern, what's the structural move that makes it work. Optional — save formats you like to the Meta Ads Format Library so you can reuse them on future projects. You can also skip this step entirely and pick formats from the library on the Selection tab.
        </div>
      </div>

      {tickedAds.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--muted)", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 10 }}>
          No ticked ads to shortlist. Continue to Selection to pick from existing Format Library entries, or go back to Video Review to tick some ads first.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, marginBottom: 20 }}>
          {tickedAds.map(ad => (
            <ShortlistRow key={ad.id} ad={ad} project={project} existing={shortlisted[`sl_${ad.id}`]} />
          ))}
        </div>
      )}

      {/* Approve — no longer gated on shortlistedCount; producers can advance with library-only formats picked on Selection */}
      <div style={{ padding: "14px 18px", background: "var(--card)", border: `1px solid ${isApproved ? "rgba(34,197,94,0.4)" : "var(--border)"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {isApproved
            ? "Shortlist approved. Move to Selection next."
            : tickedAds.length === 0
              ? "Nothing shortlisted from this project — pick formats from the library on Selection."
              : `${shortlistedCount} of ${tickedAds.length} ticked ads labelled as formats.`}
        </div>
        <button onClick={approve}
          style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isApproved ? "#22C55E" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          {isApproved ? "→ Selection" : "Approve Shortlist"}
        </button>
      </div>
    </div>
  );
}

function ShortlistRow({ ad, project, existing }) {
  const [formatName, setFormatName] = useState(existing?.formatName || "");
  const [description, setDescription] = useState(existing?.description || "");
  const [tags, setTags] = useState(existing?.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [savingLibrary, setSavingLibrary] = useState(false);
  const shortlistId = `sl_${ad.id}`;

  // save accepts an optional `overrides` object so callers can persist
  // a value that hasn't settled into React state yet — important for
  // tag add/remove, which would otherwise hit the classic stale-closure
  // bug: setTags(next) schedules a re-render but save() runs in the
  // same tick and reads the old `tags` from its closure. Overrides
  // bypass that by passing `next` through explicitly.
  // The plain-object guard (constructor === Object) protects onBlur
  // callers that pass a SyntheticEvent — those are treated as "no
  // overrides" rather than accidentally being read as override keys.
  const save = (overrides) => {
    const o = (overrides && typeof overrides === "object" && overrides.constructor === Object) ? overrides : {};
    const nextFormatName = (o.formatName ?? formatName).trim();
    if (!nextFormatName) return;
    const libraryId = existing?.formatLibraryId || null;
    fbSet(`/preproduction/metaAds/${project.id}/shortlistedFormats/${shortlistId}`, {
      adId: ad.id,
      shortlistId,
      formatLibraryId: libraryId,
      formatName: nextFormatName,
      description: (o.description ?? description).trim(),
      tags: o.tags ?? tags,
      thumbnail: ad.thumbnailUrl || null,
      videoUrl: ad.videoUrl || null,
      adUrl: ad.adUrl || null,
      pageName: ad.pageName,
      addedAt: existing?.addedAt || new Date().toISOString(),
    });
  };

  const saveToLibrary = () => {
    if (!formatName.trim()) { alert("Name the format first."); return; }
    setSavingLibrary(true);
    const now = new Date().toISOString();
    const libraryId = existing?.formatLibraryId || `fmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    fbSet(`/formatLibrary/${libraryId}`, {
      id: libraryId,
      formatType: "metaAds",
      name: formatName.trim(),
      videoAnalysis: description.trim(),
      filmingInstructions: "",
      structureInstructions: "",
      tags,
      examples: [
        {
          adId: ad.id,
          url: ad.adUrl || null,
          thumbnail: ad.thumbnailUrl || null,
          sourceAccount: ad.pageName,
          sourceProjectId: project.id,
          sourceClient: project.companyName,
          addedAt: now,
        },
      ],
      sourceProjectId: project.id,
      sourceClient: project.companyName,
      createdAt: now,
      createdBy: "producer",
      usageCount: 0,
      archived: false,
      updatedAt: now,
    });
    // Write back to shortlist with the new library id
    fbSet(`/preproduction/metaAds/${project.id}/shortlistedFormats/${shortlistId}`, {
      adId: ad.id,
      shortlistId,
      formatLibraryId: libraryId,
      formatName: formatName.trim(),
      description: description.trim(),
      tags,
      thumbnail: ad.thumbnailUrl || null,
      videoUrl: ad.videoUrl || null,
      adUrl: ad.adUrl || null,
      pageName: ad.pageName,
      addedAt: existing?.addedAt || now,
      libraryCreatedAt: now,
    });
    setSavingLibrary(false);
  };

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "");
    if (!t || tags.includes(t)) return;
    const next = [...tags, t];
    setTags(next);
    setTagInput("");
    save({ tags: next });
  };

  const removeTag = (t) => {
    const next = tags.filter(x => x !== t);
    setTags(next);
    save({ tags: next });
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "grid", gridTemplateColumns: "120px 1fr", gap: 14 }}>
      {/* Thumbnail */}
      <div style={{ position: "relative", aspectRatio: "9 / 16", background: "#0F1520", borderRadius: 6, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {ad.thumbnailUrl ? (
          <img src={ad.thumbnailUrl} alt={ad.pageName} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
        ) : (
          <div style={{ fontSize: 24, color: "#374151" }}>📘</div>
        )}
      </div>
      {/* Form */}
      <div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>{ad.pageName}</div>
        {ad.bodyText && (
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4, marginBottom: 8, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontStyle: "italic" }}>
            "{ad.bodyText.slice(0, 180)}{ad.bodyText.length > 180 ? "…" : ""}"
          </div>
        )}
        <input type="text" value={formatName} onChange={e => setFormatName(e.target.value)} onBlur={save}
          placeholder="Format name (e.g. Big Promise, Before/After, Objection Flip)"
          style={{ ...textareaSt, padding: "6px 10px", fontSize: 13, fontWeight: 700, marginBottom: 6 }} />
        <textarea value={description} onChange={e => setDescription(e.target.value)} onBlur={save} rows={2}
          placeholder="What makes this format work? What's the hook move?"
          style={{ ...textareaSt, fontSize: 12, marginBottom: 6 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {tags.map(t => (
            <span key={t} style={{ padding: "2px 8px", background: "var(--bg)", borderRadius: 3, fontSize: 10, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              {t}
              <button onClick={() => removeTag(t)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 11 }}>×</button>
            </span>
          ))}
          <input type="text" value={tagInput} onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
            placeholder="+ Tag"
            style={{ ...textareaSt, width: 100, padding: "3px 8px", fontSize: 11 }} />
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {existing?.formatLibraryId ? (
              <span style={{ padding: "4px 10px", fontSize: 10, color: "#22C55E", background: "rgba(34,197,94,0.08)", borderRadius: 4, fontWeight: 700 }}>✓ In library</span>
            ) : (
              <button onClick={saveToLibrary} disabled={!formatName.trim() || savingLibrary}
                style={{ padding: "5px 12px", fontSize: 11, fontWeight: 600, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)", borderRadius: 4, cursor: !formatName.trim() || savingLibrary ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                + Save to Meta Ads library
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 5 — Selection
// ────────────────────────────────────────────────────────────────
// Drag-drop picker from shortlisted formats + Meta Ads library.
// Per-format videoCount allocator matches Social Organic. Auto-fills
// with equal split on first mount; producer can override.
function SelectStep({ project, onPatch }) {
  const shortlisted = project.shortlistedFormats || {};
  const numberOfVideos = project.numberOfVideos || 0;
  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  const approvals = project.approvals || {};
  const isApproved = !!approvals.select;

  const [library, setLibrary] = useState({});
  useEffect(() => fbListenSafe("/formatLibrary", d => setLibrary(d || {})), []);

  // Sources panel — both shortlisted (project-local) and Meta Ads library entries.
  // Filter library to metaAds-only (legacy fallback -> organic, which is excluded).
  const libraryEntries = Object.values(library || {})
    .filter(f => f && f.id && !f.archived && (f.formatType || "organic") === "metaAds")
    .filter(f => !selected.some(s => s.formatLibraryId === f.id));
  const shortlistEntries = Object.values(shortlisted)
    .filter(s => s && s.shortlistId)
    .filter(s => !selected.some(x => x.formatLibraryId === s.formatLibraryId || x.shortlistId === s.shortlistId));

  const totalTarget = numberOfVideos;
  const totalAssigned = selected.reduce((sum, s) => sum + (s.videoCount || 0), 0);
  const countsBalanced = totalTarget > 0 && totalAssigned === totalTarget;

  const writeSelected = (next) => {
    fbSet(`/preproduction/metaAds/${project.id}/selectedFormats`, next);
  };
  const addFormat = (entry) => {
    if (selected.some(s => s.formatLibraryId && s.formatLibraryId === entry.formatLibraryId)) return;
    const next = [...selected, { ...entry, order: selected.length, addedAt: new Date().toISOString() }];
    writeSelected(next);
  };
  const removeFormat = (key) => {
    writeSelected(selected.filter((s, i) => `${s.formatLibraryId || s.shortlistId || i}` !== key));
  };
  const setCount = (key, count) => {
    const n = Math.max(0, parseInt(count, 10) || 0);
    writeSelected(selected.map((s, i) => `${s.formatLibraryId || s.shortlistId || i}` === key ? { ...s, videoCount: n } : s));
  };
  // User-triggered full rebalance — explicit "Reset to equal split"
  // button uses this. Always rewrites every row.
  const applyEqualSplit = () => {
    if (selected.length === 0 || !totalTarget) return;
    const base = Math.floor(totalTarget / selected.length);
    const remainder = totalTarget % selected.length;
    writeSelected(selected.map((s, i) => ({ ...s, videoCount: base + (i < remainder ? 1 : 0) })));
  };
  // Auto-fill — runs when a new format is added and still has no count.
  // Distributes the REMAINING budget over ONLY the rows that don't have
  // a count set yet, so the producer's manually-chosen numbers on other
  // rows are preserved. The old implementation called applyEqualSplit
  // here, which rewrote all rows.
  useEffect(() => {
    if (!totalTarget || selected.length === 0) return;
    const unsetIndexes = selected
      .map((s, i) => (s.videoCount == null ? i : -1))
      .filter(i => i >= 0);
    if (unsetIndexes.length === 0) return;
    const setTotal = selected.reduce((sum, s) => sum + (s.videoCount || 0), 0);
    const remaining = Math.max(0, totalTarget - setTotal);
    const base = Math.floor(remaining / unsetIndexes.length);
    const rem = remaining % unsetIndexes.length;
    let rIdx = 0;
    writeSelected(selected.map((s, i) => {
      if (s.videoCount != null) return s;
      const v = base + (rIdx < rem ? 1 : 0);
      rIdx++;
      return { ...s, videoCount: v };
    }));
  }, [selected.length, totalTarget]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Approval is gated by BOTH having at least one format AND having the
  // per-format counts add up to the project's total. Previously the
  // approve handler only checked length, so producers could ship a 10/12
  // allocation and silently get 10 ads from the generator (totalAds is
  // computed from selectedFormats[].videoCount on the server).
  const approveBlocked = selected.length === 0 || (!countsBalanced && totalTarget > 0);
  const approve = () => {
    if (approveBlocked) return;
    fbSet(`/preproduction/metaAds/${project.id}/approvals/select`, new Date().toISOString());
    onPatch({ tab: "script" });
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Selection</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
          Pick the formats you want to script against. Sources: this project's shortlist (labelled in the previous tab) plus every entry in the Meta Ads Format Library. Allocate how many of each format to produce on the right.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        {/* Sources */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>
            Sources <span style={{ color: "var(--muted)", fontWeight: 500, marginLeft: 6 }}>({shortlistEntries.length + libraryEntries.length} available)</span>
          </div>
          {shortlistEntries.length === 0 && libraryEntries.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "var(--muted)" }}>
              No sources available. Shortlist some ads in the previous tab, or add entries to the Meta Ads Format Library.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6, maxHeight: 480, overflowY: "auto" }}>
              {shortlistEntries.length > 0 && (
                <div style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>
                  From this project's shortlist
                </div>
              )}
              {shortlistEntries.map(s => (
                <button key={s.shortlistId} onClick={() => addFormat({ shortlistId: s.shortlistId, formatLibraryId: s.formatLibraryId || null, source: "project", formatName: s.formatName, description: s.description })}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.formatName}</span>
                  <span style={{ fontSize: 10, color: "var(--accent)" }}>+ Add</span>
                </button>
              ))}
              {libraryEntries.length > 0 && (
                <div style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 8, marginBottom: 2 }}>
                  From Meta Ads Format Library
                </div>
              )}
              {libraryEntries.map(f => (
                <button key={f.id} onClick={() => addFormat({ formatLibraryId: f.id, source: "library", formatName: f.name, description: f.videoAnalysis })}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  <span style={{ fontSize: 10, color: "var(--accent)" }}>+ Add</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Selected ({selected.length})</span>
          </div>
          {totalTarget > 0 && selected.length > 0 && (
            <div style={{ marginBottom: 10, padding: "6px 10px", borderRadius: 6, background: countsBalanced ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)", border: `1px solid ${countsBalanced ? "rgba(16,185,129,0.4)" : "rgba(239,68,68,0.4)"}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: countsBalanced ? "#10B981" : "#EF4444", fontFamily: "'JetBrains Mono',monospace" }}>
                {totalAssigned} / {totalTarget} ads {countsBalanced ? "✓" : `(${totalAssigned - totalTarget > 0 ? "+" : ""}${totalAssigned - totalTarget})`}
              </div>
              <button onClick={applyEqualSplit}
                style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--card)", color: "var(--muted)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                Equal split
              </button>
            </div>
          )}
          {selected.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "var(--muted)" }}>
              Click formats on the left to add them.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {selected.map((s, i) => {
                const key = `${s.formatLibraryId || s.shortlistId || i}`;
                return (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6 }}>
                    <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", minWidth: 18 }}>{String(i + 1).padStart(2, "0")}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.formatName}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="How many ads of this format to script">
                      <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>×</span>
                      <input type="number" min={0} max={99} value={s.videoCount ?? ""}
                        onChange={e => setCount(key, e.target.value)}
                        style={{ width: 40, padding: "3px 6px", borderRadius: 3, border: "1px solid var(--border)", background: "var(--card)", color: "var(--fg)", fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }} />
                    </div>
                    <button onClick={() => removeFormat(key)} title="Remove"
                      style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Approve */}
      <div style={{ padding: "14px 18px", background: "var(--card)", border: `1px solid ${isApproved ? "rgba(34,197,94,0.4)" : "var(--border)"}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {isApproved
            ? "Selection approved. Move to Scripting next."
            : selected.length === 0
              ? "Pick at least one format before approving."
              : !countsBalanced && totalTarget > 0
                ? "Allocated count doesn't match the total video count yet — adjust or Equal split to balance."
                : "Ready to approve."}
        </div>
        <button onClick={approve} disabled={!isApproved && approveBlocked}
          style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isApproved ? "#22C55E" : approveBlocked ? "#374151" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: !isApproved && approveBlocked ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
          {isApproved ? "→ Scripting" : "Approve Selection"}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 6 — Scripting
// ────────────────────────────────────────────────────────────────
// Generates the Hormozi-style script table from Brand Truth + selected
// formats. Backend lives at /api/meta-ads scriptGenerate.
function ScriptStep({ project, onPatch }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  // Click-to-rewrite — stores the cell or whole row currently being edited.
  // Cell mode: { mode: "cell", rowId, column, label, currentValue }
  // Row mode:  { mode: "row",  rowId, label, row }
  const [rewriteTarget, setRewriteTarget] = useState(null);
  // Project-wide feedback box — applies one instruction to every script
  // in parallel + persists to scriptFeedback.global so future per-cell
  // rewrites also pick it up.
  const [globalFeedback, setGlobalFeedback] = useState("");
  const [applyingAll, setApplyingAll] = useState(false);
  const [applyAllError, setApplyAllError] = useState(null);
  const [applyAllResult, setApplyAllResult] = useState(null);
  const scripts = project.scriptTable || [];
  // Tracks mount so the 30-60s Claude call doesn't call setState on
  // an unmounted component when the producer switches tabs mid-flight.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const generate = async () => {
    setError(null);
    setGenerating(true);
    try {
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scriptGenerate", projectId: project.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      // Firebase listener rehydrates scriptTable.
    } catch (e) {
      if (isMountedRef.current) setError(e.message);
    } finally {
      if (isMountedRef.current) setGenerating(false);
    }
  };

  // Runsheet handoff state — mirrors the Social Organic pattern at
  // SocialOrganicResearch.jsx:ScriptToolbar so the UX feels the same
  // across both preproduction flows.
  const runsheetHandoff = project.runsheetHandoff || null;
  const pushed = !!runsheetHandoff?.runsheetId;
  const shareUrl = preproductionShareUrl(project);
  const [copied, setCopied] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState(null);

  const copyShare = () => {
    try {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions denied) —
      // fall back to a native prompt the user can copy from manually.
      window.prompt("Copy this URL:", shareUrl);
    }
  };

  const pushToRunsheet = async () => {
    if (pushed || pushing) return;
    if (!window.confirm(`Push this project to the Runsheets tab? Creates a new runsheet with one video row per script (${scripts.length} videos).`)) return;
    setPushError(null);
    setPushing(true);
    try {
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pushToRunsheet", projectId: project.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
    } catch (e) {
      if (isMountedRef.current) setPushError(e.message);
    } finally {
      if (isMountedRef.current) setPushing(false);
    }
  };

  const applyToAll = async () => {
    const text = globalFeedback.trim();
    if (!text || applyingAll || scripts.length === 0) return;
    if (!window.confirm(`Apply this feedback to all ${scripts.length} scripts? Each script is rewritten in parallel — takes ~30s end to end.`)) return;
    setApplyAllError(null);
    setApplyAllResult(null);
    setApplyingAll(true);
    try {
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rewriteAllScripts", projectId: project.id, instruction: text }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      if (isMountedRef.current) {
        setApplyAllResult(d);
        setGlobalFeedback("");
      }
    } catch (e) {
      if (isMountedRef.current) setApplyAllError(e.message);
    } finally {
      if (isMountedRef.current) setApplyingAll(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)" }}>Scripting</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, maxWidth: 720 }}>
            Generate the full script table from your Brand Truth + selected formats. Each script lands in the Hormozi 7-column blueprint (Hook, Pain, Results, Offer, Why, CTA, Headline + Ad Copy).
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {scripts.length > 0 && project.shortId && (
            <button onClick={copyShare}
              style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {copied ? "✓ Copied" : "📎 Copy share URL"}
            </button>
          )}
          <button onClick={generate} disabled={generating}
            style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: generating ? "#374151" : "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: generating ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {generating ? "Generating…" : scripts.length > 0 ? "Regenerate scripts" : "Generate scripts"}
          </button>
          {scripts.length > 0 && !pushed && (
            <button onClick={pushToRunsheet} disabled={pushing}
              style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: pushing ? "#374151" : "#22C55E", color: "#fff", fontSize: 13, fontWeight: 700, cursor: pushing ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {pushing ? "Pushing…" : "→ Push to Runsheets"}
            </button>
          )}
          {pushed && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(34,197,94,0.12)", color: "#22C55E", borderRadius: 8, fontSize: 11, fontWeight: 700 }}>
              <span>✓ Pushed {new Date(runsheetHandoff.pushedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
              <span style={{ color: "#5A6B85", fontSize: 10, fontWeight: 500 }}>
                Find it in <span style={{ color: "#22C55E", fontWeight: 700 }}>Pre-Prod → Runsheets</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
          {error}
        </div>
      )}
      {pushError && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444" }}>
          {pushError}
        </div>
      )}

      {scripts.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", background: "var(--card)", border: "1px dashed var(--border)", borderRadius: 10 }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>📝</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>No scripts yet</div>
          <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 520, margin: "0 auto 16px", lineHeight: 1.5 }}>
            Click Generate. Takes 30-60s on Opus. Uses your Brand Truth fields + the selected format library entries to produce one row per ad.
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 14, padding: 14, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
              Feedback on all scripts
            </div>
            <textarea
              value={globalFeedback}
              onChange={e => setGlobalFeedback(e.target.value)}
              disabled={applyingAll}
              placeholder="e.g. Make every hook more aggressive. Or: tighten the CTAs across all scripts."
              rows={2}
              style={{ ...textareaSt, marginBottom: 8 }}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 11, color: "var(--muted)", maxWidth: 560, lineHeight: 1.4 }}>
                Rewrites all {scripts.length} scripts in parallel and saves the note to project-wide feedback, so future per-cell rewrites also see it.
              </div>
              <button onClick={applyToAll} disabled={!globalFeedback.trim() || applyingAll}
                style={{ padding: "8px 18px", borderRadius: 6, border: "none", background: !globalFeedback.trim() || applyingAll ? "#374151" : "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: !globalFeedback.trim() || applyingAll ? "not-allowed" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                {applyingAll ? "Applying…" : `Apply to all ${scripts.length} scripts`}
              </button>
            </div>
            {applyAllError && (
              <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 11, color: "#EF4444" }}>
                {applyAllError}
              </div>
            )}
            {applyAllResult && (
              <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(34,197,94,0.08)", borderRadius: 6, border: "1px solid rgba(34,197,94,0.3)", fontSize: 11, color: "#22C55E" }}>
                {applyAllResult.succeeded} rewritten · {applyAllResult.failed} failed · {applyAllResult.skipped} skipped
                {applyAllResult.errors?.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 10, color: "#EF4444" }}>
                    {applyAllResult.errors.slice(0, 3).map(e => `${e.rowId}: ${e.error}`).join("; ")}
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
            Click any cell to rewrite it with AI. Or use the row-level button to rewrite a whole script as one cohesive update. Every instruction is remembered project-wide so the AI holds context across rewrites.
          </div>
          <div style={{ overflowX: "auto", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <table style={{ width: "100%", minWidth: 1400, borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["#", "Name", "Format", "Hook", "Explain the Pain", "Results", "Offer", "CTA", "Headline", "Ad Copy"].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "2px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scripts.map((row, i) => {
                  // Renders a clickable cell that opens the rewrite modal.
                  // Plain-text cells (Name/#/Format) aren't clickable —
                  // they're metadata, producer rewrites them via regenerate
                  // or manual edit if ever needed.
                  const Cell = ({ column, label, content, width, extraStyle }) => (
                    <td
                      style={{ padding: 0, borderBottom: "1px solid var(--border-light)", verticalAlign: "top", maxWidth: width, cursor: "pointer" }}
                      onClick={() => setRewriteTarget({ mode: "cell", rowId: row.id, column, label, currentValue: content || "" })}
                      title="Click to rewrite with AI"
                    >
                      <div style={{ padding: "10px 12px", minHeight: 40, ...(extraStyle || {}) }}>
                        {content || <span style={{ color: "var(--muted)", fontStyle: "italic" }}>empty · click to fill</span>}
                      </div>
                    </td>
                  );
                  return (
                    <tr key={row.id || i}>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-light)", color: "var(--muted)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, verticalAlign: "top" }}>{String(i + 1).padStart(2, "0")}</td>
                      <td
                        style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-light)", verticalAlign: "top", cursor: "pointer" }}
                        onClick={() => setRewriteTarget({ mode: "row", rowId: row.id, label: `Whole script — ${row.videoName || "(unnamed)"}`, row })}
                        title="Click to give feedback on this entire script"
                      >
                        <div style={{ fontSize: 11, color: "var(--accent)", fontFamily: "'JetBrains Mono',monospace", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>
                          {row.videoName || "—"}
                        </div>
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-light)", verticalAlign: "top", color: "var(--muted)", fontSize: 11 }}>{row.formatName || "—"}</td>
                      <Cell column="hook"         label="Hook"            content={row.hook}         width={240} />
                      <Cell column="explainPain"  label="Explain the Pain" content={row.explainPain} width={220} />
                      <Cell column="results"      label="Results"          content={row.results}     width={220} />
                      <Cell column="offer"        label="The Offer"        content={row.offer}       width={220} />
                      <Cell column="cta"          label="CTA"              content={row.cta}         width={180} />
                      <Cell column="headline"     label="Meta Ad Headline" content={row.headline}    width={160} extraStyle={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }} />
                      <Cell column="adCopy"       label="Meta Ad Copy"     content={row.adCopy}      width={320} extraStyle={{ fontSize: 11, lineHeight: 1.5 }} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rewriteTarget && (
        <RewriteModal
          project={project}
          target={rewriteTarget}
          onClose={() => setRewriteTarget(null)}
          onDone={() => setRewriteTarget(null)}
        />
      )}
    </div>
  );
}

// Rewrite modal — two modes per the producer flow. Both modes route
// through /api/meta-ads so the server-side admin SDK does the write;
// client-side direct writes were tripping RTDB rule inheritance for
// the editor role with PERMISSION_DENIED.
//   "ai":     free-text instruction → Claude rewrites the cell/row →
//             rewriteCell / rewriteWholeScript handlers; the
//             instruction is persisted to scriptFeedback so future
//             rewrites hold context.
//   "manual": producer edits the value(s) directly in-modal →
//             manualUpdateCell / manualUpdateRow handlers (no Claude
//             call, no feedback-history entry — manual edits are
//             author-truth, not coaching).
// target.mode controls cell-vs-row scope; the AI/Manual toggle is
// modal-local state.
const WHOLE_SCRIPT_FIELDS = [
  ["hook", "Hook"], ["explainPain", "Explain the Pain"], ["results", "Results"],
  ["offer", "Offer"], ["whyOffer", "Why Offer"], ["cta", "CTA"],
  ["headline", "Headline"], ["adCopy", "Ad Copy"],
];
function RewriteModal({ project, target, onClose, onDone }) {
  const [mode, setMode] = useState("ai");  // "ai" | "manual"
  const [instruction, setInstruction] = useState("");
  // Manual-edit state — seeded from target so the producer starts from
  // the current value(s) rather than empty boxes.
  const [manualCellValue, setManualCellValue] = useState(target.currentValue || "");
  const seedRow = () => {
    const out = {};
    for (const [k] of WHOLE_SCRIPT_FIELDS) out[k] = target.row?.[k] || "";
    return out;
  };
  const [manualRow, setManualRow] = useState(seedRow);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Guards against setState after unmount (user closes the modal mid-
  // fetch) — plus a ref to dedupe rapid double-clicks which would
  // otherwise fire two Claude calls and race each other.
  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const isRow = target.mode === "row";

  const submitAi = async () => {
    if (!instruction.trim()) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const body = isRow
        ? { action: "rewriteWholeScript", projectId: project.id, rowId: target.rowId, instruction: instruction.trim() }
        : { action: "rewriteCell", projectId: project.id, rowId: target.rowId, column: target.column, instruction: instruction.trim(), currentValue: target.currentValue };
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      if (isMountedRef.current) onDone?.();
    } catch (e) {
      if (isMountedRef.current) setError(e.message);
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setSubmitting(false);
    }
  };

  const submitManual = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      // Route manual edits through /api/meta-ads (admin SDK on the
      // server) instead of writing directly to RTDB from the client.
      // Direct client writes were failing with PERMISSION_DENIED for
      // the editor role — Firebase rules check auth.token.role on
      // /preproduction/metaAds writes, and the inheritance was biting
      // editors in ways routing through the API sidesteps entirely.
      // Server-side row-index re-resolution gives the same race
      // protection the AI handlers use.
      const body = isRow
        ? (() => {
            const fields = {};
            for (const [k] of WHOLE_SCRIPT_FIELDS) {
              fields[k] = typeof manualRow[k] === "string" ? manualRow[k] : "";
            }
            return { action: "manualUpdateRow", projectId: project.id, rowId: target.rowId, fields };
          })()
        : { action: "manualUpdateCell", projectId: project.id, rowId: target.rowId, column: target.column, value: typeof manualCellValue === "string" ? manualCellValue : "" };
      const r = await authFetch("/api/meta-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? ` — ${d.detail}` : ""));
      if (isMountedRef.current) onDone?.();
    } catch (e) {
      if (isMountedRef.current) setError(e.message || String(e));
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setSubmitting(false);
    }
  };

  const submit = mode === "ai" ? submitAi : submitManual;
  const canSubmit = mode === "ai" ? instruction.trim().length > 0 : true;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "var(--card)", borderRadius: 12, padding: 24, maxWidth: isRow ? 640 : 520, width: "100%", maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--border)" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
          {isRow ? "Edit whole script" : "Edit field"}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)", marginBottom: 10 }}>
          {target.label}
        </div>

        {/* AI / Manual toggle */}
        <div style={{ display: "flex", gap: 2, marginBottom: 12, background: "var(--bg)", borderRadius: 6, padding: 3, width: "fit-content" }}>
          <button onClick={() => setMode("ai")}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: mode === "ai" ? "var(--accent)" : "transparent", color: mode === "ai" ? "#fff" : "var(--muted)" }}>
            AI rewrite
          </button>
          <button onClick={() => setMode("manual")}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: mode === "manual" ? "var(--accent)" : "transparent", color: mode === "manual" ? "#fff" : "var(--muted)" }}>
            Manual edit
          </button>
        </div>

        {/* Current preview — shown only in AI mode; in manual mode the editable fields ARE the preview */}
        {mode === "ai" && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", marginBottom: 14, maxHeight: 220, overflowY: "auto" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Current</div>
            {isRow ? (
              <div style={{ fontSize: 11, color: "var(--fg)", lineHeight: 1.5 }}>
                {WHOLE_SCRIPT_FIELDS.map(([key, lbl]) => (
                  <div key={key} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{lbl}</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>
                      {target.row?.[key] || <span style={{ color: "var(--muted)", fontStyle: "italic" }}>(empty)</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {target.currentValue || <span style={{ color: "var(--muted)", fontStyle: "italic" }}>(empty)</span>}
              </div>
            )}
          </div>
        )}

        {mode === "ai" ? (
          <>
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>
              Instruction
            </div>
            <textarea value={instruction} onChange={e => setInstruction(e.target.value)} autoFocus rows={4}
              placeholder="e.g. Make this more aggressive, lead with a specific dollar amount. Or: tighten to one sentence. Or: reframe as a Tried Before hook."
              style={{ ...textareaSt, marginBottom: 12 }} />
          </>
        ) : isRow ? (
          <div style={{ marginBottom: 12 }}>
            {WHOLE_SCRIPT_FIELDS.map(([key, lbl]) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>
                  {lbl}{key === "headline" && <span style={{ marginLeft: 6, color: "var(--accent)" }}>·35 char cap</span>}
                </div>
                <textarea
                  value={manualRow[key]}
                  onChange={e => setManualRow(prev => ({ ...prev, [key]: e.target.value }))}
                  rows={key === "adCopy" ? 5 : key === "headline" ? 1 : 2}
                  style={{ ...textareaSt }}
                />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>
              New value{target.column === "headline" && <span style={{ marginLeft: 6, color: "var(--accent)" }}>·35 char cap</span>}
            </div>
            <textarea value={manualCellValue} onChange={e => setManualCellValue(e.target.value)} autoFocus rows={4}
              style={{ ...textareaSt, marginBottom: 12 }} />
          </>
        )}

        {error && (
          <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#EF4444", marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={submitting}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting || !canSubmit}
            style={{ padding: "8px 18px", borderRadius: 6, border: "none", background: submitting || !canSubmit ? "#374151" : "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: submitting || !canSubmit ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {submitting ? (mode === "ai" ? "Rewriting…" : "Saving…") : (mode === "ai" ? "Rewrite" : "Save")}
          </button>
        </div>
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
