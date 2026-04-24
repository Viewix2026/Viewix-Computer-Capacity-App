// Sale Pricing editor — lives under the Sale tab as a third subtab
// ("Pricing") alongside Payment Intake + Quotes. Anyone with Sale
// access (founders, closers, leads) can *view* the defaults so they
// know what to quote; only founders can *edit* them.
//
// Founders enter the TOTAL ex-GST per package. The customer pays the
// grand total (ex-GST + 10% GST) split into instalments per the
// package's billing schedule:
//   Meta Ads          → 50 / 50  (deposit + manual balance)
//   Social (P/O)      → 3 × 33.33% (today, +30d, +60d auto)
//   One-off types     → 50 / 50  (deposit + manual balance)
//
// Everything derives from the single ex-GST number so there's one
// source of truth. Persisted to /salePricing via the debounced bulk-
// write in App.jsx.

import { SALE_VIDEO_TYPES, DEFAULT_SALE_PRICING } from "../config";
import { fmtCurExact, computeGst, buildSchedule } from "../utils";
import { scheduleForVideoType } from "../../api/_tiers";

export function SalePricingEditor({ salePricing, setSalePricing, canEdit = true }) {
  const pricing = salePricing || DEFAULT_SALE_PRICING;
  const update = (videoType, packageKey, value) => {
    if (!canEdit) return;
    const next = {
      ...pricing,
      [videoType]: { ...(pricing[videoType] || {}), [packageKey]: Number(value) || 0 },
    };
    setSalePricing(next);
  };

  const scheduleSummary = (videoType) => {
    const cfg = scheduleForVideoType(videoType);
    if (cfg.kind === "deposit_plus_manual")  return "50% deposit + 50% on project completion";
    if (cfg.kind === "subscription_monthly") return "3 equal payments (today, +30d, +60d auto)";
    if (cfg.kind === "paid_in_full")          return "Paid in full at checkout";
    return "";
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)" }}>Sale Pricing — Total Project Amounts (ex-GST)</div>
          {!canEdit && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B", background: "rgba(245,158,11,0.12)", padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              View only · Founders edit
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
          {canEdit
            ? <>Enter the <strong>total project amount ex-GST</strong> for each package. The customer sees GST (10%) added on top, then pays it in instalments per the package's billing schedule (shown next to each row). Closers can override per-sale.</>
            : <>Reference pricing for each package. Only founders can edit these values — head to a founder if one needs adjusting.</>
          }
        </div>
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        {SALE_VIDEO_TYPES.map(vt => (
          <div key={vt.key} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)" }}>{vt.label}</div>
              <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>{scheduleSummary(vt.key)}</div>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {vt.packages.map(p => {
                const totalExGst = Number(pricing?.[vt.key]?.[p.key] ?? 0);
                const { gstAmount, grandTotal } = computeGst(totalExGst);
                const schedule = totalExGst > 0 ? buildSchedule(vt.key, totalExGst, null) : [];
                return (
                  <div key={p.key} style={{
                    display: "grid",
                    gridTemplateColumns: "1.1fr 1fr 1.3fr",
                    gap: 16,
                    alignItems: "center",
                    padding: "12px 14px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                  }}>
                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
                        {p.label} — Total (ex-GST)
                      </label>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", background: "var(--input-bg)", border: `1px solid ${totalExGst > 0 ? "var(--border)" : "#F59E0B55"}`, borderRadius: 8, opacity: canEdit ? 1 : 0.7 }}>
                        <span style={{ fontSize: 13, color: "var(--muted)" }}>$</span>
                        <input
                          type="number" value={totalExGst || ""}
                          onChange={e => update(vt.key, p.key, e.target.value)}
                          placeholder="0" step={50}
                          disabled={!canEdit}
                          style={{ flex: 1, width: "100%", border: "none", background: "transparent", color: "var(--fg)", fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", cursor: canEdit ? "text" : "not-allowed" }}
                        />
                      </div>
                      <div style={{ fontSize: 10, color: totalExGst > 0 ? "var(--muted)" : "#F59E0B", marginTop: 4 }}>
                        {totalExGst > 0 ? "Ex-GST" : "Not set"}
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 4, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)" }}>
                        <span style={{ fontFamily: "inherit" }}>GST (10%)</span>
                        <span>{fmtCurExact(gstAmount)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", borderTop: "1px dashed var(--border)", paddingTop: 4, marginTop: 2 }}>
                        <span style={{ fontFamily: "inherit" }}>Project total</span>
                        <span>{fmtCurExact(grandTotal)}</span>
                      </div>
                      {schedule.length > 0 && (() => {
                        const totalSurcharge = schedule.reduce((sum, s) => sum + (Number(s.surcharge) || 0), 0);
                        const customerPays = grandTotal + totalSurcharge;
                        return (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)" }}>
                              <span style={{ fontFamily: "inherit" }}>Card fee (\u00d7{schedule.length})</span>
                              <span>{fmtCurExact(totalSurcharge)}</span>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--fg)", fontWeight: 700, borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 2 }}>
                              <span style={{ fontFamily: "inherit" }}>Customer pays</span>
                              <span>{fmtCurExact(customerPays)}</span>
                            </div>
                          </>
                        );
                      })()}
                    </div>

                    <div>
                      {schedule.length === 0 ? (
                        <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>Set a price to see instalments</div>
                      ) : (
                        <div style={{ display: "grid", gap: 2, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                          {schedule.map((s, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", color: s.trigger === "now" ? "var(--fg)" : "var(--muted)" }}>
                              <span style={{ fontFamily: "inherit" }}>
                                {s.label} · {s.trigger === "now" ? "Today" : s.trigger === "auto" ? `${s.dueDaysOffset}d` : "Manual"}
                              </span>
                              <span style={{ fontWeight: s.trigger === "now" ? 700 : 500 }}>{fmtCurExact(s.amount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {canEdit && (
        <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(0,130,250,0.08)", border: "1px solid rgba(0,130,250,0.25)", borderRadius: 8, fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
          <strong style={{ color: "var(--fg)" }}>Changes auto-save.</strong> New payment links use the latest defaults; already-sent links keep the total captured at creation time — their schedule can't change once any instalment is paid.
        </div>
      )}
    </div>
  );
}
