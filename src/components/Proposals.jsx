import { useState, useEffect, useMemo } from "react";
import { BTN } from "../config";
import { makeShortId, validateLinkUrl } from "../utils";
import {
  fbSetAsync, fbListenSafe,
  getCurrentUserUid, getCurrentUserName, getCurrentUserEmail,
} from "../firebase";

// ─── status model (matches the Mac mini worker contract) ───
// queued (dashboard writes) -> generating -> ready (pdfUrl) | error (error)
const STATUS = {
  queued:     { label: "Queued",     color: "var(--amber)" },
  generating: { label: "Generating", color: "var(--accent)" },
  ready:      { label: "Ready",       color: "var(--success)" },
  error:      { label: "Error",      color: "var(--danger)" },
};

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

export function Proposals({ proposalJobs, setProposalJobs, isFounder, isFounders, role }) {
  const [showForm, setShowForm] = useState(false);
  const [company, setCompany]   = useState("");
  const [email, setEmail]       = useState("");
  const [look, setLook]         = useState("wall");
  const [pickedId, setPickedId] = useState(""); // selected Attio deal record_id, or "" for manual
  const [busy, setBusy]         = useState(false);
  const [formErr, setFormErr]   = useState("");

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
              <div key={j.id} style={{ display: "flex", alignItems: "center", gap: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r3)", padding: "14px 18px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>{j.companyName || "Untitled"}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                    {j.stage ? `${j.stage} · ` : ""}{j.requestedBy?.name || "—"} · {fmtWhen(j.createdAt)}
                  </div>
                </div>
                <Badge status={j.status} />
                <div style={{ minWidth: 140, textAlign: "right" }}>
                  {j.status === "ready" && validateLinkUrl(j.pdfUrl) ? (
                    <a href={j.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>Download PDF ↗</a>
                  ) : j.status === "error" ? (
                    <span title={j.error || ""} style={{ fontSize: 12, color: "var(--danger)", fontWeight: 600 }}>Failed — {String(j.error || "see worker logs").slice(0, 60)}</span>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{j.status === "generating" ? "Rendering…" : "Waiting for worker"}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
