// api/update-custom-schedule.js
//
// Founder-only endpoint for editing a Custom sale's schedule. Use cases:
//   - Pre-deposit: tweaking amounts, dates, or triggers before the
//     client pays the deposit.
//   - Post-deposit: client asks "can we push instalment 2 back two
//     weeks?". Slice 0 (deposit) is locked once paid; any other
//     non-paid slice can be edited.
//
// Rules:
//   - Founders only.
//   - sale must exist and be videoType === "custom".
//   - The client sends the FULL new customSlices[] array. Every
//     existing sliceId that maps to a paid/refunded/processing slice
//     must arrive unchanged in label/amount/offset/trigger.
//   - totalExGst is immutable (sum-of-slices must equal sale.totalExGst).
//   - Server rebuilds schedule[] via buildCustomSchedule(), which
//     calls mergeScheduleState() to keep terminal rows verbatim.
//   - Bumps customScheduleVersion.
//
// Returns: 200 { ok: true, sale }.

import { adminGet, adminPatch } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";
import {
  validateCustomSlices,
  buildCustomSchedule,
  sumCustomSlicesExGst,
} from "./_sale-schedules.js";
import { GST_RATE } from "./_tiers.js";

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function cents(n) {
  return Math.round(Number(n || 0) * 100);
}

function isTerminal(s) {
  if (!s) return false;
  if (s.status === "paid" || s.status === "refunded" || s.status === "processing") return true;
  if (s.stripePaymentIntentId) return true;
  return false;
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
    const saleId = String(body.saleId || "").trim();
    if (!saleId) return res.status(400).json({ error: "saleId required" });
    const incomingSlices = Array.isArray(body.customSlices) ? body.customSlices : [];

    const sale = await adminGet(`/sales/${saleId}`);
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.videoType !== "custom") {
      return res.status(400).json({ error: "Sale is not videoType 'custom'" });
    }

    // totalExGst is immutable
    const targetCents = cents(sale.totalExGst);
    const sumCents = incomingSlices.reduce((s, x) => s + cents(x.amountExGst), 0);
    if (targetCents !== sumCents) {
      return res.status(400).json({
        error: `Sum of slices must equal sale total (target $${(targetCents / 100).toFixed(2)}, got $${(sumCents / 100).toFixed(2)}). Total ex-GST cannot change.`,
      });
    }

    // Build existing-slice index by sliceId for the unchanged-paid check
    const existingScheduleById = new Map();
    for (const s of Array.isArray(sale.schedule) ? sale.schedule : []) {
      if (s && s.sliceId) existingScheduleById.set(s.sliceId, s);
    }
    const existingCustomById = new Map();
    for (const s of Array.isArray(sale.customSlices) ? sale.customSlices : []) {
      if (s && s.sliceId) existingCustomById.set(s.sliceId, s);
    }

    // BEFORE everything else: ensure no terminal slice has been DELETED.
    // The previous version only validated terminal slices that were
    // PRESENT in the incoming payload — a malicious or buggy client
    // could omit a paid slice entirely, and buildCustomSchedule()
    // would happily rebuild without it (merge only preserves matching
    // sliceIds). Catch this here, before we touch anything.
    const incomingIds = new Set(incomingSlices.map(s => String(s.sliceId || "").trim()).filter(Boolean));
    for (const [sliceId, existingSched] of existingScheduleById) {
      if (isTerminal(existingSched) && !incomingIds.has(sliceId)) {
        return res.status(400).json({
          error: `Slice "${existingSched.label || sliceId}" has already moved money (status=${existingSched.status}). It cannot be removed.`,
        });
      }
    }

    // Normalise incoming rows (preserve sliceIds — they're the merge key).
    const customSlices = incomingSlices.map((s) => ({
      sliceId: String(s.sliceId || "").trim(),
      label: String(s.label || "").trim(),
      amountExGst: round2(s.amountExGst),
      offsetDays: Math.max(0, parseInt(s.offsetDays, 10) || 0),
      trigger: s.trigger === "now" ? "now" : s.trigger === "manual" ? "manual" : "auto",
    }));

    const validation = validateCustomSlices(customSlices, sale.totalExGst);
    if (!validation.ok) {
      return res.status(400).json({ error: "Invalid custom schedule", details: validation.errors });
    }

    // Reject edits to any slice that has moved money. Compare every
    // mutable field on the original customSlices row (the source of
    // truth) — schedule[] is derived and could diverge harmlessly.
    for (const incoming of customSlices) {
      const existingSched = existingScheduleById.get(incoming.sliceId);
      const existingCustom = existingCustomById.get(incoming.sliceId);
      if (existingSched && isTerminal(existingSched)) {
        const before = existingCustom || {};
        const changed =
          before.label !== incoming.label ||
          cents(before.amountExGst) !== cents(incoming.amountExGst) ||
          (parseInt(before.offsetDays, 10) || 0) !== incoming.offsetDays ||
          (before.trigger || "auto") !== incoming.trigger;
        if (changed) {
          return res.status(400).json({
            error: `Slice "${incoming.label || incoming.sliceId}" has already moved money (status=${existingSched.status}). It cannot be edited.`,
          });
        }
      }
    }

    // Anchor: deposit-paid if it's cleared, otherwise today (projection).
    const anchor = sale.depositPaidAt ? new Date(sale.depositPaidAt) : new Date();

    const schedule = buildCustomSchedule(customSlices, {
      depositAnchorDate: anchor,
      existingSchedule: sale.schedule || [],
    });

    const nextVersion = (Number(sale.customScheduleVersion) || 0) + 1;
    await adminPatch(`/sales/${saleId}`, {
      customSlices,
      schedule,
      customScheduleVersion: nextVersion,
      // Recompute totals from the source of truth even though they
      // should match — protects against the (impossible) drift.
      totalExGst: sale.totalExGst,
      gstAmount: round2(sale.totalExGst * GST_RATE),
      grandTotal: round2(sale.totalExGst * (1 + GST_RATE)),
    });

    const updated = await adminGet(`/sales/${saleId}`);
    return res.status(200).json({ ok: true, sale: updated });
  } catch (e) {
    console.error("update-custom-schedule error:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
