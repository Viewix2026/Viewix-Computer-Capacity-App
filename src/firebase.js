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

export function fbListen(p, cb) {
  if (!db) return () => {};
  const r = db.ref(p);
  r.on("value", s => cb(s.val()));
  return () => r.off("value");
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

export async function signOutUser() {
  if (!auth) return;
  await auth.signOut();
  currentRole = null;
}
