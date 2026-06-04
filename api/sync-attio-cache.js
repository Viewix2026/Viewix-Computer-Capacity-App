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
import { isAuthorizedCron } from "./_cronAuth.js";
import { buildDealIndex, resolveDeal, extractPersonEmail, extractPersonFirstName } from "../shared/attio-extract.js";

// Cap on per-id Attio people GETs in a single run. The clientContact backfill
// fetches one person record per project that still lacks a client email; on the
// first historical run hundreds could qualify, which would blow the cron's time
// budget. Bound it and let the backlog converge over a few nights (idempotent).
const MAX_PEOPLE_FETCH_PER_RUN = 50;

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

// Resolve an ISO timestamp to a Sydney calendar date (YYYY-MM-DD). lastContact
// is date-only and the team operates in Australia/Sydney, so a naive UTC slice
// would land an early-morning interaction on the previous day.
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

// Most recent client touchpoint for a company, as a Sydney date. Attio
// "interaction" attributes serialise as an array whose cell carries
// `interacted_at` (ISO). `last_interaction` is already the rolled-up latest
// across channels; the email/calendar slugs are probed as a fallback and the
// max is taken so a missing rollup can't blank an account that clearly has
// activity. Returns "" when the company has no logged interaction at all.
const LAST_INTERACTION_SLUGS = ["last_interaction", "last_email_interaction", "last_calendar_interaction"];
function lastInteractionDate(company) {
  const v = company?.values || {};
  let best = "";
  for (const slug of LAST_INTERACTION_SLUGS) {
    const cell = Array.isArray(v[slug]) ? v[slug][0] : v[slug];
    const raw = cell?.interacted_at || cell?.value || cell?.date || (typeof cell === "string" ? cell : null);
    const date = toSydneyDate(raw);
    if (date && date > best) best = date;
  }
  return best;
}

export default async function handler(req, res) {
  if (req.method === "GET" && !isAuthorizedCron(req).ok) {
    return res.status(401).json({ error: "Cron header required" });
  }
  if (req.method === "POST") {
    try {
      await requireRole(req, ["founders", "manager"]);
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

    // 5. Backfill empty clientName across projects + cascade to the
    //    related records (delivery, account, preproduction). /accounts
    //    is already the local mirror of Attio companies (each entry
    //    has attioId + companyName, populated by webhook-deal-won when
    //    each deal was first won), so we use it as the source of
    //    truth here rather than making additional Attio company calls.
    //    Idempotent — only patches records currently lacking the field.
    const accountsMap = (await fbGet("/accounts")) || {};
    const accountById = new Map();
    const accountByAttioId = new Map();
    const accountsByNameLength = []; // sorted longest-first for prefix match
    for (const a of Object.values(accountsMap)) {
      if (!a || !a.id) continue;
      accountById.set(a.id, a);
      if (a.attioId) accountByAttioId.set(a.attioId, a);
      if (a.companyName) accountsByNameLength.push(a);
    }
    // Longest companyName first so e.g. "Jamieson Group" wins over a
    // hypothetical "Jamieson" account when projectName starts with the
    // longer one. Avoids false-matches on similar-name accounts.
    accountsByNameLength.sort((a, b) => (b.companyName || "").length - (a.companyName || "").length);
    const projectsObj = (await fbGet("/projects")) || {};
    const projects = Object.values(projectsObj).filter(p => p && p.id);
    let projectsBackfilled = 0;
    let deliveriesBackfilled = 0;
    let accountsBackfilled = 0;
    let preprodBackfilled = 0;
    let projectsAccountLinked = 0;
    for (const p of projects) {
      if (p.clientName) continue;
      // Prefer the account record reachable via links.accountId;
      // fall back to the Attio company id stamped on the project for
      // older records that didn't capture an accountId at win-time;
      // last-resort: scan accounts and check if the projectName starts
      // with any account's companyName (case-insensitive). This catches
      // legacy records like "Holahealth Social Retainer Package month 2"
      // where the client name is embedded in the project name but no
      // accountId / attioCompanyId link was ever stored. When this
      // path matches, ALSO write links.accountId so the row inherits
      // the account's manager / project lead going forward.
      const acctId = (p.links || {}).accountId;
      let resolved = null;
      let linkAccountId = null;
      if (acctId && accountById.has(acctId) && accountById.get(acctId).companyName) {
        resolved = accountById.get(acctId).companyName;
      } else if (p.attioCompanyId && accountByAttioId.has(p.attioCompanyId)) {
        const matched = accountByAttioId.get(p.attioCompanyId);
        resolved = matched.companyName;
        if (!acctId) linkAccountId = matched.id;
      } else if (p.projectName) {
        const lcName = p.projectName.toLowerCase();
        for (const a of accountsByNameLength) {
          const lcCompany = a.companyName.toLowerCase();
          if (lcName.startsWith(lcCompany)) {
            resolved = a.companyName;
            if (!acctId) linkAccountId = a.id;
            break;
          }
        }
      }
      if (!resolved) continue;
      const projectPatch = { clientName: resolved, updatedAt: lastSyncedAt };
      if (linkAccountId) {
        projectPatch.links = { ...(p.links || {}), accountId: linkAccountId };
        projectsAccountLinked++;
      }
      await fbPatch(`/projects/${p.id}`, projectPatch);
      projectsBackfilled++;
      // Cascade — same name lands on every related record that's still
      // missing it. Only patches when the field is genuinely empty so
      // we don't clobber a producer's manual override.
      const delId = (p.links || {}).deliveryId;
      if (delId) {
        const del = await fbGet(`/deliveries/${delId}`);
        if (del && !del.clientName) {
          await fbPatch(`/deliveries/${delId}`, { clientName: resolved });
          deliveriesBackfilled++;
        }
      }
      if (acctId && accountById.has(acctId)) {
        const a = accountById.get(acctId);
        if (!a.companyName) {
          await fbPatch(`/accounts/${a.id}`, { companyName: resolved });
          accountsBackfilled++;
        }
      }
      const preprodId = (p.links || {}).preprodId;
      const preprodType = (p.links || {}).preprodType;
      if (preprodId && preprodType) {
        const pp = await fbGet(`/preproduction/${preprodType}/${preprodId}`);
        if (pp && !pp.companyName) {
          await fbPatch(`/preproduction/${preprodType}/${preprodId}`, { companyName: resolved });
          preprodBackfilled++;
        }
      }
    }

    // 5b. Self-heal numberOfVideos + clientContact from the matched Attio Won
    //     deal. Both should arrive via webhook-deal-won at win-time but are
    //     frequently missing (Zapier didn't map them, or the deal had no value /
    //     associated person then). ADDITIVE-ONLY: fills a blank, never overrides
    //     — a producer edit or any present value always survives. Runs in its
    //     OWN loop over all projects (NOT inside the step-5 clientName guard,
    //     which early-exits on projects that already have a clientName — i.e.
    //     most of them, exactly the ones that may still need these fields).
    let numberOfVideosBackfilled = 0;
    let clientContactBackfilled = 0;
    let peopleFetched = 0;
    let clientContactRemaining = 0;
    try {
      // includeZeroValue: a footage-only ($0) Won deal still carries a real
      // video count + client, which the default value>0 gate would hide.
      const dealIndex = buildDealIndex({ data: allDeals }, { includeZeroValue: true });

      // Carry-across claim guard (separate from profitability's value-gated
      // attioClaimCounts): a deal confidently claimed by >1 project is
      // ambiguous for ALL of them, so we never copy one deal's data onto two
      // same-named projects.
      const dealClaimCounts = new Map();
      for (const p of projects) {
        const m = resolveDeal(p, dealIndex);
        if (m && m.dealId && !m.ambiguous) {
          dealClaimCounts.set(m.dealId, (dealClaimCounts.get(m.dealId) || 0) + 1);
        }
      }
      const claimedOnce = (dealId) => dealId && dealClaimCounts.get(dealId) === 1;

      // Pass A: numberOfVideos (write immediately) + collect clientContact work.
      const needsContact = []; // { projectId, personId }
      for (const p of projects) {
        const m = resolveDeal(p, dealIndex);
        if (!m || m.ambiguous || !claimedOnce(m.dealId)) continue;
        const entry = m.entry;

        // numberOfVideos — only when the project's value is genuinely blank
        // (== null catches null + undefined; an explicit 0 is "set", skipped).
        if (p.numberOfVideos == null && entry.numberOfVideos != null) {
          // Re-read the leaf right before writing so a producer edit landing
          // between the snapshot and now is never clobbered.
          const live = await fbGet(`/projects/${p.id}/numberOfVideos`).catch(() => null);
          if (live == null) {
            await fbPatch(`/projects/${p.id}`, { numberOfVideos: entry.numberOfVideos, updatedAt: lastSyncedAt });
            numberOfVideosBackfilled++;
          }
        }

        // clientContact email — queue the deal's single associated person
        // (entry.personId is null for zero/>1-person deals, so we never guess).
        const emailBlank = !((p.clientContact?.email || "").trim());
        if (emailBlank && entry.personId) {
          needsContact.push({ projectId: p.id, personId: entry.personId });
        }
      }

      // Fetch distinct people, bounded + per-id isolated so one failure skips
      // only that person and never writes a partial/wrong address.
      const personCache = new Map(); // personId -> { email, firstName } | null
      const distinctPersonIds = [...new Set(needsContact.map(n => n.personId))];
      const toFetch = distinctPersonIds.slice(0, MAX_PEOPLE_FETCH_PER_RUN);
      clientContactRemaining = Math.max(0, distinctPersonIds.length - toFetch.length);
      for (const pid of toFetch) {
        try {
          const pr = await fetch(`https://api.attio.com/v2/objects/people/records/${pid}`, { headers });
          if (!pr.ok) { personCache.set(pid, null); continue; }
          const pj = await pr.json();
          const person = pj?.data || null;
          const email = person ? extractPersonEmail(person) : null;
          if (!email) { personCache.set(pid, null); peopleFetched++; continue; }
          personCache.set(pid, { email, firstName: person ? extractPersonFirstName(person) : null });
          peopleFetched++;
        } catch {
          personCache.set(pid, null);
        }
      }

      // Pass B: leaf-patch ONLY the still-blank child fields (re-read right
      // before so a producer edit is never clobbered). A person with no email
      // leaves the project blank rather than writing a fake address.
      for (const { projectId, personId } of needsContact) {
        const resolved = personCache.get(personId);
        if (!resolved || !resolved.email) continue;
        const live = (await fbGet(`/projects/${projectId}/clientContact`).catch(() => null)) || {};
        const patch = {};
        if (!((live.email || "").trim())) patch.email = resolved.email;
        if (!((live.firstName || "").trim()) && resolved.firstName) patch.firstName = resolved.firstName;
        if (Object.keys(patch).length === 0) continue;
        await fbPatch(`/projects/${projectId}/clientContact`, patch);
        clientContactBackfilled++;
      }
    } catch (carryErr) {
      console.error("carry-across backfill error:", carryErr);
    }

    // 6. Mirror each account's last-contact date from its Attio company's
    //    `last_interaction` (rolled-up across email + meetings). This replaces
    //    the old manual "Log Contact" button — the Accounts staleness badge is
    //    now Attio-driven and refreshes every night. Match company -> account
    //    by attioId (the same id the webhook stamps), leaf-write only
    //    `lastContact`, and skip writes that wouldn't change anything so a
    //    quiet night is a near no-op.
    let companiesScanned = 0;
    let lastContactUpdated = 0;
    try {
      const cr = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { contact_type: "Current Customer" }, limit: 500 }),
      });
      const cd = await cr.json();
      const companies = Array.isArray(cd?.data) ? cd.data : [];
      companiesScanned = companies.length;
      const contactBatch = {};
      for (const company of companies) {
        const companyId = company?.id?.record_id || "";
        if (!companyId) continue;
        const acct = accountByAttioId.get(companyId);
        if (!acct) continue;
        const date = lastInteractionDate(company);
        if (!date || acct.lastContact === date) continue;
        contactBatch[`${acct.id}/lastContact`] = date;
        lastContactUpdated++;
      }
      if (Object.keys(contactBatch).length) await fbPatch("/accounts", contactBatch);
    } catch (e) {
      console.error("last-contact sync error:", e);
    }

    return res.status(200).json({
      ok: true,
      trigger,
      dealsSynced: allDeals.length,
      quotedAtBackfilled: backfilled,
      clientNameBackfill: {
        projects: projectsBackfilled,
        projectsAccountLinked,
        deliveries: deliveriesBackfilled,
        accounts: accountsBackfilled,
        preproduction: preprodBackfilled,
      },
      lastContactSync: { companiesScanned, updated: lastContactUpdated },
      carryAcrossBackfill: {
        numberOfVideos: numberOfVideosBackfilled,
        clientContact: clientContactBackfilled,
        peopleFetched,
        clientContactRemaining,
      },
      lastSyncedAt,
    });
  } catch (e) {
    console.error("sync-attio-cache error:", e);
    return res.status(500).json({ error: e.message });
  }
}
