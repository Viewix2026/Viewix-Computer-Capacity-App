// Sale tab: wraps the Payment Intake flow + the existing Quoting flow under
// two subtabs. The Quotes subtab is the same UI that used to live directly
// in App.jsx under the old "Quoting" sidebar item — lifted here verbatim so
// state still lives at the App level and Firebase sync is unchanged.
//
// Payment Intake lets closers/leads/founders create a branded Stripe payment
// link for a package deposit. Defaults for deposit amounts are edited in the
// Founders tab's "Pricing" subtab (/salePricing in Firebase).

import { useState, useMemo } from "react";
import { BTN, QUOTE_SECTIONS, DEFAULT_RATE_CARDS, TH, SALE_VIDEO_TYPES, DEFAULT_SALE_PRICING } from "../config";
import { fmtCur, fmtCurExact, saleShareUrl, newSale, computeGst, buildSchedule } from "../utils";
import { scheduleForVideoType } from "../../api/_tiers";
import { fbSetAsync } from "../firebase";
import { QuoteCalc } from "./QuoteCalc";
import { SalePricingEditor } from "./SalePricingEditor";

function getPackageDefault(pricing, videoType, packageKey) {
  return Number(pricing?.[videoType]?.[packageKey] ?? 0);
}

export function Sale({
  // Sale (Payment Intake) state
  sales, setSales, salePricing, setSalePricing, isFounders,
  saleTab, setSaleTab,
  // Quotes state (lifted from App.jsx)
  quotes, setQuotes, activeQuoteId, setActiveQuoteId,
  clientRateCards, setClientRateCards,
  clientFilter, setClientFilter,
  qTab, setQTab,
  rcAdding, setRcAdding, rcNewName, setRcNewName, rcAddRef,
  rcEditId, setRcEditId, rcConfirmDelete, setRcConfirmDelete,
  rcShowArchive, setRcShowArchive,
  createQuote, duplicateQuote, updateQuote, deleteQuote,
}) {
  const [form, setForm] = useState({ creating: false, ...newSale() });
  const [copyFlash, setCopyFlash] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Charge Balance flow state — modal open on a specific sale, result copy,
  // loading flag, error. Only one sale can be mid-charge at a time so we
  // hold the sale id rather than per-sale state.
  const [chargingSale, setChargingSale] = useState(null);
  const [chargeLoading, setChargeLoading] = useState(false);
  const [chargeResult, setChargeResult] = useState(null);

  const pricing = salePricing || DEFAULT_SALE_PRICING;

  // Merged rate cards (same calc as App.jsx previously did inline)
  const rcArr = Array.isArray(clientRateCards) ? clientRateCards : [];
  const hiddenIds = rcArr.filter(c => c && c.deleted).map(c => c.id.replace("del-", ""));
  const visibleDefaults = DEFAULT_RATE_CARDS.filter(d => !hiddenIds.includes(d.id));
  const customOnly = rcArr.filter(c => c && !c.deleted && !c.archived);
  const archivedCards = rcArr.filter(c => c && c.archived);
  const allRateCards = [...visibleDefaults, ...customOnly];

  const activeQuote = quotes.find(q => q.id === activeQuoteId);

  // Pre-fill total from pricing whenever video type / package changes,
  // unless the founder/closer has typed a manual override (totalTouched).
  // Also rebuilds GST + grand total + schedule on every edit so the
  // preview always matches what the customer will see.
  const updateForm = (patch) => {
    setForm(f => {
      const next = { ...f, ...patch };
      if ((patch.videoType !== undefined || patch.packageKey !== undefined) && !next.totalTouched) {
        next.totalExGst = getPackageDefault(pricing, next.videoType, next.packageKey);
      }
      const { gstAmount, grandTotal } = computeGst(next.totalExGst || 0);
      next.gstAmount  = gstAmount;
      next.grandTotal = grandTotal;
      next.schedule   = buildSchedule(next.videoType, next.totalExGst || 0, null);
      return next;
    });
  };

  const resetForm = () => setForm({ creating: false, ...newSale() });

  const startNew = () => {
    const seed = newSale();
    seed.totalExGst = getPackageDefault(pricing, seed.videoType, seed.packageKey);
    const { gstAmount, grandTotal } = computeGst(seed.totalExGst);
    seed.gstAmount  = gstAmount;
    seed.grandTotal = grandTotal;
    seed.schedule   = buildSchedule(seed.videoType, seed.totalExGst, null);
    setForm({ creating: true, ...seed });
  };

  const saveSale = () => {
    if (!form.clientName.trim()) return;
    const { creating, totalTouched, ...rest } = form;
    const record = { ...rest, clientName: rest.clientName.trim() };
    setSales(p => [...p, record]);
    // Write the new record directly so the share link works immediately —
    // the debounced bulk-write in App.jsx would otherwise leave a ~400ms
    // window where clicking Preview scans /sales and finds no match.
    if (record.id) {
      fbSetAsync(`/sales/${record.id}`, record).catch(e => {
        console.error("Failed to persist new sale:", e);
      });
    }
    resetForm();
  };

  const deleteSale = (id) => {
    setSales(p => p.filter(s => s.id !== id));
    setConfirmDelete(null);
  };

  const copyLink = (s) => {
    const url = saleShareUrl(s);
    try { navigator.clipboard.writeText(url); } catch {}
    setCopyFlash(s.id);
    setTimeout(() => setCopyFlash(null), 1500);
  };

  const packagesFor = (vt) => SALE_VIDEO_TYPES.find(t => t.key === vt)?.packages || [];
  const packageLabel = (vt, pk) => packagesFor(vt).find(p => p.key === pk)?.label || pk;
  const videoLabel = (vt) => SALE_VIDEO_TYPES.find(t => t.key === vt)?.label || vt;

  // Compute a compact status + optional action for a sale row. Handles
  // legacy records (paid flag only, no schedule) and new records
  // (schedule[] with per-slice status).
  //
  // Returns { label, color, action }:
  //   label   — pill copy
  //   color   — pill tint
  //   action  — null, or { kind: "chargeBalance", sliceIdx, amount, label }
  const saleStatus = (s) => {
    const schedule = Array.isArray(s.schedule) ? s.schedule : [];
    if (schedule.length === 0) {
      return { label: s.paid ? "PAID" : "AWAITING PAYMENT", color: s.paid ? "#10B981" : "#F59E0B", action: null };
    }
    const paidCount = schedule.filter(x => x.status === "paid").length;
    if (paidCount === 0) return { label: "AWAITING DEPOSIT", color: "#F59E0B", action: null };
    if (paidCount === schedule.length) return { label: "PAID", color: "#10B981", action: null };

    const nextIdx = schedule.findIndex(x => x.status !== "paid");
    const nextSlice = schedule[nextIdx];
    const label = `${paidCount}/${schedule.length} PAID`;
    const action = nextSlice.trigger === "manual"
      ? { kind: "chargeBalance", sliceIdx: nextIdx, amount: nextSlice.amount, label: nextSlice.label }
      : null;
    return { label, color: "#0082FA", action };
  };

  const chargeBalance = async (s, sliceIdx) => {
    setChargeLoading(true);
    setChargeResult(null);
    try {
      const r = await fetch("/api/charge-sale-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saleId: s.id, sliceIdx }),
      });
      const d = await r.json();
      if (r.ok && d.status === "succeeded") {
        setChargeResult({ kind: "success", message: `Charged successfully. Stripe receipt on its way; the row will update once the webhook lands (usually a second or two).` });
      } else if (d.status === "requires_action" || d.status === "authentication_required") {
        setChargeResult({ kind: "warn", message: d.message || "Customer's bank requires 3D Secure re-authentication. Email them to complete the charge." });
      } else {
        setChargeResult({ kind: "error", message: d.error || d.message || `Unexpected status: ${d.status}` });
      }
    } catch (e) {
      setChargeResult({ kind: "error", message: e.message });
    } finally {
      setChargeLoading(false);
    }
  };

  return (<>
    {/* Top header: title + subtab switch */}
    <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Sale</span>
        <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3,marginLeft:12}}>
          <button onClick={()=>setSaleTab("payment")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:saleTab==="payment"?"var(--card)":"transparent",color:saleTab==="payment"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Payment Intake</button>
          <button onClick={()=>setSaleTab("quotes")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:saleTab==="quotes"?"var(--card)":"transparent",color:saleTab==="quotes"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Quotes</button>
          <button onClick={()=>setSaleTab("pricing")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:saleTab==="pricing"?"var(--card)":"transparent",color:saleTab==="pricing"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Pricing</button>
        </div>
        {saleTab==="quotes"&&!activeQuoteId&&(<div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3,marginLeft:8}}>
          <button onClick={()=>setQTab("quotes")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:qTab==="quotes"?"var(--card)":"transparent",color:qTab==="quotes"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Quotes</button>
          <button onClick={()=>setQTab("ratecards")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:qTab==="ratecards"?"var(--card)":"transparent",color:qTab==="ratecards"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Rate Cards</button>
        </div>)}
      </div>
      {saleTab==="payment"&&!form.creating&&<button onClick={startNew} style={{...BTN,background:"var(--accent)",color:"white"}}>+ New Sale</button>}
      {saleTab==="quotes"&&!activeQuoteId&&qTab==="quotes"&&<button onClick={()=>createQuote("New Client")} style={{...BTN,background:"var(--accent)",color:"white"}}>+ New Quote</button>}
    </div>

    <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 28px 60px"}}>

    {/* ── PAYMENT INTAKE ── */}
    {saleTab==="payment"&&(<>
      {form.creating&&(<div style={{marginBottom:20,padding:"20px 24px",background:"var(--card)",border:"1px solid var(--accent)",borderRadius:12}}>
        <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:16}}>New Sale — Payment Link</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>Video Type</label>
            <select value={form.videoType} onChange={e=>updateForm({videoType:e.target.value,packageKey:packagesFor(e.target.value)[0]?.key||"starter"})} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:600,outline:"none"}}>
              {SALE_VIDEO_TYPES.map(t=>(<option key={t.key} value={t.key}>{t.label}</option>))}
            </select>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>Package</label>
            <select value={form.packageKey} onChange={e=>updateForm({packageKey:e.target.value})} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:600,outline:"none"}}>
              {packagesFor(form.videoType).map(p=>(<option key={p.key} value={p.key}>{p.label}</option>))}
            </select>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>Client Name</label>
            <input type="text" value={form.clientName} onChange={e=>updateForm({clientName:e.target.value})} placeholder="Acme Co." style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:600,outline:"none"}}/>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>Client Logo URL</label>
            <input type="text" value={form.logoUrl} onChange={e=>updateForm({logoUrl:e.target.value})} placeholder="https://..." style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none"}}/>
          </div>
        </div>
        <div style={{marginBottom:12}}>
          <label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>Scope Notes (shown to customer)</label>
          <textarea value={form.scopeNotes} onChange={e=>updateForm({scopeNotes:e.target.value})} rows={4} placeholder="What the customer is paying a deposit for — this will appear on their payment page." style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontFamily:"inherit",outline:"none",resize:"vertical"}}/>
        </div>
        <div style={{marginBottom:16,padding:"16px",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:10}}>
          <label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",display:"block",marginBottom:6}}>Total Project Amount (ex-GST)</label>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <span style={{fontSize:16,color:"var(--muted)"}}>$</span>
            <input type="number" value={form.totalExGst||""} onChange={e=>updateForm({totalExGst:parseFloat(e.target.value)||0,totalTouched:true})} step={50} style={{flex:1,maxWidth:200,padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",outline:"none"}}/>
            <span style={{fontSize:11,color:"var(--muted)"}}>Default for {packageLabel(form.videoType,form.packageKey)}: {fmtCur(getPackageDefault(pricing,form.videoType,form.packageKey))} ex-GST</span>
          </div>
          {getPackageDefault(pricing,form.videoType,form.packageKey)===0&&(<div style={{marginBottom:12,fontSize:11,color:"#F59E0B"}}>⚠ No default set for this package. {isFounders ? "Set one in the Pricing tab." : "Ask a founder to set one in the Pricing tab."}</div>)}

          {/* Live breakdown: GST + grand total + instalment schedule */}
          {form.totalExGst>0&&(<div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:16,paddingTop:12,borderTop:"1px dashed var(--border)"}}>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Customer sees</div>
              <div style={{display:"grid",gap:4,fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>
                <div style={{display:"flex",justifyContent:"space-between",color:"var(--muted)"}}><span style={{fontFamily:"inherit"}}>Subtotal (ex-GST)</span><span>{fmtCurExact(form.totalExGst)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",color:"var(--muted)"}}><span style={{fontFamily:"inherit"}}>GST (10%)</span><span>{fmtCurExact(form.gstAmount)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",color:"var(--fg)",fontWeight:700,borderTop:"1px solid var(--border)",paddingTop:4,marginTop:2}}><span style={{fontFamily:"inherit"}}>Grand total</span><span>{fmtCurExact(form.grandTotal)}</span></div>
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Paid as ({scheduleForVideoType(form.videoType).kind === "deposit_plus_manual" ? "deposit + manual balance" : scheduleForVideoType(form.videoType).kind === "subscription_monthly" ? "3 auto-payments" : "paid in full"})</div>
              <div style={{display:"grid",gap:4,fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>
                {(form.schedule||[]).map((s,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",color:s.trigger==="now"?"var(--fg)":"var(--muted)"}}>
                    <span style={{fontFamily:"inherit"}}>{s.label} · {s.trigger==="now"?"Today":s.trigger==="auto"?`${s.dueDaysOffset}d`:"Manual"}</span>
                    <span style={{fontWeight:s.trigger==="now"?700:500}}>{fmtCurExact(s.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>)}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={saveSale} disabled={!form.clientName.trim()||!form.totalExGst} style={{...BTN,background:(form.clientName.trim()&&form.totalExGst)?"var(--accent)":"#374151",color:"white",opacity:(form.clientName.trim()&&form.totalExGst)?1:0.6}}>Create Payment Link</button>
          <button onClick={resetForm} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
        </div>
      </div>)}

      {/* Sales list */}
      {sales.length===0&&!form.creating?(<div style={{textAlign:"center",padding:"60px 20px",color:"var(--muted)"}}><div style={{fontSize:40,marginBottom:12}}>💰</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No payment links yet</div><div style={{fontSize:13}}>Click "+ New Sale" to generate a branded deposit link.</div></div>):(
        <div style={{display:"grid",gap:10}}>
          {[...sales].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(s=>{
            const url=saleShareUrl(s);
            const status=saleStatus(s);
            const showChargeBalance = status.action?.kind === "chargeBalance" && isFounders;
            return(<div key={s.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"14px 18px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                    <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>{s.clientName}</span>
                    <span style={{fontSize:10,fontWeight:700,color:status.color==="#10B981"?"white":status.color,background:status.color==="#10B981"?"#10B981":status.color==="#F59E0B"?"rgba(245,158,11,0.12)":"rgba(0,130,250,0.12)",padding:"3px 8px",borderRadius:4}}>{status.label}</span>
                    {status.action && <span style={{fontSize:10,color:"var(--muted)",fontFamily:"'JetBrains Mono',monospace"}}>{status.action.label} · {fmtCurExact(status.action.amount)} pending</span>}
                  </div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>{videoLabel(s.videoType)} · {packageLabel(s.videoType,s.packageKey)} · <span style={{color:"#10B981",fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{fmtCur(s.grandTotal||s.depositAmount||0)}</span>{s.grandTotal?<span style={{color:"var(--muted)",fontWeight:500,fontSize:11}}> inc-GST</span>:null} · {new Date(s.createdAt).toLocaleDateString("en-AU")}</div>
                  <div style={{fontSize:11,color:"var(--accent)",marginTop:6,wordBreak:"break-all"}}>{url}</div>
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0,flexWrap:"wrap",justifyContent:"flex-end"}}>
                  {showChargeBalance && (
                    <button onClick={()=>{setChargingSale(s);setChargeResult(null);}} style={{...BTN,background:"#10B981",color:"white"}}>Charge Balance</button>
                  )}
                  <button onClick={()=>copyLink(s)} style={{...BTN,background:copyFlash===s.id?"#10B981":"var(--bg)",color:copyFlash===s.id?"white":"var(--accent)",border:"1px solid var(--border)"}}>{copyFlash===s.id?"Copied!":"Copy Link"}</button>
                  <a href={url} target="_blank" rel="noopener noreferrer" style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)",textDecoration:"none",display:"inline-flex",alignItems:"center"}}>Preview ↗</a>
                  {confirmDelete===s.id?(
                    <>
                      <button onClick={()=>deleteSale(s.id)} style={{...BTN,background:"#EF4444",color:"white"}}>Confirm</button>
                      <button onClick={()=>setConfirmDelete(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
                    </>
                  ):(
                    <button onClick={()=>setConfirmDelete(s.id)} style={{...BTN,background:"#374151",color:"#EF4444"}}>Delete</button>
                  )}
                </div>
              </div>
            </div>);
          })}
        </div>
      )}

      {/* Charge Balance confirm modal — overlay with a confirm step,
          live loading state, and post-result messaging (success /
          requires-auth / error). Webhook updates the sale record on
          success so the list re-renders automatically. */}
      {chargingSale && (()=>{
        const action = saleStatus(chargingSale).action;
        if (!action) return null;
        const paidSlice = (chargingSale.schedule||[])[0];
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(10,18,40,0.65)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:14,padding:"24px 28px",maxWidth:480,width:"100%"}}>
              <div style={{fontSize:16,fontWeight:800,color:"var(--fg)",marginBottom:8}}>Charge Balance — {chargingSale.clientName}</div>
              <div style={{fontSize:13,color:"var(--muted)",marginBottom:18,lineHeight:1.55}}>
                Charge <strong style={{color:"var(--fg)",fontFamily:"'JetBrains Mono',monospace"}}>{fmtCurExact(action.amount)}</strong> to the card on file (saved when the deposit of {fmtCurExact(paidSlice?.amount||0)} cleared)?
                <div style={{marginTop:8,fontSize:12,color:"var(--muted)"}}>If the bank requires re-authentication, we'll surface that and you can email the customer to complete the charge.</div>
              </div>

              {chargeResult && (
                <div style={{marginBottom:16,padding:"12px 14px",borderRadius:8,fontSize:13,lineHeight:1.5,
                  background: chargeResult.kind==="success"?"rgba(16,185,129,0.1)":chargeResult.kind==="warn"?"rgba(245,158,11,0.1)":"rgba(239,68,68,0.1)",
                  border: `1px solid ${chargeResult.kind==="success"?"rgba(16,185,129,0.3)":chargeResult.kind==="warn"?"rgba(245,158,11,0.3)":"rgba(239,68,68,0.3)"}`,
                  color: chargeResult.kind==="success"?"#065F46":chargeResult.kind==="warn"?"#92400E":"#991B1B",
                }}>
                  {chargeResult.message}
                </div>
              )}

              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                {chargeResult?.kind === "success" ? (
                  <button onClick={()=>{setChargingSale(null);setChargeResult(null);}} style={{...BTN,background:"var(--accent)",color:"white"}}>Close</button>
                ) : (
                  <>
                    <button onClick={()=>{setChargingSale(null);setChargeResult(null);}} disabled={chargeLoading} style={{...BTN,background:"#374151",color:"#9CA3AF",opacity:chargeLoading?0.5:1,cursor:chargeLoading?"not-allowed":"pointer"}}>Cancel</button>
                    <button onClick={()=>chargeBalance(chargingSale, action.sliceIdx)} disabled={chargeLoading} style={{...BTN,background:chargeLoading?"#4B5563":"#10B981",color:"white",opacity:chargeLoading?0.7:1,cursor:chargeLoading?"wait":"pointer"}}>
                      {chargeLoading ? "Charging…" : `Charge ${fmtCurExact(action.amount)}`}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </>)}

    {/* ── PRICING (ex-Founders → moved here so closers/leads can reference
           the totals while creating a sale; edit access is still gated to
           founders). ── */}
    {saleTab==="pricing"&&(
      <SalePricingEditor salePricing={salePricing} setSalePricing={setSalePricing} canEdit={!!isFounders} />
    )}

    {/* ── QUOTES (lifted from App.jsx) ── */}
    {saleTab==="quotes"&&(<>
      {/* Rate Cards Management */}
      {!activeQuoteId&&qTab==="ratecards"&&(<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Client Rate Cards</div>
          {!rcAdding&&<button onClick={()=>setRcAdding(true)} style={{...BTN,background:"var(--accent)",color:"white"}}>+ New Rate Card</button>}
        </div>
        {rcAdding&&(<div style={{marginBottom:16,padding:"12px 16px",background:"var(--card)",border:"1px solid var(--accent)",borderRadius:10,display:"flex",alignItems:"center",gap:8}}>
          <input ref={rcAddRef} autoFocus type="text" value={rcNewName} onChange={e=>setRcNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&rcNewName.trim()){const rc={id:`rc-${Date.now()}`,name:rcNewName.trim(),rates:{}};QUOTE_SECTIONS.forEach(s=>s.items.forEach(it=>{rc.rates[it.role]=it.rate;}));setClientRateCards(p=>[...p,rc]);setRcNewName("");setRcAdding(false);}if(e.key==="Escape"){setRcAdding(false);setRcNewName("");}}} placeholder="Client name..." style={{flex:1,padding:"8px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:600,outline:"none"}}/>
          <button onClick={()=>{if(!rcNewName.trim())return;const rc={id:`rc-${Date.now()}`,name:rcNewName.trim(),rates:{}};QUOTE_SECTIONS.forEach(s=>s.items.forEach(it=>{rc.rates[it.role]=it.rate;}));setClientRateCards(p=>[...p,rc]);setRcNewName("");setRcAdding(false);}} style={{...BTN,background:"var(--accent)",color:"white"}}>Create</button>
          <button onClick={()=>{setRcAdding(false);setRcNewName("");}} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
        </div>)}
        <div style={{display:"grid",gap:12}}>
          {allRateCards.map(rc=>{
            const isCustom=customOnly.some(c=>c.id===rc.id);
            const isDefault=DEFAULT_RATE_CARDS.some(d=>d.id===rc.id);
            const isEditing=rcEditId===rc.id;
            const updateRate=(role,val)=>{
              if(isCustom){
                setClientRateCards(p=>p.map(c=>c.id===rc.id?{...c,rates:{...c.rates,[role]:val}}:c));
              } else if(isDefault){
                const copy={...rc,id:`rc-${Date.now()}`,rates:{...rc.rates,[role]:val}};
                setClientRateCards(p=>[...p,copy,{id:`del-${rc.id}`,name:rc.name,deleted:true}]);
                setRcEditId(copy.id);
              }
            };
            const deleteCard=()=>{
              if(isCustom){
                setClientRateCards(p=>p.map(c=>c.id===rc.id?{...c,archived:true}:c));
              } else if(isDefault){
                setClientRateCards(p=>[...p,{id:`del-${rc.id}`,name:rc.name,deleted:true}]);
              }
              if(rcEditId===rc.id)setRcEditId(null);
              setRcConfirmDelete(null);
            };
            return(<div key={rc.id} style={{background:"var(--card)",border:`1px solid ${isEditing?"var(--accent)":"var(--border)"}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid var(--border)"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:14,fontWeight:700,color:"var(--fg)"}}>{rc.name}</span>
                  <span style={{fontSize:10,color:"var(--muted)",background:"var(--bg)",padding:"2px 8px",borderRadius:4}}>{isDefault?"Built-in":"Custom"}</span>
                  <span style={{fontSize:10,color:"var(--muted)"}}>{Object.keys(rc.rates||{}).length} rates</span>
                </div>
                <div style={{display:"flex",gap:8}}>
                  {!isEditing&&<button onClick={()=>setRcEditId(rc.id)} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>Edit Rates</button>}
                  {isEditing&&<button onClick={()=>setRcEditId(null)} style={{...BTN,background:"#10B981",color:"white"}}>Done</button>}
                  {rcConfirmDelete===rc.id?(
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#EF4444",fontWeight:600}}>Are you sure?</span>
                      <button onClick={deleteCard} style={{...BTN,background:"#EF4444",color:"white"}}>Yes, Archive</button>
                      <button onClick={()=>setRcConfirmDelete(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
                    </div>
                  ):(
                    <button onClick={()=>setRcConfirmDelete(rc.id)} style={{...BTN,background:"#374151",color:"#EF4444"}}>Delete</button>
                  )}
                </div>
              </div>
              {isEditing?(<div style={{padding:"12px 16px"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr><th style={{...TH,textAlign:"left"}}>Role</th><th style={{...TH,textAlign:"right",width:120}}>Rate/h</th></tr></thead>
                <tbody>{Object.entries(rc.rates||{}).map(([role,rate])=>(<tr key={role}><td style={{padding:"4px 8px",color:"var(--fg)"}}>{role}</td><td style={{padding:"4px 8px"}}><input type="number" value={rate} onChange={e=>updateRate(role,parseFloat(e.target.value)||0)} step={0.5} style={{width:100,padding:"4px 8px",borderRadius:4,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",outline:"none",textAlign:"right"}}/></td></tr>))}</tbody>
              </table></div>):(
              <div style={{padding:"12px 16px",display:"flex",flexWrap:"wrap",gap:6}}>
                {Object.entries(rc.rates||{}).filter(([_,v])=>v>0).map(([role,rate])=>(
                  <div key={role} style={{fontSize:11,color:"var(--muted)",background:"var(--bg)",padding:"3px 8px",borderRadius:4}}>
                    <span style={{color:"var(--fg)",fontWeight:600}}>{role}:</span> {fmtCur(rate)}
                  </div>
                ))}
              </div>)}
            </div>);
          })}
        </div>
        {archivedCards.length>0&&(<div style={{marginTop:24}}>
          <button onClick={()=>setRcShowArchive(!rcShowArchive)} style={{...BTN,background:"transparent",color:"var(--muted)",border:"1px solid var(--border)"}}>
            {rcShowArchive?"Hide":"Show"} Archived ({archivedCards.length})
          </button>
          {rcShowArchive&&(<div style={{display:"grid",gap:8,marginTop:12}}>
            {archivedCards.map(rc=>(<div key={rc.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"12px 16px",opacity:0.6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{rc.name}</span>
                <span style={{fontSize:10,color:"var(--muted)",background:"var(--bg)",padding:"2px 8px",borderRadius:4}}>Archived</span>
              </div>
              <button onClick={()=>setClientRateCards(p=>p.map(c=>c.id===rc.id?{...c,archived:false}:c))} style={{...BTN,background:"var(--accent)",color:"white"}}>Restore</button>
            </div>))}
          </div>)}
        </div>)}
      </div>)}

      {/* Quotes List / Active Quote */}
      {activeQuoteId&&activeQuote?(
        <QuoteCalc quote={activeQuote} onUpdate={updateQuote} onBack={()=>setActiveQuoteId(null)} rateCards={allRateCards}/>
      ):activeQuoteId&&!activeQuote?(
        <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>Quote not found. <button onClick={()=>setActiveQuoteId(null)} style={{...BTN,background:"var(--accent)",color:"white",marginLeft:8}}>Back to Quotes</button></div>
      ):qTab==="quotes"?(
        <div>
          {quotes.length>0&&(<div style={{marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase"}}>Filter by client:</span>
            <select value={clientFilter} onChange={e=>setClientFilter(e.target.value)} style={{padding:"6px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none"}}>
              <option value="">All Clients</option>
              {[...new Set(quotes.map(q=>q.clientName))].sort().map(name=>(<option key={name} value={name}>{name}</option>))}
            </select>
            {clientFilter&&<button onClick={()=>setClientFilter("")} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Clear</button>}
            <span style={{fontSize:12,color:"var(--muted)",marginLeft:"auto"}}>{(clientFilter?quotes.filter(q=>q.clientName===clientFilter):quotes).length} quote{(clientFilter?quotes.filter(q=>q.clientName===clientFilter):quotes).length!==1?"s":""}</span>
          </div>)}
          {quotes.length===0?(<div style={{textAlign:"center",padding:"60px 20px",color:"var(--muted)"}}><div style={{fontSize:40,marginBottom:12}}>💰</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No quotes yet</div><div style={{fontSize:13}}>Click "+ New Quote" to create your first quote.</div></div>):(
            <div style={{display:"grid",gap:12}}>
              {(clientFilter?quotes.filter(q=>q.clientName===clientFilter):quotes).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(q=>{
                const cost=q.items.reduce((s,it)=>s+(it.rateOverride??it.rate)*(it.hours||0),0)+(q.customItems||[]).reduce((s,it)=>s+it.rate*(it.hours||0),0);
                const sell=q.sellPriceMode&&q.sellPrice?q.sellPrice:cost>0?cost*(1+(q.margin||0.4)):0;
                return(<div key={q.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"16px 20px",cursor:"pointer",transition:"all 0.15s"}} onClick={()=>setActiveQuoteId(q.id)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>{q.clientName}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{q.locked?"Locked":"Draft"} · {new Date(q.createdAt).toLocaleDateString("en-AU")}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtCur(sell)}</div><div style={{fontSize:10,color:"var(--muted)"}}>ex GST</div></div>
                      <button onClick={e=>{e.stopPropagation();duplicateQuote(q);}} style={{...BTN,background:"#374151",color:"#9CA3AF"}} title="Duplicate">⧉</button>
                      {!q.locked&&<button onClick={e=>{e.stopPropagation();deleteQuote(q.id);}} style={{...BTN,background:"#374151",color:"#EF4444"}} title="Delete">x</button>}
                    </div>
                  </div>
                </div>);
              })}
            </div>
          )}
        </div>
      ):null}
    </>)}

    </div>
  </>);
}
