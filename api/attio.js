// Vercel Serverless Function: Attio API Proxy
// Fetches all deals with pagination for monthly revenue tracking
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await requireRole(req, ["founders", "founder"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const ATTIO_KEY = process.env.ATTIO_API_KEY;
  const headers = { "Authorization": `Bearer ${ATTIO_KEY}`, "Content-Type": "application/json" };
  const { action } = req.body || {};

  try {
    if (action === "deals" || action === "all_deals") {
      // Paginate through all deals
      let allDeals = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const resp = await fetch("https://api.attio.com/v2/objects/deals/records/query", {
          method: "POST",
          headers,
          body: JSON.stringify({ limit, offset, sorts: [{ attribute: "created_at", direction: "desc" }] })
        });
        const data = await resp.json();
        if (data?.data && data.data.length > 0) {
          allDeals = allDeals.concat(data.data);
          offset += data.data.length;
          hasMore = data.data.length === limit;
        } else {
          hasMore = false;
        }
        // Safety cap at 1000 deals
        if (allDeals.length >= 1000) break;
      }

      return res.status(200).json({ data: allDeals, total: allDeals.length });
    }

    if (action === "object_schema") {
      // Fetch the deals object schema to see available attributes
      const resp = await fetch("https://api.attio.com/v2/objects/deals", { method: "GET", headers });
      const data = await resp.json();
      return res.status(200).json(data);
    }

    if (action === "attributes") {
      // Fetch deal attributes to map field names
      const resp = await fetch("https://api.attio.com/v2/objects/deals/attributes", { method: "GET", headers });
      const data = await resp.json();
      return res.status(200).json(data);
    }

    if (action === "debugCompanies") {
      const resp = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 2 })
      });
      const raw = await resp.text();
      return res.status(200).json({ status: resp.status, raw: raw.substring(0, 2000) });
    }

    if (action === "currentCustomers") {
      const resp = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: { "contact_type": "Current Customer" },
          limit: 500
        })
      });
      const data = await resp.json();
      if (!data?.data) return res.status(200).json({ companies: [], total: 0, error: data });

      // Fetch video_type attribute options for UUID -> title mapping
      const attrResp = await fetch("https://api.attio.com/v2/objects/deals/attributes/video_type", { headers });
      const attrData = await attrResp.json();
      const vtOptions = {};
      if (attrData?.data?.config?.options) {
        attrData.data.config.options.forEach(o => { vtOptions[o.id] = o.title; });
      }

      // Fetch all deals to map video_type per company
      let allDeals = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const dr = await fetch("https://api.attio.com/v2/objects/deals/records/query", {
          method: "POST",
          headers,
          body: JSON.stringify({ limit: 100, offset, sorts: [{ attribute: "created_at", direction: "desc" }] })
        });
        const dd = await dr.json();
        if (dd?.data && dd.data.length > 0) {
          allDeals = allDeals.concat(dd.data);
          offset += dd.data.length;
          hasMore = dd.data.length === 100;
        } else { hasMore = false; }
        if (allDeals.length >= 1000) break;
      }

      // Build map: company_record_id -> most recent deal's video_type
      const videoTypeMap = {};
      for (const deal of allDeals) {
        const companyRef = deal.values?.associated_company;
        const companyId = Array.isArray(companyRef) && companyRef[0]
          ? companyRef[0].target_record_id
          : (companyRef?.target_record_id || null);
        if (!companyId || videoTypeMap[companyId]) continue;
        const vtArr = deal.values?.video_type || [];
        if (Array.isArray(vtArr) && vtArr.length > 0) {
          const raw = vtArr[0];
          const vt = (typeof raw?.option === "string" ? vtOptions[raw.option] : null)
            || raw?.option?.title || raw?.status?.title || raw?.value || raw?.title
            || (typeof raw === "string" ? (vtOptions[raw] || raw) : "");
          if (vt) videoTypeMap[companyId] = vt;
        }
      }

      const companies = data.data.map(r => {
        const nameArr = r.values?.name || [];
        const name = nameArr[0]?.value || nameArr[0]?.first_name || "";
        const id = r.id?.record_id || "";
        return { id, name, videoType: videoTypeMap[id] || "" };
      }).filter(c => c.name);

      return res.status(200).json({ companies, total: companies.length });
    }

    return res.status(400).json({ error: "Unknown action. Use: deals, all_deals, object_schema, attributes, currentCustomers" });
  } catch (e) {
    console.error("Attio API error:", e);
    return res.status(500).json({ error: e.message });
  }
}
