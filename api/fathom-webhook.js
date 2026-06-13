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

import { adminSet, getAdmin, runRtdbTransaction } from "./_fb-admin.js";
import { runMeetingFeedbackAnalysis } from "./meeting-feedback.js";
import { deriveFeedbackId } from "./_fathom-dedup.js";
import { SALESPEOPLE, detectSalesperson, detectSalespersonFromTranscript } from "./_fathom-detect.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const SECRET = process.env.FATHOM_WEBHOOK_SECRET;

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
      // Fathom's native webhook field names
      recorded_by, calendar_invitees,
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
        recordedBy: recorded_by, calendarInvitees: calendar_invitees,
      });
    }
    // Metadata detection only works when the sender maps attendee/host fields
    // through — in practice the integration often sends just name + transcript.
    // The transcript's speaker labels ("Jeremy Farrugia (Viewix)") are the
    // reliable signal, so fall back to those.
    if (!salesperson) salesperson = detectSalespersonFromTranscript(transcript);
    if (!clientName) clientName = deriveClientName(meetingName, invitees);

    // Payload-derived id — identical across sender timeout-retries, so
    // a retry lands on the SAME record instead of duplicating it (and
    // paying for a second ~45s analysis).
    const feedbackId = deriveFeedbackId({ recordingUrl, meetingName, transcript });
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

    // Claim the record via transaction — a plain get-then-set leaves a
    // window where two near-simultaneous retries both miss and both run
    // the analysis. Writing on cur===null IS the claim (hash-checked, so
    // the SDK's cold-cache first run is safe); an existing record loses
    // the claim unless its analysis previously errored, in which case
    // the retry takes over and heals it under the same id.
    try {
      const claim = await runRtdbTransaction(`/meetingFeedback/${feedbackId}`, (cur) => {
        if (cur === null) return entry;
        // Takeover keeps the ORIGINAL creation time — the retry entry
        // would otherwise clobber it and corrupt audit/sort order.
        if (cur.status === "error") return { ...cur, ...entry, createdAt: cur.createdAt || entry.createdAt, status: "analysing" };
        return undefined; // analysing or done — duplicate delivery
      });
      if (!claim.committed) {
        return res.status(200).json({ success: true, deduped: true, feedbackId });
      }
    } catch (claimErr) {
      // Admin SDK unavailable (local/dev REST-fallback mode) — degrade
      // to the old non-atomic write rather than dropping the meeting.
      console.warn("fathom-webhook: claim transaction unavailable, falling back:", claimErr.message);
      await fbSet(`/meetingFeedback/${feedbackId}`, entry);
    }

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
