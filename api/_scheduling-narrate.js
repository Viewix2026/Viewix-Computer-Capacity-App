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
  projects,
  editors,
  today,
  mode = "digest",
  awareness = null,
  apiKey = process.env.ANTHROPIC_API_KEY,
}) {
  // Silent on empty input for non-digest modes — saves a token of API spend.
  if ((!flags || flags.length === 0) && mode !== "digest") {
    return { summary: "", perFlagText: {}, recommendation: "" };
  }
  if (!apiKey) {
    console.warn("scheduling-narrate: ANTHROPIC_API_KEY not configured");
    return fallbackNarration(flags || []);
  }

  const userMessage = buildUserMessage({ flags, projects, editors, today, mode, awareness });

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
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (e) {
    console.error("scheduling-narrate fetch error:", e);
    return fallbackNarration(flags || []);
  }

  if (!resp.ok) {
    console.error("scheduling-narrate API error:", resp.status, await resp.text().catch(() => ""));
    return fallbackNarration(flags || []);
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
    return {
      summary: String(parsed.summary || ""),
      perFlagText: parsed.perFlagText && typeof parsed.perFlagText === "object" ? parsed.perFlagText : {},
      recommendation: String(parsed.recommendation || ""),
    };
  } catch (e) {
    console.warn("scheduling-narrate: model output not JSON, falling back:", text.slice(0, 200));
    return fallbackNarration(flags || []);
  }
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
