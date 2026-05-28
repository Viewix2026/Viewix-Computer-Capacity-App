// api/preproduction.js
// Vercel Serverless Function: Preproduction AI pipeline
// Actions: generate (full script), rewrite (single cell)
// Uses Claude Opus 4.6 via Anthropic API with prompt caching
// Requires maxDuration: 60 in vercel.json (Hobby plan max)

import { buildSystemPrompt, buildRewritePrompt, PACKAGE_CONFIGS } from "./preproduction-prompt.js";
import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import { todaySydney } from "./_slack-helpers.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-6";

// Firebase helpers: prefer admin SDK (bypasses security rules), fall back to REST
// if FIREBASE_SERVICE_ACCOUNT env var isn't set yet (local dev / pre-rules deploy).
async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function callClaude(systemPrompt, userMessage, apiKey) {
  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text || "";
}

function parseJSON(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleaned);
}

// Tally feedback across the new (sectionFeedback / scriptFeedback) and
// legacy (clientFeedback) shapes so notifyFeedback and submitReview
// share a single source of truth. flavour just tags the result so the
// caller knows which Slack copy to render.
function feedbackSummary(project, flavour) {
  const doc = project?.preproductionDoc || {};
  const sections = Object.values(doc.sectionFeedback || {});
  const approvals = sections.filter(s => s && s.verdict === "approve").length;
  const changes   = sections.filter(s => s && s.verdict === "changes").length;
  const scripts   = Object.values(doc.scriptFeedback || {});
  const reactions = scripts.filter(s => s && s.reaction).length;
  const comments  = scripts.reduce((n, s) => n + Object.keys(s?.comments || {}).length, 0);
  const legacyCount = Object.keys(doc.clientFeedback || project?.clientFeedback || {}).length;
  return { approvals, changes, reactions, comments, legacyCount, flavour };
}

// Schedule a Meta Ads pre-production revision subtask on the project
// linked to the given preproduction record. Reverse-lookup is by
// `links.preprodId === metaAdsProjectId` because the preproduction
// record's key (e.g. "meta_1737022...") is NOT the project id (e.g.
// "proj-..."). Codex flagged that the original "same id" assumption
// would auto-create work against the wrong project.
//
// Returns { nextAvailable, plMention } on success, null when the
// linked project / PL / editor record can't be resolved (caller
// silently skips the schedule line in the Slack message — the
// notification still fires).
//
// Idempotency: the new subtask id is derived from the metaAds project
// id + the latest feedback batch timestamp so a retry of the same
// notify call produces the same subtask id and fbSet on an existing
// path overwrites without duplicating. New batches of feedback get
// new subtasks (by design — each batch is a new revision round).
async function scheduleMetaAdsRevisionSubtask({ metaAdsProjectId, project }) {
  if (!metaAdsProjectId || !project) return null;

  // Reverse lookup the linked /projects record.
  const projectsObj = (await fbGet("/projects")) || {};
  const linkedProject = Object.values(projectsObj).find(p =>
    p && p.links && p.links.preprodId === metaAdsProjectId
  );
  if (!linkedProject || !linkedProject.id) {
    console.warn(`scheduleMetaAdsRevisionSubtask: no project links preprodId=${metaAdsProjectId}`);
    return null;
  }

  // Resolve the PL via the linked account's projectLead string, then
  // look up the editor record for the Slack mention.
  const accountId = linkedProject.links?.accountId;
  const accountsObj = (await fbGet("/accounts")) || {};
  const acct = accountId ? accountsObj[accountId] : null;
  const plName = (acct?.projectLead || linkedProject.projectLead || "").trim();
  if (!plName) {
    console.warn(`scheduleMetaAdsRevisionSubtask: no PL name on project ${linkedProject.id}`);
    return null;
  }
  const editorsArr = (await fbGet("/editors")) || [];
  const editorsList = Array.isArray(editorsArr) ? editorsArr.filter(Boolean) : Object.values(editorsArr || {}).filter(Boolean);
  const plEditor = editorsList.find(e => (e?.name || "").trim().toLowerCase() === plName.toLowerCase());
  const plEditorId = plEditor?.id || null;
  const plSlackId = plEditor?.slackUserId || null;
  const plMention = plSlackId ? `<@${plSlackId}>` : `*${plName}*`;

  // Compute "next available day for PL" — first weekday from
  // tomorrow Sydney-local with no existing scheduled subtask for
  // this editor. Cap the scan at 30 days; fall back to tomorrow if
  // nothing fits.
  const today = todaySydney();
  const editorDefaultDays = plEditor?.defaultDays || null;
  const subtasksAssignedToPl = collectAssignedDates(projectsObj, plEditorId);
  const nextAvailable = findNextAvailableWeekday({
    fromIso: addIsoDays(today, 1),
    defaultDays: editorDefaultDays,
    occupiedDates: subtasksAssignedToPl,
    capDays: 30,
  });

  // Idempotent stable id per metaAds projectId + feedback batch ts.
  // Feedback batches are bucketed loosely by the largest submittedAt
  // in the current feedback object so a retry within the same window
  // returns the same id; a new batch of feedback fires a new id.
  const feedbackTimes = project.clientFeedback
    ? Object.values(project.clientFeedback).map(f => f?.submittedAt || "").filter(Boolean)
    : [];
  const batchSignal = feedbackTimes.length > 0
    ? feedbackTimes.sort().slice(-1)[0].replace(/[^0-9]/g, "").slice(-12)
    : Date.now().toString();
  const stId = `st-metaRev-${batchSignal}`;
  const now = new Date().toISOString();

  const subtask = {
    id: stId,
    name: `Pre-production revision — ${linkedProject.projectName || "Untitled project"}`,
    stage: "preProduction",
    status: "scheduled",
    startDate: nextAvailable,
    endDate: nextAvailable,
    startTime: null,
    endTime: null,
    assigneeIds: plEditorId ? [plEditorId] : [],
    assigneeId: plEditorId,
    source: "metaAdsRevision",
    createdAt: now,
    updatedAt: now,
  };
  await fbSet(`/projects/${linkedProject.id}/subtasks/${stId}`, subtask);

  return { nextAvailable, plMention };
}

// Collect every date a given editor is already scheduled for, as a
// Set of YYYY-MM-DD strings. Used to pick the next free day.
function collectAssignedDates(projectsObj, editorId) {
  const dates = new Set();
  if (!editorId) return dates;
  for (const p of Object.values(projectsObj || {})) {
    if (!p || !p.subtasks) continue;
    for (const st of Object.values(p.subtasks)) {
      if (!st || st.status === "done") continue;
      const ids = Array.isArray(st.assigneeIds) ? st.assigneeIds : (st.assigneeId ? [st.assigneeId] : []);
      if (!ids.includes(editorId)) continue;
      const start = st.startDate || st.endDate;
      const end = st.endDate || st.startDate;
      if (!start) continue;
      let d = start;
      // Span both endpoints inclusive.
      while (d <= end) {
        dates.add(d);
        d = addIsoDays(d, 1);
        if (d > "9999-12-31") break;
      }
    }
  }
  return dates;
}

// Find the first weekday from `fromIso` that:
//   - is a Mon–Fri (or one of the editor's defaultDays if provided)
//   - has no existing scheduled subtask in `occupiedDates`.
// Caps the scan at `capDays`; returns `fromIso` as the safety
// fallback so callers always get a date even when the lookup fails.
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function findNextAvailableWeekday({ fromIso, defaultDays, occupiedDates, capDays }) {
  let iso = fromIso;
  for (let i = 0; i < capDays; i++) {
    const d = new Date(iso + "T00:00:00");
    const dow = d.getDay(); // 0=Sun … 6=Sat
    const isWeekend = dow === 0 || dow === 6;
    const inDefaultDays = defaultDays
      ? !!defaultDays[DAY_KEYS[dow]]
      : !isWeekend;
    if (inDefaultDays && !occupiedDates.has(iso)) return iso;
    iso = addIsoDays(iso, 1);
  }
  return fromIso;
}

function addIsoDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { action } = req.body || {};
  // Public actions (no role check, no Anthropic key required): clients
  // submitting feedback or hitting the explicit submit button on the
  // shared review link. Everything else (generate/rewrite) needs both
  // a producer role and the ANTHROPIC_API_KEY env var, checked inside
  // the relevant branch.
  const PUBLIC_ACTIONS = new Set(["notifyFeedback", "submitReview"]);
  if (!PUBLIC_ACTIONS.has(action)) {
    try {
      await requireRole(req, ["founders", "manager", "lead"]);
    } catch (e) {
      return sendAuthError(res, e);
    }
  }

  try {
    // ─── GENERATE: Full script generation from transcript ───
    if (action === "generate") {
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

      const { projectId, transcript, googleDocUrl, packageTier, companyName } = req.body;

      if (!projectId || !packageTier || !companyName) {
        return res.status(400).json({ error: "Missing required fields: projectId, packageTier, companyName" });
      }

      if (!transcript && !googleDocUrl) {
        return res.status(400).json({ error: "Either transcript or googleDocUrl is required" });
      }

      if (!PACKAGE_CONFIGS[packageTier]) {
        return res.status(400).json({ error: `Invalid packageTier: ${packageTier}. Must be standard, premium, or deluxe` });
      }

      // Resolve transcript: use pasted text or fetch from Google Doc
      let resolvedTranscript = transcript;
      let transcriptSource = "manual";

      if (!resolvedTranscript && googleDocUrl) {
        // Extract doc ID from Google Doc URL
        const docIdMatch = googleDocUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (!docIdMatch) {
          return res.status(400).json({ error: "Invalid Google Doc URL. Expected format: https://docs.google.com/document/d/{docId}/..." });
        }
        const docId = docIdMatch[1];

        try {
          const docResp = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`);
          if (!docResp.ok) {
            throw new Error(`Google Doc fetch failed (${docResp.status}). Make sure the doc is set to "Anyone with the link can view".`);
          }
          resolvedTranscript = await docResp.text();
          transcriptSource = "googledoc";
        } catch (docErr) {
          return res.status(400).json({ error: docErr.message });
        }

        if (!resolvedTranscript || resolvedTranscript.trim().length < 50) {
          return res.status(400).json({ error: "Google Doc appears empty or too short. Check the sharing settings." });
        }
      }

      // Update status to processing
      await fbPatch(`/preproduction/metaAds/${projectId}`, {
        status: "processing",
        updatedAt: new Date().toISOString(),
      });

      // Fetch prompt learnings (curated rules from past feedback)
      const learningsData = await fbGet("/preproduction/promptLearnings");
      const promptLearnings = learningsData ? Object.values(learningsData).filter(l => l && l.active && l.rule).map(l => l.rule) : [];

      // Build prompts
      const systemPrompt = buildSystemPrompt({ packageTier, companyName, promptLearnings });
      const userMessage = `Here is the onboarding call transcript for ${companyName}:\n\n${resolvedTranscript}`;

      // Call Claude (maxDuration: 60 in vercel.json allows up to 60s)
      const rawResponse = await callClaude(systemPrompt, userMessage, ANTHROPIC_KEY);

      // Parse JSON response
      let parsed;
      try {
        parsed = parseJSON(rawResponse);
      } catch (parseErr) {
        await fbPatch(`/preproduction/metaAds/${projectId}`, {
          status: "draft",
          updatedAt: new Date().toISOString(),
          _rawResponse: rawResponse.substring(0, 5000),
          _parseError: parseErr.message,
        });
        return res.status(422).json({ error: "Failed to parse Claude response as JSON", detail: parseErr.message });
      }

      // Add IDs to script table rows
      if (parsed.scriptTable) {
        parsed.scriptTable = parsed.scriptTable.map((row) => ({
          ...row,
          id: row.videoName || row.id,
        }));
      }

      // Write results to Firebase
      const now = new Date().toISOString();
      await fbPatch(`/preproduction/metaAds/${projectId}`, {
        status: "review",
        updatedAt: now,
        transcript: {
          source: transcriptSource,
          googleDocUrl: googleDocUrl || null,
          text: resolvedTranscript,
          addedAt: now,
        },
        brandAnalysis: parsed.brandAnalysis || null,
        targetCustomer: parsed.targetCustomer || null,
        motivators: parsed.motivators || null,
        visuals: parsed.visuals || null,
        scriptTable: parsed.scriptTable || null,
      });

      // Post Slack notification
      const slackUrl = process.env.SLACK_PREPRODUCTION_WEBHOOK_URL;
      if (slackUrl) {
        try {
          await fetch(slackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: `${companyName} Meta Ads scripts are ready for review. View in dashboard: planner.viewix.com.au`,
            }),
          });
        } catch (slackErr) {
          console.error("Slack notification failed:", slackErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        projectId,
        status: "review",
        brandAnalysis: parsed.brandAnalysis,
        targetCustomer: parsed.targetCustomer,
        motivators: parsed.motivators,
        visuals: parsed.visuals,
        scriptTable: parsed.scriptTable,
      });
    }

    // ─── REWRITE: Targeted cell or row rewrite ───
    if (action === "rewrite") {
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

      const { projectId, cellId, column, instruction, currentValue } = req.body;

      if (!projectId || !cellId || !column || !instruction) {
        return res.status(400).json({ error: "Missing required fields: projectId, cellId, column, instruction" });
      }

      const project = await fbGet(`/preproduction/metaAds/${projectId}`);
      if (!project) return res.status(404).json({ error: "Project not found" });

      // ─── ROW REWRITE: rewrite all content fields in one call, return JSON ───
      if (column === "_row") {
        const rowIndex = project.scriptTable?.findIndex((r) => r.id === cellId || r.videoName === cellId);
        if (rowIndex == null || rowIndex === -1) {
          return res.status(404).json({ error: "Row not found in script table" });
        }
        const row = project.scriptTable[rowIndex];
        const rowSystemPrompt = `You are rewriting an entire Meta Ad script row. You receive the existing row content and an instruction, and you return a complete rewritten row as JSON.

CLIENT: ${project.companyName}
BRAND CONTEXT:
Brand Truths: ${JSON.stringify(project.brandAnalysis?.brandTruths || [])}
Brand Ambitions: ${JSON.stringify(project.brandAnalysis?.brandAmbitions || [])}
Brand Personality: ${JSON.stringify(project.brandAnalysis?.brandPersonality || {})}
Target Customer: ${JSON.stringify(project.targetCustomer || [])}
Motivators — Toward: ${JSON.stringify(project.motivators?.toward || [])}
Motivators — Away From: ${JSON.stringify(project.motivators?.awayFrom || [])}
Motivators — Tried Before: ${JSON.stringify(project.motivators?.triedBefore || [])}

EXISTING ROW:
Video Name: ${row.videoName || ""}
Motivator Type: ${row.motivatorType || ""}
Audience Type: ${row.audienceType || ""}
Hook: ${row.hook || ""}
Explain the Pain: ${row.explainThePain || ""}
Results: ${row.results || ""}
The Offer: ${row.theOffer || ""}
Why the Offer: ${row.whyTheOffer || ""}
CTA: ${row.cta || ""}
Meta Ad Headline: ${row.metaAdHeadline || ""}
Meta Ad Copy: ${row.metaAdCopy || ""}

REWRITE INSTRUCTION: ${instruction}

RULES:
- Never use em dashes. Use a comma, full stop, or rewrite.
- Use contractions throughout.
- Keep every field tight.
- Hook: one or two sentences, confrontational, direct.
- Explain the Pain: one sentence only.
- Results: one sentence only, lives in the viewer's world.
- The Offer: max two sentences, opens with "At ${project.companyName}, we..."
- Why the Offer: one or two short sentences.
- CTA: one short sentence, use "tap".
- Meta Ad Headline: 35 characters max.
- Meta Ad Copy: 60 to 120 words.
- Keep videoName, motivatorType, audienceType unchanged unless the instruction asks for it.

Return a single JSON object with this exact structure (no markdown, no preamble, no explanation):
{
  "videoName": "...",
  "hook": "...",
  "explainThePain": "...",
  "results": "...",
  "theOffer": "...",
  "whyTheOffer": "...",
  "cta": "...",
  "metaAdHeadline": "...",
  "metaAdCopy": "..."
}`;

        const rawRowResp = await callClaude(rowSystemPrompt, "Rewrite the row now.", ANTHROPIC_KEY);
        let parsedRow;
        try {
          parsedRow = parseJSON(rawRowResp);
        } catch (e) {
          return res.status(422).json({ error: "Failed to parse row rewrite response", detail: e.message });
        }

        // Merge: keep existing row fields, overwrite with parsed ones
        const updatedRow = { ...row, ...parsedRow };
        await fbSet(`/preproduction/metaAds/${projectId}/scriptTable/${rowIndex}`, updatedRow);

        const logId = `rwrow_${Date.now()}`;
        await fbSet(`/preproduction/feedbackLog/${logId}`, {
          type: "rewrite",
          projectId,
          companyName: project.companyName || "",
          cellId,
          column: "_row",
          instruction,
          timestamp: new Date().toISOString(),
        });

        await fbPatch(`/preproduction/metaAds/${projectId}`, {
          updatedAt: new Date().toISOString(),
        });

        return res.status(200).json({ success: true, cellId, column: "_row", newValue: JSON.stringify(parsedRow) });
      }

      // ─── CELL REWRITE: rewrite a single column ───
      const systemPrompt = buildRewritePrompt({
        brandAnalysis: project.brandAnalysis,
        motivators: project.motivators,
        targetCustomer: project.targetCustomer,
        cellId,
        column,
        currentValue: currentValue || "",
        instruction,
        companyName: project.companyName,
      });

      const rawResponse = await callClaude(
        "You rewrite individual cells in Meta Ad script tables. Return only the rewritten value, nothing else.",
        systemPrompt,
        ANTHROPIC_KEY
      );

      const newValue = rawResponse.trim();

      if (project.scriptTable) {
        const rowIndex = project.scriptTable.findIndex((r) => r.id === cellId || r.videoName === cellId);
        if (rowIndex !== -1) {
          await fbSet(`/preproduction/metaAds/${projectId}/scriptTable/${rowIndex}/${column}`, newValue);

          const historyEntry = {
            timestamp: new Date().toISOString(),
            cellId,
            column,
            instruction,
            previousValue: currentValue || "",
            newValue,
          };
          const history = project.rewriteHistory || [];
          history.push(historyEntry);
          await fbSet(`/preproduction/metaAds/${projectId}/rewriteHistory`, history);

          // Log to central feedback log for prompt refinement
          const logId = `rw_${Date.now()}`;
          await fbSet(`/preproduction/feedbackLog/${logId}`, {
            type: "rewrite",
            projectId,
            companyName: project.companyName || "",
            cellId,
            column,
            instruction,
            previousValue: currentValue || "",
            newValue,
            timestamp: new Date().toISOString(),
          });

          await fbPatch(`/preproduction/metaAds/${projectId}`, {
            updatedAt: new Date().toISOString(),
          });
        }
      }

      return res.status(200).json({
        success: true,
        cellId,
        column,
        newValue,
      });
    }

    // ─── NOTIFY FEEDBACK: Slack notification when client leaves feedback ───
    // Covers both Meta Ads (/preproduction/metaAds) and Social Organic
    // (/preproduction/socialOrganic with feedback nested under
    // preproductionDoc). Public action: fires 2 min after the client's
    // last keystroke via the client-side debounce. Submission of an
    // explicit "Submit review" goes through submitReview instead.
    //
    // For Meta Ads only, ALSO auto-create a pre-production revision
    // subtask on the linked /projects record (reverse lookup via
    // links.preprodId, since the preproduction record key is NOT the
    // project id), scheduled for the PL's next available day. SMO keeps
    // its existing flow because revision subtasks are already
    // auto-created downstream of the revisions public view in
    // notify-revision.js.
    if (action === "notifyFeedback") {
      const { projectId, type } = req.body;
      if (!projectId) return res.status(400).json({ error: "Missing projectId" });

      let project = null;
      let flavour = type || null;
      if (!flavour || flavour === "metaAds") {
        project = await fbGet(`/preproduction/metaAds/${projectId}`);
        if (project) flavour = "metaAds";
      }
      if (!project && (!flavour || flavour === "socialOrganic")) {
        project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
        if (project) flavour = "socialOrganic";
      }
      if (!project) return res.status(404).json({ error: "Project not found" });

      const feedback = flavour === "socialOrganic"
        ? project.preproductionDoc?.clientFeedback
        : project.clientFeedback;
      const feedbackCount = feedback ? Object.keys(feedback).length : 0;
      const label = flavour === "socialOrganic" ? "Social Organic scripts" : "Meta Ads scripts";

      // Meta Ads only: auto-schedule a pre-production revision subtask
      // on the linked project. Best-effort — Slack still fires even if
      // any step here trips.
      let scheduledFor = null;
      let plMention = null;
      if (flavour === "metaAds") {
        try {
          const scheduled = await scheduleMetaAdsRevisionSubtask({ metaAdsProjectId: projectId, project });
          if (scheduled) {
            scheduledFor = scheduled.nextAvailable;
            plMention = scheduled.plMention;
          }
        } catch (e) {
          console.error("notifyFeedback: schedule Meta Ads revision failed:", e.message);
        }
      }

      const slackUrl = process.env.SLACK_PREPRODUCTION_WEBHOOK_URL;
      if (slackUrl) {
        let text;
        if (flavour === "socialOrganic") {
          const s = feedbackSummary(project, flavour);
          const parts = [];
          if (s.approvals + s.changes > 0) parts.push(`${s.approvals + s.changes} section${s.approvals + s.changes !== 1 ? "s" : ""}`);
          if (s.reactions > 0)             parts.push(`${s.reactions} reaction${s.reactions !== 1 ? "s" : ""}`);
          if (s.comments > 0)              parts.push(`${s.comments} comment${s.comments !== 1 ? "s" : ""}`);
          if (s.legacyCount > 0 && parts.length === 0) parts.push(`${s.legacyCount} cell note${s.legacyCount !== 1 ? "s" : ""}`);
          const summary = parts.length > 0 ? parts.join(" · ") : "feedback saved";
          text = `${project.companyName} has left feedback on their ${label}: ${summary}. Review in dashboard: planner.viewix.com.au`;
        } else {
          // metaAds keeps the legacy per-cell count (its review page
          // hasn't been redesigned, so sectionFeedback / scriptFeedback
          // don't exist there) and appends the new auto-schedule line.
          const scheduleSuffix = scheduledFor
            ? ` Pre-production revision scheduled for *${scheduledFor}*${plMention ? ` · cc ${plMention}` : ""}.`
            : "";
          text = `:speech_balloon: *${project.companyName}* has left feedback on their ${label} (${feedbackCount} comment${feedbackCount !== 1 ? "s" : ""}).${scheduleSuffix} Review in dashboard: planner.viewix.com.au`;
        }
        await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      }

      return res.status(200).json({ success: true, scheduledFor });
    }

    // ─── SUBMIT REVIEW: client explicitly clicked "Submit review" ───
    // Stamps preproductionDoc.reviewSubmittedAt so the producer can
    // distinguish "client is still typing" from "client said they're
    // done", and fires the Slack notification immediately (bypasses
    // the 2-minute notifyFeedback debounce). socialOrganic only — the
    // metaAds public page doesn't expose a submit button.
    if (action === "submitReview") {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ error: "Missing projectId" });

      const project = await fbGet(`/preproduction/socialOrganic/${projectId}`);
      if (!project) return res.status(404).json({ error: "Project not found" });

      const submittedAt = new Date().toISOString();
      await fbSet(`/preproduction/socialOrganic/${projectId}/preproductionDoc/reviewSubmittedAt`, submittedAt);

      const slackUrl = process.env.SLACK_PREPRODUCTION_WEBHOOK_URL;
      if (slackUrl) {
        // Re-fetch so the freshly stamped reviewSubmittedAt and any
        // last-second feedback are reflected in the summary.
        const fresh = await fbGet(`/preproduction/socialOrganic/${projectId}`) || project;
        const s = feedbackSummary(fresh, "socialOrganic");
        const parts = [];
        if (s.approvals > 0) parts.push(`${s.approvals} approved`);
        if (s.changes > 0)   parts.push(`${s.changes} need${s.changes !== 1 ? "" : "s"} changes`);
        if (s.reactions > 0) parts.push(`${s.reactions} reaction${s.reactions !== 1 ? "s" : ""}`);
        if (s.comments > 0)  parts.push(`${s.comments} comment${s.comments !== 1 ? "s" : ""}`);
        const summary = parts.length > 0 ? parts.join(" · ") : "no feedback left";
        await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `✅ ${fresh.companyName} submitted their pre-production review. ${summary}. Review in dashboard: planner.viewix.com.au`,
          }),
        });
      }

      // Log the submission to the central feedback log so prompt
      // refinement workflows can spot completed reviews vs in-progress.
      await fbSet(`/preproduction/feedbackLog/sub_${Date.now()}`, {
        type: "submitReview",
        projectType: "socialOrganic",
        projectId,
        companyName: project.companyName || "",
        timestamp: submittedAt,
      });

      return res.status(200).json({ success: true, reviewSubmittedAt: submittedAt });
    }

    return res.status(400).json({ error: "Unknown action. Use: generate, rewrite, notifyFeedback, submitReview" });
  } catch (e) {
    console.error("Preproduction API error:", e);
    return res.status(500).json({ error: e.message });
  }
}
