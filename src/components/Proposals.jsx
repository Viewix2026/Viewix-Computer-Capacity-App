import { useState, useEffect, useMemo } from "react";
import { BTN } from "../config";
import { makeShortId, validateLinkUrl } from "../utils";
import {
  fbSetAsync, fbUpdateAsync, fbListenSafe,
  getCurrentUserUid, getCurrentUserName, getCurrentUserEmail,
} from "../firebase";

// ─── status model (matches the Mac mini worker contract) ───
// queued -> drafting -> review (founder confirms prices) -> approved ->
// generating -> ready (pdfUrl) | error (errorPhase routes Retry)
const STATUS = {
  queued:     { label: "Queued",     color: "var(--amber)" },
  drafting:   { label: "Drafting",   color: "var(--accent)" },
  review:     { label: "Review",     color: "var(--blue, #0082FA)" },
  approved:   { label: "Approved",   color: "var(--accent)" },
  generating: { label: "Generating", color: "var(--accent)" },
  ready:      { label: "Ready",       color: "var(--success)" },
  error:      { label: "Error",      color: "var(--danger)" },
};

// Money gate for Approve — mirrors workers/proposal-renderer/brief-schema.mjs
// (full re-validation happens worker-side; this is the UX layer of the
// three-layer price defence).
const MONEY_RE = /^\$\d{1,3}(,\d{3})*$/;
const isMoney = (p) => typeof p === "string" && MONEY_RE.test(p.trim()) && !/^\$0?0,000$/.test(p.trim());
const filled = (v) => typeof v === "string" && v.trim().length > 0;

// Client-side full-schema gate (Codex R2-3): Approve stays disabled until the
// whole flat brief validates, not just prices.
function briefProblems(b) {
  const errs = [];
  if (!b || typeof b !== "object") return ["No draft brief on this job yet."];
  if (!filled(b.client?.name)) errs.push("Client name is empty");
  if (!filled(b.project?.name)) errs.push("Project name is empty");
  if (!filled(b.cover?.promise)) errs.push("Cover promise is empty");
  if (!filled(b.brief?.para1) || !filled(b.brief?.para2)) errs.push("Brief paragraphs incomplete");
  if (!Array.isArray(b.brief?.success) || b.brief.success.length !== 3 || b.brief.success.some((s) => !filled(s?.title) || !filled(s?.desc))) errs.push("Needs exactly 3 complete success criteria");
  if (!Array.isArray(b.concepts) || b.concepts.length < 3 || b.concepts.length > 4 || b.concepts.some((c) => !filled(c?.title) || !filled(c?.desc) || !filled(c?.ref))) errs.push("Needs 3-4 complete concepts (title, description, reference)");
  if (!filled(b.approach?.intro)) errs.push("Approach intro is empty");
  if (!filled(b.nextSteps?.tagline)) errs.push("Next-steps tagline is empty");
  for (const t of ["1", "2", "3"]) {
    if (!filled(b.tier?.[t]?.name) || !filled(b.tier?.[t]?.bestFor)) errs.push(`Tier ${t} name/positioning incomplete`);
    if (!isMoney(b.tier?.[t]?.price)) errs.push(`Tier ${t} price needs a real figure like $38,000`);
  }
  return errs;
}

const LOOKS = [
  ["wall", "Moodboard wall"],
  ["strip", "Filmstrip"],
  ["hero", "Split hero"],
  ["colour", "Colour story"],
  ["desk", "Designer's desk"],
];

// Pre-won Attio stages worth proposing to (the prospect picker filters to these).
const PROSPECT_STAGES = ["Lead", "Meeting Booked", "Quoted", "On Hold"];

// ─── Attio deal field extractors (mirror NurtureLapsed.jsx) ───
function getStage(deal) {
  const v = deal?.values || {};
  for (const c of [v.stage, v.status, v.deal_stage, v.pipeline_stage]) {
    const t = c?.[0]?.status?.title || c?.[0]?.value;
    if (t) return typeof t === "string" ? t : "";
  }
  return "";
}
function getCompanyRef(deal) {
  const ref = deal?.values?.associated_company;
  if (Array.isArray(ref) && ref[0]) return { id: ref[0].target_record_id || "", name: ref[0].target_object_name || "" };
  return { id: ref?.target_record_id || "", name: "" };
}
function getDealName(deal) { return deal?.values?.name?.[0]?.value || ""; }
function dealRecordId(deal) { return deal?.id?.record_id || (typeof deal?.id === "string" ? deal.id : "") || ""; }

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " +
         d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function Badge({ status }) {
  const s = STATUS[status] || { label: status || "—", color: "var(--muted)" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 10px", borderRadius: 999, background: `${s.color}1f`, color: s.color, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color }} />
      {s.label}
    </span>
  );
}

// ─── Review panel — the founder gate before render ───
// Holds a LOCAL copy of the draft (Codex F7): the live /proposalJobs listener
// replaces the jobs array on every snapshot, so edits must never read through
// to the prop mid-edit. Mounted with key={job.id} so state resets per job.
const lblR = { fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, display: "block" };
const inR = { width: "100%", borderRadius: 7, border: "1px solid var(--border)", background: "var(--inset)", color: "var(--fg)", fontSize: 13, padding: "7px 10px", fontFamily: "inherit", boxSizing: "border-box" };
const taR = { ...inR, minHeight: 64, resize: "vertical", lineHeight: 1.45 };

function ReviewPanel({ job, onDone }) {
  const [brief, setBrief] = useState(() => JSON.parse(JSON.stringify(job.draftBrief || {})));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const set = (path, v) => setBrief((prev) => {
    const next = JSON.parse(JSON.stringify(prev));
    const keys = path.split(".");
    let o = next;
    for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = v;
    return next;
  });

  const meta = job.briefMeta || {};
  const problems = briefProblems(brief);

  async function write(patch, after) {
    setBusy(true); setErr("");
    try { await fbUpdateAsync(`/proposalJobs/${job.id}`, patch); if (after) after(); }
    catch (e) { setErr(e?.message || "Write rejected — check your access and the job state."); }
    finally { setBusy(false); }
  }

  // Ambiguous transcript: no draft yet — pick a candidate, job re-queues with it (Codex R2-4).
  if (!job.draftBrief && Array.isArray(meta.candidates) && meta.candidates.length) {
    return (
      <div style={{ borderTop: "1px solid var(--border)", padding: "16px 18px", background: "var(--inset)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Multiple call transcripts match “{job.companyName}” — pick the proposal call:</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {meta.candidates.map((c) => (
            <button key={c.id} disabled={busy} onClick={() => write({ status: "queued", selectedTranscriptId: c.id, draftBrief: null }, onDone)}
              style={{ ...BTN, textAlign: "left", background: "var(--card)", color: "var(--fg)", border: "1px solid var(--border)", padding: "10px 14px" }}>
              <b>{c.clientName || "Unknown"}</b> · {c.meetingType || "call"} · {fmtWhen(c.createdAt) || "undated"}
              {c.recordingUrl && validateLinkUrl(c.recordingUrl) ? <span style={{ color: "var(--accent)", marginLeft: 8, fontSize: 11 }}>has recording</span> : null}
            </button>
          ))}
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 12, fontWeight: 600, marginTop: 10 }}>{err}</div>}
      </div>
    );
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "16px 18px", background: "var(--inset)", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* provenance strip */}
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        {meta.transcript
          ? <>Drafted from <b style={{ color: "var(--fg-2)" }}>{meta.transcript.clientName}</b> · {meta.transcript.meetingType || "call"} · {fmtWhen(meta.transcript.createdAt)}{meta.transcript.recordingUrl && validateLinkUrl(meta.transcript.recordingUrl) ? <> · <a href={meta.transcript.recordingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>recording ↗</a></> : null}</>
          : <b style={{ color: "var(--amber)" }}>No transcript found — drafted from job details only. Fill the gaps below before approving.</b>}
        {(meta.missingFields || []).length > 0 && <div style={{ color: "var(--amber)", marginTop: 4 }}>Needs real input: {meta.missingFields.join(", ")}</div>}
        {(meta.flags || []).length > 0 && meta.flags.map((f, i) => <div key={i} style={{ color: "var(--danger)", marginTop: 4 }}>⚠ {f}</div>)}
      </div>

      {/* the brief, editable */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><label style={lblR}>Client</label><input style={inR} value={brief.client?.name || ""} onChange={(e) => set("client.name", e.target.value)} /></div>
        <div><label style={lblR}>Project</label><input style={inR} value={brief.project?.name || ""} onChange={(e) => set("project.name", e.target.value)} /></div>
      </div>
      <div><label style={lblR}>Cover promise</label><textarea style={taR} value={brief.cover?.promise || ""} onChange={(e) => set("cover.promise", e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><label style={lblR}>The brief — situation</label><textarea style={taR} value={brief.brief?.para1 || ""} onChange={(e) => set("brief.para1", e.target.value)} /></div>
        <div><label style={lblR}>The brief — what they want</label><textarea style={taR} value={brief.brief?.para2 || ""} onChange={(e) => set("brief.para2", e.target.value)} /></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
        {(brief.brief?.success || []).map((s, i) => (
          <div key={i}>
            <label style={lblR}>Success {i + 1}</label>
            <input style={{ ...inR, marginBottom: 6 }} value={s?.title || ""} onChange={(e) => { const a = [...brief.brief.success]; a[i] = { ...a[i], title: e.target.value }; set("brief.success", a); }} />
            <input style={inR} value={s?.desc || ""} onChange={(e) => { const a = [...brief.brief.success]; a[i] = { ...a[i], desc: e.target.value }; set("brief.success", a); }} />
          </div>
        ))}
      </div>
      <div><label style={lblR}>Approach intro</label><textarea style={taR} value={brief.approach?.intro || ""} onChange={(e) => set("approach.intro", e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${(brief.concepts || []).length || 1},1fr)`, gap: 12 }}>
        {(brief.concepts || []).map((c, i) => (
          <div key={i} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 10 }}>
            <label style={lblR}>Concept {i + 1}</label>
            <input style={{ ...inR, marginBottom: 6 }} value={c?.title || ""} onChange={(e) => { const a = [...brief.concepts]; a[i] = { ...a[i], title: e.target.value }; set("concepts", a); }} />
            <textarea style={{ ...taR, minHeight: 52, marginBottom: 6 }} value={c?.desc || ""} onChange={(e) => { const a = [...brief.concepts]; a[i] = { ...a[i], desc: e.target.value }; set("concepts", a); }} />
            <input style={inR} title="Comparable work reference" value={c?.ref || ""} onChange={(e) => { const a = [...brief.concepts]; a[i] = { ...a[i], ref: e.target.value }; set("concepts", a); }} />
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
        {["1", "2", "3"].map((t) => (
          <div key={t} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 10 }}>
            <label style={lblR}>{brief.tier?.[t]?.name || `Tier ${t}`} — price (ex GST)</label>
            <input style={{ ...inR, marginBottom: 6, borderColor: isMoney(brief.tier?.[t]?.price) ? "var(--border)" : "var(--danger)" }} placeholder="$38,000" value={brief.tier?.[t]?.price || ""} onChange={(e) => set(`tier.${t}.price`, e.target.value)} />
            <input style={inR} title="Best for" value={brief.tier?.[t]?.bestFor || ""} onChange={(e) => set(`tier.${t}.bestFor`, e.target.value)} />
          </div>
        ))}
      </div>
      <div><label style={lblR}>Close tagline</label><input style={inR} value={brief.nextSteps?.tagline || ""} onChange={(e) => set("nextSteps.tagline", e.target.value)} /></div>

      {problems.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--amber)", lineHeight: 1.5 }}>{problems.map((p, i) => <div key={i}>· {p}</div>)}</div>
      )}
      {err && <div style={{ color: "var(--danger)", fontSize: 12, fontWeight: 600 }}>{err}</div>}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button disabled={busy || problems.length > 0} onClick={() => write({ status: "approved", draftBrief: brief }, onDone)}
          style={{ ...BTN, background: problems.length ? "var(--border)" : "var(--success)", color: "white", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Working…" : "Approve & render"}
        </button>
        <button disabled={busy} onClick={() => write({ status: "queued", draftBrief: null, selectedTranscriptId: null }, onDone)}
          style={{ ...BTN, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" }}>
          Re-draft from scratch
        </button>
        <span style={{ fontSize: 11, color: "var(--faint)" }}>Approving locks the prices and sends it to the renderer.</span>
      </div>
    </div>
  );
}

export function Proposals({ proposalJobs, setProposalJobs, isFounder, isFounders, role }) {
  const [showForm, setShowForm] = useState(false);
  const [company, setCompany]   = useState("");
  const [email, setEmail]       = useState("");
  const [look, setLook]         = useState("wall");
  const [pickedId, setPickedId] = useState(""); // selected Attio deal record_id, or "" for manual
  const [busy, setBusy]         = useState(false);
  const [formErr, setFormErr]   = useState("");
  const [reviewId, setReviewId] = useState(null); // job expanded in the review panel

  // Retry routes by errorPhase (Codex R2-2): a render failure goes back to
  // `approved` (keeps the founder-confirmed brief + prices); a draft failure
  // re-queues for a fresh draft. Field clears (null) satisfy the rules'
  // !hasChild assertions.
  async function retryJob(j) {
    try {
      await fbUpdateAsync(`/proposalJobs/${j.id}`, {
        status: j.errorPhase === "render" ? "approved" : "queued",
        error: null, errorPhase: null,
      });
    } catch (e) {
      console.error("retry failed", e);
    }
  }

  // Live Attio deal list for the prospect picker. Read-gated to
  // founders/manager — closers get a clean denial and the manual path.
  const [attioDeals, setAttioDeals] = useState(null); // null = loading, [] = none/denied
  useEffect(() => {
    if (role === "closer") { setAttioDeals([]); return; } // closers can't read /attioCache — skip the denied listener (no retry noise)
    return fbListenSafe(
      "/attioCache",
      (d) => setAttioDeals(Array.isArray(d?.data) ? d.data : []),
      () => setAttioDeals([]) // denied or error -> manual entry only
    );
  }, [role]);

  const prospects = useMemo(() => {
    if (!Array.isArray(attioDeals)) return [];
    return attioDeals
      .map((deal) => {
        const co = getCompanyRef(deal);
        return {
          dealId: dealRecordId(deal),
          companyId: co.id,
          companyName: co.name || getDealName(deal),
          dealName: getDealName(deal),
          stage: getStage(deal),
        };
      })
      .filter((p) => p.dealId && p.companyName && PROSPECT_STAGES.includes(p.stage))
      .sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [attioDeals]);

  function pickDeal(id) {
    setPickedId(id);
    const p = prospects.find((x) => x.dealId === id);
    if (p) setCompany(p.companyName); // prefill; user can still edit
  }

  function resetForm() {
    setShowForm(false); setCompany(""); setEmail(""); setLook("wall");
    setPickedId(""); setFormErr("");
  }

  async function createJob() {
    const name = company.trim();
    if (!name) { setFormErr("Company name is required."); return; }
    const uid = getCurrentUserUid();
    if (!uid) { setFormErr("Your session is not ready yet. Refresh and try again."); return; }
    const picked = prospects.find((x) => x.dealId === pickedId);
    const id = `pj-${Date.now()}-${makeShortId(6)}`;
    const job = {
      id,
      status: "queued",
      companyName: name,
      contactEmail: email.trim(),
      companyId: picked?.companyId || "",
      dealId: picked?.dealId || "",      // Attio deal record_id; worker hydrates context from it
      stage: picked?.stage || "",
      lookVariant: look || "wall",
      requestedBy: { uid, name: getCurrentUserName() || getCurrentUserEmail() || "Unknown" },
      createdAt: new Date().toISOString(),
    };
    setBusy(true); setFormErr("");
    try {
      await fbSetAsync(`/proposalJobs/${id}`, job);
      setProposalJobs((p) => (p.some((x) => x.id === id) ? p : [...p, job])); // optimistic upsert — listener snapshot can't double it
      resetForm();
    } catch (e) {
      setFormErr(e?.message || "Could not queue the proposal. Check your access and try again.");
    } finally {
      setBusy(false);
    }
  }

  const jobs = useMemo(
    () => [...(proposalJobs || [])].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    [proposalJobs]
  );

  const inputStyle = { height: 38, borderRadius: 8, border: "1px solid var(--border)", background: "var(--inset)", color: "var(--fg)", fontSize: 14, padding: "0 12px", width: "100%", fontFamily: "inherit" };
  const lbl = { fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, display: "block" };

  return (
    <div>
      {/* Header */}
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>Enterprise Proposals</span>
          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>Generate a branded proposal deck — rendered on the Mac mini, delivered as a PDF.</span>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ New proposal</button>
        )}
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 28px 60px" }}>

        {/* New-proposal form */}
        {showForm && (
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r4)", padding: 24, marginBottom: 28 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--fg)", marginBottom: 18 }}>New proposal</div>

            {/* Prospect picker (founders/manager — Attio cache read) */}
            {Array.isArray(attioDeals) && prospects.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={lbl}>Link an Attio deal (optional)</label>
                <select value={pickedId} onChange={(e) => pickDeal(e.target.value)} style={{ ...inputStyle, appearance: "auto", cursor: "pointer" }}>
                  <option value="">— Manual entry —</option>
                  {prospects.map((p) => (
                    <option key={p.dealId} value={p.dealId}>{p.companyName} · {p.stage}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              <div>
                <label htmlFor="pj-company" style={lbl}>Company name *</label>
                <input id="pj-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Transgrid" style={inputStyle} />
              </div>
              <div>
                <label htmlFor="pj-email" style={lbl}>Primary contact email</label>
                <input id="pj-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" style={inputStyle} />
              </div>
            </div>

            <div style={{ marginBottom: 18, maxWidth: 320 }}>
              <label style={lbl}>Creative look</label>
              <select value={look} onChange={(e) => setLook(e.target.value)} style={{ ...inputStyle, appearance: "auto", cursor: "pointer" }}>
                {LOOKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>

            {formErr && <div style={{ color: "var(--danger)", fontSize: 13, fontWeight: 600, marginBottom: 14 }}>{formErr}</div>}

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={createJob} disabled={busy} style={{ ...BTN, background: "var(--accent)", color: "white", opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>{busy ? "Queuing…" : "Generate proposal"}</button>
              <button onClick={resetForm} disabled={busy} style={{ ...BTN, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" }}>Cancel</button>
            </div>
            <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 14 }}>Queues a job for the Mac mini worker. The brief is drafted from the linked deal + proposal-call transcript, or entered manually if none.</div>
          </div>
        )}

        {/* Jobs list */}
        {jobs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-2)", marginBottom: 6 }}>No proposals yet</div>
            <div style={{ fontSize: 13 }}>Click <b style={{ color: "var(--fg-2)" }}>+ New proposal</b> to queue one.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {jobs.map((j) => (
              <div key={j.id} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r3)", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 18px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{j.companyName || "Untitled"}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                      {j.stage ? `${j.stage} · ` : ""}{j.requestedBy?.name || "—"} · {fmtWhen(j.createdAt)}
                    </div>
                  </div>
                  <Badge status={j.status} />
                  <div style={{ minWidth: 150, textAlign: "right", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
                    {j.status === "ready" && validateLinkUrl(j.pdfUrl) ? (
                      <a href={j.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>Download PDF ↗</a>
                    ) : j.status === "review" ? (
                      <button onClick={() => setReviewId(reviewId === j.id ? null : j.id)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>
                        {reviewId === j.id ? "Close review" : (j.briefMeta?.candidates?.length ? "Pick transcript" : "Review & approve")}
                      </button>
                    ) : j.status === "error" ? (
                      <>
                        <span title={j.error || ""} style={{ fontSize: 12, color: "var(--danger)", fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(j.error || "Failed").slice(0, 60)}</span>
                        <button onClick={() => retryJob(j)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" }}>
                          {j.errorPhase === "render" ? "Retry render" : "Retry draft"}
                        </button>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                        {j.status === "generating" ? "Rendering…" : j.status === "drafting" ? "Claude is drafting…" : j.status === "approved" ? "Render queued" : "Waiting for worker"}
                      </span>
                    )}
                  </div>
                </div>
                {j.status === "review" && reviewId === j.id && (
                  <ReviewPanel key={`${j.id}-${j.briefMeta?.draftedAt || ""}`} job={j} onDone={() => setReviewId(null)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
