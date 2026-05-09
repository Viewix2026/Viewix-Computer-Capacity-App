// api/scheduling-flag-flusher.js
//
// Vercel cron, fires every minute. Reads /scheduling/pendingFlags
// (active records only — terminal records live under
// /scheduling/pendingFlagsDone), filters in-memory by notifyAt,
// re-evaluates each due record against current state, and either
// posts a Slack message (if the flag is still active) or silences it
// (if the user fixed the issue within the 3-min window).
//
// CHEAP first — early-out when nothing's due. The expensive reads
// (full /projects + /editors + /weekData + cached stats) only happen
// when there's at least one due record.
//
// Dedup: hashed fingerprint stored in /scheduling/postedFingerprints
// with 24h TTL — same flag won't be reposted within the same day.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";
import {
  slackPostMessage,
  buildBrainFlagsBlocks,
  hashFingerprint,
} from "./_slack-helpers.js";
import { todaySydney } from "../shared/scheduling/availability.js";
import { detectFlagsForDateRange, fingerprintFlag } from "../shared/scheduling/conflicts.js";
import { cachedStatsIsFresh } from "../shared/scheduling/stats.js";
import { buildAwareness } from "../shared/scheduling/awareness.js";
import { narrateBrain } from "./_scheduling-narrate.js";

export const config = { maxDuration: 30 };

const POSTED_FP_TTL_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const isCron = req.headers["x-vercel-cron"] === "1";
  if (req.method === "GET" && !isCron) {
    return res.status(401).json({ error: "Cron header required" });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "POST or cron GET only" });
  }

  try {
    const result = await runFlusher();
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error("scheduling-flag-flusher error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function runFlusher() {
  const channel = process.env.SLACK_SCHEDULE_CHANNEL_ID;
  const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
  if (!channel || !botToken) {
    throw new Error("SLACK_SCHEDULE_CHANNEL_ID or SLACK_SCHEDULE_BOT_TOKEN missing");
  }

  // CHEAP: only read pendingFlags first. If nothing due, return.
  const allPending = (await adminGet("/scheduling/pendingFlags")) || {};
  const now = Date.now();
  const due = Object.entries(allPending).filter(([, rec]) => {
    if (!rec) return false;
    return Number(rec.notifyAt || 0) <= now;
  });

  if (due.length === 0) {
    return { scanned: Object.keys(allPending).length, due: 0, fired: 0, silenced: 0 };
  }

  // Now load the rest of the state (still no /timeLogs).
  const [projectsRaw, editorsRaw, weekDataRaw, cachedStatsRec, postedFps] = await Promise.all([
    adminGet("/projects"),
    adminGet("/editors"),
    adminGet("/weekData"),
    adminGet("/scheduling/cachedStats"),
    adminGet("/scheduling/postedFingerprints"),
  ]);
  const projects = projectsRaw || {};
  const editorsList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
  const editors = editorsList.filter(e => e?.id);
  const weekData = weekDataRaw || {};
  const videoTypeStats = cachedStatsIsFresh(cachedStatsRec) ? (cachedStatsRec.stats || {}) : {};
  const postedFpMap = postedFps || {};
  const today = todaySydney();

  let fired = 0;
  let silenced = 0;

  for (const [id, rec] of due) {
    try {
      const result = await processOnePending({
        id, rec, projects, editors, weekData, videoTypeStats,
        postedFpMap, channel, botToken, today,
      });
      if (result === "fired") fired++;
      else if (result === "silenced") silenced++;
    } catch (e) {
      console.error(`flusher: failed to process ${id}:`, e);
    }
  }

  return {
    scanned: Object.keys(allPending).length,
    due: due.length,
    fired,
    silenced,
  };
}

async function processOnePending({
  id, rec, projects, editors, weekData, videoTypeStats,
  postedFpMap, channel, botToken, today,
}) {
  const { db } = getAdmin();

  // Re-run the checker scoped to the original subject.
  const [projectId, subtaskId] = (rec.subjectKey || "").split(":");
  const targetProject = projects[projectId];
  const targetSubtask = targetProject?.subtasks?.[subtaskId];

  // Subtask deleted between drag and now → silence quietly.
  if (!targetSubtask) {
    await moveToDone(id, rec, "silenced");
    return "silenced";
  }

  const personId = (targetSubtask.assigneeIds?.[0]) || targetSubtask.assigneeId || null;
  const dateISO = targetSubtask.startDate || today;
  const startDate = targetSubtask.startDate || dateISO;
  const endDate = targetSubtask.endDate || startDate;

  const liveFlags = detectFlagsForDateRange({
    startDate, endDate,
    projects, editors, weekData, videoTypeStats,
    loggedHoursBySubtask: {},
    scope: personId ? { kind: "actor", personId, dateISO } : { kind: "all" },
  });

  // Surviving flags = live flags whose fingerprint matches one from
  // the original pending record. If the user self-fixed, the matching
  // fingerprint is gone.
  const originalFps = new Set(rec.fingerprints || []);
  const survivingFlags = liveFlags.filter(f => originalFps.has(fingerprintFlag(f)));

  if (survivingFlags.length === 0) {
    await moveToDone(id, rec, "silenced");
    return "silenced";
  }

  // 24h dedup on hashed fingerprints.
  const newFlags = survivingFlags.filter(f => {
    const h = hashFingerprint(fingerprintFlag(f));
    const posted = postedFpMap[h];
    if (!posted) return true;
    const age = Date.now() - Number(posted.postedAt || 0);
    return age >= POSTED_FP_TTL_MS;
  });

  if (newFlags.length === 0) {
    // All survivors were already posted within the last 24h.
    await moveToDone(id, rec, "silenced");
    return "silenced";
  }

  // Narrate (with awareness) and post.
  const awareness = buildAwareness({
    projects, editors, weekData, videoTypeStats, today,
  });
  const narration = await narrateBrain({
    flags: newFlags, projects, editors, today,
    mode: "drag",
    awareness,
  });

  const project = targetProject;
  const headerLines = [];
  if (rec.actorSlackUserId) headerLines.push(`<@${rec.actorSlackUserId}>`);
  if (project?.projectName) headerLines.push(project.projectName);
  const headerSuffix = headerLines.length ? ` — ${headerLines.join(" · ")}` : "";

  const blocks = buildBrainFlagsBlocks({
    flags: newFlags,
    narration,
    header: `:warning: *Heads up from the team board${headerSuffix}*`,
    fingerprintFn: fingerprintFlag,
  });

  await slackPostMessage({
    channel,
    blocks,
    text: `Heads up — ${newFlags.length} flag(s) from the team board.`,
    botToken,
  });

  // Record dedup fingerprints.
  for (const f of newFlags) {
    const h = hashFingerprint(fingerprintFlag(f));
    await db.ref(`/scheduling/postedFingerprints/${h}`).set({
      fp: fingerprintFlag(f),
      postedAt: Date.now(),
      channel: "scheduling",
    });
  }

  await moveToDone(id, rec, "fired");
  return "fired";
}

async function moveToDone(id, rec, status) {
  const { db } = getAdmin();
  if (!db) return;
  const moved = {
    ...rec,
    status,
    [`${status}At`]: Date.now(),
  };
  // Multi-path update keeps the indexes consistent.
  const updates = {};
  updates[`/scheduling/pendingFlagsDone/${id}`] = moved;
  updates[`/scheduling/pendingFlags/${id}`] = null;
  await db.ref().update(updates);
}
