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
      const { projectId, transcript, packageTier, companyName } = req.body;

      if (!projectId || !transcript || !packageTier || !companyName) {
        return res.status(400).json({ error: "Missing required fields: projectId, transcript, packageTier, companyName" });
      }

      if (!PACKAGE_CONFIGS[packageTier]) {
        return res.status(400).json({ error: `Invalid packageTier: ${packageTier}. Must be standard, premium, or deluxe` });
      }

      // Update status to processing
      await fbPatch(`/preproduction/metaAds/${projectId}`, {
        status: "processing",
        updatedAt: new Date().toISOString(),
      });

      // Build prompts
      const systemPrompt = buildSystemPrompt({ packageTier, companyName });
      const userMessage = `Here is the onboarding call transcript for ${companyName}:\n\n${transcript}`;

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
          source: "manual",
          text: transcript,
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

    // ─── REWRITE: Targeted cell rewrite ───
    if (action === "rewrite") {
      const { projectId, cellId, column, instruction, currentValue } = req.body;

      if (!projectId || !cellId || !column || !instruction) {
        return res.status(400).json({ error: "Missing required fields: projectId, cellId, column, instruction" });
      }

      const project = await fbGet(`/preproduction/metaAds/${projectId}`);
      if (!project) return res.status(404).json({ error: "Project not found" });

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

    return res.status(400).json({ error: "Unknown action. Use: generate, rewrite" });
  } catch (e) {
    console.error("Preproduction API error:", e);
    return res.status(500).json({ error: e.message });
  }
}
