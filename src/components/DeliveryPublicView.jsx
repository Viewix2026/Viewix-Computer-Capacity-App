import { useState, useEffect } from "react";
import { initFB, onFB, fbListen, signInAnonymouslyForPublic } from "../firebase";
import { PORTAL_CSS } from "./portal/portalTheme";
import { ViewixLogo, useIsNarrow } from "./portal/ui";
import { Deliveries } from "./portal/Deliveries";
import { AccountManagerCard } from "./portal/AccountManagerCard";

// The public /d/{shortId} delivery link now renders the SAME light,
// branded UI as the logged-in portal Deliveries tab. This component is a
// thin shell: it keeps the anonymous-auth + raw /deliveries read (the link
// stays tokenless), adapts the raw node into the portal Deliveries prop
// shape, and renders the shared <Deliveries> + <AccountManagerCard>.
//
// Writes (revision1/revision2/posted) happen INSIDE <Deliveries> via the
// shared deliveryReview/deliveryWrites module — the same leaf paths and the
// same 2-minute notify batching the portal uses. We gate them on
// `writeEnabled={authReady}` so a click can't fire before anonymous auth
// has resolved.

// Adapt a raw /deliveries/{id} node to the portal Deliveries prop shape.
// Mirrors videoRow() in api/_clientRedact.js. <Deliveries> recomputes its
// own counts from rows, so we only need available + ids + rows.
function toDeliveriesProp(delivery) {
  const videos = Array.isArray(delivery?.videos) ? delivery.videos : [];
  return {
    available: true,
    deliveryId: delivery.id,
    shortId: delivery.shortId || null,
    orgName: delivery.clientName || "",
    rows: videos.map((v, idx) => ({
      n: idx + 1,
      idx,                                  // RTDB array index — write path target
      id: v?.id || v?.videoId || `v-${idx}`,
      title: String(v?.name || ""),
      link: v?.link ? String(v.link) : "",
      viewixStatus: String(v?.viewixStatus || ""),
      revision1: String(v?.revision1 || ""),
      revision2: String(v?.revision2 || ""),
      posted: !!v?.posted,
      caption: v?.caption ? String(v.caption) : "",
    })),
  };
}

export function DeliveryPublicView() {
  const narrow = useIsNarrow();
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [notFoundReason, setNotFoundReason] = useState(null);
  const [am, setAm] = useState(null);

  // Support both pretty paths (/d/HASH/slug) and legacy ?d=ID.
  const deliveryId = new URLSearchParams(window.location.search).get("d");
  const prettyMatch = window.location.pathname.match(/^\/d\/([a-z0-9]{4,12})/i);
  const shortId = prettyMatch ? prettyMatch[1].toLowerCase() : null;

  useEffect(() => {
    if (!deliveryId && !shortId) return;
    document.title = "Viewix — Your Videos";
    initFB();
    let unsub = () => {};
    let cancelled = false;
    // Safety net: if the listener never fires within 8s (rules denial that
    // didn't invoke onError, or SDK init stuck), stop the spinner and
    // surface the reason — never hang on "Loading…".
    const timeoutId = setTimeout(() => {
      setLoading(false);
      setNotFoundReason(prev => prev || "Timed out waiting for Firebase. The link may be invalid, or anonymous access is restricted on this deployment.");
    }, 8000);
    onFB(async () => {
      try {
        await signInAnonymouslyForPublic();
        if (!cancelled) setAuthReady(true);          // unlocks writes
      } catch (e) {
        if (!cancelled) setNotFoundReason(`Anonymous sign-in failed: ${e.message}. Enable anonymous auth in Firebase, or ask a producer to grant public read access.`);
      }
      if (cancelled) return;
      const onReadError = (e) => {
        clearTimeout(timeoutId);
        setLoading(false);
        setNotFoundReason(`Firebase read error: ${e.code || e.message || "unknown"}. Rules may be blocking anonymous reads of this delivery.`);
      };
      if (deliveryId) {
        unsub = fbListen(`/deliveries/${deliveryId}`, (data) => {
          clearTimeout(timeoutId);
          if (data) { setDelivery({ ...data, id: data.id || deliveryId }); setNotFoundReason(null); }
          else setNotFoundReason(`No delivery record at /deliveries/${deliveryId}. It may have been deleted or renamed.`);
          setLoading(false);
        }, onReadError);
      } else if (shortId) {
        unsub = fbListen("/deliveries", (all) => {
          clearTimeout(timeoutId);
          if (!all) {
            setNotFoundReason("The deliveries collection came back empty — anonymous reads may be blocked, or there are no deliveries yet.");
            setLoading(false);
            return;
          }
          const match = Object.values(all).find(d => d && d.shortId && d.shortId.toLowerCase() === shortId);
          if (match) { setDelivery(match); setNotFoundReason(null); }
          else {
            const total = Object.values(all).filter(d => d && d.id).length;
            setNotFoundReason(`Checked ${total} deliveries — none have shortId "${shortId}". The link may be stale or the record was deleted.`);
          }
          setLoading(false);
        }, onReadError);
      }
    });
    return () => { cancelled = true; clearTimeout(timeoutId); unsub(); };
  }, [deliveryId, shortId]);

  // Resolve the Account Manager block once we know the delivery id. The
  // server endpoint (Admin SDK) does delivery → project → account →
  // editors and returns ONLY the 5 redacted AM fields — the browser never
  // reads /accounts, /editors or /projects.
  useEffect(() => {
    const id = delivery?.id;
    if (!id) return;
    let cancelled = false;
    fetch(`/api/public/delivery-am?deliveryId=${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setAm(d.accountManager || null); })
      .catch(() => { /* AM is best-effort; the review still works without it */ });
    return () => { cancelled = true; };
  }, [delivery?.id]);

  const wrap = (children) => (
    <div className="vx" style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <style>{PORTAL_CSS}</style>
      {children}
    </div>
  );

  if (loading) return wrap(
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <ViewixLogo size={26} style={{ margin: "0 auto" }} />
        <div style={{ marginTop: 16, color: "var(--text-3)", fontSize: 13 }}>Loading your videos…</div>
      </div>
    </div>
  );

  if (!delivery) return wrap(
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <ViewixLogo size={28} style={{ margin: "0 auto 18px" }} />
        <h2 style={{ margin: "0 0 10px", fontSize: 20, fontWeight: 700, color: "var(--heading)" }}>This delivery link is broken</h2>
        {notFoundReason && <p style={{ color: "var(--text-3)", fontSize: 13, lineHeight: 1.6, margin: "0 0 16px" }}>{notFoundReason}</p>}
        <p style={{ color: "var(--text-3)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          Please ask Viewix for a fresh link, or have a producer copy the new share URL from the Projects → Deliveries tab.
        </p>
      </div>
    </div>
  );

  const adapted = toDeliveriesProp(delivery);

  // Client logo: render at the same visual height as the Viewix logo
  // on the left, but let the natural aspect ratio determine width (with
  // a generous cap so very wide logos don't push the project text out
  // of frame). No background / border / radius — present the asset
  // cleanly the way the staff Account row does.
  const clientLogoHeight = narrow ? 24 : 32;
  const header = (
    // Full-width border / background, but inner content constrained to
    // the same maxWidth as the body grid below so left/right edges align.
    <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", padding: narrow ? "16px 18px" : "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <ViewixLogo size={narrow ? 22 : 28} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
          <div style={{ minWidth: 0, textAlign: "right" }}>
            <div style={{ fontSize: narrow ? 16 : 19, fontWeight: 700, color: "var(--heading)", letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{delivery.projectName || "Your videos"}</div>
            <div style={{ fontSize: 13, color: "var(--text-3)" }}>{delivery.clientName || ""}</div>
          </div>
          {delivery.logoUrl && (
            <img
              src={delivery.logoUrl}
              alt={delivery.clientName || ""}
              style={{ height: clientLogoHeight, width: "auto", maxWidth: narrow ? 120 : 180, objectFit: "contain", flexShrink: 0, display: "block" }}
            />
          )}
        </div>
      </div>
    </div>
  );

  return wrap(
    <>
      {header}
      {narrow ? (
        <>
          <Deliveries deliveries={adapted} accountManager={am} narrow writeEnabled={authReady} />
          {am && <div style={{ padding: "0 16px 40px" }}><AccountManagerCard am={am} /></div>}
        </>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", maxWidth: 1340, margin: "0 auto", alignItems: "start" }}>
          <Deliveries deliveries={adapted} accountManager={am} narrow={false} writeEnabled={authReady} />
          <aside style={{ padding: "28px 32px 60px 0", position: "sticky", top: 0 }}>
            {am && <AccountManagerCard am={am} />}
          </aside>
        </div>
      )}
    </>
  );
}
