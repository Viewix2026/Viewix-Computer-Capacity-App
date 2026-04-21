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
        <ComingSoonTab tabNum={2} title="Ad Library Research"
          hint="Scrape Facebook Ad Library for competitor ads, or paste ad URLs manually. Ticked ads feed into Video Review." />
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
