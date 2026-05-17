// ─── Firebase ───
// IMPORTANT: This file uses the CDN compat SDK (v10.12.2). Do NOT import from the 'firebase'
// npm package anywhere in src/ — it would create a second app instance that doesn't share
// auth state with the CDN one and would silently break auth + realtime database.
const FB_CFG = {
  apiKey: "AIzaSyDhv_5W36_2Q2eVBvopg98Bwgq-D66-b2s",
  authDomain: "viewix-capacity-tracker.firebaseapp.com",
  databaseURL: "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "viewix-capacity-tracker",
  storageBucket: "viewix-capacity-tracker.firebasestorage.app",
  messagingSenderId: "1039857514551",
  appId: "1:1039857514551:web:afe099ade6fdaf6cf1e7b2"
};

let db = null, auth = null, fbReady = false;
let authReady = false, currentRole = null;
const fbCbs = [];
const authCbs = [];

export function initFB() {
  if (fbReady || document.getElementById("fb-s")) return;
  const s1 = document.createElement("script");
  s1.id = "fb-s";
  s1.src = "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js";
  s1.onload = () => {
    const s2 = document.createElement("script");
    s2.src = "https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js";
    s2.onload = () => {
      const s3 = document.createElement("script");
      s3.src = "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js";
      s3.onload = () => {
        window.firebase.initializeApp(FB_CFG);
        db = window.firebase.database();
        auth = window.firebase.auth();
        fbReady = true;
        fbCbs.forEach(c => c());
        fbCbs.length = 0;

        // Session restore: fires immediately if user is already signed in (via IndexedDB persistence)
        // and on every subsequent sign-in/out.
        auth.onAuthStateChanged(async user => {
          if (user) {
            try {
              // Force refresh on every session restore. Custom claims
              // set after the user's last sign-in (e.g. when /api/auth
              // started calling setCustomUserClaims to persist the
              // role) don't land on the existing cached ID token —
              // Firebase only picks them up on a forced refresh, or
              // ~55 min later when the token naturally expires. The
              // gap was producing PERMISSION_DENIED and "Forbidden"
              // errors for users whose user records had been
              // back-filled but whose browser session still held the
              // pre-backfill token.
              const tok = await user.getIdTokenResult(true);
              currentRole = tok.claims?.role || null;
            } catch {
              currentRole = null;
            }
          } else {
            currentRole = null;
          }
          authReady = true;
          const cbs = [...authCbs];
          authCbs.length = 0;
          cbs.forEach(c => c(currentRole));
        });
      };
      document.head.appendChild(s3);
    };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}

export function onFB(cb) {
  if (fbReady) cb();
  else fbCbs.push(cb);
}

// Per-path "recently wrote locally" stamps. Every write through this
// module records the millisecond timestamp against the path's top-level
// prefix (e.g. "/deliveries/X/videos/0/link" -> "/deliveries"). The
// App.jsx listener wrapper consults `recentlyWroteTo(prefix)` to decide
// whether to apply or suppress an incoming listener fire.
//
// Why: Firebase's onValue listens at a subtree root and re-delivers the
// FULL subtree whenever ANY leaf changes. If you fast-type a leaf and
// Firebase fires the listener with a snapshot it captured between two
// of your writes (or from a concurrent server-side write that arrived
// at the same time), the listener's `setDeliveries(arrayFromFirebase)`
// will clobber your just-typed value. The bulk-write `skipRead` guard
// only covered the App.jsx debounce window; per-path stamps cover EVERY
// recent local write regardless of timing.
const recentWrites = new Map(); // path-prefix -> Date.now() ms
const stampWrite = (p) => {
  const m = String(p || "").match(/^(\/[^/]+)/);
  if (m) recentWrites.set(m[1], Date.now());
};
export function recentlyWroteTo(pathPrefix, withinMs = 1500) {
  const t = recentWrites.get(pathPrefix);
  return !!t && Date.now() - t < withinMs;
}

export function fbSet(p, v) {
  stampWrite(p);
  if (db) db.ref(p).set(v).catch(e => console.error("Firebase set failed", p, e));
}

// Awaitable version — use when the caller needs to handle write failures
// (e.g. surface to the user). fbSet stays fire-and-forget for the common
// case of "write this and carry on" where a .catch log is sufficient.
export function fbSetAsync(p, v) {
  stampWrite(p);
  if (!db) return Promise.reject(new Error("Firebase not initialised"));
  return db.ref(p).set(v);
}

// Patch semantics — merges the given keys into the existing node instead of
// replacing it. Use this when you want to update part of an object without
// wiping sibling keys (e.g. updating .tab without losing .visitedTabs).
export function fbUpdate(p, v) {
  stampWrite(p);
  if (db) db.ref(p).update(v).catch(e => console.error("Firebase update failed", p, e));
}

export function isPermissionDenied(err) {
  if (!err) return false;
  const code = String(err.code || "").toUpperCase();
  const msg = String(err.message || "").toUpperCase();
  return code === "PERMISSION_DENIED" || code === "PERMISSION-DENIED" ||
         msg.includes("PERMISSION_DENIED") || msg.includes("PERMISSION DENIED");
}

// `cb` is called with the snapshot value. Optional `onError` is called
// ONLY after the permission-denied retry budget is exhausted (or
// immediately for non-permission errors) — never on an intermediate
// denied read, so callers that mark themselves "loaded" on error don't
// wedge when a retry then succeeds.
//
// Retry net (post-Google-SSO): the realtime socket authenticates on its
// own async schedule. Right after Google sign-in the socket can still be
// holding the pre-claim token while the JS-side token already has the
// role claim — a role-gated read (`/users`, `/projects`, `/analytics`…)
// then hits PERMISSION_DENIED. Without a retry that denial is terminal
// (Firebase never re-fires a denied .on()) until a full page reload.
// We force a token refresh and re-attach, bounded to MAX_RETRIES so a
// genuinely unauthorized read settles into onError instead of looping.
export function fbListen(p, cb, onError) {
  if (!db) return () => {};

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 400;

  // Per-subscription state — captured in this closure so an old retry
  // closure can never detach a newer listener or fire a stale timer.
  let retryCount = 0;
  let retryTimer = null;
  let currentRef = null;
  let currentHandler = null;
  let cancelled = false;

  const detach = () => {
    // CRITICAL: pass the specific handler to .off(). Firebase's
    // `ref.off("value")` with no callback detaches EVERY listener on that
    // ref, not just the one we attached here. If two components listened
    // to the same path (e.g. /formatLibrary is read by FormatLibrary,
    // SocialOrganicResearch shortlist "add as example", and
    // SocialOrganicSelect), unmounting one would silently blank the
    // others — which is the "Social Organic / Runsheets / Format Library
    // go blank after navigating away" bug that kept coming back.
    if (currentRef && currentHandler) currentRef.off("value", currentHandler);
    currentRef = null;
    currentHandler = null;
  };

  const attach = () => {
    if (cancelled) return;
    const ref = db.ref(p);
    const handler = s => {
      // A successful read clears the retry budget so a later transient
      // denial (e.g. token rotation ~55 min in) gets a fresh 2 tries.
      retryCount = 0;
      cb(s.val());
    };
    const errHandler = async e => {
      if (cancelled) return;
      if (isPermissionDenied(e) && retryCount < MAX_RETRIES) {
        retryCount++;
        // Quiet — a red console.error on every self-healing fresh Google
        // login would make a working system look broken.
        console.warn(`Firebase listen denied on ${p}, refreshing token and retrying (${retryCount}/${MAX_RETRIES})`);
        try { await auth?.currentUser?.getIdToken(true); } catch {}
        if (cancelled) return;
        detach();
        retryTimer = setTimeout(() => { retryTimer = null; attach(); }, RETRY_DELAY_MS);
        return;
      }
      // Final permission failure, or a non-permission error: log loudly
      // and notify the caller so the UI can show a real failure state.
      console.error("Firebase listen error on", p, e);
      if (onError) onError(e);
    };
    ref.on("value", handler, errHandler);
    currentRef = ref;
    currentHandler = handler;
  };

  attach();

  return () => {
    cancelled = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    detach();
  };
}

// Safer wrapper around fbListen for auth-gated paths:
//   1. Waits for `authReady` before attaching (security rules return null
//      pre-auth, which the listener would otherwise cache as "empty").
//   2. Retains state across transient nulls. Firebase occasionally fires
//      null on value listeners during token refresh, reconnects, or rule
//      re-evaluations. If the caller has already received real data once,
//      we suppress subsequent nulls so the UI doesn't flash blank.
//   3. Returns a cleanup fn — callers use it in useEffect returns.
//
// Usage:
//   useEffect(() => fbListenSafe("/formatLibrary", d => setLibrary(d || {})), []);
//
// The caller still chooses how to coerce null → empty (via `d || {}` or
// whatever default makes sense). The wrapper just makes sure transient
// nulls after a successful load don't wipe live state.
export function fbListenSafe(path, cb, onError) {
  let off = () => {};
  let hasLoaded = false;
  // `cancelled` guards the auth-deferred path: if the caller unmounts
  // before onAuthStateChanged fires, `attach` was queued in authCbs.
  // Without this flag, attach runs post-unmount, creates a real
  // listener, and no-one is left to call its unsub — one leaked
  // listener per mount/unmount pair during the auth window. Adds up
  // fast when producers bounce through tabs just after login.
  let cancelled = false;
  const attach = () => {
    if (cancelled) return;
    off = fbListen(path, d => {
      if (d != null) {
        hasLoaded = true;
        cb(d);
      } else if (!hasLoaded) {
        // First response genuinely empty (or still unauthed) — pass the
        // null through so the caller can show the empty state.
        cb(null);
      }
      // else: stale null after real data — ignore. Firebase will re-fire
      // with fresh data once the token refresh / reconnect settles.
    }, onError);
    // onError only fires after fbListen's permission-denied retry budget
    // is exhausted — callers can safely treat it as a terminal failure.
  };
  // Gate on auth — avoids the pre-auth "security rules return null" bug.
  if (authReady) attach();
  else authCbs.push(attach);
  return () => { cancelled = true; off(); };
}

// ─── Auth helpers ───

export function onAuthReady(cb) {
  if (authReady) cb(currentRole);
  else authCbs.push(cb);
}

export function getCurrentRole() {
  return currentRole;
}

// Per-user identity helpers — read straight from the live Firebase Auth
// user. Used by audit-stamping in client-side write sites (e.g. the
// delivery share modal stamps `_audit.lastEditedBy` with these).
export function getCurrentUserUid()      { return auth?.currentUser?.uid        || null; }
export function getCurrentUserEmail()    { return auth?.currentUser?.email      || null; }
export function getCurrentUserName()     { return auth?.currentUser?.displayName|| null; }
export function getCurrentUserPhotoURL() { return auth?.currentUser?.photoURL   || null; }

export async function signInWithGoogle() {
  // Ensure the Firebase app + auth SDK is loaded before constructing the
  // provider (window.firebase.auth.GoogleAuthProvider is only defined
  // after firebase-auth-compat.js finishes loading).
  await new Promise(res => onFB(res));

  const provider = new window.firebase.auth.GoogleAuthProvider();
  // Force the account chooser even when only one Google session is
  // active — prevents the wrong-account-stuck case where a user signed
  // into the wrong Google account in another tab gets auto-selected.
  provider.setCustomParameters({ prompt: "select_account" });

  const cred = await auth.signInWithPopup(provider);
  const idToken = await cred.user.getIdToken();

  // Server verifies the Google ID token, looks up the user in /users,
  // sets the role custom claim. We then force-refresh the ID token to
  // pick up the freshly-written claim.
  const r = await fetch("/api/auth-google", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${idToken}`,
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Critical: drop the half-authed Firebase session. Without this,
    // Firebase keeps the user signed in with no role claim — the app
    // would render the Login screen but the next forced refresh would
    // restore the same broken state.
    try { await auth.signOut(); } catch {}
    currentRole = null;
    throw new Error(data.error || "Not authorized");
  }

  try {
    // Force a refresh so the freshly-set role claim lands on the token,
    // then nudge the realtime socket to re-handshake with it. Best-effort
    // only — goOnline() does NOT block until the socket carries the new
    // claim, it just shrinks the race window. Correctness is owned by
    // fbListen's permission-denied retry net; this makes that retry
    // rarely needed on a clean login.
    await cred.user.getIdToken(true);
    try { db.goOffline(); db.goOnline(); } catch {}
    const tok = await cred.user.getIdTokenResult(false);
    currentRole = tok.claims?.role || data.role;
  } catch {
    currentRole = data.role;
  }
  return currentRole;
}

export async function signInAnonymouslyForPublic() {
  await new Promise(res => onFB(res));
  if (auth.currentUser) return auth.currentUser;
  return auth.signInAnonymously();
}

export async function getAuthToken(forceRefresh = false) {
  await new Promise(res => onFB(res));
  const user = auth?.currentUser;
  if (!user) throw new Error("Not signed in");
  return user.getIdToken(forceRefresh);
}

export async function authFetch(url, options = {}) {
  const token = await getAuthToken();
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };
  return fetch(url, { ...options, headers });
}

export async function signOutUser() {
  if (!auth) return;
  await auth.signOut();
  currentRole = null;
}
