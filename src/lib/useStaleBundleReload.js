import { useEffect, useRef } from "react";

// Stale-bundle detector. Edit-suite machines keep dashboard tabs open
// for weeks, so a deployed fix never reaches them — the tab keeps
// running whatever bundle it loaded on open (the 2026-06-11 Training
// role-leak ran exactly this way: the deny-by-default hardening in
// PR #294 couldn't reach already-open tabs). This hook compares the
// build id baked into the running bundle (vite `define`, see
// vite.config.js) against /version.json from the current deploy, and
// reloads at a safe moment when they diverge.
//
// Reload safety: all durable state lives in RTDB (leaf writes fire on
// edit, debounced ~400ms), so window.location.reload() loses nothing
// saved. The only thing worth protecting is literal in-flight typing /
// an open modal — hence the guards below instead of reloading the
// instant staleness is detected.
//
// When a reload fires:
//   1. Tab hidden ≥ HIDDEN_GRACE_MS when the poll detects staleness →
//      reload in the background. Anything "in progress" that long is
//      abandoned; the user comes back to a fresh bundle. This is the
//      path that fixes the weeks-old edit-suite tab.
//   2. Tab becomes visible / window refocused → re-check, and reload
//      if stale and no text input is focused (an arrival moment — the
//      user hasn't started doing anything yet). A return after a long
//      hide reloads even if some input kept focus from weeks ago.
//   3. Sidebar tool change while stale → reload always. Navigation
//      unmounts the old tab and discards its local state anyway, so
//      the reload is exactly as lossy as the click itself. The hash is
//      stamped with the destination tool first so the post-reload hash
//      router (App.jsx) lands the user on the tab they clicked.
// A poll that finds staleness while the user is actively working does
// NOT reload under them — it arms the flag and waits for 1–3.

const POLL_MS = 15 * 60 * 1000;        // background poll cadence
const MIN_CHECK_GAP_MS = 60 * 1000;    // throttle focus/visibility re-checks
const HIDDEN_GRACE_MS = 5 * 60 * 1000; // hidden this long = nothing in flight
// Rate-limit auto-reloads (sessionStorage survives reload, per-tab).
// Belt-and-braces against a reload loop if the CDN ever serves a
// version.json from a newer deploy than the index.html it gives us.
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
const RELOAD_STAMP_KEY = "staleBundleReloadAt";

const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const isEditing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

const reload = () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) || 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return;
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch { /* storage blocked — reload anyway */ }
  window.location.reload();
};

export function useStaleBundleReload(tool) {
  const stale = useRef(false);
  const lastCheck = useRef(0);
  const hiddenSince = useRef(null);

  // Boundary 3 — reload on tool change. `stale` is always false on
  // mount (detection is async), so no first-render guard is needed.
  useEffect(() => {
    if (!stale.current) return;
    try {
      history.replaceState(null, "", window.location.pathname + window.location.search + "#" + tool);
    } catch { /* hash stamp is best-effort — worst case the reload lands on the hash router's previous tool */ }
    reload();
  }, [tool]);

  useEffect(() => {
    if (!import.meta.env.PROD) return;

    const check = async (force) => {
      const now = Date.now();
      if (!force && now - lastCheck.current < MIN_CHECK_GAP_MS) return;
      lastCheck.current = now;
      try {
        const r = await fetch(`/version.json?t=${now}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (j && typeof j.buildId === "string" && j.buildId && j.buildId !== BUILD_ID) {
          if (!stale.current) console.info(`[staleBundle] running ${BUILD_ID}, deployed ${j.buildId} — reload pending`);
          stale.current = true;
        }
      } catch { /* offline / deploy in flight — next poll retries */ }
    };

    // Boundary 1 — poll. Hidden tabs get timer-throttled by the
    // browser (~1 fire/min minimum granularity) but a 15-minute
    // interval still lands close enough to on-time.
    const poll = setInterval(async () => {
      await check(false);
      if (!stale.current) return;
      const hiddenLong = document.hidden && hiddenSince.current && Date.now() - hiddenSince.current >= HIDDEN_GRACE_MS;
      if (hiddenLong) reload();
    }, POLL_MS);

    // Boundary 2 — arrival moments.
    const onVisibility = async () => {
      if (document.hidden) { hiddenSince.current = Date.now(); return; }
      const hiddenFor = hiddenSince.current ? Date.now() - hiddenSince.current : 0;
      hiddenSince.current = null;
      if (stale.current && (hiddenFor >= HIDDEN_GRACE_MS || !isEditing())) { reload(); return; }
      await check(hiddenFor >= HIDDEN_GRACE_MS);
      if (stale.current && !isEditing()) reload();
    };
    const onFocus = async () => {
      await check(false);
      if (stale.current && !isEditing()) reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
