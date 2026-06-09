import { useState, useEffect } from "react";
import { fbListen, onFB } from "../firebase";

// Live subscription to /proposalJobs — the enterprise-proposal job queue.
// The dashboard CREATES jobs (status:"queued"); the Mac mini worker (separate,
// firebase-admin, bypasses rules) flips them generating -> ready/error and
// writes back pdfUrl.
//
// `enabled` gate: /proposalJobs is readable only by founders/closer, so we
// only attach for those roles (same pattern as useCalendarSyncQueue) — an
// editor/lead session would otherwise hit a permanent permission-denied.
//
// No recentlyWroteTo suppression here (unlike useDeliveriesSync): there are no
// locally-editable fields after submit, so we always apply the server snapshot.
// That's what lets a worker status flip show up live even if it lands within
// the old 1.5s suppression window. The optimistic create in Proposals.jsx
// upserts by id, so it can't double with the listener's snapshot.
export function useProposalJobsSync({ enabled = true } = {}) {
  const [proposalJobs, setProposalJobs] = useState([]);

  useEffect(() => {
    if (!enabled) { setProposalJobs([]); return; }
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/proposalJobs",
        (data) => setProposalJobs(data ? Object.values(data).filter((j) => j && j.id) : []),
        (err) => console.error("useProposalJobsSync listener denied:", err)
      );
    });
    return () => {
      cancelled = true;
      try { off(); } catch { /* noop */ }
    };
  }, [enabled]);

  return { proposalJobs, setProposalJobs };
}
