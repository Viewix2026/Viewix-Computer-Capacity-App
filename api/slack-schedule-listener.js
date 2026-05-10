// api/slack-schedule-listener.js
//
// Slack Events API entry for the Viewix Scheduler bot. Listens to messages
// in the dedicated #scheduling channel, asks Claude to extract the user's
// scheduling intent, runs deterministic backend logic to pick a target
// subtask + detect conflicts, then posts a Block Kit confirm card. The
// actual Firebase write happens later in api/slack-interactivity.js after
// Confirm is clicked.
//
// Architectural principle: Claude interprets, backend decides. Claude
// returns intent (project, stage, dates, assignees) — backend owns the
// choice of subtaskId, the update-vs-create call, and conflict detection.
// This bounds the blast radius of any LLM misfire.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { adminGet, adminPatch, getAdmin } from "./_fb-admin.js";
import {
  readRawBody,
  verifySlackSignature,
  todaySydney,
  slackPostMessage,
  slackPostEphemeral,
  slackAddReaction,
  slackSwapReaction,
  randomShortId,
  parseAllowlist,
  fingerprintSubtask,
  buildBrainFlagsBlocks,
  STAGES,
  STAGE_LABELS,
  STAGE_EMOJI,
  DEFAULT_NAME_FOR_STAGE,
  REACTION,
} from "./_slack-helpers.js";
import { detectFlagsForDateRange } from "../shared/scheduling/conflicts.js";
import { fingerprintFlag, SCHEDULING_CARD_KINDS } from "../shared/scheduling/flags.js";
import { cachedStatsIsFresh } from "../shared/scheduling/stats.js";
import { buildAwareness } from "../shared/scheduling/awareness.js";
import { narrateBrain } from "./_scheduling-narrate.js";

export const config = { api: { bodyParser: false } };

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2000;
const PROPOSAL_TTL_MS = 60 * 60 * 1000; // 1 hour
const EVENT_DEDUP_TTL_MS = 60 * 60 * 1000;

// ─── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const secret = process.env.SLACK_SCHEDULE_SIGNING_SECRET;
  if (!secret) {
    console.error("slack-schedule-listener: SLACK_SCHEDULE_SIGNING_SECRET not configured");
    return res.status(500).json({ error: "signing secret not configured" });
  }
  if (!verifySlackSignature({ rawBody, timestamp, signature, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: "invalid JSON" }); }

  // URL verification handshake — Slack pings this once when the Events
  // API request URL is first saved. Echo the challenge back.
  if (payload.type === "url_verification") {
    return res.status(200).send(payload.challenge);
  }

  // Acknowledge the event immediately so Slack doesn't retry on slow
  // ack. Real work continues via waitUntil (Vercel keeps the function
  // alive past response close, up to its maxDuration).
  res.status(200).end();

  if (payload.type === "event_callback") {
    waitUntil(processEvent(payload).catch(err => {
      console.error("slack-schedule-listener processEvent error:", err);
    }));
  }
}

// ─── Event processor ───────────────────────────────────────────────
async function processEvent(payload) {
  const event = payload.event || {};
  const eventId = payload.event_id;
  const targetChannel = process.env.SLACK_SCHEDULE_CHANNEL_ID;
  const botToken = process.env.SLACK_SCHEDULE_BOT_TOKEN;

  if (!targetChannel || !botToken) {
    console.error("slack-schedule-listener: SLACK_SCHEDULE_CHANNEL_ID or SLACK_SCHEDULE_BOT_TOKEN missing");
    return;
  }

  // Filters: only target channel, only bare user messages.
  if (event.type !== "message") return;
  if (event.channel !== targetChannel) return;
  if (event.bot_id) return;
  if (event.subtype) return; // skip edits/joins/file shares
  if (!event.text || !event.text.trim()) return;

  // Dedup — Slack retries on slow ack. transaction() returns the
  // committed snapshot; if `committed` is false we already saw this id.
  if (eventId) {
    const { db } = getAdmin();
    if (db) {
      const ref = db.ref(`/scheduling/events/${eventId}`);
      const tx = await ref.transaction(curr => (curr ? undefined : { receivedAt: Date.now(), expiresAt: Date.now() + EVENT_DEDUP_TTL_MS }));
      if (!tx.committed) return; // duplicate
    }
  }

  // Allowlist gate (before LLM call) — prevents unauthorized users
  // from burning ANTHROPIC_API_KEY tokens even if they're in #scheduling.
  const allowlist = parseAllowlist(process.env.SLACK_SCHEDULE_ALLOWED_USER_IDS);
  if (allowlist && !allowlist.has(event.user)) {
    await slackPostEphemeral({
      channel: event.channel,
      user: event.user,
      text: "You're not on the scheduler allowlist. Ask Jeremy to add your Slack ID.",
      botToken,
    });
    return;
  }

  // Mark the producer's message with :eyes: so they know the bot saw
  // it and is working. Stays through clarification rounds; flipped to
  // :white_check_mark: / :x: / :warning: by the interactivity handler.
  await slackAddReaction({
    channel: event.channel,
    timestamp: event.ts,
    name: REACTION.THINKING,
    botToken,
  });

  // ── Build context for Claude ────────────────────────────────────
  const context = await buildSchedulingContext();

  // ── Call Claude ────────────────────────────────────────────────
  const claudeOut = await callClaudeForIntent({
    userText: event.text,
    context,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  if (claudeOut.kind === "error") {
    // Claude couldn't parse — flip :eyes: to :warning: so the producer
    // can see at a glance that the message hit a parse error rather
    // than wondering if the bot is still working.
    await slackSwapReaction({
      channel: event.channel,
      timestamp: event.ts,
      removeName: REACTION.THINKING,
      addName: REACTION.ERROR,
      botToken,
    });
    await slackPostMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Couldn't parse that. ${claudeOut.message}`,
      botToken,
    });
    return;
  }

  // ── Render the right card depending on what Claude returned ─────
  await renderProposalAndPostCard({
    claudeOut,
    context,
    event,
    botToken,
  });
}

// ─── Context build ─────────────────────────────────────────────────
async function buildSchedulingContext() {
  const [projectsRaw, editorsRaw] = await Promise.all([
    adminGet("/projects"),
    adminGet("/editors"),
  ]);

  // Active projects: commissioned !== false (legacy projects with no
  // field treat as active, matching Projects.jsx:1640) and not archived/done.
  const projects = [];
  for (const [id, p] of Object.entries(projectsRaw || {})) {
    if (!p || typeof p !== "object") continue;
    if (p.commissioned === false) continue;
    const status = p.status || "";
    if (status === "archived" || status === "done") continue;
    projects.push({
      id,
      projectName: p.projectName || "(untitled)",
      clientName: p.clientName || "(unknown client)",
    });
  }

  // Editors come either as an array (legacy DEF_EDS) or keyed object.
  const editorsList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
  const editors = [];
  for (const e of editorsList) {
    if (!e?.id) continue;
    const role = e.role || "editor";
    if (role !== "editor" && role !== "crew") continue;
    editors.push({
      id: e.id,
      name: e.name || e.id,
      role,
      slackUserId: e.slackUserId || null,
    });
  }

  return { projects, editors, today: todaySydney() };
}

// ─── Claude call ───────────────────────────────────────────────────
const TOOLS = [
  {
    name: "extract_schedule_intent",
    description: "Convert the user's scheduling request into a structured intent. The backend chooses the target subtask and runs conflict detection.",
    input_schema: {
      type: "object",
      required: ["projectId", "stage", "startDate"],
      properties: {
        projectId: { type: "string", description: "id from the active projects list" },
        stage: { type: "string", enum: STAGES },
        startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        endDate: { type: ["string", "null"] },
        startTime: { type: ["string", "null"], description: "HH:MM, optional" },
        endTime: { type: ["string", "null"] },
        assigneeIds: { type: "array", items: { type: "string" }, description: "ids from editors+crew list; may be empty" },
        explicitMode: {
          type: ["string", "null"],
          enum: ["update", "create", null],
          description: "set to 'create' only when user explicitly says 'another'/'second'/'add'; otherwise null and let backend decide",
        },
      },
    },
  },
  {
    name: "request_clarification",
    description: "Use when project, stage, date, or assignee is genuinely ambiguous (multiple matches or none).",
    input_schema: {
      type: "object",
      required: ["question", "kind", "options"],
      properties: {
        question: { type: "string" },
        kind: { type: "string", enum: ["project", "stage", "assignee"] },
        options: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            required: ["label", "value"],
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      },
    },
  },
];

function buildSystemPrompt(ctx) {
  const projectsTable = ctx.projects
    .map(p => `${p.id} | ${p.clientName} | ${p.projectName}`)
    .join("\n");
  const editorsTable = ctx.editors
    .map(e => `${e.id} | ${e.name} | ${e.role}`)
    .join("\n");

  return `You are the Viewix scheduling assistant. Convert the user's natural-language request into ONE tool call.

TODAY (Sydney): ${ctx.today}
Week starts Monday.

ACTIVE PROJECTS (id | client | project):
${projectsTable || "(none)"}

EDITORS / CREW (id | name | role):
${editorsTable || "(none)"}

STAGE MAPPING
- "shoot" / "filming" / "on-site" / "record" → shoot
- "pre-pro" / "prep" / "planning call" / "pre-production" → preProduction
- "edit" / "editing" / "post" / "cut" → edit
- "revisions" / "v2" / "feedback round" / "client changes" → revisions
- "hold" / "block out" / "reserve" → hold

RULES
- Always call exactly one of extract_schedule_intent or request_clarification.
- Resolve relative dates ("next Thursday", "Tuesday afternoon") to absolute YYYY-MM-DD against today.
- "Tuesday afternoon" → startTime "13:00" (or omit if you're not sure).
- If projectId resolution is ambiguous (multiple matches OR no match), call request_clarification with kind="project" and up to 4 candidate projects (label="ClientName — ProjectName", value=projectId).
- If stage is ambiguous, call request_clarification with kind="stage".
- If editor name is ambiguous and the user named someone, call request_clarification with kind="assignee".
- If the user did not name an editor at all, leave assigneeIds empty — that's fine.
- Set explicitMode="create" ONLY when the user uses words like "another", "second", "additional", "new". Otherwise leave null — the backend will decide update vs create based on the existing subtask state.
- Do not invent project ids or editor ids — only use ones from the tables above.`;
}

async function callClaudeForIntent({ userText, context, apiKey }) {
  if (!apiKey) return { kind: "error", message: "ANTHROPIC_API_KEY not configured" };
  if (context.projects.length === 0) {
    return { kind: "error", message: "No active projects in Firebase to schedule against." };
  }

  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: buildSystemPrompt(context), cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    return { kind: "error", message: `Anthropic API ${resp.status}: ${err.slice(0, 200)}` };
  }
  const data = await resp.json();

  // Find the tool_use block. Claude can also emit text before/after — ignore that.
  const toolUse = (data.content || []).find(b => b.type === "tool_use");
  if (!toolUse) {
    return { kind: "error", message: "Claude didn't return a tool call. Try rephrasing." };
  }

  if (toolUse.name === "extract_schedule_intent") {
    return { kind: "intent", input: toolUse.input };
  }
  if (toolUse.name === "request_clarification") {
    return { kind: "clarification", input: toolUse.input };
  }
  return { kind: "error", message: `Unknown tool: ${toolUse.name}` };
}

// ─── Target selection + conflict detection (backend) ──────────────
//
// Selection rules:
//  - explicitMode === "create" → create a new subtask
//  - 0 same-stage subtasks → create
//  - 1 same-stage subtask → update it
//  - 2+ same-stage subtasks → ask the user (NEVER auto-pick by
//    "unscheduled" heuristic; that bit us when the producer wanted to
//    move an existing dated shoot but the project also had an
//    auto-seeded default Shoot with no startDate — the heuristic
//    silently picked the empty one)
//  - Special case for stage "edit": prefer literally-named "Edit"
//    over "Selects timeline + kick off video" (both infer to edit
//    stage, but only the former is the editor's real cut)
function pickTargetSubtask({ subtasksObj, stage, explicitMode }) {
  if (explicitMode === "create") {
    return { mode: "create", subtaskId: null, existing: null };
  }
  const all = Object.entries(subtasksObj || {})
    .map(([id, st]) => ({ id, ...(st || {}) }))
    .filter(st => st && st.id);
  const sameStage = all.filter(st => st.stage === stage);

  if (sameStage.length === 0) {
    return { mode: "create", subtaskId: null, existing: null };
  }

  if (stage === "edit") {
    const exact = sameStage.find(st => st.name === "Edit");
    if (exact) return { mode: "update", subtaskId: exact.id, existing: exact };
  }

  if (sameStage.length === 1) {
    return { mode: "update", subtaskId: sameStage[0].id, existing: sameStage[0] };
  }

  return {
    mode: "clarify",
    subtaskId: null,
    existing: null,
    candidates: sameStage.map(st => ({
      label: `${st.name || "(unnamed)"}${st.startDate ? ` — ${st.startDate}` : " — unscheduled"}`,
      value: st.id,
    })),
  };
}

function detectDateConflict({ existing, intent, today }) {
  if (!existing || !existing.startDate) return null;
  if (existing.startDate < today) {
    return {
      kind: "past",
      existingStartDate: existing.startDate,
    };
  }
  if (existing.startDate !== intent.startDate) {
    return {
      kind: "diff",
      existingStartDate: existing.startDate,
    };
  }
  return null;
}

// ─── Render proposal + post card ───────────────────────────────────
async function renderProposalAndPostCard({ claudeOut, context, event, botToken }) {
  const shortId = randomShortId();
  const now = Date.now();

  if (claudeOut.kind === "clarification") {
    // Persist an awaiting_clarification proposal so the click handler
    // has somewhere to load partialIntent from.
    const ci = claudeOut.input;
    const proposal = {
      shortId,
      status: "awaiting_clarification",
      clarificationKind: ci.kind || "project",
      clarificationQuestion: ci.question,
      clarificationOptions: ci.options || [],
      partialIntent: {}, // nothing resolved yet
      authorSlackUserId: event.user,
      originalText: event.text,
      slackChannel: event.channel,
      slackTs: event.ts,
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
    };
    const { db } = getAdmin();
    await db.ref(`/scheduling/pending/${shortId}`).set(proposal);

    const blocks = clarificationBlocks(proposal);
    const post = await slackPostMessage({
      channel: event.channel,
      thread_ts: event.ts,
      blocks,
      text: `Need a quick clarification: ${ci.question}`,
      botToken,
    });
    if (post?.ts) {
      await db.ref(`/scheduling/pending/${shortId}/confirmMessageTs`).set(post.ts);
    }
    return;
  }

  if (claudeOut.kind !== "intent") return;

  const intent = claudeOut.input;
  const project = context.projects.find(p => p.id === intent.projectId);
  if (!project) {
    await slackPostMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Couldn't find a project with id \`${intent.projectId}\` — try naming the client.`,
      botToken,
    });
    return;
  }

  // Resolve assignees against the editors list — drop anything Claude
  // hallucinated. The dashboard treats unknown ids as "no assignee".
  const editorById = new Map(context.editors.map(e => [e.id, e]));
  const assigneeIds = (intent.assigneeIds || []).filter(id => editorById.has(id));

  // Pull this project's subtasks once for target selection + conflict.
  const subtasksObj = (await adminGet(`/projects/${intent.projectId}/subtasks`)) || {};

  const target = pickTargetSubtask({
    subtasksObj,
    stage: intent.stage,
    explicitMode: intent.explicitMode,
  });

  if (target.mode === "clarify") {
    // Multiple same-stage subtasks with no obvious pick — ask the user.
    const proposal = {
      shortId,
      status: "awaiting_clarification",
      clarificationKind: "subtask",
      clarificationQuestion: `Multiple ${STAGE_LABELS[intent.stage]} tasks under "${project.projectName}" — which one?`,
      clarificationOptions: target.candidates,
      partialIntent: { ...intent, assigneeIds },
      authorSlackUserId: event.user,
      originalText: event.text,
      slackChannel: event.channel,
      slackTs: event.ts,
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
    };
    const { db } = getAdmin();
    await db.ref(`/scheduling/pending/${shortId}`).set(proposal);
    const post = await slackPostMessage({
      channel: event.channel,
      thread_ts: event.ts,
      blocks: clarificationBlocks(proposal),
      text: proposal.clarificationQuestion,
      botToken,
    });
    if (post?.ts) {
      await db.ref(`/scheduling/pending/${shortId}/confirmMessageTs`).set(post.ts);
    }
    return;
  }

  // Conflict detection — past or future-but-different date on the
  // existing same-stage subtask. We turn this into a forced "reschedule
  // vs add new" clarification.
  if (target.mode === "update") {
    const conflict = detectDateConflict({
      existing: target.existing,
      intent,
      today: context.today,
    });
    if (conflict) {
      const proposal = {
        shortId,
        status: "awaiting_clarification",
        clarificationKind: "resched_or_new",
        clarificationQuestion:
          conflict.kind === "past"
            ? `There's already a ${STAGE_LABELS[intent.stage]} on ${conflict.existingStartDate} for ${project.projectName}. Reschedule that one or add a new ${STAGE_LABELS[intent.stage]} day?`
            : `${project.projectName} already has a ${STAGE_LABELS[intent.stage]} on ${conflict.existingStartDate}. Replace it with ${intent.startDate} or add a second one?`,
        clarificationOptions: [
          { label: conflict.kind === "past" ? "Reschedule existing" : "Replace existing", value: "update" },
          { label: conflict.kind === "past" ? `Add new ${STAGE_LABELS[intent.stage]} day` : "Add a second one", value: "create" },
        ],
        partialIntent: { ...intent, assigneeIds, _conflictExistingId: target.subtaskId },
        authorSlackUserId: event.user,
        originalText: event.text,
        slackChannel: event.channel,
        slackTs: event.ts,
        createdAt: now,
        expiresAt: now + PROPOSAL_TTL_MS,
      };
      const { db } = getAdmin();
      await db.ref(`/scheduling/pending/${shortId}`).set(proposal);
      const post = await slackPostMessage({
        channel: event.channel,
        thread_ts: event.ts,
        blocks: clarificationBlocks(proposal),
        text: proposal.clarificationQuestion,
        botToken,
      });
      if (post?.ts) {
        await db.ref(`/scheduling/pending/${shortId}/confirmMessageTs`).set(post.ts);
      }
      return;
    }
  }

  // Clean path — render the confirm card.
  const proposal = await buildPendingProposal({
    shortId,
    intent,
    assigneeIds,
    target,
    project,
    event,
    now,
    subtasksObj,
  });

  // ── Brain pass ──────────────────────────────────────────────────
  // Run the deterministic checker against a virtual world where the
  // proposed write is already applied, scoped to the proposed date
  // range only (no point flagging next month's idle Tuesday when the
  // user is scheduling for next Thursday). Filter to the kinds that
  // belong on confirm cards — under-capacity / idle / overrun stay
  // digest-only because they're noisy at scheduling time.
  const brainOutcome = await runBrainPassForScheduling({
    intent, project, target, fields: proposal.resolvedPatch.fields, context,
  });
  if (brainOutcome.flags.length) {
    proposal.brainFlags = brainOutcome.flags;
    proposal.brainNarration = brainOutcome.narration;
  }

  const { db } = getAdmin();
  await db.ref(`/scheduling/pending/${shortId}`).set(proposal);

  const post = await slackPostMessage({
    channel: event.channel,
    thread_ts: event.ts,
    blocks: confirmCardBlocks({ proposal, project, editors: context.editors }),
    text: `Confirm: ${STAGE_LABELS[intent.stage]} for ${project.projectName} on ${intent.startDate}`,
    botToken,
  });
  if (post?.ts) {
    await db.ref(`/scheduling/pending/${shortId}/confirmMessageTs`).set(post.ts);
  }
}

// Run the brain checker over the virtual post-confirm state. Returns
// { flags, narration } — flags filtered to scheduling-relevant kinds.
// Empty flags means no API call to Opus.
async function runBrainPassForScheduling({ intent, project, target, fields, context }) {
  // Load current full team-board state. Listener already has projects
  // (paged-down) and editors via context.buildSchedulingContext, but
  // those are NAME-only. We need the raw projects+subtasks for the
  // checker.
  const [projectsRaw, editorsRaw, weekData, cachedStatsRec] = await Promise.all([
    adminGet("/projects"),
    adminGet("/editors"),
    adminGet("/weekData"),
    adminGet("/scheduling/cachedStats"),
  ]);
  const projects = projectsRaw || {};
  const editorsList = Array.isArray(editorsRaw) ? editorsRaw : Object.values(editorsRaw || {});
  const editors = editorsList.filter(e => e?.id);
  const weekDataMap = weekData || {};
  const videoTypeStats = cachedStatsIsFresh(cachedStatsRec) ? (cachedStatsRec.stats || {}) : {};

  // Build the virtual write. mode=update merges fields onto the
  // existing subtask; mode=create injects a new subtask.
  const virtualProjects = applyVirtualWrite(projects, {
    projectId: project.id,
    subtaskId: target.subtaskId,
    mode: target.mode,
    fields,
  });

  // Date range: the bar's startDate..endDate (default to single-day
  // when endDate not set).
  const startDate = fields.startDate;
  const endDate = fields.endDate || fields.startDate;

  const allFlags = detectFlagsForDateRange({
    startDate, endDate,
    projects: virtualProjects,
    editors,
    weekData: weekDataMap,
    videoTypeStats,
    loggedHoursBySubtask: {}, // overrun is digest-only
  });

  // Filter to scheduling-card-relevant kinds.
  const flags = allFlags.filter(f => SCHEDULING_CARD_KINDS.has(f.kind));
  if (flags.length === 0) return { flags: [], narration: null };

  // Phase 1A awareness — gives the narration access to unscheduled
  // edits + editor free-capacity so it can suggest concrete fixes
  // (e.g., "Charlie shoot is unassigned, could pull forward").
  const awareness = buildAwareness({
    projects: virtualProjects, editors, weekData: weekDataMap,
    videoTypeStats, today: context.today,
  });

  // Narrate.
  const narration = await narrateBrain({
    flags,
    projects: virtualProjects,
    editors,
    today: context.today,
    mode: "scheduling",
    awareness,
  });
  return { flags, narration };
}

// Apply the proposed write virtually onto a copy of the projects map.
// Pure — doesn't mutate the input.
function applyVirtualWrite(projects, { projectId, subtaskId, mode, fields }) {
  const targetProject = projects[projectId];
  if (!targetProject) return projects;
  const subtasks = { ...(targetProject.subtasks || {}) };
  if (mode === "update" && subtaskId) {
    const existing = subtasks[subtaskId] || {};
    subtasks[subtaskId] = { ...existing, ...fields, id: subtaskId };
  } else if (mode === "create") {
    const newId = `_virtual_${Date.now()}`;
    subtasks[newId] = { ...fields, id: newId };
  }
  return {
    ...projects,
    [projectId]: { ...targetProject, subtasks },
  };
}

// Build the pending-proposal record. Captures the resolved patch the
// confirm handler will apply, plus a fingerprint of the target subtask
// at this moment for race detection.
//
// Assignee preservation: when updating an existing subtask AND the
// user didn't name anyone (Claude returned empty assigneeIds), we
// preserve the subtask's existing assignees instead of clearing them.
// "Move the shoot to Wednesday — same people" is a common phrasing,
// and zeroing the crew is destructive. If the producer wants to clear
// crew, they can do it on the dashboard.
async function buildPendingProposal({
  shortId, intent, assigneeIds, target, project, event, now, subtasksObj,
}) {
  const preserveExistingAssignees =
    target.mode === "update" && assigneeIds.length === 0 && target.existing;
  const finalAssigneeIds = preserveExistingAssignees
    ? (Array.isArray(target.existing.assigneeIds) ? target.existing.assigneeIds : (target.existing.assigneeId ? [target.existing.assigneeId] : []))
    : assigneeIds;
  const finalAssigneeId = preserveExistingAssignees
    ? (target.existing.assigneeId || finalAssigneeIds[0] || null)
    : (assigneeIds[0] || null);

  const fields = {
    startDate: intent.startDate,
    endDate: intent.endDate || intent.startDate, // single-day default
    startTime: intent.startTime || null,
    endTime: intent.endTime || null,
    assigneeIds: finalAssigneeIds,
    assigneeId: finalAssigneeId,
    stage: intent.stage,
    name: target.mode === "create" ? defaultNameForStage(intent.stage, intent.startDate, subtasksObj) : (target.existing?.name || null),
    source: "slack",
  };

  return {
    shortId,
    status: "pending",
    authorSlackUserId: event.user,
    originalText: event.text,
    slackChannel: event.channel,
    slackTs: event.ts,
    confirmMessageTs: null, // filled after chat.postMessage returns
    claudeIntent: intent,
    resolvedPatch: {
      projectId: project.id,
      subtaskId: target.subtaskId,
      mode: target.mode,
      fields,
    },
    targetFingerprint: target.existing ? fingerprintSubtask(target.existing) : null,
    project: { id: project.id, projectName: project.projectName, clientName: project.clientName },
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
  };
}

// Pick a name for a newly-created subtask. Plain "Shoot"/"Edit"/etc.
// when the project has no same-stage subtask of that default name yet;
// otherwise append the date so the dashboard can tell them apart.
function defaultNameForStage(stage, startDate, subtasksObj) {
  const defaultName = DEFAULT_NAME_FOR_STAGE[stage];
  const all = Object.values(subtasksObj || {});
  const collision = all.some(st => st && st.name === defaultName && st.stage === stage);
  return collision ? `${defaultName} — ${startDate}` : defaultName;
}

// ─── Block Kit builders ────────────────────────────────────────────
function clarificationBlocks(proposal) {
  const opts = (proposal.clarificationOptions || []).slice(0, 4);
  return [
    { type: "section", text: { type: "mrkdwn", text: `:thinking_face: ${proposal.clarificationQuestion}` } },
    {
      type: "actions",
      elements: opts.map((o, i) => ({
        type: "button",
        text: { type: "plain_text", text: o.label.slice(0, 75) },
        action_id: `clarify_${proposal.clarificationKind}_${i}`,
        value: `${proposal.shortId}|${proposal.clarificationKind}:${o.value}`,
      })),
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_From your message:_ ${truncate(proposal.originalText, 140)}` }],
    },
  ];
}

function confirmCardBlocks({ proposal, project, editors }) {
  const f = proposal.resolvedPatch.fields;
  const editorById = new Map(editors.map(e => [e.id, e]));
  const assigneeNames = (f.assigneeIds || [])
    .map(id => editorById.get(id)?.name)
    .filter(Boolean);
  const dateLine = (f.endDate && f.endDate !== f.startDate)
    ? `${f.startDate} → ${f.endDate}`
    : f.startDate;
  const timeLine = f.startTime ? `\n*Time:* ${f.startTime}${f.endTime ? `–${f.endTime}` : ""}` : "";
  const modeLine = proposal.resolvedPatch.mode === "create" ? "Create new subtask" : "Update existing subtask";

  // Brain flags (if any) flip the Confirm button to "Confirm anyway"
  // and add a "Heads up" section above the action buttons. Cognitive
  // friction is intentional — you can still proceed, but you've seen
  // the warning.
  const hasBrainFlags = Array.isArray(proposal.brainFlags) && proposal.brainFlags.length > 0;
  const headsUpBlocks = hasBrainFlags
    ? buildBrainFlagsBlocks({
        flags: proposal.brainFlags,
        narration: proposal.brainNarration,
        header: ":warning: *Heads up*",
        fingerprintFn: fingerprintFlag,
      })
    : [];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Schedule confirmation* ${STAGE_EMOJI[f.stage]} *${STAGE_LABELS[f.stage]}*\n` +
          `*Project:* ${project.clientName} — ${project.projectName}\n` +
          `*Subtask:* ${f.name || STAGE_LABELS[f.stage]} _(${modeLine})_\n` +
          `*Date:* ${dateLine}${timeLine}\n` +
          `*Editor:* ${assigneeNames.length ? assigneeNames.join(", ") : "_unassigned_"}`,
      },
    },
    ...headsUpBlocks,
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_From your message:_ ${truncate(proposal.originalText, 140)}` }],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: hasBrainFlags ? "Confirm anyway" : "Confirm" },
          action_id: "confirm_schedule",
          value: proposal.shortId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "cancel_schedule",
          value: proposal.shortId,
        },
      ],
    },
  ];
}

function truncate(s, n) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
