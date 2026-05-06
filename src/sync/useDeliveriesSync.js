// useDeliveriesSync — domain hook that owns /deliveries.
//
// Mirrors useAccountsSync. Same shape, same first-fire +
// recentlyWroteTo guards. Differences from accounts:
//
//   - /deliveries is stored as an OBJECT in Firebase (keyed by id)
//     but the dashboard uses an ARRAY everywhere downstream. The
//     listener applies Object.values + array filter + a videos
//     default the same way the inline App.jsx listener used to.
//   - Delete is already direct fbSet(`/deliveries/${id}`, null)
//     from Deliveries.jsx's removeDelivery, so no deleteDelivery
//     helper is needed in this hook (vs. the deleteAccount
//     helper that useAccountsSync had to add when peeling /accounts
//     off the deletedPaths flush).
//
// Existing exclusion-from-bulk-write background — App.jsx comment:
// "pasting a link on one video reverted the previous video's link;
//  flipping Viewix status quickly across rows occasionally reverted
//  one of them" — was the symptom that drove /deliveries out of the
// bulk loop in the first place. This hook just relocates ownership.
//
// shortId backfill — a one-time-per-record decorative migration
// that ensures every /deliveries entry has a stable URL slug —
// also moves into the hook so the deliveries lifecycle is fully
// owned in one place. Behaviour preserved: same `[deliveries.length]`
// trigger, same makeShortId, same dedupe logic.

import { useState, useEffect, useRef } from "react";
import { fbListen, recentlyWroteTo, onFB } from "../firebase";
import { makeShortId } from "../utils";

export function useDeliveriesSync() {
  const [deliveries, setDeliveries] = useState([]);
  const firstFireRef = useRef(false);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/deliveries",
        (data) => {
          const isInitial = !firstFireRef.current;
          firstFireRef.current = true;
          if (!isInitial && recentlyWroteTo("/deliveries")) return;
          if (!data) return;
          // Same object→array transform App.jsx used to do inline,
          // including the videos-default guard so downstream
          // components don't have to .videos?.map every time.
          setDeliveries(
            Object.values(data)
              .filter(d => d && d.id)
              .map(d => ({ ...d, videos: Array.isArray(d.videos) ? d.videos : [] }))
          );
        },
        (err) => console.error("useDeliveriesSync listener denied:", err)
      );
    });
    return () => {
      cancelled = true;
      try { off(); } catch { /* noop */ }
    };
  }, []);

  // shortId backfill — one-time migration. Local-state only (does
  // not write to Firebase) — same as the App.jsx version. Triggers
  // on length change so rows added by webhook also get a slug.
  useEffect(() => {
    if (!deliveries.length) return;
    const used = new Set();
    let changed = false;
    const next = deliveries.map(d => {
      if (!d) return d;
      if (d.shortId && !used.has(d.shortId)) {
        used.add(d.shortId);
        return d;
      }
      let id = d.shortId || makeShortId();
      while (used.has(id)) id = makeShortId();
      used.add(id);
      if (id !== d.shortId) {
        changed = true;
        return { ...d, shortId: id };
      }
      return d;
    });
    if (changed) setDeliveries(next);
  }, [deliveries.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  return { deliveries, setDeliveries };
}
