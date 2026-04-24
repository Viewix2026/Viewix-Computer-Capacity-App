// Public payment page served at /s/{shortId}/{slug}.
// Resolves the sale record from Firebase, requests a Stripe Embedded
// Checkout Session from /api/create-checkout-session, and mounts the
// Stripe-hosted iframe inline inside our Studio-branded page. The
// customer never leaves — Stripe owns the card-entry UI, subscription
// schedule, retries, SCA, dunning; we own the wrapper.
//
// Mirrors the auth pattern in DeliveryPublicView: anonymous sign-in
// + indexed scan by shortId. Upgraded from Stripe Elements (one-time
// charges) to Embedded Checkout (payment / subscription / setup modes)
// so we can support Meta Ads 50/50 manual-balance flows AND Social
// Media 3-payment autopay schedules with one code path.

import { useState, useEffect, useMemo } from "react";
import { initFB, onFB, fbListen, signInAnonymouslyForPublic } from "../firebase";
import { Logo } from "./Logo";
import { SALE_VIDEO_TYPES } from "../config";
import { fmtCur, fmtCurExact, logoBg, embedUrl, isEmbeddableBookingUrl, normaliseImageUrl } from "../utils";
import { scheduleForVideoType } from "../../api/_tiers";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
// Module-level singleton: Stripe.js rejects re-initialization with the same key,
// and this module can re-evaluate across hot reloads during dev.
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null;

function packageLabel(videoType, packageKey) {
  const vt = SALE_VIDEO_TYPES.find(t => t.key === videoType);
  if (!vt) return packageKey;
  return vt.packages.find(p => p.key === packageKey)?.label || packageKey;
}
function videoTypeLabel(videoType) {
  return SALE_VIDEO_TYPES.find(t => t.key === videoType)?.label || videoType;
}

export function SalePublicView() {
  const [sale, setSale] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [clientSecret, setClientSecret] = useState(null);
  const [thankYou, setThankYou] = useState(null);
  // Optimistic-paid latch: set when CheckoutForm's Stripe confirmPayment
  // resolves with status=succeeded. Flips the top-level render to the
  // Studio thank-you layout immediately, without waiting for the Stripe
  // webhook to mark sale.paid in Firebase. Also drives the celebratory
  // confetti burst (respects prefers-reduced-motion).
  const [optimisticPaid, setOptimisticPaid] = useState(false);

  const prettyMatch = window.location.pathname.match(/^\/s\/([a-z0-9]{4,12})/i);
  const shortId = prettyMatch ? prettyMatch[1].toLowerCase() : null;
  const saleIdParam = new URLSearchParams(window.location.search).get("s");
  // If the page reloads with ?session_id= (Stripe 3DS fallback, or
  // a user refresh after paying before our webhook landed), flip to
  // the paid view immediately — no re-showing the checkout form.
  // The belt to redirect_on_completion: 'never''s suspenders.
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (sessionId) setOptimisticPaid(true);
  }, []);

  useEffect(() => {
    if (!shortId && !saleIdParam) return;
    document.title = "Viewix — Deposit Payment";
    initFB();
    let unsub = () => {};
    // `cancelled` guard: if the effect re-fires (or the component
    // unmounts) before the async `onFB` resolves, the fresh listener
    // attached inside that callback would write to a stale unsub ref
    // and leak. Checking the flag inside onFB prevents the attach.
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      setLoading(false);
      setError(prev => prev || "Timed out loading payment details. The link may be invalid.");
    }, 8000);
    onFB(async () => {
      try { await signInAnonymouslyForPublic(); } catch (e) {
        if (!cancelled) setError(`Anonymous sign-in failed: ${e.message}`);
      }
      if (cancelled) return;
      const onReadError = (e) => {
        clearTimeout(timeoutId);
        setLoading(false);
        setError(`Firebase error: ${e.code || e.message}`);
      };
      if (saleIdParam) {
        unsub = fbListen(`/sales/${saleIdParam}`, (data) => {
          clearTimeout(timeoutId);
          if (data) { setSale(data); setError(null); }
          else setError(`No sale record found for id ${saleIdParam}.`);
          setLoading(false);
        }, onReadError);
      } else {
        unsub = fbListen("/sales", (all) => {
          clearTimeout(timeoutId);
          if (!all) { setError("No sale records available."); setLoading(false); return; }
          const match = Object.values(all).find(s => s && s.shortId && s.shortId.toLowerCase() === shortId);
          if (match) { setSale(match); setError(null); }
          else setError(`No payment link found for code "${shortId}". It may have been deleted.`);
          setLoading(false);
        }, onReadError);
      }
    });
    return () => { cancelled = true; clearTimeout(timeoutId); unsub(); };
  }, [shortId, saleIdParam]);

  // Thank-you content — read once the sale is resolved (don't block the
  // payment form waiting for it). Nullish is fine; PaidCard falls back to
  // the generic copy for tiers that haven't had their slot filled in yet.
  useEffect(() => {
    if (!sale) return;
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen("/saleThankYou", (data) => setThankYou(data || null));
    });
    return () => { cancelled = true; unsub(); };
  }, [sale?.id]);

  // Roster — the thank-you page producer's avatar lives on the editor
  // record now (Capacity → Team Roster → Photo column). We look up the
  // producer by a name-startsWith match ("Vish" finds "Vish Peiris",
  // "Vish P", etc.) so the producer can edit their avatar in one place
  // and every future thank-you page picks it up. Falls back to the
  // hardcoded initials circle when no match / no avatarUrl.
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    if (!sale) return;
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen("/editors", (data) => {
        setRoster(Array.isArray(data) ? data.filter(Boolean) : []);
      });
    });
    return () => { cancelled = true; unsub(); };
  }, [sale?.id]);

  // Once we have the sale, request an Embedded Checkout Session. Only
  // re-request if the sale id changes. If already paid, skip — the
  // thank-you view renders instead.
  //
  // Legacy sales created before the Total-ex-GST / schedule rewrite
  // (no schedule array) can't use the new Checkout endpoint — surface
  // an error telling the customer to get a fresh link. Their old
  // record stays valid (paid flag, depositAmount) but cannot drive a
  // new payment session.
  useEffect(() => {
    if (!sale || sale.paid) return;
    if (!STRIPE_PK) {
      setError("Stripe is not configured. Set VITE_STRIPE_PUBLISHABLE_KEY in your environment.");
      return;
    }
    const hasSchedule = Array.isArray(sale.schedule) && sale.schedule.length > 0;
    const firstAmount = hasSchedule ? Number(sale.schedule[0]?.amount) : Number(sale.depositAmount);
    if (!firstAmount || firstAmount <= 0) {
      setError("This payment link has no amount set. Contact the Viewix team.");
      return;
    }
    if (!hasSchedule) {
      setError("This payment link was created before we updated our billing system. Please ask Viewix to send you a fresh link.");
      return;
    }
    fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId: sale.id }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.clientSecret) setClientSecret(d.clientSecret);
        else setError(d.error || "Failed to create checkout session.");
      })
      .catch(e => setError(`Network error: ${e.message}`));
  }, [sale?.id]);

  if (loading) {
    return (<Shell><div style={{ textAlign: "center", padding: 80, color: "var(--muted)" }}><Logo h={36} /><div style={{ marginTop: 16, fontSize: 14 }}>Loading…</div></div></Shell>);
  }
  if (error && !sale) {
    return (<Shell><ErrorCard title="Payment link unavailable" detail={error} /></Shell>);
  }
  if (!sale) return (<Shell><ErrorCard title="Not found" detail="This payment link is invalid." /></Shell>);

  // Paid states (webhook-confirmed OR optimistically latched from
  // CheckoutForm's stripe.confirmPayment resolution) render the Studio
  // thank-you layout directly — no Shell wrapper. The component ships
  // its own masthead + footer.
  // Thank-you renders as soon as the FIRST slice has been paid —
  // not just when sale.paid (which only flips true after ALL slices
  // settle for multi-slice flows). Otherwise a Meta Ads customer who
  // refreshes after paying the deposit would see the payment form
  // again, which is wrong: they've paid, the balance is a founder-
  // triggered manual charge, and the public page should show them a
  // receipt + booking, not ask them to pay again.
  //
  // Three paths into the thank-you:
  //   - optimisticPaid       → just-paid-on-this-page flip
  //   - sale.paid            → fully-paid (all slices settled)
  //   - first slice paid     → partial-paid (covers deposit+manual
  //                             mid-project, and 1-of-3 / 2-of-3
  //                             states for Social Media subs)
  const firstSlicePaid = sale.schedule?.[0]?.status === "paid";
  if (sale.paid || optimisticPaid || firstSlicePaid) {
    return <StudioThankYou sale={sale} thankYou={thankYou} roster={roster} justPaid={optimisticPaid && !sale.paid} />;
  }

  return (
    <StudioPayment
      sale={sale}
      clientSecret={clientSecret}
      error={error}
      onComplete={() => setOptimisticPaid(true)}
    />
  );
}

// ─── Studio Payment view ────────────────────────────────────────────
// Pre-paid layout: paper-cream background, editorial hero, client strip,
// totals card (ex-GST + GST + grand total), payment-schedule card,
// consent box, Stripe Embedded Checkout iframe inline. Matches the
// design handoff at /Users/cicero/Documents/Webpages/design_handoff_sale_payment.
//
// Zero redirect — when the customer completes payment in Stripe's
// iframe, `onComplete` fires, we flip optimisticPaid, and the page
// swaps to StudioThankYou (same paper-cream canvas, visual
// continuity).
function StudioPayment({ sale, clientSecret, error, onComplete }) {
  const cfg = scheduleForVideoType(sale.videoType);
  const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
  const firstSlice = schedule[0];
  const firstName = (sale.clientName || "there").split(/\s+/)[0];

  // Embedded Checkout options — the onComplete callback lets us stay
  // on-page when Stripe finishes. `clientSecret` must be stable per
  // render pass or the iframe remounts.
  const options = useMemo(() => {
    if (!clientSecret) return null;
    return { clientSecret, onComplete };
  }, [clientSecret, onComplete]);

  return (
    <div className="vx-studio" style={{ background: "var(--paper)", minHeight: "100vh" }}>
      <style>{STUDIO_CSS}</style>

      {/* Masthead */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "20px 28px", borderBottom: "1px solid var(--line)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo h={26} />
          <span style={{ color: "var(--muted-2)", fontSize: 12, marginLeft: 10, fontFamily: "'JetBrains Mono', monospace" }}>VIDEO · SYDNEY</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", fontFamily: "'JetBrains Mono', monospace" }}>
          <span aria-hidden="true">🔒</span> SECURE PAYMENT
        </div>
      </header>

      <div className="studio-page" style={{ maxWidth: 980, margin: "0 auto", padding: "0 28px 56px" }}>
        {/* Hero */}
        <section style={{ paddingTop: 48, paddingBottom: 20, textAlign: "center" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, background: "#fff", border: "1px solid var(--line)", fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--orange)", boxShadow: "0 0 0 4px rgba(248,119,0,.12)" }} />
            <span style={{ color: "var(--muted)", fontFamily: "'JetBrains Mono', monospace" }}>READY FOR YOUR DEPOSIT</span>
          </div>
          <h1 className="studio-hero" style={{ fontWeight: 800, lineHeight: 0.98, margin: "22px auto 12px", maxWidth: 820, letterSpacing: "-0.02em", fontSize: "clamp(40px, 6vw, 72px)" }}>
            Let's get it made,<br/>
            <span style={{ color: "var(--orange)" }}>{firstName}</span>.
          </h1>
          <p style={{ fontSize: 17, color: "var(--muted)", maxWidth: 560, margin: "0 auto", lineHeight: 1.5 }}>
            You're one deposit away from locking in your {videoTypeLabel(sale.videoType).toLowerCase()} project. Review the scope and schedule below, then pay securely through Stripe.
          </p>
        </section>

        {/* Client + package strip */}
        <section style={{ marginBottom: 20 }}>
          <StudioClientStrip sale={sale} />
        </section>

        {/* Scope */}
        {sale.scopeNotes && (
          <section style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 14, padding: 20, marginBottom: 20 }}>
            <div className="studio-eyebrow" style={{ marginBottom: 8 }}>Scope</div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{sale.scopeNotes}</p>
          </section>
        )}

        {/* Totals */}
        <section style={{ marginBottom: 20 }}>
          <StudioTotals sale={sale} />
        </section>

        {/* Schedule */}
        <section style={{ marginBottom: 20 }}>
          <div className="studio-eyebrow" style={{ marginBottom: 10 }}>Payment schedule</div>
          <StudioSchedule sale={sale} cfg={cfg} />
        </section>

        {/* Payment + consent */}
        <section style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 14, padding: 24, marginBottom: 24 }}>
          <div className="studio-eyebrow" style={{ marginBottom: 14 }}>Complete payment</div>
          <div style={{ marginBottom: 16 }}>
            <StudioConsent sale={sale} cfg={cfg} />
          </div>

          {error && <ErrorCard title="Could not load payment form" detail={error} />}

          {!error && clientSecret && stripePromise && options && (
            <div style={{ borderRadius: 12, overflow: "hidden" }}>
              <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          )}
          {!error && !clientSecret && (
            <div style={{ textAlign: "center", padding: 32, color: "var(--muted)", fontSize: 13 }}>
              Preparing secure payment form…
            </div>
          )}
        </section>

        {/* Trust row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, paddingTop: 12, color: "var(--muted)", fontSize: 11, flexWrap: "wrap" }}>
          <span>🔒 SSL-encrypted</span>
          <span>🛡 PCI-DSS compliant</span>
          <span>Powered by <strong style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>stripe</strong></span>
        </div>

        <footer style={{ textAlign: "center", padding: "28px 0 0", color: "var(--muted-2)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
          © VIEWIX VIDEO PRODUCTION · SYDNEY · {new Date().getFullYear()}
        </footer>
      </div>
    </div>
  );
}

function StudioClientStrip({ sale }) {
  const initials = (sale.clientName || "?").split(/\s+/).slice(0, 2).map(s => s[0] || "").join("").toUpperCase();
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr auto", gap: 16,
      padding: "14px 18px", borderRadius: 10,
      background: "var(--paper)", border: "1px solid var(--line)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        {sale.logoUrl ? (
          <img src={sale.logoUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "contain", background: "#fff", padding: 4, border: "1px solid var(--line)" }} />
        ) : (
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: "linear-gradient(135deg,#0082FA,#004F99)",
            color: "#fff", fontSize: 14, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{initials}</div>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="studio-eyebrow" style={{ fontSize: 11 }}>For</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, color: "var(--ink)" }}>{sale.clientName}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {videoTypeLabel(sale.videoType)} · {packageLabel(sale.videoType, sale.packageKey)}
          </div>
        </div>
      </div>
      <div style={{ textAlign: "right", minWidth: 110 }}>
        <div className="studio-eyebrow">Order</div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, marginTop: 4, color: "var(--ink)", fontWeight: 600 }}>
          {sale.shortId ? `VWX-${sale.shortId}` : sale.id}
        </div>
      </div>
    </div>
  );
}

function StudioTotals({ sale }) {
  const row = { display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14, color: "var(--muted)" };
  const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
  const totalSurcharge = schedule.reduce((sum, s) => sum + (Number(s.surcharge) || 0), 0);
  const totalCharged = (Number(sale.grandTotal) || 0) + totalSurcharge;
  const sliceCount = schedule.length;
  return (
    <div style={{ background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 12, padding: 20 }}>
      <div style={row}><span>Subtotal (ex-GST)</span><span className="studio-num" style={{ fontWeight: 600, color: "var(--ink)" }}>{fmtCurExact(sale.totalExGst || 0)}</span></div>
      <div style={row}><span>GST (10%)</span><span className="studio-num" style={{ fontWeight: 600, color: "var(--ink)" }}>{fmtCurExact(sale.gstAmount || 0)}</span></div>
      <div style={{ ...row, borderTop: "1px dashed var(--line)", marginTop: 6, paddingTop: 10, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
        <span>Project total</span><span className="studio-num">{fmtCurExact(sale.grandTotal || 0)}</span>
      </div>
      {totalSurcharge > 0 && (
        <div style={row}>
          <span>Card processing (1.73% + 30c{sliceCount > 1 ? ` \u00d7 ${sliceCount}` : ""})</span>
          <span className="studio-num" style={{ fontWeight: 600, color: "var(--ink)" }}>{fmtCurExact(totalSurcharge)}</span>
        </div>
      )}
      <div style={{ ...row, borderTop: "1px solid var(--line-strong)", marginTop: 10, paddingTop: 12, fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
        <span>Total to be charged</span><span className="studio-num">{fmtCurExact(totalCharged)} AUD</span>
      </div>
    </div>
  );
}

function StudioSchedule({ sale, cfg }) {
  const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
  const hint = cfg.kind === "subscription_monthly"
    ? "Payments 2 and 3 are auto-charged to the card you enter today."
    : cfg.kind === "deposit_plus_manual"
      ? "The balance is charged manually when your project wraps — no auto-charge."
      : "";

  return (
    <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, padding: 18 }}>
      {schedule.map((s, i) => {
        const isDue = s.status === "pending" && i === 0;
        return (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto",
            gap: 14, padding: "12px 0",
            borderBottom: i < schedule.length - 1 ? "1px dashed var(--line)" : "none",
            alignItems: "center",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20 }}>
              <span style={{
                width: 10, height: 10, borderRadius: 99,
                background: isDue ? "var(--orange)" : "var(--line-strong)",
                display: "inline-block",
                boxShadow: isDue ? "0 0 0 4px rgba(248,119,0,.14)" : "none",
              }} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
                {s.label} · <span style={{ fontWeight: 500, color: "var(--muted)" }}>{s.dueLabel}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                {s.trigger === "now" && "Charged on submit"}
                {s.trigger === "auto" && "Auto-charged to card on file"}
                {s.trigger === "manual" && "Viewix will charge this manually when the project concludes"}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="studio-num" style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{fmtCurExact(s.amount)}</div>
              {Number(s.surcharge) > 0 && (
                <div className="studio-num" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  {fmtCurExact(s.projectAmount)} + {fmtCurExact(s.surcharge)} fee
                </div>
              )}
            </div>
          </div>
        );
      })}
      {hint && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--line)", fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8 }}>
          <span>ⓘ</span>
          <span>{hint}</span>
        </div>
      )}
    </div>
  );
}

function StudioConsent({ sale, cfg }) {
  const schedule = Array.isArray(sale.schedule) ? sale.schedule : [];
  const autoSlices = schedule.filter(s => s.trigger === "auto");
  const manualSlice = schedule.find(s => s.trigger === "manual");

  return (
    <div style={{
      fontSize: 12, color: "var(--muted)", lineHeight: 1.6,
      padding: 14, background: "#fdf3e8", border: "1px solid #f4d9a9", borderRadius: 8,
    }}>
      {cfg.kind === "subscription_monthly" && autoSlices.length > 0 && (
        <>
          By completing this payment, you authorise Viewix Video Production to charge the same card{" "}
          {autoSlices.map((s, i) => (
            <span key={i}>
              <strong>{fmtCurExact(s.amount)} on {s.dueLabel}</strong>{i < autoSlices.length - 1 ? " and " : ""}
            </span>
          ))}
          {" "}for the remaining instalments of this project. Cancel at any time by emailing{" "}
          <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--ink)" }}>hello@viewix.com.au</span>.
        </>
      )}
      {cfg.kind === "deposit_plus_manual" && manualSlice && (
        <>
          You're paying a <strong>50% deposit today</strong>. The remaining{" "}
          <strong>{fmtCurExact(manualSlice.amount)}</strong> is charged when your project wraps.
        </>
      )}
      {cfg.kind === "paid_in_full" && (
        <>You're paying for this project <strong>in full</strong> today. A receipt will be emailed once the payment clears.</>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Studio thank-you layout — replaces the old PaidCard. Full-page,
// self-contained (masthead + footer inline), mirrors the design-
// handoff spec from /Users/cicero/Documents/Webpages/design_handoff_deposit_thankyou:
// paper-cream background, Montserrat display headline in brand
// accent, 4-up facts strip, producer's note + video two-up, TidyCal
// booking embed inside a styled shell, receipt + numbered next-steps.
// Responsive: 2-up grids collapse to 1-up at ≤960px, facts strip to
// 2-up at ≤720px, further tweaks at ≤480px.
//
// Producer is hardcoded below. To swap in a real photo, set
// PRODUCER.avatarUrl to the uploaded URL; otherwise we render the
// VP initials circle.
const PRODUCER = {
  name: "Vish Peiris",
  role: "Production Manager",
  initials: "VP",
  // TODO: set when Vish sends a headshot URL. Use https, circular crop
  // recommended at 120x120 so it renders crisp on retina.
  avatarUrl: "",
  avatarBg: "linear-gradient(135deg,#0082FA 0%,#004F99 100%)",
};

function StudioThankYou({ sale, thankYou, roster, justPaid }) {
  // Scroll reset — the customer arrived at this layout scrolled down
  // to the Stripe iframe on the payment page. Without this, they land
  // at the bottom of the thank-you and miss the headline + confetti.
  // Fires once on mount; instant (not smooth) so there's no
  // distracting scroll animation right after payment.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, []);

  // Per-package thank-you slot. Falls back to an empty object (no video,
  // no copy) so an un-configured tier still renders a working page — the
  // customer sees the confirmation, receipt badge, and booking button.
  const slot = thankYou?.packages?.[sale.videoType]?.[sale.packageKey] || {};

  // Producer lookup — name-startsWith match against /editors so a
  // producer's avatar/phone/email live in one place (Capacity → Team
  // Roster). Falls back to the hardcoded PRODUCER constant when no
  // match, which is also where we default when the roster listener
  // hasn't loaded yet.
  const producerEditor = (Array.isArray(roster) ? roster : []).find(e =>
    e && (e.name || "").toLowerCase().startsWith(PRODUCER.name.split(/\s+/)[0].toLowerCase())
  );
  const producerAvatarUrl = normaliseImageUrl(producerEditor?.avatarUrl, 120);
  const bookingUrl = thankYou?.bookingUrl?.trim() || "";
  const videoSrc = embedUrl(slot.videoUrl);
  const nextSteps = (slot.nextStepsCopy || "").trim();
  const pkgLabel = packageLabel(sale.videoType, sale.packageKey);

  // Order reference — "VWX-<8 from Stripe intent>-<2 from client name>".
  // Falls back to shortId if the webhook hasn't stamped
  // stripePaymentIntentId yet (optimistic-paid path, pre-webhook).
  const orderRef = (() => {
    const stripeId = sale.stripePaymentIntentId || "";
    const suffix = stripeId
      ? stripeId.replace(/^pi_/, "").slice(0, 8).toUpperCase()
      : (sale.shortId || "").toUpperCase();
    const initials = (sale.clientName || "")
      .split(/\s+/).map(w => w[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "VX";
    return `VWX-${suffix}-${initials}`;
  })();

  // Paid-at formatting — "21 April 2026 · 5:02pm AEST"
  const paidAtIso = sale.paidAt || new Date().toISOString();
  const paidAtDate = new Date(paidAtIso);
  const paidAtDateStr = paidAtDate.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const paidAtTimeStr = paidAtDate.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase().replace(/\s/g, "");
  const paidAtStr = `${paidAtDateStr} · ${paidAtTimeStr} AEST`;

  // First-name in the headline. "Smith & Co." → falls through to
  // full clientName; "Jeremy Farrugia" → "Jeremy".
  const firstName = (sale.clientName || "").split(/\s+/)[0] || "";
  const useFirstName = firstName && /^[A-Za-z][A-Za-z'’-]+$/.test(firstName);

  // Confetti burst on first paint of the paid state. Driven by the
  // `justPaid` prop (set by the optimistic-paid latch). Respects
  // prefers-reduced-motion — no burst if the user has that set.
  const [burstOn, setBurstOn] = useState(false);
  useEffect(() => {
    if (!justPaid) return;
    const reduce = typeof window !== "undefined"
      && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    setBurstOn(true);
    const t = setTimeout(() => setBurstOn(false), 1600);
    return () => clearTimeout(t);
  }, [justPaid]);

  // Copyable order-number chip.
  const [copied, setCopied] = useState(false);
  const copyOrder = () => {
    try { navigator.clipboard.writeText(orderRef); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (<>
    <style>{STUDIO_CSS}</style>
    {burstOn && <Confetti />}

    <div className="vx-studio">
      {/* Masthead */}
      <header className="vx-mast">
        <div className="vx-mast-left">
          <Logo h={26} />
          <span className="vx-mono vx-muted2">VIDEO · SYDNEY</span>
        </div>
        <div className="vx-mast-right vx-mono vx-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="9" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M8 10.5V7.5a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
          SECURE RECEIPT
        </div>
      </header>

      <div className="vx-page">
        {/* Hero moment */}
        <section className="vx-hero">
          <div className="vx-pill">
            <span className="vx-dot" />
            <span className="vx-mono vx-muted">PAYMENT RECEIVED · {paidAtTimeStr.toUpperCase()}</span>
          </div>
          <h1 className="vx-headline">
            Welcome aboard,<br/>
            <span className="vx-accent">{useFirstName ? firstName : (sale.clientName || "there")}</span>.
          </h1>
          <p className="vx-hero-sub">
            Your {videoTypeLabel(sale.videoType)}: {pkgLabel} Pack deposit is in. We're genuinely excited to start creating with you — here's how the next few weeks look.
          </p>
        </section>

        {/* 4-up facts strip — the "Paid" value is the first slice that
            just cleared (deposit for Meta Ads, payment 1 of 3 for
            Social). Falls back to depositAmount for legacy records. */}
        <section className="vx-facts">
          <StudioFact k="Paid" v={fmtCur(sale.schedule?.[0]?.amount ?? sale.depositAmount)} sub={sale.schedule?.[0]?.label || "Deposit"} />
          <StudioFact k="Order" v={orderRef} sub="Reference" mono />
          <StudioFact k={PRODUCER.role} v={PRODUCER.name} sub="Viewix" />
          <StudioFact k="First meeting" v="Pre-production" sub="Book below" />
        </section>

        {/* Two-up: producer's note + video */}
        <section className="vx-two-up">
          <div className="vx-card vx-note">
            <div className="vx-eyebrow">A note from your producer</div>
            {nextSteps ? (
              <div className="vx-note-body">
                <MarkdownLite text={nextSteps} />
              </div>
            ) : (
              <>
                <p className="vx-note-quote">
                  "Deposit's in — you're locked in. Now the fun part: we pin down the brief, the creative direction, and the shoot dates."
                </p>
                <p className="vx-note-p">
                  Before our pre-production call, watch the 2-minute walkthrough — it covers how the Viewix system turns a single shoot day into a library of ad variations.
                </p>
                <p className="vx-note-p vx-muted">
                  If anything comes up in the meantime, reach out to your Viewix contact directly.
                </p>
              </>
            )}
            <div className="vx-note-sig">
              <StudioAvatar avatarUrl={producerAvatarUrl} />
              <div>
                <div className="vx-note-sig-name">{PRODUCER.name}</div>
                <div className="vx-note-sig-role vx-muted">{PRODUCER.role} · Viewix</div>
              </div>
            </div>
          </div>

          <div className="vx-video-col">
            {videoSrc ? (
              <div className="vx-video-frame">
                <iframe
                  src={videoSrc} title="Welcome from Viewix"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
                <div className="vx-video-badge vx-mono">2 MIN WATCH</div>
              </div>
            ) : (
              <div className="vx-video-placeholder">
                <div className="vx-muted" style={{ fontSize: 13 }}>
                  Welcome video not configured yet for this package.
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Booking */}
        <section className="vx-booking-section">
          <div className="vx-card vx-booking">
            <div className="vx-booking-head">
              <div>
                <div className="vx-eyebrow">Step 2 · Book a time</div>
                <div className="vx-booking-title">Book your pre-production meeting</div>
              </div>
              <div className="vx-booking-meta vx-muted vx-mono">60 MIN · GOOGLE MEET or DULWICH HILL OFFICE · AEST</div>
            </div>
            {bookingUrl && thankYou?.bookingEmbed !== false && isEmbeddableBookingUrl(bookingUrl) ? (
              isTidyCalUrl(bookingUrl) ? (
                <TidyCalEmbed url={bookingUrl} />
              ) : (
                <iframe
                  src={bookingUrl} title="Book your pre-production meeting"
                  className="vx-booking-iframe"
                  loading="lazy"
                />
              )
            ) : bookingUrl ? (
              <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="vx-btn vx-btn-primary">
                Book your kickoff call →
              </a>
            ) : (
              <div className="vx-muted" style={{ padding: "24px 0", textAlign: "center", fontSize: 13 }}>
                Booking link not configured. The Viewix team will be in touch to schedule.
              </div>
            )}
          </div>
        </section>

        {/* Receipt + what happens next */}
        <section className="vx-two-up vx-two-up-sm">
          {/* Receipt card */}
          <div className="vx-card">
            <div className="vx-receipt-head">
              <div>
                <div className="vx-eyebrow">Receipt</div>
                <div className="vx-receipt-date vx-muted">{paidAtStr}</div>
              </div>
              <button type="button" onClick={copyOrder} className="vx-chip vx-mono" title="Copy order number">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="3.5" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M16 17.5v1.9A2 2 0 0 1 14 21.5H6a2 2 0 0 1-2-2.1V9a2 2 0 0 1 2-2.1h1.9" stroke="currentColor" strokeWidth="1.6"/></svg>
                {copied ? "Copied" : orderRef}
              </button>
            </div>
            <div className="vx-receipt-grid">
              <div>
                <div className="vx-eyebrow">Paid today</div>
                <div className="vx-receipt-amount vx-mono">{fmtCur(sale.schedule?.[0]?.amount ?? sale.depositAmount)}</div>
              </div>
              <div>
                <div className="vx-eyebrow">Package</div>
                <div className="vx-receipt-val">{pkgLabel}</div>
              </div>
              <div>
                <div className="vx-eyebrow">Method</div>
                <div className="vx-receipt-val">Stripe · AUD</div>
              </div>
            </div>
            {/* Download receipt — opens Stripe's hosted receipt PDF
                if the webhook captured it (new sales); falls back to
                printing the current page for legacy records. Always
                works, even on old paid sales from before the receipt-
                URL capture landed. */}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed var(--vx-line)", display: "flex", justifyContent: "flex-start" }}>
              <button
                type="button"
                onClick={() => {
                  const url = sale.schedule?.[0]?.receiptUrl || sale.stripeReceiptUrl;
                  if (url) {
                    window.open(url, "_blank", "noopener,noreferrer");
                  } else {
                    window.print();
                  }
                }}
                className="vx-chip"
                style={{ fontSize: 12, fontWeight: 600, padding: "8px 14px", gap: 8 }}
                title="Download a PDF receipt for this payment"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 4v12m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Download receipt
              </button>
            </div>
          </div>

          {/* What happens next */}
          <div className="vx-card vx-next">
            <div className="vx-eyebrow" style={{ marginBottom: 10 }}>What happens next</div>
            <ol className="vx-next-list">
              <StudioNext n="01" h="Watch the welcome video" s="Two minutes. It saves ten in the meeting." />
              <StudioNext n="02" h="Lock your pre-production time" s="Brief, creative direction, shoot dates." />
              <StudioNext n="03" h="Shoot day on-site" s="Roughly 1 - 3 weeks from today." />
            </ol>
          </div>
        </section>

        <footer className="vx-footer vx-mono vx-muted2">
          © VIEWIX VIDEO PRODUCTION · SYDNEY · {new Date().getFullYear()}
        </footer>
      </div>

      {/* Print-only receipt. Invisible in the normal flow (display:none
          inside .vx-studio); @media print flips the rule so ONLY this
          block renders when the customer hits "Download receipt" and
          the browser produces a PDF. Means the print fallback produces
          a clean one-page receipt instead of the whole thank-you. */}
      <PrintableReceipt
        sale={sale}
        pkgLabel={pkgLabel}
        orderRef={orderRef}
        paidAtStr={paidAtStr}
      />
    </div>
  </>);
}

// Clean receipt layout shown only when the browser prints the page.
// No inline styles so the print-media CSS in STUDIO_CSS owns all
// presentation. The legacy-paid fallback (window.print()) gets a
// one-page PDF with just these fields — no confetti, no iframe, no
// booking, just the receipt.
function PrintableReceipt({ sale, pkgLabel, orderRef, paidAtStr }) {
  const paidAmount = sale.schedule?.[0]?.amount ?? sale.depositAmount ?? 0;
  const totalExGst = sale.totalExGst;
  const gstAmount  = sale.gstAmount;
  const grandTotal = sale.grandTotal;
  return (
    <div className="vx-print-receipt">
      <div className="vx-print-head">
        {/* Square V-mark (apple-touch-icon.png is the 180x180 master
            that already ships in /public). Fixed 42x42 pixels in the
            print receipt so it never stretches — the horizontal
            wordmark looked warped at small sizes. */}
        <img className="vx-print-logo" src="/apple-touch-icon.png" alt="Viewix" width="42" height="42" />
        <div className="vx-print-head-text">
          <div className="vx-print-brand">VIEWIX VIDEO PRODUCTION</div>
          <div className="vx-print-sub">Sydney, Australia</div>
        </div>
      </div>
      <div className="vx-print-title">Tax Invoice — Payment Receipt</div>
      <div className="vx-print-meta">
        <div><span>Issued</span><strong>{paidAtStr}</strong></div>
        <div><span>Order</span><strong>{orderRef}</strong></div>
        <div><span>Billed to</span><strong>{sale.clientName || "—"}</strong></div>
        <div><span>Package</span><strong>{pkgLabel}</strong></div>
      </div>

      {sale.scopeNotes && (
        <div className="vx-print-scope">
          <div className="vx-print-label">Scope</div>
          <div className="vx-print-scope-body">{sale.scopeNotes}</div>
        </div>
      )}

      <table className="vx-print-table">
        <thead>
          <tr><th>Description</th><th style={{ textAlign: "right" }}>Amount (AUD)</th></tr>
        </thead>
        <tbody>
          {typeof totalExGst === "number" && totalExGst > 0 ? (
            <>
              <tr>
                <td>{pkgLabel} — project total (ex-GST)</td>
                <td style={{ textAlign: "right" }}>{fmtCurExact(totalExGst)}</td>
              </tr>
              <tr>
                <td>GST (10%)</td>
                <td style={{ textAlign: "right" }}>{fmtCurExact(gstAmount || 0)}</td>
              </tr>
              <tr className="vx-print-total">
                <td>Project total (inc-GST)</td>
                <td style={{ textAlign: "right" }}>{fmtCurExact(grandTotal || 0)}</td>
              </tr>
              <tr className="vx-print-paid">
                <td>Paid today ({sale.schedule?.[0]?.label || "Deposit"})</td>
                <td style={{ textAlign: "right" }}>{fmtCurExact(paidAmount)}</td>
              </tr>
            </>
          ) : (
            // Legacy record with only depositAmount — no GST breakdown
            // available. Show a single-line receipt for what was paid.
            <tr className="vx-print-paid">
              <td>{pkgLabel} — paid</td>
              <td style={{ textAlign: "right" }}>{fmtCur(paidAmount)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="vx-print-method">
        <span>Method</span><strong>Stripe · AUD · card on file</strong>
      </div>

      <div className="vx-print-foot">
        <div>Viewix Video Production Pty Ltd</div>
        <div>hello@viewix.com.au · viewix.com.au</div>
        <div className="vx-print-ref">{orderRef}</div>
      </div>
    </div>
  );
}

// TidyCal JS embed — replaces the chunky iframe with TidyCal's own
// embed widget. Their script renders a responsive booking view
// that collapses to a stacked mobile layout at narrow widths and
// avoids the awkward wide-left-panel / narrow-right-panel split
// the raw iframe produces.
//
// Loads the script once per page via useEffect. TidyCal's script
// uses a MutationObserver so new .tidycal-embed divs auto-init
// without a manual call — the `key={path}` on the div ensures a
// clean remount if the booking URL changes between sales.
function isTidyCalUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "tidycal.com" || host.endsWith(".tidycal.com");
  } catch { return false; }
}

function TidyCalEmbed({ url }) {
  const path = (() => {
    try { return new URL(url).pathname.replace(/^\//, ""); }
    catch { return ""; }
  })();

  useEffect(() => {
    if (!path) return;
    if (document.querySelector('script[src*="tidycal.b-cdn.net"]')) return;
    const s = document.createElement("script");
    s.src = "https://asset-tidycal.b-cdn.net/js/embed.js";
    s.async = true;
    document.body.appendChild(s);
  }, [path]);

  if (!path) return null;
  return (
    <div
      className="tidycal-embed vx-booking-embed"
      data-path={path}
      key={path}
    />
  );
}

// Single fact cell in the 4-up strip. Pulled out so the grid renders
// cleanly + `mono` prop opts the order-reference cell into JetBrains
// Mono with tighter tracking.
function StudioFact({ k, v, sub, mono }) {
  return (
    <div className="vx-fact">
      <div className="vx-eyebrow">{k}</div>
      <div className={`vx-fact-v${mono ? " vx-mono" : ""}`}>{v}</div>
      <div className="vx-fact-sub vx-muted">{sub}</div>
    </div>
  );
}

function StudioNext({ n, h, s }) {
  return (
    <li className="vx-next-item">
      <div className="vx-mono vx-muted vx-next-n">{n}</div>
      <div>
        <div className="vx-next-h">{h}</div>
        <div className="vx-next-s vx-muted">{s}</div>
      </div>
    </li>
  );
}

function StudioAvatar({ avatarUrl }) {
  // Prefer the roster-pulled URL; fall back to the hardcoded PRODUCER
  // constant (set by paste later) and finally to the initials circle.
  // onError hides the img if the URL 404s or Drive throttles, so a
  // broken link doesn't leave an empty square.
  const [broken, setBroken] = useState(false);
  const url = !broken && (avatarUrl || PRODUCER.avatarUrl);
  if (url) {
    return <img src={url} alt={PRODUCER.name} className="vx-avatar-img" onError={() => setBroken(true)} />;
  }
  return (
    <div className="vx-avatar" style={{ background: PRODUCER.avatarBg }} aria-hidden="true">
      {PRODUCER.initials}
    </div>
  );
}

// Confetti burst — 36 radial pieces in the brand palette. Fires once
// via parent's `burstOn` flag, animation lasts 1.4s, parent unmounts
// the component when done. Hidden entirely via prefers-reduced-motion.
function Confetti() {
  const pieces = useMemo(() => {
    const count = 36;
    return Array.from({ length: count }, (_, i) => {
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 160 + Math.random() * 180;
      return {
        x: Math.cos(ang) * dist,
        y: Math.sin(ang) * dist * 0.9 - 60,  // biased upward
        r: (Math.random() * 2 - 1) * 540,
        c: ["#F87700", "#0082FA", "#0a1228", "#19976a", "#F4F5F9"][i % 5],
        d: 0.05 + Math.random() * 0.15,
        round: i % 3 === 0,
      };
    });
  }, []);
  return (
    <div className="vx-burst" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{
          "--vx-x": `${p.x}px`, "--vx-y": `${p.y}px`, "--vx-r": `${p.r}deg`,
          background: p.c,
          animationDelay: `${p.d}s`,
          borderRadius: p.round ? "999px" : "2px",
        }} />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Studio design tokens + responsive CSS. Injected once per paid-state
// mount via <style>{STUDIO_CSS}</style>. Keeps the thank-you layout
// fully isolated from the rest of the app (no tokens leak into the
// pre-payment Shell, error states, or the dashboard itself).
const STUDIO_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

.vx-studio {
  --vx-blue: #0082FA; --vx-blue-deep: #004F99;
  --vx-orange: #F87700; --vx-orange-deep: #AE3A00;
  --vx-paper: #F4F5F9; --vx-paper-2: #e8ebf1; --vx-grey: #CBCCD1;
  --vx-ink: #0a1228; --vx-muted: #5a6478; --vx-muted-2: #8a8f9e;
  --vx-line: #dfe2ea; --vx-line-strong: #CBCCD1;
  --vx-green: #19976a;
  /* Short-form aliases — StudioPayment's inline styles reference
     these without the vx- prefix for readability. Everything here
     resolves to the same palette. */
  --paper: var(--vx-paper); --paper-2: var(--vx-paper-2);
  --ink: var(--vx-ink);
  --muted: var(--vx-muted); --muted-2: var(--vx-muted-2);
  --line: var(--vx-line); --line-strong: var(--vx-line-strong);
  --orange: var(--vx-orange); --orange-deep: var(--vx-orange-deep);
  --green: var(--vx-green);
  font-family: 'Montserrat', -apple-system, system-ui, sans-serif;
  color: var(--vx-ink);
  background: var(--vx-paper);
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.vx-studio * { box-sizing: border-box; }
/* Classes used by the StudioPayment wrapper (alongside the vx-*
   classes used by StudioThankYou). */
.vx-studio .studio-eyebrow {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.14em;
  color: var(--vx-muted); text-transform: uppercase; font-weight: 400;
}
.vx-studio .studio-num {
  font-variant-numeric: tabular-nums;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.vx-studio .studio-hero {
  font-family: 'Montserrat', -apple-system, system-ui, sans-serif;
  font-weight: 800;
}
.vx-studio .vx-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.vx-studio .vx-muted { color: var(--vx-muted); }
.vx-studio .vx-muted2 { color: var(--vx-muted-2); }
.vx-studio .vx-accent { color: var(--vx-orange); }
.vx-studio .vx-eyebrow {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.14em;
  color: var(--vx-muted); text-transform: uppercase; font-weight: 400;
}
.vx-mast {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 28px; border-bottom: 1px solid var(--vx-line);
}
.vx-mast-left, .vx-mast-right { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.vx-mast-left > :not(:first-child) { margin-left: 10px; }
.vx-mast-right { gap: 8px; }
.vx-page { max-width: 1100px; margin: 0 auto; padding: 0 28px 48px; }
.vx-hero { padding: 56px 0 40px; text-align: center; position: relative; }
.vx-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 999px;
  background: #fff; border: 1px solid var(--vx-line); font-size: 12px;
}
.vx-dot {
  width: 7px; height: 7px; border-radius: 99px;
  background: var(--vx-green);
  box-shadow: 0 0 0 4px rgba(25,151,106,.12);
}
.vx-headline {
  font-weight: 800;
  font-size: clamp(44px, 8vw, 108px);
  line-height: 0.95; letter-spacing: -0.025em;
  margin: 22px auto 12px; max-width: 900px;
}
.vx-hero-sub {
  font-size: clamp(15px, 1.6vw, 18px);
  color: var(--vx-muted);
  max-width: 560px; margin: 0 auto; line-height: 1.5;
}
.vx-facts {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 0;
  border: 1px solid var(--vx-line); border-radius: 14px;
  background: #fff; overflow: hidden; margin-bottom: 28px;
}
.vx-fact { padding: 18px 20px; }
.vx-fact + .vx-fact { border-left: 1px solid var(--vx-line); }
.vx-fact-v {
  font-size: 20px; font-weight: 600; margin-top: 6px; letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums; word-break: break-word;
}
.vx-fact-sub { font-size: 12px; margin-top: 2px; }
.vx-two-up { display: grid; grid-template-columns: 1.05fr 1fr; gap: 24px; margin-bottom: 28px; }
.vx-two-up-sm { grid-template-columns: 1fr 1fr; }
.vx-card { background: #fff; border: 1px solid var(--vx-line); border-radius: 14px; padding: 28px; }
.vx-note-body { font-size: 15px; line-height: 1.65; color: var(--vx-ink); margin-top: 12px; }
.vx-note-body p { margin: 0 0 12px; }
.vx-note-body ul { margin: 0 0 12px; padding-left: 22px; }
.vx-note-body li { margin-bottom: 6px; line-height: 1.55; }
.vx-note-body strong { font-weight: 700; }
.vx-note-quote {
  font-size: 26px; line-height: 1.25; font-weight: 600;
  margin: 12px 0 14px; letter-spacing: -0.01em;
}
.vx-note-p { font-size: 14px; line-height: 1.6; margin: 0 0 12px; }
.vx-note-sig {
  display: flex; align-items: center; gap: 10px;
  margin-top: 22px; padding-top: 16px;
  border-top: 1px dashed var(--vx-line-strong);
}
.vx-avatar, .vx-avatar-img {
  width: 40px; height: 40px; border-radius: 99px;
  color: #fff; font-size: 14px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.vx-avatar { box-shadow: inset 0 0 0 2px rgba(255,255,255,.18); }
.vx-avatar-img { object-fit: cover; }
.vx-note-sig-name { font-size: 14px; font-weight: 600; }
.vx-note-sig-role { font-size: 12px; }
.vx-video-col { display: flex; flex-direction: column; gap: 16px; }
.vx-video-frame {
  position: relative; aspect-ratio: 16 / 9;
  border-radius: 14px; overflow: hidden;
  border: 1px solid var(--vx-line); background: #000;
}
.vx-video-frame iframe { width: 100%; height: 100%; border: 0; display: block; }
.vx-video-badge {
  position: absolute; left: 14px; top: 14px;
  padding: 4px 8px; font-size: 11px; letter-spacing: .12em;
  background: rgba(255,255,255,.14); backdrop-filter: blur(8px);
  color: #fff; border-radius: 6px; text-transform: uppercase;
}
.vx-video-placeholder {
  aspect-ratio: 16 / 9; border-radius: 14px;
  background: var(--vx-paper-2); border: 1px dashed var(--vx-line-strong);
  display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center;
}
.vx-booking-section { margin-bottom: 28px; }
.vx-booking { padding: 22px 24px; }
.vx-booking-head {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 8px; margin-bottom: 14px;
}
.vx-booking-title { font-size: 17px; font-weight: 600; margin-top: 4px; letter-spacing: -0.01em; }
.vx-booking-meta { font-size: 11px; letter-spacing: .12em; }
.vx-booking-iframe {
  width: 100%; height: 760px; border: 0;
  border-radius: 10px; display: block; background: #fff;
}
/* TidyCal JS embed container — let the widget size itself. We
   constrain max-width so the booking view doesn't stretch beyond
   what its internal layout is designed for (about 780px) and
   centre it. The widget handles its own min-height as content
   loads. */
.vx-booking-embed {
  max-width: 820px;
  margin: 0 auto;
  min-height: 560px;
  border-radius: 10px;
  overflow: hidden;
}
.vx-receipt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.vx-receipt-date { font-size: 13px; margin-top: 6px; }
.vx-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 10px;
  background: #fff; border: 1px solid var(--vx-line);
  color: var(--vx-ink); cursor: pointer;
  font-size: 12px; font-weight: 500;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.03em;
}
.vx-chip:hover { background: var(--vx-paper-2); }
.vx-receipt-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
  margin-top: 14px;
  border-top: 1px dashed var(--vx-line-strong); padding-top: 14px;
}
.vx-receipt-amount {
  font-size: 22px; font-weight: 600; margin-top: 4px;
  letter-spacing: -0.01em; font-variant-numeric: tabular-nums;
}
.vx-receipt-val { font-size: 14px; font-weight: 500; margin-top: 4px; }
.vx-next { background: var(--vx-paper-2); padding: 22px 24px; }
.vx-next-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.vx-next-item { display: flex; gap: 14px; align-items: flex-start; }
.vx-next-n { font-size: 11px; padding-top: 3px; min-width: 24px; }
.vx-next-h { font-size: 14px; font-weight: 600; }
.vx-next-s { font-size: 13px; margin-top: 2px; }
.vx-btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 12px 22px; border-radius: 10px; border: 0;
  font-family: inherit; font-size: 14px; font-weight: 600;
  cursor: pointer; text-decoration: none;
}
.vx-btn-primary { background: var(--vx-ink); color: #fff; }
.vx-btn-primary:hover { background: #000; }
.vx-footer { text-align: center; padding-top: 16px; font-size: 12px; }

/* Responsive */
@media (max-width: 960px) {
  .vx-two-up, .vx-two-up-sm { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .vx-mast { padding: 16px 20px; }
  .vx-page { padding: 0 20px 40px; }
  .vx-hero { padding: 40px 0 28px; }
  .vx-card { padding: 20px; }
  .vx-note-quote { font-size: 22px; }
  .vx-facts { grid-template-columns: repeat(2, 1fr); }
  .vx-fact:nth-child(3) { border-left: 0; border-top: 1px solid var(--vx-line); }
  .vx-fact:nth-child(4) { border-top: 1px solid var(--vx-line); }
  .vx-booking-iframe { height: 640px; }
}
@media (max-width: 480px) {
  .vx-mast-left > :nth-child(2) { display: none; }
  .vx-fact-v { font-size: 18px; }
  .vx-receipt-grid { grid-template-columns: 1fr; }
  .vx-receipt-grid > div + div { border-top: 1px dashed var(--vx-line); padding-top: 10px; }
  .vx-booking-iframe { height: 560px; }
}

/* ────────────────────────────────────────────────────────────────
   Print-only receipt layout.

   In normal rendering the .vx-print-receipt div is display:none
   (hidden in the flow). When window.print() fires, @media print
   flips the scope: hide EVERYTHING inside .vx-studio, then reveal
   only .vx-print-receipt with a clean paper-ready layout.

   Result: the customer clicks Download Receipt on a legacy paid
   sale → print dialog → "Save as PDF" → they get a one-page
   receipt, not the whole thank-you screenshot.
   ──────────────────────────────────────────────────────────────── */
.vx-print-receipt { display: none; }

@media print {
  /* Reset the page so nothing bleeds from the thank-you layout. */
  html, body { background: #fff !important; }
  .vx-studio { background: #fff !important; color: #000 !important; }
  .vx-studio > *,
  .vx-studio header,
  .vx-studio .vx-page,
  .vx-studio section,
  .vx-studio footer,
  .vx-studio .vx-confetti-layer { display: none !important; }
  .vx-studio .vx-print-receipt { display: block !important; }

  .vx-print-receipt {
    font-family: 'Montserrat', -apple-system, system-ui, sans-serif;
    color: #0a1228;
    padding: 32px 40px;
    max-width: 760px;
    margin: 0 auto;
  }
  .vx-print-head {
    display: flex; align-items: center; gap: 14px;
    border-bottom: 2px solid #0a1228;
    padding-bottom: 14px; margin-bottom: 18px;
  }
  .vx-print-logo { width: 42px; height: 42px; flex-shrink: 0; object-fit: contain; }
  .vx-print-head-text { display: flex; flex-direction: column; }
  .vx-print-brand { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; }
  .vx-print-sub { font-size: 12px; color: #5a6478; margin-top: 2px; }
  .vx-print-title {
    font-size: 28px; font-weight: 800; letter-spacing: -0.02em;
    margin-bottom: 20px;
  }
  .vx-print-meta {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px;
    margin-bottom: 24px; font-size: 13px;
  }
  .vx-print-meta > div { display: flex; flex-direction: column; gap: 2px; }
  .vx-print-meta span {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: #5a6478;
  }
  .vx-print-meta strong { font-size: 14px; font-weight: 600; }

  .vx-print-scope { margin-bottom: 20px; padding-top: 12px; border-top: 1px dashed #dfe2ea; }
  .vx-print-label {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: #5a6478; margin-bottom: 4px;
  }
  .vx-print-scope-body { font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; }

  .vx-print-table {
    width: 100%; border-collapse: collapse;
    margin-bottom: 20px; font-size: 13px;
  }
  .vx-print-table th {
    text-align: left; padding: 10px 0;
    border-bottom: 1.5px solid #0a1228;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: #5a6478; font-weight: 500;
  }
  .vx-print-table td {
    padding: 10px 0; border-bottom: 1px dashed #dfe2ea;
    font-variant-numeric: tabular-nums;
  }
  .vx-print-table .vx-print-total td {
    border-top: 1.5px solid #0a1228; border-bottom: none;
    font-weight: 700; padding-top: 14px;
  }
  .vx-print-table .vx-print-paid td {
    background: #f4f5f9; font-weight: 700;
    padding: 12px 10px; border-bottom: none;
  }

  .vx-print-method {
    display: flex; gap: 10px; align-items: baseline;
    padding: 10px 0; font-size: 13px;
    border-top: 1px dashed #dfe2ea;
    border-bottom: 1px dashed #dfe2ea;
    margin-bottom: 24px;
  }
  .vx-print-method span {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: #5a6478;
  }

  .vx-print-foot {
    font-size: 11px; color: #5a6478; line-height: 1.6;
    padding-top: 12px;
  }
  .vx-print-ref {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    margin-top: 6px; letter-spacing: 0.02em;
  }

  /* Hide browser headers/footers (URL, date) on Chrome/Safari. The
     user still has to tick "Options → Headers and footers" off in
     the print dialog on older browsers, but this covers most. */
  @page { margin: 12mm; size: A4; }
}

/* Confetti */
.vx-burst {
  position: fixed; inset: 0; pointer-events: none; z-index: 50;
  display: flex; align-items: flex-start; justify-content: center; padding-top: 20vh;
}
.vx-burst i {
  position: absolute; width: 8px; height: 10px;
  animation: vx-pop 1.4s cubic-bezier(.2,.7,.2,1) forwards; opacity: 0;
}
@keyframes vx-pop {
  0%   { transform: translate(0,0) rotate(0); opacity: 0; }
  10%  { opacity: 1; }
  100% { transform: translate(var(--vx-x), var(--vx-y)) rotate(var(--vx-r)); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) { .vx-burst { display: none; } }

.vx-studio :focus-visible {
  outline: 2px solid var(--vx-orange);
  outline-offset: 2px; border-radius: 4px;
}
`;

function ErrorCard({ title, detail }) {
  return (
    <div style={{ padding: "60px 28px", textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#991B1B", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: "#64748B", maxWidth: 420, margin: "0 auto" }}>{detail}</div>
    </div>
  );
}

// Light-themed shell — the marketing-facing Viewix payment page is NOT the
// dashboard's dark palette; customers expect a clean white checkout surface.
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#F1F5F9", fontFamily: "'DM Sans',-apple-system,sans-serif", padding: "32px 16px" }}>
      <div style={{ maxWidth: 520, margin: "0 auto", background: "white", borderRadius: 16, boxShadow: "0 8px 32px rgba(15,23,42,0.08)", overflow: "hidden" }}>
        <div style={{ padding: "20px 28px", borderBottom: "1px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "center", background: "#0B0F1A" }}>
          <Logo h={22} />
        </div>
        {children}
        <div style={{ padding: "16px 28px", borderTop: "1px solid #E5E7EB", background: "#F8FAFC", textAlign: "center", fontSize: 11, color: "#94A3B8" }}>
          © Viewix Video Production · Sydney, Australia
        </div>
      </div>
    </div>
  );
}

// Tiny safe markdown subset for thank-you page copy. We don't pull in a
// full markdown library — the surface area founders need is small:
//   **bold**              → <strong>
//   - item / • item       → <ul><li>
//   blank line            → <p>…</p>
// Rendering is pure React (no dangerouslySetInnerHTML) so user-authored
// copy can't inject HTML. Anything that isn't bold or a bullet line is
// emitted as a paragraph; unrecognised markdown characters render
// literally, which is better than silently swallowing them.
function renderInline(text) {
  // Inside-paragraph line breaks: a single \n (that isn't a paragraph
  // boundary — those are handled upstream) becomes a <br/>. This lets
  // sign-offs like "Talk soon,\nThe Viewix Team" render as two lines
  // without needing a full blank-line paragraph break between them.
  const lines = text.split(/\n/);
  return lines.flatMap((line, li) => {
    const parts = line.split(/(\*\*[^*\n]+\*\*)/g);
    const nodes = parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) {
        return <strong key={`${li}-${i}`}>{p.slice(2, -2)}</strong>;
      }
      return <span key={`${li}-${i}`}>{p}</span>;
    });
    return li < lines.length - 1 ? [...nodes, <br key={`br-${li}`} />] : nodes;
  });
}
function MarkdownLite({ text }) {
  if (!text) return null;
  const paragraphs = String(text).split(/\n\s*\n/);
  return (
    <>
      {paragraphs.map((p, i) => {
        const lines = p.split(/\n/);
        const isList = lines.length > 0 && lines.every(l => /^\s*[-•]\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} style={{ margin: "0 0 14px", paddingLeft: 22 }}>
              {lines.map((l, j) => (
                <li key={j} style={{ marginBottom: 6, lineHeight: 1.6 }}>
                  {renderInline(l.replace(/^\s*[-•]\s+/, ""))}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} style={{ margin: "0 0 14px", lineHeight: 1.65 }}>
            {renderInline(p)}
          </p>
        );
      })}
    </>
  );
}

// Stripe Appearance API removed — Embedded Checkout styles its own
// iframe; branding is configured in the Stripe Dashboard (logo,
// brand colour) rather than passed per-session.
