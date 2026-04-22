// api/inspect-sales.js
// One-shot diagnostic — list every sale's key, id, shortId,
// clientName, paid state, and schedule presence. Delete once the
// j3egt8-not-found mystery is resolved.
//
// Usage: curl https://planner.viewix.com.au/api/inspect-sales

import { adminGet } from "./_fb-admin.js";

export default async function handler(req, res) {
  try {
    const sales = await adminGet("/sales");
    if (!sales) {
      return res.status(200).json({ ok: true, count: 0, records: [], note: "/sales is empty or missing" });
    }
    const records = Object.entries(sales).map(([key, s]) => ({
      key,
      id: s?.id || null,
      shortId: s?.shortId || null,
      clientName: s?.clientName || null,
      paid: !!s?.paid,
      hasSchedule: Array.isArray(s?.schedule) && s.schedule.length > 0,
      firstSliceStatus: s?.schedule?.[0]?.status || null,
      totalExGst: s?.totalExGst ?? null,
      grandTotal: s?.grandTotal ?? null,
      createdAt: s?.createdAt || null,
    }));
    records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    res.status(200).json({ ok: true, count: records.length, records });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
