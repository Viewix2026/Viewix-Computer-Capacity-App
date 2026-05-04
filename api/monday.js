import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

const MONDAY_API = "https://api.monday.com/v2";
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || "1884080816";
const MONDAY_IN_PROGRESS_GROUP = process.env.MONDAY_IN_PROGRESS_GROUP || "new_group__1";
const ALLOWED_ROLES = ["founders", "founder", "editor"];

async function mondayQuery(query) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) {
    const err = new Error("MONDAY_TOKEN not configured");
    err.status = 500;
    throw err;
  }
  const r = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.errors) {
    const err = new Error(data.errors?.[0]?.message || `Monday API failed (${r.status})`);
    err.status = 502;
    throw err;
  }
  return data;
}

function parentInfo(parent) {
  const parentCol = (id) => parent.column_values?.find(v => v.id === id)?.text || "";
  return {
    id: parent.id,
    taskContent: parentCol("text9"),
    dueDate: parentCol("date"),
    projectDueDate: parentCol("date8"),
    status: parentCol("project_status"),
    stage: parentCol("status_18"),
    clientName: parentCol("text1"),
    clientEmail: parentCol("email"),
    type: parentCol("dropdown"),
    estimatedEditTime: parentCol("long_text"),
  };
}

async function fetchBoardItems() {
  const q = `query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id name group { id title } column_values(ids: ["text9","date","date8","project_status","status_18","text1","email","dropdown","long_text"]) { id text } subitems { id name column_values(ids: ["people","status8","stage","timeline","due_date","numeric_mkyg3qb1","hour","hour0"]) { id text } } } } } }`;
  const res = await mondayQuery(q);
  return res?.data?.boards?.[0]?.items_page?.items || [];
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  try {
    const { action, args = {} } = req.body || {};

    if (action === "users") {
      const q = `query { users { id name } }`;
      const result = await mondayQuery(q);
      const users = (result?.data?.users || []).filter(u => u.name && !u.name.toLowerCase().includes("trial"));
      return res.status(200).json({ users });
    }

    if (action === "activeProjectCount") {
      const q = `query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id group { id } } } } }`;
      const result = await mondayQuery(q);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      return res.status(200).json({ count: items.filter(it => it.group?.id === MONDAY_IN_PROGRESS_GROUP).length });
    }

    if (action === "inProgressParents") {
      const q = `query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id name group { id } subitems { id name } } } } }`;
      const result = await mondayQuery(q);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      return res.status(200).json({ parents: items.filter(it => it.group?.id === MONDAY_IN_PROGRESS_GROUP) });
    }

    if (action === "editorTasks") {
      const editorName = String(args.editorName || "").trim();
      if (!editorName) return res.status(400).json({ error: "editorName required" });
      const items = (await fetchBoardItems()).filter(it => it.group?.id === MONDAY_IN_PROGRESS_GROUP);
      const tasks = [];
      for (const parent of items) {
        const info = parentInfo(parent);
        for (const sub of parent.subitems || []) {
          const people = sub.column_values?.find(v => v.id === "people")?.text || "";
          if (!people.toLowerCase().includes(editorName.toLowerCase())) continue;
          const getCol = (id) => sub.column_values?.find(v => v.id === id)?.text || "";
          const timeline = getCol("timeline");
          let startDate = null;
          let endDate = null;
          if (timeline) {
            const parts = timeline.split(" - ");
            if (parts.length === 2) { startDate = parts[0].trim(); endDate = parts[1].trim(); }
            else if (parts.length === 1) { startDate = parts[0].trim(); endDate = parts[0].trim(); }
          }
          const status = getCol("status8");
          if (status === "DONE") continue;
          tasks.push({
            id: sub.id,
            name: sub.name,
            parentName: parent.name,
            parentInfo: info,
            status,
            stage: getCol("stage"),
            timeline,
            startDate,
            endDate,
            people,
            estimatedHours: getCol("numeric_mkyg3qb1"),
            startTime: getCol("hour"),
            endTime: getCol("hour0"),
          });
        }
      }
      return res.status(200).json({ tasks });
    }

    if (action === "itemUpdates") {
      const itemId = String(args.itemId || "").replace(/[^\d]/g, "");
      if (!itemId) return res.status(400).json({ error: "itemId required" });
      const q = `query { items(ids: ${itemId}) { updates(limit: 10) { id body text_body created_at creator { name } } } }`;
      const result = await mondayQuery(q);
      return res.status(200).json({ updates: result?.data?.items?.[0]?.updates || [] });
    }

    return res.status(400).json({ error: "Unknown Monday action" });
  } catch (e) {
    console.error("Monday proxy error:", e);
    return res.status(e.status || 500).json({ error: e.message || "Monday proxy failed" });
  }
}
