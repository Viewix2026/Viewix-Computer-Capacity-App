// api/fathom-webhook.js
// Webhook receiver for Fathom (or Zapier/Make.com pulling from Fathom).
// Accepts a meeting payload, auto-detects meeting type from the name,
// creates a /meetingFeedback/{id} record, and kicks off Hormozi analysis.
//
// Expected payload (flexible — we try multiple field names):
// {
//   secret: process.env.FATHOM_WEBHOOK_SECRET,
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
const SECRET = process.env.FATHOM_WEBHOOK_SECRET;

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
  // "Content blueprint" is a specific Viewix meeting name that should map to
  // the blueprint type — matched before the generic "blueprint" check so the
  // more specific pattern wins when it contains extra words.
  if (n.includes("content blueprint") || n.includes("content strategy")) return "blueprint";
  if (n.includes("blueprint") || n.includes("proposal") || n.includes("pitch") || n.includes("presentation")) return "blueprint";
  if (n.includes("catchup") || n.includes("catch up") || n.includes("follow") || n.includes("check-in") || n.includes("check in")) return "catchup";
  return "";
}

// Try to detect the Viewix salesperson from whatever the webhook sender gave
// us. Fathom's native payload has `invitees` as objects; Zapier/Make may send
// `attendees`, `participants`, or individual `hostName`/`organizer` fields.
// We throw everything into one haystack and look for SALESPEOPLE substrings.
function detectSalesperson(invitees, meetingName, extras = {}) {
  const inviteeNames = (invitees || []).map(i => {
    if (typeof i === "string") return i;
    return (i?.name || i?.displayName || i?.fullName || i?.email || "").toString();
  });
  const extraFields = [
    extras.hostName, extras.host, extras.organizer, extras.owner,
    extras.meetingHost, extras.scheduledBy, extras.assignedTo,
    ...(Array.isArray(extras.attendees) ? extras.attendees.map(a => typeof a === "string" ? a : (a?.name || a?.email || "")) : []),
    ...(Array.isArray(extras.participants) ? extras.participants.map(a => typeof a === "string" ? a : (a?.name || a?.email || "")) : []),
  ].filter(Boolean);
  const combined = [...inviteeNames, ...extraFields, meetingName || ""].join(" ").toLowerCase();
  for (const sp of SALESPEOPLE) {
    if (combined.includes(sp.toLowerCase())) return sp;
  }
  return "";
}

// Derive a client name from the meeting name by stripping common prefixes/
// suffixes. Designed to handle Viewix's actual naming conventions:
//   "Content Blueprint: Kris & Viewix"  → "Kris & Viewix"
//   "Discovery - Acme Corp"              → "Acme Corp"
//   "Blueprint with GEMIQ"               → "GEMIQ"
//   "Catchup call - Acme"                → "Acme"
function deriveClientName(meetingName, invitees) {
  let n = (meetingName || "").trim();

  // Strategy 1: strip a known meeting-type prefix + separator at the start.
  // Expanded list to include two-word phrases like "content blueprint".
  const prefixRegex = /^(content\s+blueprint|content\s+strategy|content\s+review|discovery|blueprint|catchup|catch\s*up|follow[\s-]*up|pitch|proposal|intro(?:ductory)?|kick[\s-]*off|presentation|check[\s-]*in)\s*(?:call|meeting|chat|session)?\s*[-–—:|]?\s*/i;
  const stripped = n.replace(prefixRegex, "").trim();
  if (stripped && stripped !== n) {
    n = stripped;
  } else {
    // Strategy 2: if there's a separator anywhere, take the part *after* the
    // last one. This catches "Custom Meeting Name: ClientCo" even when the
    // prefix isn't in our list.
    const sepMatch = n.match(/^(.+?)\s*[-–—:|]\s*(.+)$/);
    if (sepMatch && sepMatch[2].trim()) {
      n = sepMatch[2].trim();
    }
  }

  // Strategy 3: "with X" / "for X" → take what's after.
  const withMatch = n.match(/^(?:.*?\b)(?:with|for)\s+(.+)$/i);
  if (withMatch && withMatch[1].trim()) n = withMatch[1].trim();

  // Strip trailing "call / meeting / chat / session"
  n = n.replace(/\s+(call|meeting|chat|session)$/i, "").trim();

  // Strip an "& Viewix" / "+ Viewix" suffix — the agency doesn't need to be
  // in the client-name field. "Kris & Viewix" → "Kris".
  n = n.replace(/\s*[&+]\s*viewix\s*$/i, "").trim();

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
    const {
      secret, meetingName, transcript, invitees, recordingUrl, durationSeconds,
      // Any of these can be sent by the webhook integrator; we feed them into
      // detectSalesperson so detection still works when `invitees` is absent.
      hostName, host, organizer, owner, meetingHost, scheduledBy, assignedTo,
      attendees, participants,
    } = body;
    let { clientName, salesperson, meetingType } = body;

    // Secret check — prevents anyone from spamming the endpoint
    if (!SECRET) return res.status(500).json({ error: "FATHOM_WEBHOOK_SECRET not configured" });
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
    if (!salesperson) {
      salesperson = detectSalesperson(invitees, meetingName, {
        hostName, host, organizer, owner, meetingHost, scheduledBy, assignedTo, attendees, participants,
      });
    }
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
      // Mark errored so the UI doesn't spin forever on a config gap.
      try {
        await fbSet(`/meetingFeedback/${feedbackId}/status`, "error");
        await fbSet(`/meetingFeedback/${feedbackId}/analyseError`, analyseError);
      } catch { /* noop */ }
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
        // Mark the record as errored so the UI surfaces a Retry button.
        // Without this update the record sits at status="analysing" forever
        // and the stuck-detector in MeetingFeedback.jsx only kicks in after
        // 3 minutes — the explicit error is cleaner + actionable.
        try {
          await fbSet(`/meetingFeedback/${feedbackId}/status`, "error");
          await fbSet(`/meetingFeedback/${feedbackId}/analyseError`, analyseError);
        } catch (writeErr) {
          console.error("fathom-webhook: failed to mark record as errored:", writeErr);
        }
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
