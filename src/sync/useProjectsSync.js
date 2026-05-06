// useProjectsSync — domain hook that owns /projects.
//
// Fourth and final PR in the "already-excluded paths" batch of the
// domain-split refactor. Smallest extraction so far:
//
//   - /projects already wasn't in the bulk-write loop's body OR its
//     deps array (every write to /projects is a direct fbSet leaf
//     write from Projects.jsx, EditorDashboardViewix, Preproduction,
//     etc.). The lifecycle was already direct-only — App.jsx was
//     just the listener registrar.
//   - Delete is already direct fbSet(`/projects/${id}`, null) from
//     Projects.jsx's deleteProject and bulkDelete — no helper
//     needed in the hook.
//   - Drag-to-commission optimistic updates (PR #49) and the
//     cross-section flip both rely on setProjects, which the hook
//     returns unchanged.
//
// The cross-domain videoId backfill that reads BOTH projects AND
// deliveries (and writes leaves on both) intentionally stays in
// App.jsx — neither hook can own it cleanly without a coordination
// layer that doesn't exist yet. That migration is one-time per
// session via a ref so its placement doesn't affect performance.

import { useState, useEffect, useRef } from "react";
import { fbListen, recentlyWroteTo, onFB } from "../firebase";

export function useProjectsSync() {
  const [projects, setProjects] = useState([]);
  const firstFireRef = useRef(false);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      off = fbListen(
        "/projects",
        (data) => {
          const isInitial = !firstFireRef.current;
          firstFireRef.current = true;
          if (!isInitial && recentlyWroteTo("/projects")) return;
          // /projects is heavily written-to via per-leaf updates
          // (status, commissioned, subtasks/...). The recently-
          // wrote guard combined with the optimistic local-state
          // updates in Projects.jsx (added in PR #49) is what
          // keeps the UI from "bouncing back" on rapid edits.
          // Apply Object.values + id-filter the same way App.jsx
          // used to.
          if (data == null) {
            setProjects([]);
            return;
          }
          setProjects(Object.values(data).filter(p => p && p.id));
        },
        (err) => console.error("useProjectsSync listener denied:", err)
      );
    });
    return () => {
      cancelled = true;
      try { off(); } catch { /* noop */ }
    };
  }, []);

  return { projects, setProjects };
}
