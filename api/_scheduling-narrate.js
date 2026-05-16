// api/_scheduling-narrate.js
//
// Opus 4.7 wrapper. Takes deterministic flags + minimal context and
// returns production-manager-voice text. Skipped (no API call) when
// flags is empty for modes "scheduling" / "drag" — the digest mode
// always narrates because that's the always-narrate moment.
//
// Every call also pushes a usage record to /scheduling/llmUsage/{date}
// so we can see actual daily spend after a week and decide if Sonnet
// should replace Opus for some modes.

import { getAdmin } from "./_fb-admin.js";
import { fingerprintFlag } from "../shared/scheduling/flags.js";
import { todaySydney } from "../shared/scheduling/availability.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2000;

// Anthropic Opus 4.7 list pricing (USD per 1M tokens). Update if
// pricing changes. Used only for the cost-logging line — not load-bearing.
const PRICING_USD_PER_1M = { input: 15, output: 75 };

const SYSTEM_PROMPT = `You are the Viewix production manager. Brief, decisive, no hedging. You receive
deterministic flags about the team's schedule and write 1–3 sentences per flag in your
voice — concrete, names + dates filled in. If multiple flags share a subject (same editor
double-booked AND idle the next day), synthesise. If you'd recommend a fix (reassign,
reschedule, hold), say so concretely.

Pair under-capacity flags with backlog suggestions when the inputs include unscheduled
edits with deadlines AND an editor with free capacity — but only when the inputs say
so. Don't fabricate.

Never invent facts not in the data. No travel times, no locations, no specific return
times. If a producer should think about travel, say "shoot ends 2pm — check travel
before stacking more work after it" rather than asserting "back by 3pm".

Use the editor's first name only.

Output strict JSON, no preamble:
{
  "summary": "single sentence — 1-line header for digest. Empty for scheduling/drag.",
  "perFlagText": { "<fingerprint>": "1-3 sentences for this flag" },
  "recommendation": "single concrete fix sentence, or empty string"
}`;

// Phase 2: narrate-ONLY system prompt. The deterministic planner has
// already produced a feasible allocation. Opus reads it, flags
// tradeoffs, recommends small adjustments only when the data clearly
// supports it. It NEVER proposes an alternate plan, invents dates, or
// invents names. The output schema has no field for an alternate plan.
const PLAN_SYSTEM_PROMPT = `You are the Viewix production manager reviewing a proposed editing plan.
A deterministic planner has ALREADY produced a feasible allocation. Your job: read it, call
out tradeoffs the producer should think about, and recommend small adjustments only when the
data clearly supports it.

You do NOT propose alternate plans. You do NOT invent dates, names, or facts. Use first names
only. Be brief and decisive — no hedging.

Output strict JSON, no preamble:
{
  "summary": "one sentence — the header line for the plan card",
  "perRowText": { "<rowKey>": "optional 1-line callout for this row, omit rows with nothing to say" },
  "recommendation": "single concrete adjustment sentence, or empty string"
}

rowKey is "<stage>#<videoIndex>" for edits/revisions (e.g. "edit#3") or "shoot#extra" for the
extra shoot. Only include rows that genuinely warrant a callout (tight day, deadline pressure,
multi-assignee). Silence on a row is fine.`;

function buildPlanUserMessage({ plan, today, awareness }) {
  const lines = [
    `TODAY (Sydney): ${today}`,
    `PROJECT: ${plan.project?.name} (${plan.project?.client || "no client"}) — ` +
      `${plan.project?.numberOfVideos} videos, type ${plan.project?.videoType}`,
    `DEADLINE: ${plan.deadline || "(none set)"}`,
    `PLAN WINDOW: ${plan.planWindow?.start} → ${plan.planWindow?.end}`,
    "",
    "PROPOSED ROWS:",
  ];
  for (const s of plan.proposedSubtasks || []) {
    const key = s.stage === "shoot" ? "shoot#extra" : `${s.stage}#${s.videoIndex}`;
    const when = s.startDate ? `${s.startDate}${s.endDate && s.endDate !== s.startDate ? `..${s.endDate}` : ""}` : "unscheduled";
    const times = s.startTime && s.endTime ? ` ${s.startTime}-${s.endTime}` : "";
    const who = (s.assigneeIds || []).join(", ") || "(unassigned)";
    lines.push(`- ${key} · ${s.name} · ${when}${times} · ${who} · ${s.mode}`);
  }
  if ((plan.hardViolations || []).length) {
    lines.push("", "HARD VIOLATIONS (these block one-click approve):");
    for (const v of plan.hardViolations) lines.push(`- ${JSON.stringify(v)}`);
  }
  if ((plan.warnings || []).length) {
    lines.push("", "WARNINGS:");
    for (const w of plan.warnings) lines.push(`- ${JSON.stringify(w)}`);
  }
  if (awareness?.editorFreeCapacity?.length) {
    lines.push("", "EDITOR FREE CAPACITY (next 14 days):");
    for (const e of awareness.editorFreeCapacity) lines.push(`- ${e.name}: ${e.freeHoursNext2Weeks}h free`);
  }
  return lines.join("\n");
}

function buildUserMessage({ flags, projects, editors, today, mode, awareness }) {
  // Resolve names so the model writes "Sam" instead of "ed-7".
  const editorById = new Map((editors || []).map(e => [e.id, e]));
  const projectById = new Map(Object.entries(projects || {}).map(([id, p]) => [id, p]));

  const flagBlock = (flags || []).map(f => {
    const fp = fingerprintFlag(f);
    const enriched = enrichForPrompt(f, editorById, projectById);
    return `- fingerprint: ${fp}\n  ${JSON.stringify(enriched)}`;
  }).join("\n");

  const lines = [
    `MODE: ${mode}`,
    `TODAY (Sydney): ${today}`,
    `FLAGS:`,
    flagBlock || "(none)",
  ];

  if (awareness) {
    if (awareness.unscheduledByProject?.length) {
      lines.push("");
      lines.push("UNSCHEDULED EDITS BY PROJECT (for backlog suggestions):");
      for (const p of awareness.unscheduledByProject) {
        const dl = p.daysToDeadline != null ? `, deadline in ${p.daysToDeadline} days` : "";
        lines.push(`- ${p.projectName}: ${p.unscheduledStages.join(", ")}${dl}`);
      }
    }
    if (awareness.editorFreeCapacity?.length) {
      lines.push("");
      lines.push("EDITOR FREE CAPACITY (next 14 days):");
      for (const e of awareness.editorFreeCapacity) {
        lines.push(`- ${e.name}: ${e.freeHoursNext2Weeks}h free`);
      }
    }
  }

  return lines.join("\n");
}

function enrichForPrompt(flag, editorById, projectById) {
  const out = { ...flag };
  if (flag.personId && editorById.has(flag.personId)) {
    out.personName = editorById.get(flag.personId).name;
  }
  if (flag.projectId && projectById.has(flag.projectId)) {
    const p = projectById.get(flag.projectId);
    out.projectName = p.projectName;
    out.clientName = p.clientName;
  }
  return out;
}

export async function narrateBrain({
  flags,
  plan = null,                 // Phase 2: present only when mode === "plan"
  projects,
  editors,
  today,
  mode = "digest",
  awareness = null,
  apiKey = process.env.ANTHROPIC_API_KEY,
}) {
  const isPlan = mode === "plan";

  // Silent on empty input for non-digest modes — saves a token of API spend.
  if (!isPlan && (!flags || flags.length === 0) && mode !== "digest") {
    return { summary: "", perFlagText: {}, recommendation: "" };
  }
  if (!apiKey) {
    console.warn("scheduling-narrate: ANTHROPIC_API_KEY not configured");
    return isPlan
      ? { summary: planFallbackSummary(plan), perRowText: {}, recommendation: "" }
      : fallbackNarration(flags || []);
  }

  const system = isPlan ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userMessage = isPlan
    ? buildPlanUserMessage({ plan, today, awareness })
    : buildUserMessage({ flags, projects, editors, today, mode, awareness });

  let resp;
  try {
    resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (e) {
    console.error("scheduling-narrate fetch error:", e);
    return isPlan
      ? { summary: planFallbackSummary(plan), perRowText: {}, recommendation: "" }
      : fallbackNarration(flags || []);
  }

  if (!resp.ok) {
    console.error("scheduling-narrate API error:", resp.status, await resp.text().catch(() => ""));
    return isPlan
      ? { summary: planFallbackSummary(plan), perRowText: {}, recommendation: "" }
      : fallbackNarration(flags || []);
  }

  const data = await resp.json();
  const text = (data.content || []).find(b => b.type === "text")?.text || "";

  // Log usage for cost visibility.
  await logUsage({
    mode,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  }).catch(() => {});

  // Parse — model is told to emit strict JSON. If it slipped, fall back.
  try {
    const trimmed = text.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(trimmed);
    if (isPlan) {
      return {
        summary: String(parsed.summary || planFallbackSummary(plan)),
        perRowText: parsed.perRowText && typeof parsed.perRowText === "object" ? parsed.perRowText : {},
        recommendation: String(parsed.recommendation || ""),
      };
    }
    return {
      summary: String(parsed.summary || ""),
      perFlagText: parsed.perFlagText && typeof parsed.perFlagText === "object" ? parsed.perFlagText : {},
      recommendation: String(parsed.recommendation || ""),
    };
  } catch (e) {
    console.warn("scheduling-narrate: model output not JSON, falling back:", text.slice(0, 200));
    return isPlan
      ? { summary: planFallbackSummary(plan), perRowText: {}, recommendation: "" }
      : fallbackNarration(flags || []);
  }
}

// Plain summary when the LLM is unavailable — the plan card still
// renders something useful.
function planFallbackSummary(plan) {
  if (!plan) return "Proposed plan.";
  const edits = (plan.proposedSubtasks || []).filter(s => s.stage === "edit").length;
  const revs = (plan.proposedSubtasks || []).filter(s => s.stage === "revisions").length;
  const shoot = (plan.proposedSubtasks || []).some(s => s.stage === "shoot") ? "1 shoot, " : "";
  const hv = (plan.hardViolations || []).length;
  return `Plan for ${plan.project?.name || "project"}: ${shoot}${edits} edits, ${revs} revisions`
    + (hv ? ` — ${hv} hard violation(s) to review.` : ".");
}

// Deterministic fallback when the LLM is unavailable / non-JSON.
// Just stringifies each flag plainly so the digest / Slack post is
// still useful (no flowery prose, but no failure either).
function fallbackNarration(flags) {
  const perFlagText = {};
  for (const f of flags) {
    perFlagText[fingerprintFlag(f)] = stringifyFlag(f);
  }
  return {
    summary: flags.length ? `${flags.length} flag(s) raised.` : "",
    perFlagText,
    recommendation: "",
  };
}

function stringifyFlag(f) {
  switch (f.kind) {
    case "fixedTimeConflict":
      return `${f.personId} double-booked on ${f.date} — overlapping timed work.`;
    case "multipleUntimedShoots":
      return `${f.personId} on ${(f.subtasks || []).length} untimed shoots ${f.date}. Add times or confirm.`;
    case "offDayAssigned":
      return `${f.personId} not working ${f.date} but has work assigned.`;
    case "inOfficeIdle":
      return `${f.personId} in office ${f.date} with nothing scheduled.`;
    case "dailyUnderCapacity":
      return `${f.personId} planned ${f.plannedHours}h on ${f.date} (target ${f.capacityHours}h).`;
    case "dailyOverCapacity":
      return `${f.personId} planned ${f.plannedHours}h on ${f.date}.`;
    case "dailyHardOverCapacity":
      return `${f.personId} hard over-capacity at ${f.plannedHours}h on ${f.date}.`;
    case "editOverrun":
      return `Edit ${f.subtaskId} at ${Math.round(f.actualHours)}h vs avg ${Math.round(f.avgHours)}h (${Math.round(f.ratio * 10) / 10}x).`;
    case "weekDataMismatch":
      return `${f.personId} weekData/subtask mismatch ${f.date} (${f.subkind}).`;
    case "unassignedScheduled":
      return `Subtask ${f.subtaskId} scheduled for ${f.startDate} with no assignee.`;
    default:
      return JSON.stringify(f);
  }
}

async function logUsage({ mode, inputTokens, outputTokens }) {
  const { db } = getAdmin();
  if (!db) return;
  const cost = (inputTokens / 1_000_000) * PRICING_USD_PER_1M.input
    + (outputTokens / 1_000_000) * PRICING_USD_PER_1M.output;
  const date = todaySydney();
  await db.ref(`/scheduling/llmUsage/${date}`).push({
    ts: Date.now(),
    mode,
    inputTokens,
    outputTokens,
    costUsd: Math.round(cost * 1000000) / 1000000, // 6dp
    model: MODEL,
  });
}
