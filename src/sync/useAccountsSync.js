// useAccountsSync — domain hook that owns /accounts.
//
// Replaces three things that used to live in App.jsx:
//   1. The `[accounts, setAccounts]` state slot.
//   2. The `listen("/accounts", ...)` registration inside the
//      central listener wrapper.
//   3. The deletedPaths flush that AccountsDashboard's removeClient
//      relied on to actually persist a delete to Firebase.
//
// First step in the "split Firebase ownership by domain" refactor
// (see the long thread with Codex). The pattern this PR establishes
// is the template for the other already-excluded paths
// (/deliveries, /sales, /projects) and eventually for the bulk-
// write paths too.
//
// Why /accounts first:
//   - Already excluded from the App.jsx bulk-write loop, so there's
//     no contention to untangle when the listener moves out.
//   - Already does direct leaf writes (updateAccount,
//     updateMilestone, setSigningDate, doSync, the projectLead
//     auto-heal effect) — the hook just owns the state + listener
//     instead of those flowing through App.jsx.
//   - Delete was the one piece still coupled to App.jsx via
//     deletedPaths — making that direct here closes the loop.
//
// Behaviour preserved:
//   - First-fire exemption (initial load always applies).
//   - recentlyWroteTo("/accounts") guard within 1.5s of any local
//     /accounts write — same anti-clobber behaviour the App.jsx
//     listener wrapper had.
//   - skipRead guard NOT included; /accounts isn't part of the
//     bulk-write debounce so there's nothing for skipRead to
//     suppress here.
//
// Returned API:
//   accounts        — the live /accounts subtree (object keyed by id).
//   setAccounts     — local-state setter, same shape as before; used
//                     by AccountsDashboard's optimistic updates.
//   deleteAccount   — direct delete. Patches local state AND issues
//                     fbSet(`/accounts/${id}`, null). No longer
//                     dependent on a debounced bulk flush firing
//                     later — the delete persists immediately.

import { useState, useEffect, useRef } from "react";
import { fbListen, fbSet, recentlyWroteTo, onFB } from "../firebase";

export function useAccountsSync() {
  const [accounts, setAccounts] = useState({});
  // First-fire tracking — Firebase's onValue re-delivers the full
  // subtree on initial subscribe even when the path is empty. We
  // always let that initial fire through so empty Firebase doesn't
  // get suppressed by recentlyWroteTo from a stamp set before the
  // listener attached.
  const firstFireRef = useRef(false);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/accounts",
        (data) => {
          const isInitial = !firstFireRef.current;
          firstFireRef.current = true;
          if (!isInitial && recentlyWroteTo("/accounts")) return;
          // Defensive null guard — Firebase fires `null` during
          // token refresh / reconnects on auth-gated paths.
          // Treating null as "deliberately empty" wipes valid
          // local state; treat it as a transient and ignore.
          if (data) setAccounts(data);
        },
        (err) => {
          // Silent for now — App.jsx-level error handling already
          // captures listener denials. Worst case a non-founders
          // user sees an empty Accounts surface, which is the
          // existing behaviour the rules enforce anyway.
          console.error("useAccountsSync listener denied:", err);
        }
      );
    });
    return () => {
      cancelled = true;
      try { off(); } catch { /* noop */ }
    };
  }, []);

  // Direct delete — replaces App.jsx's deletedPaths flush.
  // Local state update first so the row disappears from the table
  // immediately; fbSet(null) then persists the deletion to
  // Firebase. fbSet stamps "/accounts" recently-written, so the
  // listener echo of our own delete is suppressed by the guard
  // above (no double-update flicker).
  const deleteAccount = (id) => {
    if (!id) return;
    setAccounts((prev) => {
      const next = { ...(prev || {}) };
      delete next[id];
      return next;
    });
    fbSet(`/accounts/${id}`, null);
  };

  return { accounts, setAccounts, deleteAccount };
}
