// NurtureLapsed — Lapsed-Proposal Auto-Recovery sequence (read-only v1)
//
// One of several sub-tabs hosted by the Nurture hub (src/components/Nurture.jsx).
// The full layout from the plan ships, but the automation columns
// (in-sequence, replied, delivered, channel attribution, deferred queue)
// are intentionally empty until the GHL/Aimfox/classifier workers land.
//
// Reads:
//   - attioDeals prop (from Founders/Nurture cache at /attioCache, refreshed
//     nightly by api/sync-attio-cache.js, also triggered manually from the
//     Nurture hub's "Refresh from Attio" button)
//   - /nurture/quotedAt/{dealId} from Firebase (timestamp the deal first
//     entered Quoted; populated by api/nurture-stage-webhook.js on real-time
//     stage transitions, with a nightly safety-net backfill from updated_at)
//   - /nurture/contactsState/{dealId} (sequence state; empty for now)
//   - /nurture/replyLog (replies; empty for now)
//   - /nurture/deferredReengagements (deferred queue; empty for now)
//
// Pipeline stages (literal, from Attio): Lead, Meeting Booked, Quoted,
// On Hold, Won, Lost.

import { useState, useMemo, useEffect } from "react";
import { fbListen } from "../firebase";
import { fmtCur } from "../utils";
import { BTN } from "../config";

const ATTIO_WORKSPACE = "viewix"; // for deep-link URLs

// ─── Field extractors (mirror api/_attio-metrics.js logic) ─────────────
function getStage(deal) {
  const v = deal?.values || {};
  const candidates = [v.stage, v.status, v.deal_stage, v.pipeline_stage];
  for (const c of candidates) {
    const t = c?.[0]?.status?.title || c?.[0]?.value;
    if (t) return typeof t === "string" ? t : "";
  }
  return "";
}
function getDealValue(deal) {
  const v = deal?.values || {};
  const candidates = [v.deal_value, v.amount, v.value, v.revenue, v.contract_value];
  for (const c of candidates) {
    if (c?.[0] != null) {
      const n = c[0].currency_value ?? c[0].value;
      if (n != null) return typeof n === "number" ? n : parseFloat(n) || 0;
    }
  }
  return 0;
}
function getCompanyRef(deal) {
  const ref = deal?.values?.associated_company;
  if (Array.isArray(ref) && ref[0]) {
    return { id: ref[0].target_record_id || null, name: ref[0].target_object_name || null };
  }
  return { id: ref?.target_record_id || null, name: null };
}
function getDealName(deal) {
  const arr = deal?.values?.name || [];
  return arr[0]?.value || "";
}
function getOwner(deal) {
  const v = deal?.values || {};
  const cands = [v.owner, v.deal_owner, v.assignee, v.strongest_connection_user];
  for (const c of cands) {
    const a = c?.[0];
    if (!a) continue;
    return a?.referenced_actor_id || a?.value?.name || a?.name || a?.title || "";
  }
  return "";
}
function getCreatedAt(deal) {
  return deal?.created_at || deal?.values?.created_at?.[0]?.value || null;
}
function getUpdatedAt(deal) {
  return deal?.updated_at || deal?.values?.updated_at?.[0]?.value || null;
}
function dealId(deal) {
  return deal?.id?.record_id || deal?.id || "";
}

const daysSince = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

// ─── Status taxonomy (mirrors plan) ────────────────────────────────────
// Computable from current data:
//   Pending Sequence — in Quoted, < 30 days since quoted_at
//   Eligible        — in Quoted, >= 30 days, no contactState row yet
// Placeholder (populated only when automation lands):
//   In Sequence, Replied, Deferred, Delivered, Suppressed, Re-enrolled, Reconverted
const STATUS_COLORS = {
  "Pending Sequence": "#3B82F6",
  "Eligible": "#F59E0B",
  "In Sequence": "#8B5CF6",
  "Replied": "#10B981",
  "Deferred": "#06B6D4",
  "Delivered": "#10B981",
  "Reconverted": "#22C55E",
  "Suppressed": "#6B7280",
};

export function NurtureLapsed({ attioDeals }) {
  const [quotedAt, setQuotedAt] = useState({});
  const [contactsState, setContactsState] = useState({});
  const [replyLog, setReplyLog] = useState({});
  const [deferred, setDeferred] = useState({});
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterChannel, setFilterChannel] = useState("all");
  const [filterCohort, setFilterCohort] = useState("all");
  const [drillId, setDrillId] = useState(null);
  const [search, setSearch] = useState("");

  // Listen to nurture state in Firebase
  useEffect(() => {
    const u1 = fbListen("/nurture/quotedAt", (d) => setQuotedAt(d || {}));
    const u2 = fbListen("/nurture/contactsState", (d) => setContactsState(d || {}));
    const u3 = fbListen("/nurture/replyLog", (d) => setReplyLog(d || {}));
    const u4 = fbListen("/nurture/deferredReengagements", (d) => setDeferred(d || {}));
    return () => { u1?.(); u2?.(); u3?.(); u4?.(); };
  }, []);

  const deals = attioDeals?.data || [];

  // Derive each deal's display row
  const rows = useMemo(() => {
    return deals.map((d) => {
      const id = dealId(d);
      const stage = getStage(d);
      const company = getCompanyRef(d);
      const dealName = getDealName(d);
      const value = getDealValue(d);
      const owner = getOwner(d);
      const createdAt = getCreatedAt(d);
      const updatedAt = getUpdatedAt(d);
      const qAt = quotedAt[id]?.timestamp || (stage === "Quoted" ? updatedAt : null);
      const days = qAt ? daysSince(qAt) : null;
      const cs = contactsState[id] || null;
      let status;
      if (cs?.status) {
        status = cs.status;
      } else if (stage === "Quoted") {
        status = (days != null && days >= 30) ? "Eligible" : "Pending Sequence";
      } else if (stage === "Won") {
        status = qAt ? "Reconverted" : null;
      } else {
        status = null;
      }
      return {
        id,
        dealName,
        companyId: company.id,
        companyName: company.name || dealName || "—",
        stage,
        value,
        owner,
        createdAt,
        updatedAt,
        quotedAt: qAt,
        daysSinceQuoted: days,
        status,
        cohort: cs?.cohort || null,
        lastChannelTouch: cs?.lastChannelTouch || null,
        lastChannel: cs?.lastChannel || null,
        nextScheduled: cs?.nextScheduled || null,
        scorecardUrl: cs?.scorecardUrl || null,
      };
    });
  }, [deals, quotedAt, contactsState]);

  // Funnel — 90-day window for replies/delivered/reconverted
  const NINETY = Date.now() - 90 * 86400000;
  const funnel = useMemo(() => {
    const quotedRows = rows.filter((r) => r.stage === "Quoted");
    const eligible = quotedRows.length;
    const inWindow = quotedRows.filter((r) => r.daysSinceQuoted != null && r.daysSinceQuoted < 30).length;
    const inSequence = Object.values(contactsState).filter((c) => c?.status === "In Sequence" || c?.status === "Re-enrolled").length;
    const replied = Object.values(contactsState).filter((c) => c?.status === "Replied" || c?.status === "Deferred" || c?.status === "Delivered" || c?.status === "Reconverted" || c?.status === "Suppressed").length;
    const replies90 = Object.values(replyLog).filter((r) => r?.classifiedAt && new Date(r.classifiedAt).getTime() >= NINETY);
    const interested = replies90.filter((r) => r.classifierIntent === "interested").length;
    const deferredCount = replies90.filter((r) => r.classifierIntent === "deferred").length;
    const notInterested = replies90.filter((r) => r.classifierIntent === "not-interested").length;
    const delivered = Object.values(contactsState).filter((c) => c?.status === "Delivered" && c?.deliveredAt && new Date(c.deliveredAt).getTime() >= NINETY).length;
    const reconverted = rows.filter((r) => r.status === "Reconverted").length;
    const channels = { email: 0, linkedin: 0, sms: 0 };
    replies90.forEach((r) => { if (channels[r.channel] != null) channels[r.channel]++; });
    return { eligible, inWindow, inSequence, replied, interested, deferredCount, notInterested, delivered, reconverted, channels };
  }, [rows, contactsState, replyLog]);

  // Activity table — show only deals relevant to the funnel (any nurture
  // state, OR currently in Quoted, OR Reconverted).
  const tableRows = useMemo(() => {
    const visible = rows.filter((r) => r.status);
    return visible
      .filter((r) => filterStatus === "all" || r.status === filterStatus)
      .filter((r) => filterChannel === "all" || r.lastChannel === filterChannel)
      .filter((r) => filterCohort === "all" || r.cohort === filterCohort)
      .filter((r) => !search || r.companyName.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (b.daysSinceQuoted ?? -1) - (a.daysSinceQuoted ?? -1));
  }, [rows, filterStatus, filterChannel, filterCohort, search]);

  const deferredQueue = useMemo(() => {
    return Object.values(deferred)
      .filter((d) => d && !d.reEnrolledAt)
      .sort((a, b) => new Date(a.deferUntil) - new Date(b.deferUntil));
  }, [deferred]);

  const drilled = drillId ? rows.find((r) => r.id === drillId) : null;
  const drilledReplies = drillId ? Object.values(replyLog).filter((r) => r?.dealId === drillId) : [];

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", padding: "24px 28px 60px" }}>

      {/* ═══ FUNNEL HEADER ═══ */}
      <div style={{ marginBottom: 24, padding: 24, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 16 }}>
          90-day funnel · re-engagement only
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <FunnelStat label="Quoted (eligible)" value={funnel.eligible} />
          <FunnelStat label="In 30-day window" value={funnel.inWindow} hint="Pending sequence" />
          <FunnelStat label="In sequence" value={funnel.inSequence} muted={funnel.inSequence === 0} />
          <FunnelStat label="Replied (any channel)" value={funnel.replied} muted={funnel.replied === 0} />
          <FunnelStat label="Delivered (scorecards)" value={funnel.delivered} muted={funnel.delivered === 0} />
          <FunnelStat label="Reconverted (Won)" value={funnel.reconverted} accent="#10B981" />
        </div>
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          <SubStat label="↳ Interested" value={funnel.interested} />
          <SubStat label="↳ Deferred" value={funnel.deferredCount} />
          <SubStat label="↳ Not interested" value={funnel.notInterested} />
          <SubStat label="Email replies" value={funnel.channels.email} />
          <SubStat label="LinkedIn replies" value={funnel.channels.linkedin} />
          <SubStat label="SMS replies" value={funnel.channels.sms} />
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
          Automation columns populate when GHL + Aimfox + classifier workers go live.
        </div>
      </div>

      {/* ═══ FILTERS ═══ */}
      <div style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="text" placeholder="Search company…" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", minWidth: 200 }} />
        <FilterSelect label="Status" value={filterStatus} onChange={setFilterStatus} options={["all", "Pending Sequence", "Eligible", "In Sequence", "Replied", "Deferred", "Delivered", "Reconverted", "Suppressed"]} />
        <FilterSelect label="Channel" value={filterChannel} onChange={setFilterChannel} options={["all", "email", "linkedin", "sms"]} />
        <FilterSelect label="Cohort" value={filterCohort} onChange={setFilterCohort} options={["all", "fresh-lapse", "deferred-revival"]} />
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>{tableRows.length} deals</span>
      </div>

      {/* ═══ ACTIVITY TABLE ═══ */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg)" }}>
              <Th>Company</Th>
              <Th>Status</Th>
              <Th>Days since quoted</Th>
              <Th>Last touch</Th>
              <Th>Channel</Th>
              <Th>Owner</Th>
              <Th>Value</Th>
              <Th>Next</Th>
            </tr>
          </thead>
          <tbody>
            {tableRows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
                No deals match. Try widening filters or refresh from Attio.
              </td></tr>
            )}
            {tableRows.map((r) => (
              <tr key={r.id} onClick={() => setDrillId(r.id)} style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: drillId === r.id ? "rgba(245,158,11,0.06)" : "transparent" }}>
                <Td><span style={{ fontWeight: 600, color: "var(--fg)" }}>{r.companyName}</span>{r.dealName && r.dealName !== r.companyName && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{r.dealName}</div>}</Td>
                <Td><StatusPill status={r.status} /></Td>
                <Td>{r.daysSinceQuoted != null ? <span style={{ fontFamily: "'JetBrains Mono',monospace", color: r.daysSinceQuoted >= 30 ? "#F59E0B" : "var(--fg)" }}>{r.daysSinceQuoted}d</span> : <span style={{ color: "var(--muted)" }}>—</span>}</Td>
                <Td>{r.lastChannelTouch ? fmtDate(r.lastChannelTouch) : <span style={{ color: "var(--muted)" }}>—</span>}</Td>
                <Td>{r.lastChannel ? <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--bg)", padding: "2px 8px", borderRadius: 4 }}>{r.lastChannel}</span> : <span style={{ color: "var(--muted)" }}>—</span>}</Td>
                <Td>{r.owner || <span style={{ color: "var(--muted)" }}>—</span>}</Td>
                <Td><span style={{ fontFamily: "'JetBrains Mono',monospace", color: r.value > 0 ? "var(--fg)" : "var(--muted)" }}>{r.value > 0 ? fmtCur(r.value) : "—"}</span></Td>
                <Td>{r.nextScheduled ? fmtDate(r.nextScheduled) : <span style={{ color: "var(--muted)" }}>—</span>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ═══ DEFERRED QUEUE ═══ */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px", marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 12 }}>
          Deferred queue <span style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)", marginLeft: 8 }}>{deferredQueue.length} awaiting re-trigger</span>
        </div>
        {deferredQueue.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "12px 0" }}>
            No prospects in the deferred queue. Replies classified as "ask me later" will appear here when automation goes live.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr><Th>Company</Th><Th>Deferred until</Th><Th>Original reply</Th></tr>
            </thead>
            <tbody>
              {deferredQueue.map((d, i) => {
                const r = rows.find((x) => x.id === d.dealId);
                return (
                  <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                    <Td>{r?.companyName || d.companyName || "—"}</Td>
                    <Td>{fmtDate(d.deferUntil)}</Td>
                    <Td><span style={{ color: "var(--muted)", fontStyle: "italic" }}>"{(d.originalReply || "").slice(0, 80)}{d.originalReply?.length > 80 ? "…" : ""}"</span></Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ═══ DRILL-DOWN PANEL ═══ */}
      {drilled && (
        <div style={{ background: "var(--card)", border: "1px solid var(--accent)", borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg)" }}>{drilled.companyName}</div>
              {drilled.dealName && drilled.dealName !== drilled.companyName && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{drilled.dealName}</div>}
            </div>
            <button onClick={() => setDrillId(null)} style={{ ...BTN, background: "#374151", color: "#9CA3AF" }}>Close</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 16 }}>
            <DetailField label="Stage" value={drilled.stage || "—"} />
            <DetailField label="Status" value={drilled.status ? <StatusPill status={drilled.status} /> : "—"} />
            <DetailField label="Quoted at" value={fmtDate(drilled.quotedAt)} />
            <DetailField label="Days since quoted" value={drilled.daysSinceQuoted != null ? `${drilled.daysSinceQuoted}d` : "—"} />
            <DetailField label="Owner" value={drilled.owner || "—"} />
            <DetailField label="Deal value" value={drilled.value > 0 ? fmtCur(drilled.value) : "—"} />
            <DetailField label="Created" value={fmtDate(drilled.createdAt)} />
            <DetailField label="Updated" value={fmtDate(drilled.updatedAt)} />
          </div>

          <div style={{ marginBottom: 12, fontSize: 11, color: "var(--muted)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>Channel content sent</div>
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px", marginBottom: 16, fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>
            No channel content yet — populated once GHL/Aimfox start sending.
          </div>

          <div style={{ marginBottom: 12, fontSize: 11, color: "var(--muted)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>Replies</div>
          {drilledReplies.length === 0 ? (
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px", marginBottom: 16, fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>
              No replies recorded.
            </div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              {drilledReplies.map((rep, i) => (
                <div key={i} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 14px", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, color: "var(--muted)", background: "var(--card)", padding: "2px 6px", borderRadius: 3 }}>{rep.channel}</span>
                    <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>{rep.classifierIntent}</span>
                    <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>{fmtDate(rep.classifiedAt)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--fg)" }}>{rep.body}</div>
                </div>
              ))}
            </div>
          )}

          {drilled.scorecardUrl && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Generated scorecard</div>
              <a href={drilled.scorecardUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontSize: 13, textDecoration: "none" }}>📊 Open scorecard deck ↗</a>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            {drilled.companyId && (
              <a href={`https://app.attio.com/${ATTIO_WORKSPACE}/company/${drilled.companyId}`} target="_blank" rel="noopener noreferrer" style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)", textDecoration: "none", display: "inline-block" }}>Open in Attio ↗</a>
            )}
            <span style={{ ...BTN, background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)", cursor: "default" }}>GHL contact (pending)</span>
            <span style={{ ...BTN, background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)", cursor: "default" }}>Aimfox contact (pending)</span>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────
function FunnelStat({ label, value, hint, accent, muted }) {
  return (
    <div style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 16px", opacity: muted ? 0.5 : 1 }}>
      <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent || "var(--fg)", fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
function SubStat({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", background: "var(--bg)", borderRadius: 6 }}>
      <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: value > 0 ? "var(--fg)" : "var(--muted)", fontFamily: "'JetBrains Mono',monospace" }}>{value}</span>
    </div>
  );
}
function StatusPill({ status }) {
  if (!status) return <span style={{ color: "var(--muted)" }}>—</span>;
  const c = STATUS_COLORS[status] || "var(--muted)";
  return <span style={{ fontSize: 10, fontWeight: 700, color: c, background: `${c}20`, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{status}</span>;
}
function FilterSelect({ label, value, onChange, options }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase" }}>{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 12, outline: "none" }}>
        {options.map((o) => <option key={o} value={o}>{o === "all" ? "All" : o}</option>)}
      </select>
    </div>
  );
}
function Th({ children }) {
  return <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: "10px 14px", color: "var(--fg)" }}>{children}</td>;
}
function DetailField({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--fg)", fontWeight: 600 }}>{value}</div>
    </div>
  );
}
