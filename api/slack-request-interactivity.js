// api/slack-request-interactivity.js
//
// Handles button clicks from the Dashboard Requests intake bot's clarifying
// questions. When a teammate taps a multiple-choice answer, Slack POSTs here
// (the app's Interactivity Request URL). We record the chosen option into the
// SAME transactional intake thread state the events listener uses, disable the
// buttons on the original message, and re-run triage to ask the next question
// or file the ticket.
//
// Mirrors api/slack-interactivity.js: bodyParser:false, signature-verified,
// immediate-200 ack + waitUntil. The payload is URL-encoded with a `payload`
// field holding the JSON. Inert (clean 200) until the signing secret exists.
//
// Trust: the button value carries only `rootTs::roundIndex::optIndex`. The
// answer TEXT is read from the server-side stored round.options — never from
// the client — so a forged payload cannot inject an arbitrary answer, and the
// roundIndex binds the click to the exact question it was shown under.

import { waitUntil } from "@vercel/functions";
import { adminGet, mutateRecord } from "./_fb-admin.js";
import { readRawBody, verifySlackSignature, slackUpdateMessage } from "./_slack-helpers.js";
import { threadPath, toSlackMrkdwn, triage } from "./_dashboard-intake.js";

export const config = { api: { bodyParser: false } };

// Parse a button value "rootTs::roundIndex::optIndex". rootTs itself never
// contains "::". Returns null for anything malformed/forged. Exported for tests.
export function parseButtonValue(value) {
  const parts = String(value == null ? "" : value).split("::");
  if (parts.length !== 3) return null;
  const rootTs = parts[0];
  const roundIndex = Number(parts[1]);
  const optIndex = Number(parts[2]);
  if (!rootTs || !Number.isInteger(roundIndex) || roundIndex < 0) return null;
  if (!Number.isInteger(optIndex) || optIndex < 0) return null;
  return { rootTs, roundIndex, optIndex };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawBody = await readRawBody(req);
  const secret = process.env.SLACK_REQUEST_SIGNING_SECRET;
  if (!secret) return res.status(200).json({ ok: true, inert: "signing secret not set" });

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!verifySlackSignature({ rawBody, timestamp, signature, secret })) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get("payload") || "{}");
  } catch {
    return res.status(400).json({ error: "invalid payload" });
  }

  res.status(200).end();
  waitUntil(processInteraction(payload).catch(err => {
    console.error("slack-request-interactivity error:", err);
  }));
}

async function processInteraction(payload) {
  if (payload?.type !== "block_actions") return;
  const botToken = process.env.SLACK_REQUEST_BOT_TOKEN;
  const wantChannel = process.env.SLACK_REQUEST_CHANNEL_ID;
  const channel = payload.channel?.id;
  const action = (payload.actions || [])[0];
  if (!botToken || !channel || !action) return;
  if (wantChannel && channel !== wantChannel) return; // not our channel
  if (!String(action.action_id || "").startsWith("dr_ans_")) return; // not our button

  const parsed = parseButtonValue(action.value);
  if (!parsed) return;
  const { rootTs, roundIndex, optIndex } = parsed;

  const path = threadPath(rootTs);
  const state = await adminGet(path);
  const msgTs = payload.message?.ts || payload.container?.message_ts;

  // Resolve the answer from the SERVER-stored options for that exact round.
  const round = state?.rounds?.[roundIndex];
  const answer = round && Array.isArray(round.options) ? round.options[optIndex] : null;

  // Stale / already-answered / ticket filed → just disable the buttons so the
  // message isn't re-clickable, and stop.
  if (!state || state.ticketCreated || !round || round.a != null || answer == null) {
    if (msgTs && round?.q) await disableButtons({ channel, msgTs, question: round.q, chosen: round?.a, botToken });
    return;
  }

  // Fill THIS round's answer (targeted, transactional). If a concurrent click /
  // typed reply already filled it, this is a no-op and we don't double-record.
  const tx = await mutateRecord(path, (cur) => {
    if (cur.ticketCreated) return cur;
    const rounds = Array.isArray(cur.rounds) ? cur.rounds.map(r => ({ ...r })) : [];
    const r = rounds[roundIndex];
    if (!r || r.a != null) return cur; // already answered → no change
    r.a = answer;
    return { ...cur, rounds };
  });
  const recorded = tx.snapshot?.rounds?.[roundIndex]?.a === answer;

  if (msgTs) await disableButtons({ channel, msgTs, question: round.q, chosen: answer, botToken });

  // Only advance if WE recorded the answer (avoid double-triage on a race;
  // triage is idempotent-ish but this keeps it clean).
  if (recorded) await triage({ rootTs, channel, botToken });
}

// Replace the question message with the chosen answer and no buttons, so it
// can't be clicked again.
async function disableButtons({ channel, msgTs, question, chosen, botToken }) {
  const q = toSlackMrkdwn(question || "");
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: q } },
    { type: "context", elements: [{ type: "mrkdwn", text: chosen ? `✅ Answered: *${chosen}*` : "_Answered._" }] },
  ];
  await slackUpdateMessage({ channel, ts: msgTs, text: q, blocks, botToken }).catch(() => {});
}
