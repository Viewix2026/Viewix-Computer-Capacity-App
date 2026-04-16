// api/meeting-feedback.js
// Vercel Serverless Function: Meeting Feedback AI analysis
// Takes a sales meeting transcript, returns a /10 rating, summary, and feedback bullet points.

import { adminGet, adminSet, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-6";

async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
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
      max_tokens: 8000,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
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

const SYSTEM_PROMPT = `You are an expert sales coach analysing a recorded sales call for Viewix, a video production company that sells Meta Ads and social media video retainers to Australian businesses.

Your job: analyse the transcript and return a structured evaluation of the sales person's performance.

Grade on these dimensions (each contributes to the overall /10):
1. Discovery — did they uncover the prospect's real pain, goals, and timeline?
2. Qualification — did they confirm budget, authority, need, and timing (BANT)?
3. Pitch quality — did they tailor the pitch to the prospect's situation? Did they communicate Viewix's value clearly?
4. Objection handling — did they address concerns with confidence and evidence?
5. Control of the call — did they lead the conversation with purpose, or react to the prospect?
6. Next steps / close — did they land a clear next step (booked follow-up, signed proposal, etc.)?

Return STRICTLY valid JSON in this shape, with no prose outside the JSON:

{
  "rating": <integer 1-10>,
  "summary": "<1-2 sentence overall verdict>",
  "strengths": ["<specific strength with timestamp or quote if possible>", ...],
  "improvements": ["<specific actionable coaching point>", ...],
  "keyMoments": ["<notable moment from the call with brief context>", ...],
  "outcome": "<did they close, book a follow-up, or lose the deal? one sentence>"
}

Rules:
- Be direct and specific. Avoid generic advice.
- Each bullet should reference something concrete from the transcript.
- Rating must reflect the actual performance: 1-3 poor, 4-6 average, 7-8 strong, 9-10 exceptional.
- Aim for 3-6 items in each bullet list.
- Do NOT wrap the JSON in markdown code fences.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const { feedbackId, transcript, salesperson, clientName, meetingName } = req.body || {};
    if (!feedbackId || !transcript) return res.status(400).json({ error: "Missing feedbackId or transcript" });

    const userMessage = `Salesperson: ${salesperson || "Unknown"}
Client: ${clientName || "Unknown"}
Meeting: ${meetingName || "Sales call"}

Transcript:
${transcript}`;

    const raw = await callClaude(SYSTEM_PROMPT, userMessage, ANTHROPIC_KEY);
    let result;
    try {
      result = parseJSON(raw);
    } catch (e) {
      return res.status(500).json({ error: "Failed to parse AI response", raw });
    }

    const updated = {
      rating: result.rating,
      summary: result.summary || "",
      strengths: result.strengths || [],
      improvements: result.improvements || [],
      keyMoments: result.keyMoments || [],
      outcome: result.outcome || "",
      status: "analysed",
      analysedAt: new Date().toISOString(),
    };

    // Merge analysis into the existing feedback entry
    await fbSet(`/meetingFeedback/${feedbackId}/analysis`, updated);

    return res.status(200).json({ success: true, analysis: updated });
  } catch (err) {
    console.error("meeting-feedback error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
