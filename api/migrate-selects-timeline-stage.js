// api/migrate-selects-timeline-stage.js
//
// One-time data migration. Walks /projects/*/subtasks/* and re-stamps
// every "Selects timeline + kick off video" subtask whose `stage` is
// still "edit" (or missing) to the new `stage: "selectsTimeline"`.
//
// Why: the default-seed name was always "Selects timeline + kick off
// video", but until selectsTimeline became its own stage these subtasks
// inherited stage="edit" (matched "edit" in inferStage). With the new
// stage shipped, existing projects keep showing them as edit-coloured
// bars on the Team Board and routing them through the edit Finish-modal
// branch (Frame.io link required). This migration retro-fits the right
// stage so the rest of the codebase treats them consistently.
//
// Idempotent — running it twice is safe (the second pass finds nothing
// to touch and reports zero changes).
//
// Auth: founders-tier role gate to prevent accidental triggers.
//
// Trigger from the terminal once after deploy:
//   curl -X POST -H "Authorization: Bearer $YOUR_TOKEN" \
//     https://planner.viewix.com.au/api/migrate-selects-timeline-stage
//
// Once you've confirmed the response shows the touched count you
// expected, this file can be deleted in a follow-up PR.

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

  try {
    const result = await reStampStage();
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error("migrate-selects-timeline-stage error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function reStampStage() {
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
      const name = (st.name || "").toLowerCase();
      // Match the exact default seed phrase (and the common variant
      // without the trailing "+ kick off video"). Anything else stays
      // put — producers may have manually renamed subtasks and we
      // don't want to surprise them.
      const isSelectsTimeline =
        name.startsWith("selects timeline") ||
        name === "selects timeline";
      if (!isSelectsTimeline) continue;
      if (st.stage === "selectsTimeline") continue; // already migrated
      await db.ref(`/projects/${pid}/subtasks/${stid}/stage`).set("selectsTimeline");
      subtasksTouched++;
      projectModified = true;
      if (sample.length < 10) sample.push(`/projects/${pid}/subtasks/${stid}`);
    }
    if (projectModified) projectsTouched++;
  }
  return { projectsTouched, subtasksTouched, samplePathsRestamped: sample };
}
