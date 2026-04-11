// Vercel Serverless Function: Attio API Proxy
// Fetches all deals with pagination for monthly revenue tracking

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

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
      // Confirmed attribute IDs from Attio
      const CT_SLUG = "contact_type";
      const CT_UUID = "b8434ac0-4705-4e1a-90d2-37e47b6c370b";
      const CURRENT_CUSTOMER_OPT = "dca55277-f510-4690-a1d8-b9942d4a156b";
      const NAME_SLUG = "name";
      const NAME_UUID = "b1e0f62f-3aa7-415e-a259-5a769878c38a";

      let allRecords = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const resp = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
          method: "POST",
          headers,
          body: JSON.stringify({ limit, offset })
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

      const companies = [];
      for (const r of allRecords) {
        const v = r.values || {};
        const ct = v[CT_SLUG] || v[CT_UUID] || [];
        if (!Array.isArray(ct) || ct.length === 0) continue;
        const ctStr = JSON.stringify(ct[0]).toLowerCase();
        if (!ctStr.includes("current customer") && !ctStr.includes(CURRENT_CUSTOMER_OPT)) continue;
        const nameArr = v[NAME_SLUG] || v[NAME_UUID] || [];
        let name = "";
        if (Array.isArray(nameArr) && nameArr.length > 0) {
          name = nameArr[0]?.value || nameArr[0]?.first_name || "";
        } else if (typeof nameArr === "string") {
          name = nameArr;
        }
        const id = r.id?.record_id || "";
        if (name) companies.push({ id, name });
      }

      return res.status(200).json({ companies, total: companies.length, scanned: allRecords.length });
    }

    return res.status(400).json({ error: "Unknown action. Use: deals, all_deals, object_schema, attributes, currentCustomers" });
  } catch (e) {
    console.error("Attio API error:", e);
    return res.status(500).json({ error: e.message });
  }
}
