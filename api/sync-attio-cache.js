// api/sync-attio-cache.js
// Vercel Cron: nightly Attio sync. Replaces both the Founders manual
// "Refresh from Attio" button and the Nurture tab's source data so they
// stay in sync. Also performs the Nurture quoted_at backfill: every
// deal currently in the Quoted stage that has no /nurture/quotedAt/{id}
// entry gets one set to the deal's updated_at as a starting point.
// Real-time stage transitions go through api/nurture-stage-webhook.js.
//
// Schedule: see vercel.json — runs nightly + can be POSTed manually
// via the Nurture tab's "Refresh from Attio" button with founder auth.

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { computeFoundersMetrics } from "./_attio-metrics.js";
import { requireRole, sendAuthError } from "./_requireAuth.js";

const FB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FB_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FB_URL}${path}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FB_URL}${path}.json`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

function getStage(deal) {
  const v = deal?.values || {};
  const cands = [v.stage, v.status, v.deal_stage, v.pipeline_stage];
  for (const c of cands) {
    const t = c?.[0]?.status?.title || c?.[0]?.value;
    if (t) return typeof t === "string" ? t : "";
  }
  return "";
}
function dealRecordId(deal) {
  return deal?.id?.record_id || deal?.id || "";
}

export default async function handler(req, res) {
  if (req.method === "GET" && req.headers["x-vercel-cron"] !== "1") {
    return res.status(401).json({ error: "Cron header required" });
  }
  if (req.method === "POST") {
    try {
      await requireRole(req, ["founders", "founder"]);
    } catch (e) {
      return sendAuthError(res, e);
    }
  } else if (req.method !== "GET") {
    return res.status(405).json({ error: "GET cron or POST manual only" });
  }

  // Allow GET (Vercel cron) and POST (manual trigger from Nurture tab)
  const isManual = req.method === "POST";
  const trigger = isManual ? "manual" : "cron";

  const ATTIO_KEY = process.env.ATTIO_API_KEY;
  if (!ATTIO_KEY) return res.status(500).json({ error: "ATTIO_API_KEY missing" });

  const headers = { Authorization: `Bearer ${ATTIO_KEY}`, "Content-Type": "application/json" };

  try {
    // 1. Fetch all deals (paginated, cap 1000 to match existing /api/attio)
    let allDeals = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;
    while (hasMore) {
      const r = await fetch("https://api.attio.com/v2/objects/deals/records/query", {
        method: "POST",
        headers,
        body: JSON.stringify({ limit, offset, sorts: [{ attribute: "created_at", direction: "desc" }] }),
      });
      const d = await r.json();
      if (d?.data && d.data.length > 0) {
        allDeals = allDeals.concat(d.data);
        offset += d.data.length;
        hasMore = d.data.length === limit;
      } else {
        hasMore = false;
      }
      if (allDeals.length >= 1000) break;
    }

    const lastSyncedAt = new Date().toISOString();

    // 2. Write to /attioCache (same shape Founders + Nurture both read)
    await fbSet("/attioCache", {
      data: allDeals,
      total: allDeals.length,
      lastSyncedAt,
      lastSyncTrigger: trigger,
    });

    // 3. Recalculate Founders north-star metrics so the Founders tab also
    //    refreshes. Mirrors what Founders.syncAttio does on manual click.
    const m = computeFoundersMetrics(allDeals, new Date());
    const existing = (await fbGet("/foundersData")) || {};
    const merged = {
      ...existing,
      monthlyRevenue: m.monthlyRevenue || existing.monthlyRevenue,
      activeClients: m.activeClients || existing.activeClients,
      avgRetainerValue: m.avgRetainerValue || existing.avgRetainerValue,
      leadPipelineValue: m.leadPipelineValue || existing.leadPipelineValue,
      closingRate: m.closingRate || existing.closingRate,
    };
    if (m.ytdRevenue > 0) merged.currentRevenue = m.ytdRevenue;
    await fbPatch("/foundersData", merged);

    // 4. Backfill /nurture/quotedAt for every deal currently in Quoted
    //    that has no entry yet. Uses updated_at as the starting timestamp.
    //    The webhook (nurture-stage-webhook.js) sets accurate timestamps
    //    going forward; this is the safety-net for historical + missed
    //    transitions.
    const existingQuotedAt = (await fbGet("/nurture/quotedAt")) || {};
    const backfillBatch = {};
    let backfilled = 0;
    for (const deal of allDeals) {
      const stage = getStage(deal);
      if (stage !== "Quoted") continue;
      const id = dealRecordId(deal);
      if (!id || existingQuotedAt[id]) continue;
      const ts = deal.updated_at || deal.created_at || lastSyncedAt;
      backfillBatch[id] = { timestamp: ts, source: "backfill", recordedAt: lastSyncedAt };
      backfilled++;
    }
    if (Object.keys(backfillBatch).length) {
      await fbPatch("/nurture/quotedAt", backfillBatch);
    }

    return res.status(200).json({
      ok: true,
      trigger,
      dealsSynced: allDeals.length,
      quotedAtBackfilled: backfilled,
      lastSyncedAt,
    });
  } catch (e) {
    console.error("sync-attio-cache error:", e);
    return res.status(500).json({ error: e.message });
  }
}
