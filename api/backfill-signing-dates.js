// api/backfill-signing-dates.js
// ONE-OFF maintenance endpoint. NOT a cron, NOT in vercel.json — it only runs
// when a founder explicitly POSTs to it, never on its own.
//
// Fills the Accounts "Signing" milestone for historical accounts that never
// got one. Going forward, api/webhook-deal-won.js sets `signing` in real time
// when a deal is won; this is the one-time catch-up for accounts that predate
// the webhook (or whose webhook never fired). Idempotent: it only writes
// signing where it is currently blank, so it never overwrites a date a
// producer typed in, and re-running it is a safe no-op.
//
// Matches accounts to deals by attioId (the company record_id the webhook and
// the old sync both store). Manual accounts with no attioId can't be matched
// to an Attio deal and are reported as skipped so they can be filled by hand.
//
// Returns a JSON report of exactly what it changed.

import { adminGet, adminPatch, getAdmin } from "./_fb-admin.js";
import { requireRole, sendAuthError, setCors, handleOptions } from "./_requireAuth.js";

const FB_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

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

// ── Close-date resolution (same logic as the /api/attio currentCustomers
// helper): probe the common close / won-date attribute slugs, fall back to the
// deal's system created_at, and resolve to a Sydney calendar date so a
// late-UTC-evening close doesn't land a day early. ──
const CLOSE_DATE_SLUGS = ["close_date", "closed_date", "won_date", "date_won", "signing_date", "signed_date", "won_on", "close"];

function toSydneyDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(d);
  } catch {
    return String(iso).slice(0, 10);
  }
}

function dealRawDate(deal) {
  const v = deal?.values || {};
  for (const slug of CLOSE_DATE_SLUGS) {
    const cell = Array.isArray(v[slug]) ? v[slug][0] : v[slug];
    const raw = cell?.value || cell?.date || (typeof cell === "string" ? cell : null);
    if (raw) return raw;
  }
  return deal?.created_at || (Array.isArray(v.created_at) ? v.created_at[0]?.value : null) || null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only (one-off founder maintenance trigger)" });

  try {
    await requireRole(req, ["founders", "manager"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const ATTIO_KEY = process.env.ATTIO_API_KEY;
  if (!ATTIO_KEY) return res.status(500).json({ error: "ATTIO_API_KEY missing" });
  const headers = { Authorization: `Bearer ${ATTIO_KEY}`, "Content-Type": "application/json" };

  try {
    // 1. Fetch all deals (paginate, cap 1000 — matches /api/attio + the cron).
    let allDeals = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;
    while (hasMore) {
      const r = await fetch("https://api.attio.com/v2/objects/deals/records/query", {
        method: "POST", headers,
        body: JSON.stringify({ limit, offset, sorts: [{ attribute: "created_at", direction: "desc" }] }),
      });
      const d = await r.json();
      if (d?.data && d.data.length > 0) {
        allDeals = allDeals.concat(d.data);
        offset += d.data.length;
        hasMore = d.data.length === limit;
      } else { hasMore = false; }
      if (allDeals.length >= 1000) break;
    }

    // 2. company record_id -> earliest deal date (the signing anchor).
    //    Earliest, not latest, so a later upsell deal can't move the anchor.
    const closeDateMap = {};
    for (const deal of allDeals) {
      const companyRef = deal.values?.associated_company;
      const companyId = Array.isArray(companyRef) && companyRef[0]
        ? companyRef[0].target_record_id
        : (companyRef?.target_record_id || null);
      if (!companyId) continue;
      const resolved = toSydneyDate(dealRawDate(deal));
      if (!resolved) continue;
      if (!closeDateMap[companyId] || resolved < closeDateMap[companyId]) closeDateMap[companyId] = resolved;
    }

    // 3. Walk /accounts and stage a backfill for every account whose Signing
    //    date is blank. One fan-out write at the end so a large roster can't
    //    blow the function timeout with hundreds of sequential patches.
    const accounts = (await fbGet("/accounts")) || {};
    const batch = {};
    const backfilled = [];
    const skippedNoAttio = [];
    const skippedNoDeal = [];
    let skippedHasDate = 0;
    let total = 0;

    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct || typeof acct !== "object") continue;
      total++;
      const name = acct.companyName || id;
      if (acct.milestones?.signing?.date) { skippedHasDate++; continue; }
      const attioId = acct.attioId || "";
      if (!attioId) { skippedNoAttio.push(name); continue; }
      const date = closeDateMap[attioId];
      if (!date) { skippedNoDeal.push(name); continue; }
      // Leaf path per account, so this preserves any sibling milestones and
      // any existing signing.status; it only sets date + status.
      batch[`${id}/milestones/signing`] = { date, status: "Completed" };
      backfilled.push({ name, date });
    }

    if (Object.keys(batch).length) await fbPatch("/accounts", batch);

    return res.status(200).json({
      ok: true,
      dealsScanned: allDeals.length,
      totalAccounts: total,
      backfilledCount: backfilled.length,
      backfilled,
      skippedHasDate,
      skippedNoAttio,
      skippedNoDeal,
    });
  } catch (e) {
    console.error("backfill-signing-dates error:", e);
    return res.status(500).json({ error: e.message });
  }
}
