// api/preproduction.js
// Vercel Serverless Function: Preproduction AI pipeline
// Actions: generate (full script), rewrite (single cell)
// Uses Claude Opus 4.6 via Anthropic API with prompt caching
// Requires maxDuration: 60 in vercel.json (Hobby plan max)

import { buildSystemPrompt, buildRewritePrompt, PACKAGE_CONFIGS } from "./preproduction-prompt.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-6";

async function fbGet(path) {
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

async function fbSet(path, data) {
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fbPatch(path, data) {
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { action } = req.body || {};

  try {
    // ─── GENERATE: Full script generation from transcript ───
    if (action === "generate") {
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
    if (action === "notifyFeedback") {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ error: "Missing projectId" });

      const project = await fbGet(`/preproduction/metaAds/${projectId}`);
      if (!project) return res.status(404).json({ error: "Project not found" });

      const slackUrl = process.env.SLACK_PREPRODUCTION_WEBHOOK_URL;
      if (slackUrl) {
        const feedbackCount = project.clientFeedback ? Object.keys(project.clientFeedback).length : 0;
        await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `${project.companyName} has left feedback on their Meta Ads scripts (${feedbackCount} comment${feedbackCount !== 1 ? "s" : ""}). Review in dashboard: planner.viewix.com.au`,
          }),
        });
      }

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action. Use: generate, rewrite, notifyFeedback" });
  } catch (e) {
    console.error("Preproduction API error:", e);
    return res.status(500).json({ error: e.message });
  }
}
