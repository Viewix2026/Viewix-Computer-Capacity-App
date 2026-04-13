// api/webhook-deal-won.js
// Zapier webhook: fires when a deal stage changes to "Won" in Attio
// Creates/updates account, auto-calcs milestones, creates delivery + sherpas entry
// Writes directly to Firebase

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";
const SECRET = "viewix-webhook-2026";

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
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}

async function fbSet(path, data) {
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function fbPatch(path, data) {
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { companyName, companyId, dealName, dealValue, closeDate, videoType, numberOfVideos, secret } = req.body || {};

    if (secret !== SECRET) return res.status(401).json({ error: "Invalid secret" });
    if (!companyName) return res.status(400).json({ error: "companyName is required" });

    const now = new Date().toISOString().split("T")[0];
    const signingDate = closeDate || now;
    const results = { account: null, delivery: null, sherpas: null };

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

    // --- 2. DELIVERIES ---
    const delId = "del-" + Date.now();
    const newDelivery = {
      id: delId,
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
          name: dealName ? `${dealName} - Video ${i + 1}` : `Video ${i + 1}`,
          viewixStatus: "In Development",
          revision1: "",
          revision2: "",
        });
      }
    }
    await fbSet(`/deliveries/${delId}`, newDelivery);
    results.delivery = "created";

    // --- 3. SHERPAS (clients) ---
    const clients = (await fbGet("/clients")) || {};
    let sherpaExists = false;
    for (const cl of Object.values(clients)) {
      if (cl && (cl.name || "").toLowerCase() === nameLC) {
        sherpaExists = true;
        break;
      }
    }
    if (!sherpaExists) {
      const clId = "cl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 5);
      await fbSet(`/clients/${clId}`, {
        id: clId,
        name: companyName,
        projectLead: "",
        accountManager: "",
        docUrl: "",
      });
      results.sherpas = "created";
    } else {
      results.sherpas = "exists";
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
