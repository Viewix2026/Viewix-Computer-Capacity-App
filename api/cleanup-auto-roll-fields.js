// api/cleanup-auto-roll-fields.js
//
// One-time data migration. Walks /projects/*/subtasks/* and removes the
// `autoRolledCount` + `autoRolledLast` fields that the now-deleted
// `roll-overdue-edits` cron used to write. Nothing in the dashboard
// reads these fields, but they're cruft on every previously-rolled
// subtask.
//
// Idempotent — running it twice is safe (the second pass finds nothing
// to strip and reports zero touches).
//
// Auth: founders-tier role gate to prevent accidental triggers.
//
// Trigger from the terminal once after deploy:
//   # dry-run (default) — returns counts but writes nothing:
//   curl -X POST -H "Authorization: Bearer $YOUR_TOKEN" \
//     https://planner.viewix.com.au/api/cleanup-auto-roll-fields
//
//   # apply for real:
//   curl -X POST -H "Authorization: Bearer $YOUR_TOKEN" \
//     'https://planner.viewix.com.au/api/cleanup-auto-roll-fields?apply=1'
//
// Once you've confirmed the response shows the touched count you
// expected, this file can be deleted in a follow-up PR. Leaving it
// indefinitely is also fine — it's auth-gated and idempotent.

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

  // Default to dry-run so a misclick on a "Run cleanup" producer button
  // can't wipe data. The sibling collapse-stretched-edits.js follows
  // the same `?apply=1` convention. Returns the same counts either way
  // so the operator can pre-verify scope before flipping `apply=1`.
  const apply = req.query?.apply === "1";

  try {
    const result = await stripFields({ apply });
    return res.status(200).json({ success: true, apply, ...result });
  } catch (e) {
    console.error("cleanup-auto-roll-fields error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function stripFields({ apply }) {
  const { db, err } = getAdmin();
  if (err) throw new Error(err);

  const projects = (await adminGet("/projects")) || {};
  let projectsTouched = 0;
  let subtasksTouched = 0;
  const sample = []; // first 10 paths touched, for sanity checking

  for (const [pid, p] of Object.entries(projects)) {
    if (!p || typeof p !== "object" || !p.subtasks) continue;
    let projectModified = false;
    for (const [stid, st] of Object.entries(p.subtasks)) {
      if (!st || typeof st !== "object") continue;
      const hasCount = "autoRolledCount" in st;
      const hasLast = "autoRolledLast" in st;
      if (!hasCount && !hasLast) continue;
      // Multi-path update strips both leaves in one write.
      const updates = {};
      if (hasCount) updates[`/projects/${pid}/subtasks/${stid}/autoRolledCount`] = null;
      if (hasLast) updates[`/projects/${pid}/subtasks/${stid}/autoRolledLast`] = null;
      if (apply) await db.ref().update(updates);
      subtasksTouched++;
      projectModified = true;
      if (sample.length < 10) sample.push(`/projects/${pid}/subtasks/${stid}`);
    }
    if (projectModified) projectsTouched++;
  }
  return { projectsTouched, subtasksTouched, samplePathsStripped: sample };
}
