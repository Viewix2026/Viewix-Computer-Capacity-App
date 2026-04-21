// Public payment page served at /s/{shortId}/{slug}.
// Resolves the sale record from Firebase, requests a PaymentIntent from
// /api/create-payment-intent, and mounts Stripe's Elements so the customer
// can pay. Mirrors the auth pattern in DeliveryPublicView: anonymous sign-in
// + indexed scan by shortId.

import { useState, useEffect, useMemo } from "react";
import { initFB, onFB, fbListen, signInAnonymouslyForPublic } from "../firebase";
import { Logo } from "./Logo";
import { SALE_VIDEO_TYPES } from "../config";
import { fmtCur, logoBg, embedUrl } from "../utils";
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

  const prettyMatch = window.location.pathname.match(/^\/s\/([a-z0-9]{4,12})/i);
  const shortId = prettyMatch ? prettyMatch[1].toLowerCase() : null;
  const saleIdParam = new URLSearchParams(window.location.search).get("s");

  useEffect(() => {
    if (!shortId && !saleIdParam) return;
    document.title = "Viewix — Deposit Payment";
    initFB();
    let unsub = () => {};
    const timeoutId = setTimeout(() => {
      setLoading(false);
      setError(prev => prev || "Timed out loading payment details. The link may be invalid.");
    }, 8000);
    onFB(async () => {
      try { await signInAnonymouslyForPublic(); } catch (e) {
        setError(`Anonymous sign-in failed: ${e.message}`);
      }
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
    return () => { clearTimeout(timeoutId); unsub(); };
  }, [shortId, saleIdParam]);

  // Thank-you content — read once the sale is resolved (don't block the
  // payment form waiting for it). Nullish is fine; PaidCard falls back to
  // the generic copy for tiers that haven't had their slot filled in yet.
  useEffect(() => {
    if (!sale) return;
    let unsub = () => {};
    onFB(() => {
      unsub = fbListen("/saleThankYou", (data) => setThankYou(data || null));
    });
    return () => unsub();
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

  if (sale.paid) {
    return (<Shell><PaidCard sale={sale} thankYou={thankYou} /></Shell>);
  }

  return (
    <Shell>
      <SaleSummary sale={sale} />
      {error && <ErrorCard title="Could not load payment form" detail={error} />}
      {!error && clientSecret && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: stripeAppearance }}>
          <CheckoutForm sale={sale} thankYou={thankYou} />
        </Elements>
      )}
      {!error && !clientSecret && (<div style={{ textAlign: "center", padding: 24, color: "var(--muted)", fontSize: 13 }}>Preparing secure payment form…</div>)}
    </Shell>
  );
}

function CheckoutForm({ sale, thankYou }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [succeeded, setSucceeded] = useState(false);

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
      setSucceeded(true);
    }
    setSubmitting(false);
  };

  if (succeeded) return <PaidCard sale={sale} thankYou={thankYou} justPaid />;

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

function PaidCard({ sale, thankYou, justPaid }) {
  // Per-package thank-you slot. Falls back to an empty object (no video,
  // no copy) so an un-configured tier still renders a working page — the
  // customer sees the confirmation, receipt badge, and booking button.
  const slot = thankYou?.packages?.[sale.videoType]?.[sale.packageKey] || {};
  const bookingUrl = thankYou?.bookingUrl?.trim() || "";
  const videoSrc = embedUrl(slot.videoUrl);
  const nextSteps = (slot.nextStepsCopy || "").trim();

  return (
    <div style={{ padding: "40px 28px 32px", textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 10 }}>✓</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#0B0F1A", marginBottom: 6 }}>
        {justPaid ? "Payment received" : "Payment already received"}
      </div>
      <div style={{ fontSize: 14, color: "#64748B", marginBottom: 20 }}>
        Thank you, {sale.clientName}.
      </div>

      {/* Receipt badge */}
      <div style={{ display: "inline-block", padding: "10px 16px", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 8, color: "#166534", fontSize: 13, fontWeight: 600, marginBottom: 28 }}>
        {fmtCur(sale.depositAmount)} · {packageLabel(sale.videoType, sale.packageKey)} deposit
      </div>

      {/* Welcome video */}
      {videoSrc && (
        <div style={{ marginBottom: 24, borderRadius: 12, overflow: "hidden", border: "1px solid #E5E7EB", background: "#000", aspectRatio: "16 / 9" }}>
          <iframe
            src={videoSrc} title="Welcome from Viewix"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          />
        </div>
      )}

      {/* Next-steps copy */}
      {nextSteps && (
        <div style={{ marginBottom: 24, padding: "20px 22px", background: "#F8FAFC", border: "1px solid #E5E7EB", borderRadius: 12, textAlign: "left" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>What happens next</div>
          <div style={{ fontSize: 14, color: "#0B0F1A", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{nextSteps}</div>
        </div>
      )}

      {/* Booking CTA */}
      {bookingUrl && (
        <a href={bookingUrl} target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-block", padding: "14px 28px", borderRadius: 10, background: "#0082FA", color: "white", fontSize: 15, fontWeight: 700, textDecoration: "none" }}>
          Book your kickoff call →
        </a>
      )}

      {/* Fallback copy if nothing is configured for this tier yet */}
      {!videoSrc && !nextSteps && !bookingUrl && (
        <div style={{ fontSize: 13, color: "#64748B" }}>The Viewix team will be in touch shortly.</div>
      )}
    </div>
  );
}

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
