// api/create-custom-sale.js
//
// Founder-only endpoint that mints a Custom-videoType sale record.
// Preset sales still write to /sales directly from the dashboard
// (open Firebase rules allow it for any signed-in user). Custom sales
// gate creation here because:
//   1. Founder-only — Firebase rules don't enforce role.
//   2. Server re-assigns sliceIds and re-derives schedule[] so the
//      client can't supply paid/refunded metadata or mismatched
//      amounts.
//   3. Future-proofing — same pattern when we lock preset creation
//      behind a server endpoint too.
//
// Auth: bearer token verified by requireRole(["founders", "founder"]).
// Returns: 200 { ok: true, sale } with the freshly-written record.

import { adminGet, adminSet } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import {
  newSliceId,
  validateCustomSlices,
  buildCustomSchedule,
  sumCustomSlicesExGst,
} from "./_sale-schedules.js";
import { GST_RATE } from "./_tiers.js";

const SHORT_ID_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
function makeShortId(length = 10) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SHORT_ID_CHARS[Math.floor(Math.random() * SHORT_ID_CHARS.length)];
  }
  return out;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await requireRole(req, ["founders", "founder"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  try {
    const body = req.body || {};
    const clientName = String(body.clientName || "").trim();
    if (!clientName) return res.status(400).json({ error: "clientName required" });

    const logoUrl = String(body.logoUrl || "").trim();
    const scopeNotes = String(body.scopeNotes || "").trim();
    const incomingSlices = Array.isArray(body.customSlices) ? body.customSlices : [];

    // Re-assign sliceIds server-side — we never trust client ids on
    // creation (no risk of spoofing a future-edit collision).
    const customSlices = incomingSlices.map(s => ({
      sliceId: newSliceId(),
      label: String(s.label || "").trim(),
      amountExGst: round2(s.amountExGst),
      offsetDays: Math.max(0, parseInt(s.offsetDays, 10) || 0),
      trigger: s.trigger === "now" ? "now" : s.trigger === "manual" ? "manual" : "auto",
    }));

    // Derive totalExGst from the rows themselves — never trust the
    // body field, even though the form sends it. validateCustomSlices()
    // will fail loudly if the rows don't sum to a positive total.
    const totalExGst = sumCustomSlicesExGst(customSlices);
    const validation = validateCustomSlices(customSlices, totalExGst);
    if (!validation.ok) {
      return res.status(400).json({ error: "Invalid custom schedule", details: validation.errors });
    }

    const gstAmount = round2(totalExGst * GST_RATE);
    const grandTotal = round2(totalExGst + gstAmount);

    // Schedule anchored to today as a projection — the deposit's
    // actual paidAt re-anchors via the stripe-webhook when it lands.
    const schedule = buildCustomSchedule(customSlices, { depositAnchorDate: new Date() });

    const id = `sale-${Date.now()}`;
    // Guard: extremely unlikely collision (timestamp granularity), but
    // refuse to overwrite an existing /sales/{id} just in case.
    const existing = await adminGet(`/sales/${id}`);
    if (existing) {
      return res.status(409).json({ error: "id collision — retry" });
    }

    const sale = {
      id,
      shortId: makeShortId(),
      videoType: "custom",
      packageKey: "custom",
      isCustom: true,
      clientName,
      logoUrl,
      scopeNotes,
      totalExGst,
      gstAmount,
      grandTotal,
      customSlices,
      customScheduleVersion: 1,
      schedule,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionScheduleId: null,
      paid: false,
      depositPaidAt: null,
      createdAt: new Date().toISOString(),
    };

    await adminSet(`/sales/${id}`, sale);
    return res.status(200).json({ ok: true, sale });
  } catch (e) {
    console.error("create-custom-sale error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
