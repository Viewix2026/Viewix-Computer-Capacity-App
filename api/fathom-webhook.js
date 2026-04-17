// api/fathom-webhook.js
// Webhook receiver for Fathom (or Zapier/Make.com pulling from Fathom).
// Accepts a meeting payload, auto-detects meeting type from the name,
// creates a /meetingFeedback/{id} record, and kicks off Hormozi analysis.
//
// Expected payload (flexible — we try multiple field names):
// {
//   secret: "viewix-fathom-2026",   // REQUIRED — matches SECRET const below
//   meetingName: "Discovery with Acme",
//   transcript: "...",               // full meeting transcript
//   invitees: [...],                 // optional: array of attendees
//   clientName: "Acme Corp",         // optional: defaults to derived from name
//   salesperson: "Brandon",          // optional: attempts to detect from invitees
//   recordingUrl: "...",             // optional: Fathom playback URL
//   durationSeconds: 1800,           // optional
//   meetingType: "discovery",        // optional: overrides auto-detection
// }
//
// Response: { success: true, feedbackId, meetingType, analyseQueued: true }

import { adminSet, getAdmin } from "./_fb-admin.js";
import { runMeetingFeedbackAnalysis } from "./meeting-feedback.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const SECRET = "viewix-fathom-2026";

// Salespeople to detect from invitee list (order matters — longest first to avoid partial matches)
const SALESPEOPLE = ["Brandon", "Jeremy"];

async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// Detect meeting type from the meeting name (mirror of the client-side helper)
function detectMeetingType(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("discovery") || n.includes("intro") || n.includes("qualifying")) return "discovery";
  if (n.includes("blueprint") || n.includes("proposal") || n.includes("pitch") || n.includes("presentation")) return "blueprint";
  if (n.includes("catchup") || n.includes("catch up") || n.includes("follow") || n.includes("check-in") || n.includes("check in")) return "catchup";
  return "";
}

// Try to detect the Viewix salesperson from the invitee list
function detectSalesperson(invitees, meetingName) {
  // Invitees can be strings or objects with .name/.email fields — handle both
  const names = (invitees || []).map(i => {
    if (typeof i === "string") return i;
    return (i?.name || i?.displayName || i?.email || "").toString();
  });
  const combined = (names.join(" ") + " " + (meetingName || "")).toLowerCase();
  for (const sp of SALESPEOPLE) {
    if (combined.includes(sp.toLowerCase())) return sp;
  }
  return "";
}

// Derive a client name from the meeting name by stripping common prefixes/suffixes
function deriveClientName(meetingName, invitees) {
  let n = (meetingName || "").trim();
  // Strip common meeting type prefixes: "Discovery - Acme", "Blueprint with Acme"
  n = n.replace(/^(discovery|blueprint|catchup|catch\s*up|follow[\s-]*up|pitch|proposal|intro)\s*[-–—:|]?\s*/i, "");
  n = n.replace(/\s+(with|-)\s+/i, " ").trim();
  // Strip trailing "call", "meeting", "chat"
  n = n.replace(/\s+(call|meeting|chat)$/i, "").trim();
  if (n) return n;
  // Fallback: first non-Viewix invitee
  const names = (invitees || []).map(i => (typeof i === "string" ? i : (i?.name || i?.email || ""))).filter(Boolean);
  const external = names.find(n2 => !SALESPEOPLE.some(sp => n2.toLowerCase().includes(sp.toLowerCase())));
  return external || "Unknown client";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    const { secret, meetingName, transcript, invitees, recordingUrl, durationSeconds } = body;
    let { clientName, salesperson, meetingType } = body;

    // Secret check — prevents anyone from spamming the endpoint
    if (secret !== SECRET) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }

    if (!transcript || typeof transcript !== "string" || transcript.trim().length < 50) {
      return res.status(400).json({ error: "Transcript is required (min 50 chars)" });
    }
    if (!meetingName) {
      return res.status(400).json({ error: "meetingName is required" });
    }

    // Auto-derive missing fields
    if (!meetingType) meetingType = detectMeetingType(meetingName);
    if (!salesperson) salesperson = detectSalesperson(invitees, meetingName);
    if (!clientName) clientName = deriveClientName(meetingName, invitees);

    const feedbackId = `mf-${Date.now()}`;
    const entry = {
      id: feedbackId,
      clientName,
      meetingName,
      meetingType: meetingType || "",
      salesperson: salesperson || "",
      transcript: transcript.trim(),
      recordingUrl: recordingUrl || "",
      durationSeconds: durationSeconds || null,
      source: "fathom",
      createdAt: new Date().toISOString(),
      status: "analysing",
    };

    await fbSet(`/meetingFeedback/${feedbackId}`, entry);

    // Run the analysis inline and await. Vercel freezes serverless functions
    // the moment they respond, so any fire-and-forget fetch would die mid-
    // flight — that's why records were getting stuck at "analysing" forever.
    // Worst case this takes ~45s which is within most webhook senders' timeout
    // budgets (Fathom, Zapier, Make all tolerate up to 60-90s).
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    let analyseResult = null;
    let analyseError = null;
    if (!ANTHROPIC_KEY) {
      analyseError = "ANTHROPIC_API_KEY not configured";
    } else {
      try {
        analyseResult = await runMeetingFeedbackAnalysis({
          feedbackId,
          transcript: entry.transcript,
          salesperson: entry.salesperson,
          clientName: entry.clientName,
          meetingName: entry.meetingName,
          meetingType: entry.meetingType,
          apiKey: ANTHROPIC_KEY,
        });
      } catch (err) {
        analyseError = err.message || "Analysis failed";
        console.error("fathom-webhook analysis error:", err);
      }
    }

    return res.status(200).json({
      success: true,
      feedbackId,
      meetingType: entry.meetingType,
      salesperson: entry.salesperson,
      clientName: entry.clientName,
      analysed: !!analyseResult,
      analyseError,
      rating: analyseResult?.rating ?? null,
    });
  } catch (err) {
    console.error("fathom-webhook error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
