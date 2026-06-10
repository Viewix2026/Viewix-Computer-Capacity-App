// src/sync/useCalendarSyncQueue.js
// Domain hook — listens to /calendarSyncQueue and exposes a Map keyed
// by `${projectId}__${subtaskId}` for components to render sync-status
// pills + gantt-bar dots.
//
// Same shape as useProjectsSync / useAccountsSync etc, with ONE
// addition (E6): an `enabled` flag. The /calendarSyncQueue rule only
// grants founder/manager/lead read access, so for editor/trial/closer
// users an unconditional listener would spam permission-denied errors.
// App.jsx passes `enabled: isFounder || isLead` so the listener only
// attaches for roles that can actually read the queue.

import { useState, useEffect } from "react";
import { fbListen, onFB } from "../firebase";

export function useCalendarSyncQueue({ enabled = true } = {}) {
  // Map<key, queueEntry>. Map (not plain object) so reference identity
  // is fresh on every snapshot.
  const [queue, setQueue] = useState(() => new Map());

  useEffect(() => {
    if (!enabled) {
      // Role can't read the queue — don't attach a listener (avoids
      // permission-denied log spam). Keep the Map empty.
      setQueue(new Map());
      return;
    }
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/calendarSyncQueue",
        (data) => {
          // No recentlyWroteTo suppression here (unlike useProjectsSync):
          // there are no locally-editable fields to protect, and dropping
          // the echo of our own enqueue left the just-queued entry's
          // status pill invisible until the worker touched the queue —
          // same reasoning as useProposalJobsSync.
          if (!data || typeof data !== "object") { setQueue(new Map()); return; }
          const m = new Map();
          for (const [key, entry] of Object.entries(data)) {
            if (entry && typeof entry === "object") m.set(key, entry);
          }
          setQueue(m);
        },
        (err) => console.error("useCalendarSyncQueue listener denied:", err)
      );
    });
    return () => { cancelled = true; try { off(); } catch {} };
  }, [enabled]);

  return { calendarSyncQueue: queue };
}
