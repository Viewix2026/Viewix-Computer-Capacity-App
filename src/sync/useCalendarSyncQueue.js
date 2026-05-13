// src/sync/useCalendarSyncQueue.js
// Domain hook — listens to /calendarSyncQueue and exposes a Map keyed
// by `${projectId}__${subtaskId}` for components to render sync-status
// pills + gantt-bar dots.
//
// Same shape as useProjectsSync / useAccountsSync etc. Without this
// listener no React component can render the pill — the queue would
// only be visible to the server worker.

import { useState, useEffect, useRef } from "react";
import { fbListen, recentlyWroteTo, onFB } from "../firebase";

export function useCalendarSyncQueue() {
  // Map<key, queueEntry>. Map instead of plain object so React's
  // reference identity is fresh on every snapshot (cheap consumers
  // can rely on === to detect updates).
  const [queue, setQueue] = useState(() => new Map());
  const firstFireRef = useRef(false);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/calendarSyncQueue",
        (data) => {
          const isInitial = !firstFireRef.current;
          firstFireRef.current = true;
          if (!isInitial && recentlyWroteTo("/calendarSyncQueue")) return;
          if (!data || typeof data !== "object") {
            setQueue(new Map());
            return;
          }
          const m = new Map();
          for (const [key, entry] of Object.entries(data)) {
            if (entry && typeof entry === "object") m.set(key, entry);
          }
          setQueue(m);
        },
        (err) => console.error("useCalendarSyncQueue listener denied:", err)
      );
    });
    return () => {
      cancelled = true;
      try { off(); } catch {}
    };
  }, []);

  return { calendarSyncQueue: queue };
}
