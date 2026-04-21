// api/webhook-deal-won.js
// Zapier webhook: fires when a deal stage changes to "Won" in Attio
// Creates/updates account, auto-calcs milestones, creates delivery + sherpas entry
// Writes to Firebase via admin SDK (falls back to REST if service account not configured)

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";
import { identifyDeal, productLineLabel } from "./_tiers.js";
import { computeFoundersMetrics } from "./_attio-metrics.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const SECRET = "viewix-webhook-2026";

// Generate a 6-char unguessable short id for share URLs (matches frontend utils.makeShortId)
function makeShortId() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Milestone gaps in days from signing date
const GAPS = {
  preProductionMeeting: 3,
  preProductionPresentation: 10,
  shoot: 17,
  posting: 31,
  resultsReview: 59,
  partnershipReview: 87,
  growthStrategy: 115,
};

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    const { companyName, companyId, dealName, dealValue, closeDate, videoType, numberOfVideos, secret } = body;

    // New Attio fields (Zapier sends these with capital letters / spaces —
    // bracket notation required). Each is optional; Destination is
    // comma-separated which we split client-side for chip rendering.
    const description = body["Description"] || body.description || body.scopeOfWork || "";
    const destinationRaw = body["Destination"] || body.destinations || body.destination || "";
    const destinations = typeof destinationRaw === "string"
      ? destinationRaw.split(",").map(s => s.trim()).filter(Boolean)
      : (Array.isArray(destinationRaw) ? destinationRaw : []);
    const targetAudience = body["Target Audience"] || body.targetAudience || body.audience || "";
    const dueDate = body["Due Date"] || body.dueDate || body.projectDueDate || null;
    const firstName = body["First Name"] || body.firstName || "";
    const clientEmail = body["Client Email"] || body.clientEmail || body.email || "";

    if (secret !== SECRET) return res.status(401).json({ error: "Invalid secret" });
    if (!companyName) return res.status(400).json({ error: "companyName is required" });

    const now = new Date().toISOString().split("T")[0];
    const signingDate = closeDate || now;
    const results = { account: null, delivery: null, sherpas: null };
    // Capture the IDs of each linked record as we create them — gets
    // denormalised onto the /projects/{id} record at the end so the
    // Projects tab's status pills can click straight through to each one
    // without re-querying Firebase.
    const links = { accountId: null, sherpaId: null, preprodId: null, preprodType: null, runsheetId: null, deliveryId: null };

    // --- 1. ACCOUNTS ---
    const accounts = (await fbGet("/accounts")) || {};
    const nameLC = companyName.toLowerCase();
    let acctId = null;
    let isNew = true;

    // Check if account already exists by name or attioId
    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct) continue;
      if ((acct.companyName || "").toLowerCase() === nameLC || (companyId && acct.attioId === companyId)) {
        acctId = id;
        isNew = false;
        break;
      }
    }

    // Build milestones from signing date
    const milestones = {
      signing: { date: signingDate, status: "Completed" },
    };
    for (const [key, gap] of Object.entries(GAPS)) {
      milestones[key] = { date: addDays(signingDate, gap), status: "TBC" };
    }

    if (isNew) {
      acctId = "acct-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      const newAccount = {
        id: acctId,
        companyName: companyName,
        attioId: companyId || "",
        accountManager: "",
        projectLead: "",
        partnershipType: videoType || "",
        lastContact: now,
        milestones: milestones,
      };
      await fbSet(`/accounts/${acctId}`, newAccount);
      results.account = "created";
    } else {
      // Update existing: fill partnership if empty, update milestones if no signing date set
      const existing = accounts[acctId];
      const patch = {};
      if (videoType && !existing.partnershipType) patch.partnershipType = videoType;
      if (!existing.milestones || !existing.milestones.signing || !existing.milestones.signing.date) {
        patch.milestones = milestones;
      }
      patch.lastContact = now;
      if (Object.keys(patch).length > 0) {
        await fbPatch(`/accounts/${acctId}`, patch);
      }
      results.account = "updated";
    }
    links.accountId = acctId;

    // --- 2. DELIVERIES ---
    // One identifyDeal() call routes the entire webhook. Returns
    //   { productLine, tier }
    // where productLine is "metaAds" | "socialPremium" | "socialOrganic"
    // | "oneOff" | null. Meta Ads packages skip delivery creation here —
    // delivery is auto-created when preproduction scripts are approved.
    // Everything else gets a delivery placeholder.
    const deal = identifyDeal(videoType);
    const isMetaAds = deal.productLine === "metaAds";

    if (!isMetaAds) {
      const delId = "del-" + Date.now();
      const newDelivery = {
        id: delId,
        shortId: makeShortId(),
        clientName: companyName,
        logoUrl: "",
        notes: "",
        videos: [],
      };
      // Add placeholder videos based on numberOfVideos
      const numVids = parseInt(numberOfVideos) || 0;
      if (numVids > 0) {
        for (let i = 0; i < numVids; i++) {
          newDelivery.videos.push({
            id: `vid-${Date.now()}-${i}`,
            name: `Video ${i + 1}:`,
            viewixStatus: "In Development",
            revision1: "",
            revision2: "",
          });
        }
      }
      await fbSet(`/deliveries/${delId}`, newDelivery);
      results.delivery = "created";
      links.deliveryId = delId;
    } else {
      results.delivery = "deferred to preproduction approval";
    }

    // --- 3. SHERPAS (clients) ---
    const clients = (await fbGet("/clients")) || {};
    let sherpaExists = false;
    const clientEntries = Object.values(clients).filter(Boolean);
    for (const cl of clientEntries) {
      if ((cl.name || "").trim().toLowerCase() === nameLC.trim()) {
        sherpaExists = true;
        break;
      }
    }
    console.log(`Sherpas check: "${companyName}" exists=${sherpaExists}, total clients=${clientEntries.length}`);
    if (!sherpaExists) {
      const clId = "cl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 5);
      await fbSet(`/clients/${clId}`, {
        id: clId,
        name: companyName.trim(),
        projectLead: "",
        accountManager: "",
        docUrl: "",
      });
      results.sherpas = "created";
      links.sherpaId = clId;
    } else {
      results.sherpas = "exists";
      // Find the existing sherpa's id so the Projects tab links through.
      const existing = clientEntries.find(cl => (cl.name || "").trim().toLowerCase() === nameLC.trim());
      if (existing?.id) links.sherpaId = existing.id;
    }

    // --- 4. PREPRODUCTION ---
    // Three branches driven by the identifyDeal() result:
    //   metaAds                → /preproduction/metaAds/{id}
    //   socialPremium / organic → /preproduction/socialOrganic/{id}
    //                             (shared tree, productLine field disambiguates)
    //   oneOff / unrecognised  → no preprod record; deal lives in /projects
    //                             + /deliveries only.
    if (isMetaAds) {
      const projectId = `meta_${Date.now()}`;
      links.preprodId = projectId;
      links.preprodType = "metaAds";
      // New records default to the tab-based flow (Phase 2 of the
      // Meta Ads rebuild). `tab: "brandTruth"` is what MetaAdsResearch
      // keys off to render — legacy records without this field keep
      // using the single-page UI in Preproduction.jsx.
      await fbSet(`/preproduction/metaAds/${projectId}`, {
        id: projectId,
        shortId: makeShortId(),
        companyName: companyName,
        packageTier: deal.tier,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attioCompanyId: companyId || null,
        attioDealId: null,
        dealValue: dealValue || null,
        numberOfVideos: parseInt(numberOfVideos) || null,
        // New-flow fields — see MetaAdsResearch.META_TABS for the order
        tab: "brandTruth",
        approvals: {},
        brandTruth: { fields: {}, transcript: "", producerNotes: "" },
        // Legacy fields left on the record for forward-compat; the
        // Scripting tab (Phase 6) will populate scriptTable when ready.
        transcript: null,
        brandAnalysis: null,
        targetCustomer: null,
        motivators: null,
        visuals: null,
        scriptTable: null,
        rewriteHistory: [],
      });
      results.preproduction = "metaAds created (new tab flow)";
    }

    if (deal.productLine === "socialPremium" || deal.productLine === "socialOrganic") {
      const projectId = `social_${Date.now()}`;
      links.preprodId = projectId;
      links.preprodType = "socialOrganic";
      // Both Social Premium and Social Organic share the same 7-tab flow
      // under /preproduction/socialOrganic. productLine persists on the
      // record so any future divergence (different prompts, different
      // deliverable counts) can branch on it without a path migration.
      await fbSet(`/preproduction/socialOrganic/${projectId}`, {
        id: projectId,
        shortId: makeShortId(),
        companyName: companyName,
        packageTier: deal.tier,
        productLine: deal.productLine,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attioCompanyId: companyId || null,
        dealValue: dealValue || null,
        videoType: videoType || null,
        numberOfVideos: parseInt(numberOfVideos) || null,
        // 7-tab workflow state. Tab router keys off `tab`; approvals[key]
        // timestamps advance each gate.
        tab: "brandTruth",
        approvals: {},
        videoReview: { ticked: [], crossed: [], extraLinks: [] },
        shortlistedFormats: {},
        selectedFormats: [],
        videoCountOverride: null,
      });
      results.preproduction = `${productLineLabel(deal.productLine)} created`;
    }

    if (deal.productLine === "oneOff") {
      // No preproduction tree for one-off types (Live Action / 90 Day
      // Gameplan / Animation) — they go straight to production, tracked
      // via /projects + /deliveries below.
      results.preproduction = "skipped (one-off)";
    }

    // --- 4b. PROJECTS ---
    // Central registry of every won deal. Dashboard's Projects tab reads
    // from here. Denormalises the Attio webhook fields + the IDs of all
    // linked records (account / sherpa / preprod / runsheet / delivery)
    // so the status-pill UI has everything it needs without cross-queries.
    const projectId = "proj-" + Date.now() + "-" + Math.random().toString(36).slice(2, 5);
    await fbSet(`/projects/${projectId}`, {
      id: projectId,
      shortId: makeShortId(),
      clientName: companyName,
      projectName: (dealName || "").trim() || "Untitled project",
      dealValue: dealValue != null ? Number(dealValue) || null : null,
      // `videoType` keeps the raw Attio label for human readability;
      // `productLine` + `packageTier` are the canonical machine keys for
      // filtering / colour lookup / future per-product branching.
      videoType: videoType || "",
      productLine: deal.productLine,
      packageTier: deal.tier,
      numberOfVideos: parseInt(numberOfVideos) || null,
      description,                    // scope of work from Attio "Description"
      destinations,                   // array, split from Attio comma-separated "Destination"
      targetAudience,                 // Attio "Target Audience" — future field, empty for now
      dueDate,                        // Attio "Due Date" — future field, null for now
      closeDate: closeDate || null,
      clientContact: { firstName, email: clientEmail },
      attioCompanyId: companyId || null,
      attioDealId: null,              // Attio webhook doesn't expose the deal's own record_id yet
      status: "active",               // active | archived
      producerNotes: "",
      links,                          // { accountId, sherpaId, preprodId, preprodType, deliveryId, runsheetId }
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    results.project = projectId;

    // --- 5. REFRESH ATTIO CACHE ---
    // Pull a fresh copy of all deals from Attio and store at /attioCache so the
    // Founders dashboard shows the newly-won deal on next load (or immediately
    // for anyone currently listening to root). Failures here are non-fatal —
    // the main webhook work is already committed above.
    try {
      const ATTIO_KEY = process.env.ATTIO_API_KEY;
      if (ATTIO_KEY) {
        const attioHeaders = { "Authorization": `Bearer ${ATTIO_KEY}`, "Content-Type": "application/json" };
        let allDeals = [];
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
          const r = await fetch("https://api.attio.com/v2/objects/deals/records/query", {
            method: "POST",
            headers: attioHeaders,
            body: JSON.stringify({ limit: 100, offset, sorts: [{ attribute: "created_at", direction: "desc" }] }),
          });
          const d = await r.json();
          if (d?.data && d.data.length > 0) {
            allDeals = allDeals.concat(d.data);
            offset += d.data.length;
            hasMore = d.data.length === 100;
          } else {
            hasMore = false;
          }
          if (allDeals.length >= 1000) break;
        }
        await fbSet("/attioCache", {
          data: allDeals,
          total: allDeals.length,
          lastSyncedAt: new Date().toISOString(),
          lastSyncTrigger: "webhook",
          lastTriggerCompany: companyName,
        });
        results.attioCache = `refreshed (${allDeals.length} deals)`;

        // Auto-populate Founders KPIs from the fresh deal list. Mirrors
        // the Founders.jsx syncAttio button — same helper is used there
        // so the manual button and the webhook can't drift. We patch
        // /foundersData (not set) so founder-entered fields we don't
        // compute (revenueTarget, etc.) survive. Zero-valued metrics
        // are skipped so a transient empty-deals response can't blank
        // out a previously-good figure.
        try {
          const metrics = computeFoundersMetrics(allDeals);
          const patch = {};
          if (metrics.ytdRevenue > 0)         patch.currentRevenue    = metrics.ytdRevenue;
          if (metrics.monthlyRevenue > 0)     patch.monthlyRevenue    = metrics.monthlyRevenue;
          if (metrics.activeClients > 0)      patch.activeClients     = metrics.activeClients;
          if (metrics.avgRetainerValue > 0)   patch.avgRetainerValue  = metrics.avgRetainerValue;
          if (metrics.leadPipelineValue > 0)  patch.leadPipelineValue = metrics.leadPipelineValue;
          if (metrics.closingRate > 0)        patch.closingRate       = metrics.closingRate;
          if (Object.keys(patch).length > 0) {
            await fbPatch("/foundersData", patch);
            results.foundersMetrics = `populated (${Object.keys(patch).join(", ")})`;
          } else {
            results.foundersMetrics = "no values computed";
          }
        } catch (metricsErr) {
          console.error("Founders metrics calc failed:", metricsErr);
          results.foundersMetrics = `failed: ${metricsErr.message}`;
        }
      } else {
        results.attioCache = "skipped (no ATTIO_API_KEY)";
      }
    } catch (cacheErr) {
      console.error("Attio cache refresh failed:", cacheErr);
      results.attioCache = `failed: ${cacheErr.message}`;
    }

    return res.status(200).json({
      success: true,
      companyName,
      dealName: dealName || "",
      results,
    });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ error: e.message });
  }
}
