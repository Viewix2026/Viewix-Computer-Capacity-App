// api/nurture-stage-webhook.js
// Real-time Attio (via Zapier) stage-change receiver.
//
// Wire-up (Zapier zap):
//   Trigger:  Attio → "Updated Record" on the deals object
//   Filter:   only continue if Stage equals "Quoted"
//   Action:   Webhook POST to https://<vercel>/api/nurture-stage-webhook
//             body JSON: { dealId, secret, stage }  (companyName optional)
//
// On receipt: stamp /nurture/quotedAt/{dealId} with the current ISO time,
// source "webhook", IF the deal has no entry yet (avoids overwriting an
// older accurate timestamp on a re-fire).

import { adminGet, adminPatch, getAdmin } from "./_fb-admin.js";

const FB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const SECRET = process.env.ATTIO_NURTURE_WEBHOOK_SECRET;

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FB_URL}${path}.json`);
  return r.json();
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FB_URL}${path}.json`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = (Array.isArray(req.body) ? req.body[0] : req.body) || {};
    // Tolerate common Zapier field-naming variants. Order = preference.
    const dealId = body.dealId || body.dealid || body["Deal ID"] || body.deal_id || body.recordId || body["Record Id"];
    const stage = body.stage || body.Stage || body.satge;
    const secret = body.secret || body.Secret;
    const companyName = body.companyName || body.company_name || body["Company Name"] || null;
    if (!SECRET) return res.status(500).json({ error: "ATTIO_NURTURE_WEBHOOK_SECRET not configured" });
    if (secret !== SECRET) return res.status(401).json({ error: "Invalid secret" });
    if (!dealId) return res.status(400).json({ error: "dealId is required", receivedKeys: Object.keys(body) });

    // Soft guard: only act on Quoted-stage transitions. Zapier should
    // already filter, but if the zap fires on every update we can drop
    // the noise here.
    if (stage && stage !== "Quoted") {
      return res.status(200).json({ ok: true, skipped: `stage is ${stage}, not Quoted` });
    }

    const existing = (await fbGet(`/nurture/quotedAt/${dealId}`)) || null;
    if (existing?.timestamp) {
      return res.status(200).json({ ok: true, skipped: "already stamped", existing });
    }

    const stamp = {
      timestamp: new Date().toISOString(),
      source: "webhook",
      recordedAt: new Date().toISOString(),
      companyName: companyName || null,
    };
    await fbPatch(`/nurture/quotedAt`, { [dealId]: stamp });

    return res.status(200).json({ ok: true, dealId, stamp });
  } catch (e) {
    console.error("nurture-stage-webhook error:", e);
    return res.status(500).json({ error: e.message });
  }
}
