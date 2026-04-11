// Vercel Serverless Function: Attio API Proxy
// Fetches all deals with pagination for monthly revenue tracking

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ATTIO_KEY = "4b3e2b54beefb2b23095e90df934db4dbdf843cdd19ce83b77cf20e63e4c2f6e";
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

    if (action === "currentCustomers") {
      let allRecords = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const resp = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
          method: "POST",
          headers,
          body: JSON.stringify({ limit, offset, sorts: [{ attribute: "name", direction: "asc" }] })
        });
        const data = await resp.json();
        if (data?.data && data.data.length > 0) {
          allRecords = allRecords.concat(data.data);
          offset += data.data.length;
          hasMore = data.data.length === limit;
        } else {
          hasMore = false;
        }
        if (allRecords.length >= 500) break;
      }

      const companies = allRecords
        .filter(r => {
          const ct = r.values?.contact_type;
          if (!ct || !ct.length) return false;
          const val = ct[0]?.option?.title || ct[0]?.status?.title || ct[0]?.value || "";
          return typeof val === "string" && val.toLowerCase() === "current customer";
        })
        .map(r => ({
          id: r.id?.record_id || "",
          name: r.values?.name?.[0]?.value || r.values?.name?.[0]?.first_name || "",
        }));

      return res.status(200).json({ companies, total: companies.length });
    }

    return res.status(400).json({ error: "Unknown action. Use: deals, all_deals, object_schema, attributes, currentCustomers" });
  } catch (e) {
    console.error("Attio API error:", e);
    return res.status(500).json({ error: e.message });
  }
}
