// api/meeting-feedback.js
// Vercel Serverless Function: Meeting Feedback AI analysis
// Analyses a sales call transcript using Alex Hormozi's $100M Closing playbook
// as the evaluation framework. Returns a /10 rating, summary, and feedback bullets.

import { adminSet, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

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

// ─── HOUSE RULES ─────────────────────────────────────────────────────
// Shared across every meeting type. Sets the frame: who Viewix is, what
// Australian-B2B-appropriate behaviour looks like, and what the
// Hormozi-style reframing principles buy us (supplementary pattern
// notes, NOT primary scoring). Stage scorecards get appended below.
const HOUSE_RULES = `You are reviewing a sales call from Viewix Video Production, an Australian social video agency. The team runs a multi stage sales process:

1. Discovery call (30 min) - fit, pain, budget, decision process
2. Content Blueprint call (30 min) - strategy presentation and proposal
3. Nurture catchups (ongoing) - moving the deal toward yes or a clean no

You are scoring ONE call in that sequence. The meetingType tells you which stage.

SCORING CALIBRATION (read this first, it changes how you grade):

This is Australian B2B sales. Reps are running a professional but human conversation, not performing a Hormozi script. Be generous. Most competent Aussie sales calls should land in the 6-8 range. A 10 is rare and means the rep nailed the stage with real craft. A 5 means the call was OK but drifted. Below 5 means something genuinely went wrong (wasted the prospect's time, let a clear buying signal walk out the door, or actively damaged trust).

The rep does NOT need to hit every single item on the scorecard to score well on a category. "Solid job, not perfect" is a 2/2, not a 1/2. Only drop to 1 if they clearly half-did it, and to 0 if they missed it entirely or did the opposite. Reward partial wins.

Not every call needs every element. If a rep missed one thing but handled four others well, that's still a strong call. Say so.

TONE — WHAT AUSTRALIAN B2B SELLING SOUNDS LIKE:

Do not reward behaviours that work in a US context but damage trust with Australian founders and marketers. But don't punish a rep for being a normal human either.

Watch for (these should pull the score down when they appear):
- Manufactured urgency ("this offer expires Friday", "I can only hold this rate today")
- Hype and superlatives that ring hollow ("game changing", "world class", "revolutionary")
- Obvious sales theatre — rehearsed closing lines, overly polished cadence, tonality tricks
- Fake scarcity, overclaiming results, inflating case studies
- Talking over the prospect to maintain control
- Reframing that feels combative instead of curious

What good Aussie selling looks like (reward these when you see them):
- Plain language, short sentences, no agency jargon
- Confident pushback when the prospect is wrong about scope, timeline, or what video can realistically deliver — said plainly, not aggressively
- Under promising, over explaining the tradeoffs honestly
- Naming the awkward thing directly ("yeah look, most agencies won't say this, but...")
- Self aware humour, lightness, letting a laugh sit
- Genuine curiosity about the prospect's business — questions that prove the rep is actually listening
- Letting silence hang instead of filling it with nervous talk
- Treating the prospect like a peer, not a mark

A rep being a bit scrappy, a bit unpolished, or occasionally going off-script is NOT a penalty. Australians trust that more than a slick performance.

Soft no detection: Australians rarely give a hard no. Watch for "yeah nah", "I'll have a think", "sounds interesting, let me circle back", "look, it's probably not for us right now, but...". Flag if the rep accepted a soft no at face value WHEN they clearly should have clarified. Don't over-interpret — sometimes "I'll have a think" genuinely means they need to think, and a rep who gracefully gives them space is fine. The call matters.

SUPPLEMENTARY PRINCIPLES (consider when reviewing, but do not let these override stage scoring):

These come from Alex Hormozi's reframing framework. Use them as pattern checks, not primary criteria. Note them in the reframing_notes section if relevant.

- Who asked more questions, the rep or the prospect? The rep should generally be in control.
- Did the rep ever say "do you have any questions" as an open invitation? Flag it.
- When the prospect asked a vague question, did the rep answer it blind or ask a clarifying question first?
- Did the rep acknowledge the objection before responding, or jump straight to an overcome?
- Did the rep use a straw man to deliver a hard truth (referencing an earlier caller, a past client like Sydney Zoo, or Jeremy/Steve as authority) rather than disagreeing head on?
- Did the rep callback a label the prospect accepted earlier ("you mentioned you're the kind of business that...")?
- Did the rep ever voice direct disagreement? If so, did it land, or did it damage rapport?

OUTPUT FORMAT (return exactly this JSON structure):

{
  "score": <number, 0-10>,
  "summary": "<2-3 sentence overall read on the call>",
  "strengths": ["<specific moment or behaviour>", "<specific moment>"],
  "gaps": ["<specific moment or behaviour>", "<specific moment>"],
  "reframing_notes": ["<supplementary pattern observations, 0-3 items>"],
  "next_call_coaching": "<single clearest thing to fix before the next call with this prospect or the next call this rep runs>",
  "deal_status_read": "<your read on where this deal actually sits: hot / warm / cold / dead, with one line of reasoning>"
}

Quote specific lines from the transcript in strengths and gaps. Vague feedback is useless. "Rep handled the pricing objection well" is a fail. "When prospect said 'that's a lot more than we budgeted', rep said 'yeah, fair, what figure were you working with?' which kept them in the conversation instead of defending" is useful.

Return STRICTLY valid JSON, no markdown code fences, no prose outside the JSON object.`;

// ─── STAGE SCORECARDS ────────────────────────────────────────────────
// Each stage has 5 categories × 0-2 points = /10 total. These replace
// the old Hormozi-primary TYPE_FOCUS blocks. Appended to HOUSE_RULES
// based on req.body.meetingType.

const SCORECARDS = {
  discovery: `This is a DISCOVERY call. The goal is not to close. The goal is to qualify, uncover real pain with numbers attached, understand the decision process, and earn the right to present a Content Blueprint in the next meeting.

Score each category 0, 1, or 2. Total out of 10.

1. PREP AND CONTEXT (0-2)
0: Generic opener, no evidence of research, asked questions that are answered on their website.
1: Mentioned the prospect's business or recent content but didn't use it to drive the conversation.
2: Opened with 2-3 specific observations about their Instagram, website, ads, or market position and used them to frame the discovery.

2. AGENDA AND CONTROL (0-2)
0: Meandered, let the prospect hijack, no structure.
1: Soft agenda stated, but lost control later in the call.
2: Clear structure set in first 2 minutes (why we're here, what we'll cover, what happens next if we're a fit or not), and held it throughout.

3. DISCOVERY DEPTH (0-2)
0: Surface level pain, no numbers, no decision process.
1: Got some numbers or some process detail, but missing key pieces.
2: Got real metrics (current lead flow, ad spend, CAC, revenue, team size, video output), the decision process (who signs off, by when), and the internal context (what have they tried, what's failed, what are they comparing us to).

4. PAIN AND CONSEQUENCE (0-2)
0: Took the first answer at face value, moved on.
1: Lightly explored impact.
2: Stayed with the problem long enough for the prospect to state the cost of not fixing it, in their own words. Financial, operational, or strategic cost, all valid.

5. NEXT STEP LOCKED (0-2)
0: Ended with "I'll send something through" or "let me know what you think".
1: Mentioned the Blueprint call but didn't book it live.
2: Sold the Blueprint as a working session, booked it on the call, calendar invite sent before hanging up. Or, if not a fit, clean disqualification stated.`,

  blueprint: `This is a BLUEPRINT call. The prospect has already done discovery. They're here to see the strategy and hear the price. The goal is a decision, or at minimum a committed next step with a date.

Score each category 0, 1, or 2. Total out of 10.

1. RECAP AND CONFIRMATION (0-2)
0: Jumped straight into the pitch.
1: Rough recap, missed key details from discovery.
2: Precise 2-3 minute recap of their situation, goals, constraints, and what they said on the discovery call. Prospect explicitly agrees "yeah that's right" before the strategy is shown.

2. STRATEGY CLARITY (0-2)
0: Random list of services or tactics, no through line.
1: Some structure but still feels like agency soup, or leans on jargon (engagement, authority, brand equity, HVCO).
2: Simple stepwise plan in plain language: where they are now, what changes month 1 to month 3, what they'll see and when. No buzzwords.

3. OFFER AND VALUE FRAMING (0-2)
0: Listed features and quoted the price.
1: Talked about outcomes but stayed hand wavy.
2: Connected specific deliverables to the metrics the prospect actually cares about (lead flow, CAC, pipeline, team capacity saved), positioned price against that upside, and named the tradeoffs honestly.

4. PROOF AND RISK (0-2)
0: "Trust us, we're good."
1: Generic case studies dropped in without tailoring.
2: Used 1-3 specific examples matched to the prospect's industry or size (Sydney Zoo, Vasectomy Australia, DLA Piper, RBS, etc.), set realistic expectations, and addressed risk plainly. What we'll commit to, what we can't guarantee, what typically goes wrong in month 1.

5. DECISION AND NEXT STEP (0-2)
0: "Have a think and get back to me."
1: Got a "probably" or a "sounds good" with no committed next action.
2: Asked for a clear yes, no, or specific decision process. If yes, confirmed signing path. If needs time, agreed exact next action, decision maker, and date, booked on the call.

SPECIFIC FAILS TO FLAG ON BLUEPRINT CALLS:
- Dropping price unprompted on the call (cardinal sin)
- Selling past yes (prospect signals ready, rep keeps pitching)
- Defending the price instead of asking what the concern actually is
- Agreeing to "send the proposal across" without a follow up call booked
- Not naming money objections directly when they appear ("is it the total, the monthly, or the commitment length?")`,

  nurture: `This is a NURTURE catchup. The Blueprint has already happened. The prospect hasn't said yes yet. The goal of this call is to advance the deal, not maintain contact. Every nurture call should either move the prospect closer to signing, surface a new blocker, or produce a clean no.

Score each category 0, 1, or 2. Total out of 10.

1. CONTEXT RECALL AND PICKUP (0-2)
0: Treated the call like a fresh conversation, re asked things already covered.
1: Referenced the prior call loosely.
2: Picked up precisely where the last call ended, referenced specific things the prospect said last time, confirmed what's changed since.

2. WHAT'S CHANGED SURFACE (0-2)
0: Didn't ask what's moved on their side.
1: Asked but took a vague answer.
2: Surfaced real new information: new internal pressure, a competitor move, a budget decision, a team change, a failed campaign, a win that changed priorities. The rep leaves the call knowing more than they did before it.

3. BLOCKER CLARITY (0-2)
0: Let the prospect stay vague about what's holding them back.
1: Probed but accepted a soft answer ("still thinking about it", "just timing").
2: Pinned the actual blocker. Named it clearly. Money, partner, internal politics, timing, competing priority, or genuine doubt about the solution. The rep can now articulate exactly what needs to happen for a yes.

4. ADVANCING THE DEAL (0-2)
0: The call ended roughly where it started. No forward motion.
1: Minor progress (one new piece of info, no committed action).
2: Something concrete moved. A stakeholder meeting booked, a specific concern resolved, a revised scope agreed, a start date proposed, a decision deadline named.

5. NEXT STEP AND HONEST STATUS (0-2)
0: "I'll check back in a few weeks."
1: Next catchup loosely agreed, no anchor.
2: Next step booked with a purpose and a date, OR the rep called the deal directly ("look, it sounds like the timing isn't right, do you want me to stop following up?") and got a real answer.

SPECIFIC FAILS TO FLAG ON NURTURE CALLS:
- Reheating the original pitch instead of moving forward
- Accepting "yeah still keen, just busy" for the third call in a row without pinning a decision
- Discounting to create movement (never acceptable without a real reason)
- Letting the prospect off without a committed next date
- Not surfacing the real blocker because it feels rude to ask
- Missing a buying signal because the rep is in nurture mode and stopped listening for it`,
};

function getSystemPrompt(meetingType) {
  // "catchup" is the legacy type name — existing Firebase records and
  // Fathom webhook payloads still use it. Treat it as nurture so old
  // references keep routing to the right scorecard.
  const normalised = meetingType === "catchup" ? "nurture" : meetingType;
  const scorecard = SCORECARDS[normalised] || SCORECARDS.discovery;
  return `${HOUSE_RULES}

${scorecard}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const { feedbackId, transcript, salesperson, clientName, meetingName, meetingType } = req.body || {};
    if (!feedbackId || !transcript) return res.status(400).json({ error: "Missing feedbackId or transcript" });

    const updated = await runMeetingFeedbackAnalysis({
      feedbackId, transcript, salesperson, clientName, meetingName, meetingType,
      apiKey: ANTHROPIC_KEY,
    });
    return res.status(200).json({ success: true, analysis: updated });
  } catch (err) {
    console.error("meeting-feedback error:", err);
    // Write error status so the UI stops spinning and gets a retry option
    try {
      if (req.body?.feedbackId) {
        await fbSet(`/meetingFeedback/${req.body.feedbackId}/status`, "error");
        await fbSet(`/meetingFeedback/${req.body.feedbackId}/lastError`, err.message || "Unknown error");
      }
    } catch {}
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}

// Exported so api/fathom-webhook.js can call this directly instead of HTTP-
// self-invoking (Vercel serverless freezes the webhook lambda as soon as it
// responds, killing any in-flight fetch to our own API — that's what was
// leaving records stuck at status="analysing").
export async function runMeetingFeedbackAnalysis({ feedbackId, transcript, salesperson, clientName, meetingName, meetingType, apiKey }) {
  const userMessage = `Salesperson: ${salesperson || "Unknown"}
Client: ${clientName || "Unknown"}
Meeting: ${meetingName || "Sales call"}
Type: ${meetingType || "general"}

Transcript:
${transcript}`;

  const systemPrompt = getSystemPrompt(meetingType);
  const raw = await callClaude(systemPrompt, userMessage, apiKey);
  let result;
  try {
    result = parseJSON(raw);
  } catch (e) {
    // Surface parse failure as a status so the UI can show retry
    await fbSet(`/meetingFeedback/${feedbackId}/status`, "error");
    await fbSet(`/meetingFeedback/${feedbackId}/lastError`, `Failed to parse AI response: ${e.message}`);
    throw new Error("Failed to parse AI response");
  }

  // New JSON schema (post-rebuild): score, strengths, gaps, reframing_notes,
  // next_call_coaching, deal_status_read. We also mirror `score` to `rating`
  // and `gaps` to `improvements` for backward compat — the old UI card
  // renders both legacy + new fields (see MeetingFeedback.jsx) but this
  // means pre-migration components reading `rating` still get a number.
  const score = typeof result.score === "number" ? result.score
             : typeof result.rating === "number" ? result.rating
             : null;
  const gaps = Array.isArray(result.gaps) ? result.gaps
            : Array.isArray(result.improvements) ? result.improvements
            : [];
  const updated = {
    score,
    rating: score, // legacy alias
    summary: result.summary || "",
    strengths: Array.isArray(result.strengths) ? result.strengths : [],
    gaps,
    improvements: gaps, // legacy alias
    reframing_notes: Array.isArray(result.reframing_notes) ? result.reframing_notes : [],
    next_call_coaching: result.next_call_coaching || "",
    deal_status_read: result.deal_status_read || "",
    status: "analysed",
    analysedAt: new Date().toISOString(),
  };
  await fbSet(`/meetingFeedback/${feedbackId}/analysis`, updated);
  await fbSet(`/meetingFeedback/${feedbackId}/status`, "analysed");
  await fbSet(`/meetingFeedback/${feedbackId}/lastError`, null);
  return updated;
}
