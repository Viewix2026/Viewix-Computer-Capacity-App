// api/scheduling-daily-digest.js
//
// Daily 8:50 AM Sydney Mon–Fri brain briefing in #scheduling.
// DST-correct via Sydney-time gate inside the handler — Vercel cron
// fires at two UTC times (21:50 and 22:50) so one of them lands on
// 08:50 Sydney year-round; the gate makes sure only one fires per day.
//
// Always narrates (digest is the always-narrate moment). Reads full
// /timeLogs to compute videoTypeStats once per day, writes the result
// to /scheduling/cachedStats so the listener / drag flusher can read
// it without recomputing.
//
// Layout: deliberately bland v1. Three sections, plain bullets, two
// link buttons. Iterate after a week of real reading.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";
import { requireRole, sendAuthError } from "./_requireAuth.js";
import { slackPostMessage } from "./_slack-helpers.js";
import { todaySydney, nowInSydney } from "../shared/scheduling/availability.js";
import { detectFlags } from "../shared/scheduling/conflicts.js";
import { computeVideoTypeStats, buildLoggedHoursMap } from "../shared/scheduling/stats.js";
import { fingerprintFlag, FLAG_SEVERITY } from "../shared/scheduling/flags.js";
import { inferStage } from "../shared/scheduling/stages.js";
import { buildAwareness } from "../shared/scheduling/awareness.js";
import { narrateBrain } from "./_scheduling-narrate.js";

export const config = { maxDuration: 60 };

// Toggle to skip the Sydney-time gate (for manual curl testing).
// Pass ?skipGate=1 on the URL.
function shouldRunNow(query, isCron) {
  if (!isCron) return true; // manual run via authenticated POST: always proceed
  if (query?.skipGate === "1") return true;
  const sydney = nowInSydney();
  // 8:50 AM Mon–Fri (weekday 1=Mon..5=Fri).
  return sydney.hour === 8 && sydney.minute === 50 && sydney.weekday >= 1 && sydney.weekday <= 5;
}

export default async function handler(req, res) {
  const isCron = req.headers["x-vercel-cron"] === "1";
  if (req.method === "GET") {
    if (!isCron) return res.status(401).json({ error: "Cron header required" });
  } else if (req.method === "POST") {
    // Manual run path — require founders auth so the public can't
    // trigger LLM spend / Slack posts via an unauthenticated POST.
    // Mirrors api/founders-advisor.js's pattern.
    try {
      await requireRole(req, ["founders", "founder"]);
    } catch (e) {
      return sendAuthError(res, e);
    }
  } else {
    return res.status(405).json({ error: "POST or cron GET only" });
  }
  if (!shouldRunNow(req.query || {}, isCron)) {
    // Wrong time — short-circuit silently. Vercel cron fires twice
    // a day; only one of those lands on Sydney 8:50.
    return res.status(204).end();
  }

  try {
    const result = await runDailyDigest({ skipPost: req.query?.skipPost === "1" });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error("scheduling-daily-digest error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function runDailyDigest({ skipPost = false } = {}) {
  const channel = process.env.SLACK_SCHEDULE_CHANNEL_ID;
  const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;
  if (!channel || !botToken) {
    throw new Error("SLACK_SCHEDULE_CHANNEL_ID or SLACK_SCHEDULE_BOT_TOKEN missing");
  }

  const today = todaySydney();

  // Read everything once. Heavy day, but it's once per day.
  const [projectsRaw, editorsRaw, weekDataRaw, timeLogsRaw] = await Promise.all([
    adminGet("/projects"),
    adminGet("/editors"),
    adminGet("/weekData"),
    adminGet("/timeLogs"),
  ]);
  const projects = projectsRaw || {};
  const editorsList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
  const editors = editorsList.filter(e => e?.id);
  const weekData = weekDataRaw || {};
  const timeLogs = timeLogsRaw || {};

  // Compute videoTypeStats from /timeLogs and cache it. This is the
  // ONLY place that recomputes — every other surface reads the cache.
  const videoTypeStats = computeVideoTypeStats(projects, timeLogs);
  await adminSet("/scheduling/cachedStats", {
    computedAt: Date.now(),
    stats: videoTypeStats,
  });

  // Per-subtask logged hours for editOverrun detection.
  const loggedHoursBySubtask = buildLoggedHoursMap(timeLogs);

  // Detect today's flags.
  const flags = detectFlags({
    projects, editors, weekData, videoTypeStats,
    loggedHoursBySubtask, date: today, scope: { kind: "all" },
  });

  // Build the digest payload.
  const todayScheduled = collectTodayScheduled(projects, editors, today);
  const todayUnassigned = flags
    .filter(f => f.kind === "unassignedScheduled" && f.startDate === today);

  // Build Phase 1A awareness — unscheduled-edit context per project +
  // editor free-capacity over the next 14 days. Narration uses this
  // to suggest pulling forward backlog work to fill idle/under days.
  const awareness = buildAwareness({
    projects, editors, weekData, videoTypeStats, today,
  });

  // Narrate (always — this is the always-narrate moment).
  const narration = await narrateBrain({
    flags, projects, editors, today,
    mode: "digest",
    awareness,
  });

  const blocks = buildDigestBlocks({
    today, flags, todayScheduled, todayUnassigned, narration,
  });

  if (skipPost) {
    return { skipPost: true, flagCount: flags.length, todayScheduledCount: todayScheduled.length };
  }

  await slackPostMessage({
    channel,
    blocks,
    text: flags.length ? `Daily plan — ${flags.length} flag(s)` : `Daily plan — all clear`,
    botToken,
  });

  return {
    flagCount: flags.length,
    todayScheduledCount: todayScheduled.length,
    unassignedCount: todayUnassigned.length,
    cachedStatsWrote: true,
  };
}

// Subtasks overlapping `today`, returned as a compact display list.
// Capped at 5 with "+N more" — the digest is exception-led, not a
// roster dump. Ordered: shoots first (most logistics-sensitive),
// then in-progress edits, then everything else.
function collectTodayScheduled(projects, editors, today) {
  const editorById = new Map(editors.map(e => [e.id, e]));
  const out = [];
  for (const [pid, p] of Object.entries(projects || {})) {
    if (!p || typeof p !== "object") continue;
    for (const [stid, st] of Object.entries(p.subtasks || {})) {
      if (!st || typeof st !== "object") continue;
      if (!st.startDate) continue;
      if (st.status === "done" || st.status === "archived") continue;
      const start = st.startDate;
      const end = st.endDate || start;
      if (today < start || today > end) continue;
      const stage = inferStage(st);
      if (stage === "hold") continue; // holds are not "scheduled work"
      const assigneeNames = (st.assigneeIds || [])
        .map(id => editorById.get(id)?.name)
        .filter(Boolean);
      out.push({
        projectId: pid,
        projectName: p.projectName || "(untitled)",
        clientName: p.clientName || "",
        subtaskId: stid,
        name: st.name || stage,
        stage,
        assigneeNames,
        startTime: st.startTime || null,
        endTime: st.endTime || null,
      });
    }
  }
  // Sort: shoots first, then edits, then everything else.
  const order = { shoot: 0, edit: 1, revisions: 2, preProduction: 3 };
  out.sort((a, b) => (order[a.stage] ?? 9) - (order[b.stage] ?? 9));
  return out;
}

// ─── Block Kit builder ─────────────────────────────────────────────

function buildDigestBlocks({ today, flags, todayScheduled, todayUnassigned, narration }) {
  const headerDate = formatHeaderDate(today);
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:sunrise: *Daily Plan — ${headerDate}*` },
    },
  ];

  // All clear: zero flags of any kind (idle/under/etc all included).
  if (flags.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "All clear — nothing flagged today." },
    });
    blocks.push(linkButtonsBlock());
    return blocks;
  }

  // Flags — exception-led. Group by severity (hard > warning > info)
  // but render as a single bullet list — the narration provides the
  // texture, severity is just the ordering.
  const severityRank = { hard: 0, warning: 1, info: 2 };
  const sortedFlags = [...flags].sort((a, b) => {
    const sa = severityRank[FLAG_SEVERITY[a.kind] ?? "info"];
    const sb = severityRank[FLAG_SEVERITY[b.kind] ?? "info"];
    return sa - sb;
  });
  const flagLines = sortedFlags.map(f => {
    const fp = fingerprintFlag(f);
    const text = narration?.perFlagText?.[fp];
    return `• ${text || stringifyFlagPlain(f)}`;
  });
  if (narration?.recommendation) {
    flagLines.push(`_${narration.recommendation}_`);
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `:warning: *Flags (${flags.length})*\n${flagLines.join("\n")}` },
  });

  // Unassigned (today only) — separate section so it stands out.
  if (todayUnassigned.length) {
    const lines = todayUnassigned.slice(0, 5).map(f => `• \`${f.subtaskId}\` (${f.stage}) — needs an assignee`);
    if (todayUnassigned.length > 5) lines.push(`• +${todayUnassigned.length - 5} more`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:white_circle: *Needs an assignee*\n${lines.join("\n")}` },
    });
  }

  // Today list — capped at 5 with "+N more".
  if (todayScheduled.length) {
    const lines = todayScheduled.slice(0, 5).map(formatScheduledLine);
    if (todayScheduled.length > 5) lines.push(`• +${todayScheduled.length - 5} more`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:date: *Today*\n${lines.join("\n")}` },
    });
  }

  blocks.push(linkButtonsBlock());
  return blocks;
}

function formatScheduledLine(s) {
  const time = (s.startTime && s.endTime) ? ` · ${s.startTime}–${s.endTime}` : "";
  const who = s.assigneeNames.length ? ` · ${s.assigneeNames.join(", ")}` : "";
  return `• ${s.clientName ? `${s.clientName} ` : ""}${s.name}${who}${time}`;
}

function formatHeaderDate(yyyymmdd) {
  // 2026-05-13 → "Wed, May 13"
  const d = new Date(`${yyyymmdd}T00:00:00`);
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short", month: "short", day: "numeric",
    timeZone: "Australia/Sydney",
  }).format(d);
}

function linkButtonsBlock() {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open Team Board" },
        url: "https://planner.viewix.com.au/#projects/teamBoard",
        action_id: "open_team_board_link",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Open Projects" },
        url: "https://planner.viewix.com.au/#projects/projects",
        action_id: "open_projects_link",
      },
    ],
  };
}

// Plain fallback when narration can't produce per-flag text.
function stringifyFlagPlain(f) {
  switch (f?.kind) {
    case "fixedTimeConflict": return `Time conflict on ${f.date}.`;
    case "multipleUntimedShoots": return `Multiple untimed shoots on ${f.date}.`;
    case "offDayAssigned": return `Editor not working ${f.date} but has work assigned.`;
    case "inOfficeIdle": return `${f.personId} in office ${f.date}, nothing scheduled.`;
    case "dailyUnderCapacity": return `${f.personId} under-capacity ${f.date} (${f.plannedHours}h).`;
    case "dailyOverCapacity": return `${f.personId} over-capacity ${f.date} (${f.plannedHours}h).`;
    case "dailyHardOverCapacity": return `${f.personId} hard over-capacity ${f.date} (${f.plannedHours}h).`;
    case "editOverrun": return `Edit ${f.subtaskId} overrunning (${Math.round(f.actualHours)}h vs avg ${Math.round(f.avgHours)}h).`;
    case "weekDataMismatch": return `${f.personId} weekData/subtask mismatch ${f.date}.`;
    case "unassignedScheduled": return `Subtask ${f.subtaskId} scheduled with no assignee.`;
    default: return JSON.stringify(f);
  }
}
