// api/_sale-schedules.js
//
// Shared server-safe schedule helpers for Custom-videoType sales.
// Imported by both API endpoints (create-custom-sale, update-custom-schedule,
// charge-sale-balance, stripe-webhook, cron/sales-daily) and the React UI
// (Sale.jsx, SalePublicView.jsx via re-export from src/utils.js).
//
// Source of truth on Custom sales is `sale.customSlices[]`. The
// `sale.schedule[]` array is derived from it by buildCustomSchedule()
// and stored alongside so consumers that iterate `schedule[]` (webhook,
// public page, dashboard chips) work unchanged.
//
// Identity is `sliceId` (UUID-ish), NOT `idx`. Post-deposit edits can
// remove/insert pending rows, so the numeric index of a paid slice will
// shift. All merge, lookup, and Stripe-metadata operations must match
// on sliceId. `idx` is recomputed from array position on every rebuild
// for display ordering only.

import {
  GST_RATE,
  computeStripeSurcharge,
  CUSTOM_MIN_SLICES,
  CUSTOM_MAX_SLICES,
} from "./_tiers.js";

// ─── Helpers ───────────────────────────────────────────────────────

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function cents(n) {
  return Math.round(Number(n || 0) * 100);
}

// UUID-ish stable id for each custom slice. crypto.randomUUID() is
// available in Node 19+ and every modern browser; the fallback path
// covers older runtimes (some Vercel cold-starts on Node 18 used to
// trip this) and SSR test harnesses where crypto is undefined.
export function newSliceId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `s_${crypto.randomUUID()}`;
    }
  } catch {}
  // Fallback: timestamp + random — collision odds vanish at the scale we run.
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Format a Sydney-time YYYY-MM-DD key from an ISO/Date input. Used
// for cron filtering ("is this slice due today?") so comparisons stay
// timezone-correct without juggling raw timestamps.
export function sydneyDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// Human-readable Sydney date label for the public page schedule.
function sydneyDateLabel(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric", month: "short", year: "numeric",
  }).format(d);
}

// ─── Validation ────────────────────────────────────────────────────
//
// Returns { ok, errors[] }. Caller decides whether to render the
// errors inline (UI) or reject the request (API). Both code paths
// run the SAME validator so the UI's "save" button and the server's
// schema check can never disagree.
export function validateCustomSlices(slices, totalExGst) {
  const errors = [];
  const arr = Array.isArray(slices) ? slices : [];

  if (arr.length < CUSTOM_MIN_SLICES) {
    errors.push(`At least ${CUSTOM_MIN_SLICES} instalments required.`);
  }
  if (arr.length > CUSTOM_MAX_SLICES) {
    errors.push(`At most ${CUSTOM_MAX_SLICES} instalments allowed.`);
  }

  const ids = new Set();
  let sumCents = 0;
  let prevOffset = -1;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] || {};
    if (!s.sliceId || typeof s.sliceId !== "string") {
      errors.push(`Row ${i + 1}: missing sliceId.`);
    } else if (ids.has(s.sliceId)) {
      errors.push(`Row ${i + 1}: duplicate sliceId ${s.sliceId}.`);
    } else {
      ids.add(s.sliceId);
    }

    if (typeof s.label !== "string" || !s.label.trim()) {
      errors.push(`Row ${i + 1}: label required.`);
    }

    const amount = Number(s.amountExGst);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${i + 1}: amount must be greater than 0.`);
    } else {
      sumCents += cents(amount);
    }

    const offset = Number(s.offsetDays);
    if (!Number.isInteger(offset) || offset < 0) {
      errors.push(`Row ${i + 1}: offsetDays must be a non-negative integer.`);
    } else if (i === 0 && offset !== 0) {
      errors.push(`Row 1 (deposit) must have offsetDays: 0.`);
    } else if (i > 0 && offset <= prevOffset) {
      errors.push(`Row ${i + 1}: offsetDays must be strictly greater than row ${i}'s offset.`);
    } else {
      prevOffset = offset;
    }

    if (i === 0 && s.trigger !== "now") {
      errors.push(`Row 1 (deposit) must have trigger: "now".`);
    }
    if (i > 0 && s.trigger !== "auto" && s.trigger !== "manual") {
      errors.push(`Row ${i + 1}: trigger must be "auto" or "manual".`);
    }
  }

  const targetCents = cents(totalExGst);
  if (Number.isFinite(targetCents) && targetCents > 0 && sumCents !== targetCents) {
    errors.push(
      `Sum of instalments ($${(sumCents / 100).toFixed(2)} ex-GST) must equal total ex-GST ($${(targetCents / 100).toFixed(2)}).`
    );
  }

  return { ok: errors.length === 0, errors };
}

// ─── Seeding ───────────────────────────────────────────────────────
// Default starter rows the form shows when the founder first picks
// videoType: "custom". Two rows (deposit + balance at +6 weeks auto)
// — they can add/edit from there. Splits the total 50/50 if a total
// is already known.
export function seedCustomSlices(totalExGst = 0) {
  const total = Number(totalExGst) || 0;
  const half = round2(total / 2);
  const other = round2(total - half); // absorbs rounding
  return [
    {
      sliceId: newSliceId(),
      label: "Deposit",
      amountExGst: half,
      offsetDays: 0,
      trigger: "now",
    },
    {
      sliceId: newSliceId(),
      label: "Balance",
      amountExGst: other,
      offsetDays: 42,
      trigger: "auto",
    },
  ];
}

// ─── State merge ──────────────────────────────────────────────────
// Match by sliceId. For any existing slice that has moved money
// (paid, refunded, processing, or has a Stripe PI on it) — KEEP THE
// ENTIRE EXISTING ROW. Do not merge new fields into it; do not let a
// schedule rebuild overwrite paid metadata.
//
// For declined slices: preserve the decline-context fields but allow
// new amount/date/trigger from the rebuild so the founder can edit
// a failed instalment to fix it.
//
// For pending slices: replace entirely with the newly-derived row.
//
// idx is recomputed from array position on every call — display-only.
function isTerminalOrMoneyMoved(existing) {
  if (!existing) return false;
  if (existing.status === "paid" || existing.status === "refunded") return true;
  if (existing.status === "processing") return true;
  if (existing.stripePaymentIntentId) return true;
  return false;
}

export function mergeScheduleState(newSchedule, existingSchedule) {
  const existingById = new Map();
  for (const s of Array.isArray(existingSchedule) ? existingSchedule : []) {
    if (s && s.sliceId) existingById.set(s.sliceId, s);
  }

  return newSchedule.map((next, idx) => {
    const existing = next.sliceId ? existingById.get(next.sliceId) : null;
    if (!existing) {
      return { ...next, idx };
    }
    if (isTerminalOrMoneyMoved(existing)) {
      // Keep paid/refunded/processing rows verbatim. Only `idx`
      // updates to reflect new display ordering.
      return { ...existing, idx };
    }
    if (existing.status === "declined") {
      // Allow the rebuild's new amount/date/trigger/label to apply,
      // but carry the decline context forward so the dashboard chip
      // still surfaces "last decline at ..." and the retry button
      // doesn't lose its Stripe PI reference.
      return {
        ...next,
        idx,
        status: "declined",
        lastDeclineAt: existing.lastDeclineAt || null,
        lastDeclineMessage: existing.lastDeclineMessage || null,
        ...(existing.stripePaymentIntentId
          ? { stripePaymentIntentId: existing.stripePaymentIntentId }
          : {}),
      };
    }
    // Pending — replace fully.
    return { ...next, idx };
  });
}

// ─── buildCustomSchedule ───────────────────────────────────────────
//
// Derive `sale.schedule[]` from `sale.customSlices[]`.
//
// Inputs:
//   customSlices         — founder rows: { sliceId, label, amountExGst, offsetDays, trigger }
//   depositAnchorDate    — Date|string|null. The anchor for offsetDays.
//                          - On creation (no deposit paid yet): pass `new Date()` so
//                            dueAt is a *projected* date based on today.
//                          - After deposit clears: pass sale.depositPaidAt so dueAt
//                            re-anchors to the real deposit-paid date.
//   existingSchedule     — sale.schedule (if any). Used for state merge.
//
// Output: schedule[] in the same shape buildSchedule() returns, plus
// the carried `sliceId` and `offsetDays` so downstream consumers can
// re-derive without looking at customSlices.
export function buildCustomSchedule(customSlices, { depositAnchorDate, existingSchedule } = {}) {
  const slices = Array.isArray(customSlices) ? customSlices : [];
  const anchor = depositAnchorDate ? new Date(depositAnchorDate) : new Date();
  const validAnchor = !Number.isNaN(anchor.getTime()) ? anchor : new Date();

  // Sum of ex-GST amounts (cents) — used to compute proportional GST
  // per slice + absorb rounding on the final row so the cents sum
  // matches grandTotal exactly.
  const exCentsList = slices.map(s => cents(s.amountExGst));
  const totalExCents = exCentsList.reduce((a, b) => a + b, 0);
  const totalExGst = totalExCents / 100;
  const grandTotal = round2(totalExGst * (1 + GST_RATE));
  const grandTotalCents = cents(grandTotal);

  // Distribute grandTotal across slices proportionally to exGst share,
  // then patch the final slice so the sum lands exactly on grandTotal.
  const projectAmounts = [];
  let cumulative = 0;
  for (let i = 0; i < slices.length; i++) {
    if (i < slices.length - 1) {
      const ratio = totalExCents > 0 ? exCentsList[i] / totalExCents : 0;
      const cAmount = Math.round(grandTotalCents * ratio);
      projectAmounts.push(cAmount / 100);
      cumulative += cAmount;
    } else {
      // Final slice: absorbs rounding so Σ projectAmount === grandTotal.
      projectAmounts.push((grandTotalCents - cumulative) / 100);
    }
  }

  const built = slices.map((s, i) => {
    const offsetDays = Number(s.offsetDays) || 0;
    const trigger = s.trigger === "now" ? "now"
                  : s.trigger === "auto" ? "auto"
                  : "manual";

    const due = new Date(validAnchor.getTime());
    due.setDate(due.getDate() + offsetDays);
    const dueAt = due.toISOString();
    const dueDateKeySydney = sydneyDateKey(due);
    let dueLabel = "";
    if (trigger === "now") {
      dueLabel = "Today";
    } else {
      dueLabel = sydneyDateLabel(due);
    }

    const projectAmount = round2(projectAmounts[i] || 0);
    const surcharge = computeStripeSurcharge(projectAmount);
    const amount = round2(projectAmount + surcharge);

    return {
      sliceId: s.sliceId,
      idx: i, // recomputed on merge too
      label: String(s.label || "").trim() || `Payment ${i + 1}`,
      trigger,
      pct: totalExCents > 0 ? round2((exCentsList[i] / totalExCents) * 100) : 0,
      projectAmount,
      surcharge,
      amount,
      offsetDays,
      dueAt,
      dueDateKeySydney,
      dueLabel,
      status: "pending",
    };
  });

  return mergeScheduleState(built, existingSchedule);
}

// Sum of grand-total cents across a custom slices array. Useful for the
// UI live-indicator and for server-side total checks. Returns ex-GST
// dollars; multiply by 1.10 elsewhere for grand total.
export function sumCustomSlicesExGst(customSlices) {
  const arr = Array.isArray(customSlices) ? customSlices : [];
  return round2(arr.reduce((s, x) => s + (Number(x.amountExGst) || 0), 0));
}

// ─── Day/week display helpers ──────────────────────────────────────
//
// offsetDays is the persisted source of truth — we never serialise
// "weeks" to Firebase. The editor needs a unit to render against, so:
//
//   1. Honour an explicit `offsetUnit` on the row when set (the UI
//      stores this row-locally so toggling the dropdown takes effect
//      immediately, even before save).
//   2. Otherwise, auto-detect: if offsetDays is a clean multiple of 7,
//      show weeks; otherwise show days. This stops a 45-day offset
//      being silently displayed as "6 wks" (= 42 days) on reopen
//      after the server roundtrip strips the row-local unit hint.
export function displayOffsetUnit(row) {
  if (row?.offsetUnit === "days") return "days";
  if (row?.offsetUnit === "weeks") return "weeks";
  const days = Number(row?.offsetDays) || 0;
  return days > 0 && days % 7 !== 0 ? "days" : "weeks";
}

export function displayOffsetValue(row) {
  const days = Number(row?.offsetDays) || 0;
  if (displayOffsetUnit(row) === "days") return Math.max(1, days);
  // Weeks branch — caller guaranteed offsetDays is a clean multiple,
  // either via offsetUnit==="weeks" (set by founder) or via the
  // multiple-of-7 auto-detect above.
  return Math.max(1, Math.round(days / 7));
}
