// ClientPortal — the EXTERNAL, client-facing analytics surface.
//
// Reached via a per-client magic link: /r/{portalShortId}/slug (or
// legacy ?r=shortId). No password. Anonymous Firebase auth + the
// shortId in the URL is the token, exactly mirroring the proven
// DeliveryPublicView pattern.
//
// It reads ONLY /analytics/public/{portalShortId} — a client-safe
// projection authored server-side in api/_analyticsClientProjection.js.
// It physically cannot render internal state (scores, rule ids, raw
// confidence, Renewal Ammo, debug) because none of that is in the
// projection. "Nothing internal leaks" is a storage guarantee here,
// not a UI promise.
//
// Light, fully brand-compliant (CSS_LIGHT, scoped to `.viewix-portal`).
// Mobile-first. This is a monthly client confidence check, not an
// analytics dashboard — see the design brief.
//
// Step 2 = the shell: routing, light theme, anon auth, projection
// read, the loading / not-found / gathering states, and the page
// scaffold. The real zones (Header, Winning, NextVideos, …) drop into
// <PortalBody/> in step 3.

import { useState, useEffect } from "react";
import { initFB, onFB, fbListen, signInAnonymouslyForPublic } from "../../firebase";
import { CSS_LIGHT } from "../../config";
import { Logo } from "../../components/Logo";
import { GATHERING } from "./portalCopy";
import { Winning } from "./zones/Winning";
import { NextVideos } from "./zones/NextVideos";
import { FormatPlaybook } from "./zones/FormatPlaybook";
import { Story } from "./zones/Story";
import { Niche } from "./zones/Niche";
import { WhatThisIncludes } from "./zones/WhatThisIncludes";

function readShortId() {
  const pretty = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]{6,16})(?:\/|$)/);
  if (pretty) return pretty[1];
  return new URLSearchParams(window.location.search).get("r") || null;
}

export function ClientPortal() {
  const shortId = readShortId();
  const [projection, setProjection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!shortId) { setLoading(false); setError("missing"); return undefined; }
    document.title = "Viewix — Your Content Performance";
    initFB();
    let unsub = () => {};
    let cancelled = false;
    // Safety net: if the listener never fires (rules denial that
    // didn't invoke onError, or SDK init stuck), stop spinning.
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      setLoading(false);
      setError(prev => prev || "timeout");
    }, 8000);

    onFB(async () => {
      try {
        await signInAnonymouslyForPublic();
      } catch (e) {
        // Continue — rules may still allow the read; if not, onError
        // below surfaces it.
        console.warn("[clientPortal] anon auth failed:", e.message);
      }
      if (cancelled) return;
      unsub = fbListen(
        `/analytics/public/${shortId}`,
        (data) => {
          clearTimeout(timeoutId);
          if (cancelled) return;
          // A retired tombstone (written when a client moves to the
          // multi-platform pipeline before the Phase 4 portal exists) is
          // truthy but is NOT a renderable projection — treat it as
          // not-found rather than feeding the "still gathering" UI with a
          // doc that has no zones (Codex r4).
          if (data && data.retired) { setProjection(null); setError("notfound"); }
          else if (data) { setProjection(data); setError(null); }
          else { setError("notfound"); }
          setLoading(false);
        },
        (e) => {
          clearTimeout(timeoutId);
          if (cancelled) return;
          console.warn("[clientPortal] read error:", e?.code || e?.message);
          setError("read");
          setLoading(false);
        },
      );
    });

    return () => { cancelled = true; clearTimeout(timeoutId); unsub(); };
  }, [shortId]);

  return (
    <div className="viewix-portal">
      <style>{CSS_LIGHT}</style>
      {loading ? (
        <CenteredState>
          <Logo h={34} />
          <div style={{ marginTop: 16, color: "var(--muted)", fontSize: 14 }}>
            Loading your dashboard…
          </div>
        </CenteredState>
      ) : error ? (
        <CenteredState>
          <Logo h={34} />
          <div style={{
            marginTop: 18, color: "var(--fg)", fontSize: 15, fontWeight: 600,
            maxWidth: 360, textAlign: "center", lineHeight: 1.6,
          }}>
            {error === "missing" || error === "notfound"
              ? "This link doesn't seem to be active. Reach out to your Viewix contact for a fresh one."
              : error === "timeout"
              ? "Taking longer than expected to load. Refresh in a moment, or contact your Viewix contact."
              : "We couldn't load your dashboard just now. Please try again shortly."}
          </div>
        </CenteredState>
      ) : (
        <PortalBody p={projection} />
      )}
    </div>
  );
}

function CenteredState({ children }) {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 24,
      background: "var(--bg)",
    }}>
      <div style={{ textAlign: "center" }}>{children}</div>
    </div>
  );
}

// PortalBody — the page, in build/priority order:
//   Header snapshot → Winning → NextVideos → FormatPlaybook → Story →
//   Niche → "what this includes" drawer.
//
// First-screen discipline (the ~15s trust moment on a 375px phone):
// the Header card is deliberately tight — one momentum sentence + one
// hero proof — and the very next thing is the single top winning post
// (Winning's first card is accented) plus the first next-video idea.
// One proof, one post, one idea before scroll. Not a mini dashboard.
function PortalBody({ p }) {
  const company = p?.header?.companyName || "Your content";
  const freshness = p?.meta?.freshnessLine || "";
  const ds = p?.meta?.dataState || {};
  const headerGathering = ds.header === "gathering";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px 64px" }}>
      <div className="rise" style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 18,
      }}>
        <Logo h={28} />
        <span style={{ fontSize: 12, color: "var(--muted)", textAlign: "right" }}>
          {freshness}
        </span>
      </div>

      {/* Header snapshot card — momentum + hero proof. Tight. */}
      <div className="rise" style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: 16, padding: "22px 20px",
      }}>
        <div style={{
          fontSize: 13, fontWeight: 800, color: "var(--navy)",
          textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8,
        }}>
          {company}
        </div>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--fg)", lineHeight: 1.4 }}>
          {headerGathering
            ? GATHERING.header
            : (p?.header?.momentumSentence || GATHERING.header)}
        </div>
        {p?.header?.heroProof && !headerGathering && (
          <div style={{
            marginTop: 12, fontSize: 15, color: "var(--fg)", lineHeight: 1.55,
          }}>
            {p.header.heroProof}
          </div>
        )}
      </div>

      <Winning items={p?.winning} dataState={ds.winning} />
      <NextVideos items={p?.nextVideos} dataState={ds.nextVideos} />
      <FormatPlaybook items={p?.formatPlaybook} dataState={ds.formatPlaybook} />
      <Story story={p?.story} dataState={ds.story} />
      <Niche niche={p?.niche} dataState={ds.niche} />
      <WhatThisIncludes text={p?.meta?.whatThisIncludes} />
    </div>
  );
}
