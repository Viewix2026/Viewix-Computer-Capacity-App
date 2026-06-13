import { useEffect, useState, useCallback } from "react";
import {
  initFB, onClientAuthChanged, looksLikeClientSignInLink, completeClientSignIn,
  getPendingClientEmail, signOutUser, authFetch,
} from "../../firebase";
import { PORTAL_CSS } from "./portalTheme";
import { ViewixLogo } from "./ui";
import { SignIn } from "./SignIn";
import { Dashboard } from "./Dashboard";
import { ProjectView } from "./ProjectView";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { Analytics } from "./Analytics";
// DEV-only: mock user + data so /clients/?preview renders the whole
// portal without Firebase auth (which can't complete in the preview
// sandbox). Every use below is import.meta.env.DEV-gated, so this
// import tree-shakes out of production builds.
import { PREVIEW_USER, previewFetch } from "./previewData";

const THEME_KEY = "vx_portal_theme";

function PortalLoading({ label = "Loading your portal..." }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <div style={{ textAlign: "center" }}>
        <ViewixLogo size={26} style={{ margin: "0 auto" }} />
        <div style={{ marginTop: 16, color: "var(--text-3)", fontSize: 13 }}>{label}</div>
      </div>
    </div>
  );
}

// Parse the in-portal route from the pathname:
//   /clients, /clients/                  -> { name:"dashboard" }
//   /clients/p/<shortId>                 -> { name:"project", id, view:"videos" }
//   /clients/p/<shortId>/preprod         -> { name:"project", id, view:"preprod" }
//   /clients/p/<shortId>/schedule        -> { name:"project", id, view:"schedule" }
//   /clients/analytics                   -> { name:"analytics" }
//   /clients/accounts                    -> { name:"accounts" }   (Phase 5)
function parseRoute() {
  if (/^\/clients\/accounts\/?$/i.test(window.location.pathname)) {
    return { name: "accounts" };
  }
  if (/^\/clients\/analytics\/?$/i.test(window.location.pathname)) {
    return { name: "analytics" };
  }
  const m = window.location.pathname.match(/^\/clients\/p\/([a-z0-9]{4,16})(?:\/(preprod|schedule))?\/?$/i);
  if (m) return { name: "project", id: m[1].toLowerCase(), view: (m[2] || "videos").toLowerCase() };
  return { name: "dashboard" };
}

export function ClientPortal() {
  // DEV preview mode: captured once at mount. import.meta.env.DEV is a
  // build-time false in prod, so this folds to `false`, PREVIEW_USER /
  // previewFetch references below become dead, and the import is
  // tree-shaken away. ?preview survives SPA nav because the flag lives
  // in state and navigate() re-appends the query param.
  const [preview] = useState(() => import.meta.env.DEV
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).has("preview"));

  const [user, setUser] = useState(import.meta.env.DEV && preview ? PREVIEW_USER : undefined); // undefined=boot, null=signed out, obj=in
  const [completing, setCompleting] = useState(import.meta.env.DEV && preview ? false : looksLikeClientSignInLink());
  const [needEmail, setNeedEmail] = useState(false);     // cross-device link open
  const [completeErr, setCompleteErr] = useState("");
  const [route, setRoute] = useState(parseRoute());
  const [theme, setTheme] = useState(() => {
    try { return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
  });

  useEffect(() => {
    document.title = "Viewix — Client Portal";
    if (import.meta.env.DEV && preview) return;   // no Firebase in preview
    initFB();
  }, [preview]);

  // Complete an email-link sign-in if we arrived via one. Gate on the
  // URL-only check (the CDN auth SDK may not be loaded yet);
  // completeClientSignIn awaits onFB and does the authoritative check.
  useEffect(() => {
    if (import.meta.env.DEV && preview) return;
    if (!looksLikeClientSignInLink()) return;
    let cancelled = false;
    (async () => {
      try {
        await completeClientSignIn();           // uses pending email (same device)
        if (cancelled) return;
        // Strip the long sign-in query string, keep the path — the
        // continue URL may carry a deep link (/clients/p/{id}/preprod).
        window.history.replaceState(null, "", window.location.pathname);
        setRoute(parseRoute());
        setCompleting(false);
      } catch (e) {
        if (cancelled) return;
        if (e?.code === "vx/email-required" && !getPendingClientEmail()) {
          setNeedEmail(true);                   // cross-device → ask for email
        } else {
          setCompleteErr(e?.message || "Sign-in link could not be completed");
        }
        setCompleting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Continuous auth subscription.
  useEffect(() => {
    if (import.meta.env.DEV && preview) return undefined;   // mock user, no Firebase auth
    return onClientAuthChanged(u => setUser(u));
  }, [preview]);

  // In-portal navigation (history API + popstate). In preview mode the
  // ?preview flag is re-appended so a manual reload stays in preview.
  const navigate = useCallback((to) => {
    const q = import.meta.env.DEV && preview ? (to.includes("?") ? "&preview=1" : "?preview=1") : "";
    window.history.pushState(null, "", to + q);
    setRoute(parseRoute());
  }, [preview]);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const onTheme = useCallback((t) => {
    setTheme(t);
    try { window.localStorage.setItem(THEME_KEY, t); } catch {}
  }, []);

  const onSignOut = useCallback(async () => {
    if (import.meta.env.DEV && preview) { navigate("/clients/"); return; }   // keep the mock session
    try { await signOutUser(); } catch {}
    navigate("/clients/");
    setUser(null);
  }, [navigate, preview]);

  // Top-level tab navigation (PortalNav / MobileTabBar).
  const onNavTab = useCallback((tab) => {
    navigate(tab === "Analytics" ? "/clients/analytics" : "/clients/");
  }, [navigate]);

  // Finish a cross-device link once the user re-enters their email.
  const completeWithEmail = useCallback(async (email) => {
    setCompleteErr("");
    try {
      await completeClientSignIn(email);
      window.history.replaceState(null, "", window.location.pathname);
      setRoute(parseRoute());
      setNeedEmail(false);
    } catch (e) {
      setCompleteErr(e?.message || "Could not complete sign-in");
    }
  }, []);

  // In preview, all /api/client/* calls resolve from local fixtures.
  // Prod folds this to `authFetch` and tree-shakes previewFetch out.
  const apiFetch = import.meta.env.DEV && preview ? previewFetch : authFetch;

  let body;
  if (completing) {
    body = <PortalLoading label="Signing you in..." />;
  } else if (!user) {
    body = (
      <SignIn
        needEmail={needEmail}
        completeError={completeErr}
        onCompleteWithEmail={completeWithEmail}
      />
    );
  } else if (route.name === "project") {
    body = (
      <ProjectView
        projectShortId={route.id}
        view={route.view}
        onViewChange={(v) => navigate(`/clients/p/${route.id}${v === "videos" ? "" : `/${v}`}`)}
        user={user}
        theme={theme}
        onTheme={onTheme}
        onSignOut={onSignOut}
        onBack={() => navigate("/clients/")}
        onNav={onNavTab}
        authFetch={apiFetch}
      />
    );
  } else if (route.name === "analytics") {
    body = (
      <Analytics
        user={user}
        theme={theme}
        onTheme={onTheme}
        onSignOut={onSignOut}
        onNav={onNavTab}
        authFetch={apiFetch}
      />
    );
  } else if (route.name === "accounts") {
    body = (
      <ConnectedAccounts
        user={user}
        theme={theme}
        onTheme={onTheme}
        onSignOut={onSignOut}
        onBack={() => navigate("/clients/")}
        onNav={onNavTab}
      />
    );
  } else {
    body = (
      <Dashboard
        user={user}
        theme={theme}
        onTheme={onTheme}
        onSignOut={onSignOut}
        onOpenProject={(shortId, view) => navigate(`/clients/p/${shortId}${view && view !== "videos" ? `/${view}` : ""}`)}
        onNav={onNavTab}
        authFetch={apiFetch}
      />
    );
  }

  return (
    <div className={"vx" + (theme === "dark" ? " dark" : "")}>
      <style>{PORTAL_CSS}</style>
      {body}
    </div>
  );
}
