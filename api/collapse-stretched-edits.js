// api/collapse-stretched-edits.js
//
// One-shot audit + migration. Walks /projects/*/subtasks/* and finds
// active edit-stage subtasks where endDate > startDate (i.e., they
// were silently stretched into a multi-day bar by the now-deleted
// auto-roll cron). Without `?apply=1`, dry-runs and reports counts.
// With `?apply=1`, collapses each one to a 1-day bar by writing
// endDate = startDate.
//
// Scoped tightly:
//   - stage === "edit" only — the auto-roll cron (api/roll-overdue-
//     edits.js, deleted in PR #84) only ever stretched edits, so
//     this won't accidentally collapse a deliberate multi-day shoot
//     or pre-pro window.
//   - status not in {done, archived} — historical bars stay as-is.
//   - endDate strictly > startDate — single-day bars (already
//     correct) are left untouched.
//
// Idempotent. Auth-gated to founders. Once Jeremy has run it once
// and confirmed the count drops to zero, this file can be deleted
// in a follow-up PR — leaving it indefinitely is fine too.

import { adminGet, getAdmin } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await requireRole(req, ["founders", "founder"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const apply = req.query?.apply === "1";

  try {
    const result = await collapseStretchedEdits({ apply });
    return res.status(200).json({ success: true, apply, ...result });
  } catch (e) {
    console.error("collapse-stretched-edits error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function collapseStretchedEdits({ apply }) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);

  const projects = (await adminGet("/projects")) || {};
  let scannedSubtasks = 0;
  let stretchedCount = 0;
  let collapsedCount = 0;
  const sample = []; // first 20 paths matched, for sanity checking

  for (const [pid, p] of Object.entries(projects)) {
    if (!p || typeof p !== "object" || !p.subtasks) continue;
    for (const [stid, st] of Object.entries(p.subtasks)) {
      if (!st || typeof st !== "object") continue;
      scannedSubtasks++;

      // Match: active edit subtask with a multi-day span.
      if (st.stage !== "edit") continue;
      if (st.status === "done" || st.status === "archived") continue;
      if (!st.startDate || !st.endDate) continue;
      if (st.endDate <= st.startDate) continue;

      stretchedCount++;
      if (sample.length < 20) {
        sample.push({
          path: `/projects/${pid}/subtasks/${stid}`,
          name: st.name || null,
          startDate: st.startDate,
          endDate: st.endDate,
          spanDays: daysBetween(st.startDate, st.endDate),
        });
      }
      if (apply) {
        // Collapse to 1-day bar at startDate. Bumps updatedAt so the
        // dashboard's listener echoes the change immediately.
        await db.ref(`/projects/${pid}/subtasks/${stid}`).update({
          endDate: st.startDate,
          updatedAt: new Date().toISOString(),
        });
        collapsedCount++;
      }
    }
  }

  return {
    scannedSubtasks,
    stretchedCount,
    collapsedCount,
    sample,
  };
}

function daysBetween(a, b) {
  return Math.round(
    (new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000,
  );
}
