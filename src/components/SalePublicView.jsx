// Public payment page served at /s/{shortId}/{slug}.
// Resolves the sale record from Firebase, requests a PaymentIntent from
// /api/create-payment-intent, and mounts Stripe's Elements so the customer
// can pay. Mirrors the auth pattern in DeliveryPublicView: anonymous sign-in
// + indexed scan by shortId.

import { useState, useEffect, useMemo } from "react";
import { initFB, onFB, fbListen, signInAnonymouslyForPublic } from "../firebase";
import { Logo } from "./Logo";
import { SALE_VIDEO_TYPES } from "../config";
import { fmtCur, logoBg, embedUrl, isEmbeddableBookingUrl, normaliseImageUrl } from "../utils";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";

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

  // Once we have the sale, request a PaymentIntent. Only re-request if the
  // sale id changes (not every re-render). If the sale is already paid we
  // skip this — the confirmation view renders instead.
  useEffect(() => {
    if (!sale || sale.paid) return;
    if (!STRIPE_PK) {
      setError("Stripe is not configured. Set VITE_STRIPE_PUBLISHABLE_KEY in your environment.");
      return;
    }
    if (!sale.depositAmount || sale.depositAmount <= 0) {
      setError("This payment link has no amount set. Contact the Viewix team.");
      return;
    }
    fetch("/api/create-payment-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId: sale.id }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.clientSecret) setClientSecret(d.clientSecret);
        else setError(d.error || "Failed to create payment intent.");
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
  if (sale.paid || optimisticPaid) {
    return <StudioThankYou sale={sale} thankYou={thankYou} roster={roster} justPaid={optimisticPaid && !sale.paid} />;
  }

  return (
    <Shell>
      <SaleSummary sale={sale} />
      {error && <ErrorCard title="Could not load payment form" detail={error} />}
      {!error && clientSecret && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: stripeAppearance }}>
          <CheckoutForm sale={sale} thankYou={thankYou} onSucceeded={() => setOptimisticPaid(true)} />
        </Elements>
      )}
      {!error && !clientSecret && (<div style={{ textAlign: "center", padding: 24, color: "var(--muted)", fontSize: 13 }}>Preparing secure payment form…</div>)}
    </Shell>
  );
}

function CheckoutForm({ sale, thankYou, onSucceeded }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setFormError(null);
    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    if (stripeError) {
      setFormError(stripeError.message || "Payment failed.");
      setSubmitting(false);
      return;
    }
    if (paymentIntent && paymentIntent.status === "succeeded") {
      // Flip the parent's optimistic-paid latch so the page swaps to
      // the Studio thank-you layout immediately. Firebase webhook will
      // catch up shortly after.
      onSucceeded?.();
    }
    setSubmitting(false);
  };

  return (
    <form onSubmit={submit} style={{ padding: "0 28px 40px" }}>
      <div style={{ background: "#ffffff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "20px 22px" }}>
        <PaymentElement />
      </div>
      {formError && <div style={{ marginTop: 12, padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#991B1B", fontSize: 13 }}>{formError}</div>}
      <button type="submit" disabled={!stripe || submitting} style={{ marginTop: 16, width: "100%", padding: "14px 20px", borderRadius: 10, border: "none", background: submitting ? "#94A3B8" : "#0082FA", color: "white", fontSize: 15, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer" }}>
        {submitting ? "Processing…" : `Pay ${fmtCur(sale.depositAmount)} Deposit`}
      </button>
      <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: "#64748B" }}>Payments secured by Stripe. You'll receive a receipt by email.</div>
    </form>
  );
}

function SaleSummary({ sale }) {
  return (
    <div style={{ padding: "28px 28px 0" }}>
      {sale.logoUrl && (
        <div style={{ textAlign: "center", marginBottom: 20, padding: 20, background: logoBg(sale.logoUrl), borderRadius: 12, border: "1px solid #E5E7EB" }}>
          <img src={sale.logoUrl} alt={sale.clientName} style={{ maxHeight: 60, maxWidth: "80%" }} />
        </div>
      )}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Deposit Payment</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#0B0F1A", marginBottom: 4 }}>{sale.clientName}</div>
        <div style={{ fontSize: 13, color: "#64748B" }}>{videoTypeLabel(sale.videoType)} · {packageLabel(sale.videoType, sale.packageKey)}</div>
      </div>
      <div style={{ textAlign: "center", padding: "24px 20px", background: "linear-gradient(135deg, #0082FA 0%, #005FBF 100%)", borderRadius: 12, marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Amount Due</div>
        <div style={{ fontSize: 36, fontWeight: 800, color: "white", fontFamily: "'JetBrains Mono',monospace" }}>{fmtCur(sale.depositAmount)}</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", marginTop: 4 }}>AUD · One-time deposit</div>
      </div>
      {sale.scopeNotes && (
        <div style={{ padding: "16px 18px", background: "#F8FAFC", border: "1px solid #E5E7EB", borderRadius: 10, marginBottom: 24 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>What this deposit covers</div>
          <div style={{ fontSize: 13, color: "#0B0F1A", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{sale.scopeNotes}</div>
        </div>
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
            Your {pkgLabel.toLowerCase()} deposit is in. We're genuinely excited to start creating with you — here's how the next few weeks look.
          </p>
        </section>

        {/* 4-up facts strip */}
        <section className="vx-facts">
          <StudioFact k="Paid" v={fmtCur(sale.depositAmount)} sub="Deposit" />
          <StudioFact k="Order" v={orderRef} sub="Reference" mono />
          <StudioFact k="Producer" v={PRODUCER.name} sub={PRODUCER.role} />
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
              <div className="vx-booking-meta vx-muted vx-mono">60 MIN · ZOOM · AEST</div>
            </div>
            {bookingUrl && thankYou?.bookingEmbed !== false && isEmbeddableBookingUrl(bookingUrl) ? (
              <iframe
                src={bookingUrl} title="Book your pre-production meeting"
                className="vx-booking-iframe"
                loading="lazy"
              />
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
                <div className="vx-receipt-amount vx-mono">{fmtCur(sale.depositAmount)}</div>
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
          </div>

          {/* What happens next */}
          <div className="vx-card vx-next">
            <div className="vx-eyebrow" style={{ marginBottom: 10 }}>What happens next</div>
            <ol className="vx-next-list">
              <StudioNext n="01" h="Watch the welcome video" s="Two minutes. It saves ten in the meeting." />
              <StudioNext n="02" h="Lock your pre-production time" s="Brief, creative direction, shoot dates." />
              <StudioNext n="03" h="Onboarding pack in your inbox" s="Within 24 hours of our call." />
              <StudioNext n="04" h="Shoot day on-site in Sydney" s="Roughly 3 weeks from today." />
            </ol>
          </div>
        </section>

        <footer className="vx-footer vx-mono vx-muted2">
          © VIEWIX VIDEO PRODUCTION · SYDNEY · {new Date().getFullYear()}
        </footer>
      </div>
    </div>
  </>);
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
  font-family: 'Montserrat', -apple-system, system-ui, sans-serif;
  color: var(--vx-ink);
  background: var(--vx-paper);
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.vx-studio * { box-sizing: border-box; }
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

const stripeAppearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#0082FA",
    colorBackground: "#ffffff",
    colorText: "#0B0F1A",
    fontFamily: "'DM Sans', -apple-system, sans-serif",
    borderRadius: "8px",
  },
};
