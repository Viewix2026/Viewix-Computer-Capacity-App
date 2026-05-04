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
              const tok = await user.getIdTokenResult();
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

export function fbSet(p, v) {
  if (db) db.ref(p).set(v).catch(e => console.error("Firebase set failed", p, e));
}

// Awaitable version — use when the caller needs to handle write failures
// (e.g. surface to the user). fbSet stays fire-and-forget for the common
// case of "write this and carry on" where a .catch log is sufficient.
export function fbSetAsync(p, v) {
  if (!db) return Promise.reject(new Error("Firebase not initialised"));
  return db.ref(p).set(v);
}

// Patch semantics — merges the given keys into the existing node instead of
// replacing it. Use this when you want to update part of an object without
// wiping sibling keys (e.g. updating .tab without losing .visitedTabs).
export function fbUpdate(p, v) {
  if (db) db.ref(p).update(v).catch(e => console.error("Firebase update failed", p, e));
}

// `cb` is called with the snapshot value. Optional `onError` is called
// if Firebase rules deny the read (or any other read error). Without
// an error handler, rules denials would silently never fire cb at all,
// leaving callers hanging on "Loading…" forever (what we saw on
// DeliveryPublicView when anonymous auth was blocked).
export function fbListen(p, cb, onError) {
  if (!db) return () => {};
  const r = db.ref(p);
  // CRITICAL: pass the specific handler to .off(). Firebase's
  // `ref.off("value")` with no callback detaches EVERY listener on that
  // ref, not just the one we attached here. If two components listened
  // to the same path (e.g. /formatLibrary is read by FormatLibrary,
  // SocialOrganicResearch shortlist "add as example", and
  // SocialOrganicSelect), unmounting one would silently blank the
  // others — which is the "Social Organic / Runsheets / Format Library
  // go blank after navigating away" bug that kept coming back.
  const handler = s => cb(s.val());
  const errHandler = e => {
    console.error("Firebase listen error on", p, e);
    if (onError) onError(e);
  };
  r.on("value", handler, errHandler);
  return () => r.off("value", handler);
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
export function fbListenSafe(path, cb) {
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
    });
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

export async function signInWithRole(password) {
  const r = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.token) {
    throw new Error(data.error || "Auth failed");
  }
  // Ensure the Firebase app is loaded
  await new Promise(res => onFB(res));
  await auth.signInWithCustomToken(data.token);
  // Force token refresh so the custom claim is available immediately
  const u = auth.currentUser;
  if (u) {
    try {
      const tok = await u.getIdTokenResult(true);
      currentRole = tok.claims?.role || data.role;
    } catch {
      currentRole = data.role;
    }
  } else {
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
