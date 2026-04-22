// api/inspect-sales.js
// ONE-SHOT DIAGNOSTIC — list every sale's id, shortId, clientName, paid state.
// Delete this file once the w5gss6-not-found mystery is resolved.
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
      depositAmount: s?.depositAmount || null,
      createdAt: s?.createdAt || null,
    }));
    res.status(200).json({ ok: true, count: records.length, records });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
