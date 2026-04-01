// ─── Monday.com ───
const MONDAY_API = "https://api.monday.com/v2";
const MONDAY_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjM5NzQ3MTI3OSwiYWFpIjoxMSwidWlkIjo2MjY3NDg4NSwiaWFkIjoiMjAyNC0wOC0xNVQwNjo0MjoxMC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQxMzg2NTksInJnbiI6ImFwc2UyIn0.-YhtvI8VFze2Tv971jezS8BAaABF3nQG7vjBS0xXq_E";
const MONDAY_BOARD_ID = "1884080816";
const MONDAY_IN_PROGRESS_GROUP = "new_group__1";

async function mondayQuery(q) {
  try {
    console.log("Monday API query:", q);
    const r = await fetch(MONDAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": MONDAY_TOKEN },
      body: JSON.stringify({ query: q })
    });
    const data = await r.json();
    if (data.errors) console.error("Monday API errors:", data.errors);
    return data;
  } catch (e) {
    console.error("Monday API error:", e);
    return null;
  }
}

export async function fetchMondayUsers() {
  const q = `query { users { id name } }`;
  const res = await mondayQuery(q);
  if (!res?.data?.users) return null;
  return res.data.users.filter(u => u.name && !u.name.toLowerCase().includes("trial"));
}

export async function fetchActiveProjectCount() {
  const q = `query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id group { id } } } } }`;
  const res = await mondayQuery(q);
  if (!res?.data?.boards?.[0]?.items_page?.items) return null;
  return res.data.boards[0].items_page.items.filter(it => it.group?.id === MONDAY_IN_PROGRESS_GROUP).length;
}

export async function fetchInProgressParents() {
  const q = `query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id name group { id } subitems { id name } } } } }`;
  const res = await mondayQuery(q);
  if (!res?.data?.boards?.[0]?.items_page?.items) return [];
  return res.data.boards[0].items_page.items.filter(it => it.group?.id === MONDAY_IN_PROGRESS_GROUP);
}

export async function fetchEditorTasks(editorName) {
  const q = `query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id name group { id title } column_values(ids: ["text9","date","date8","project_status","status_18","text1","email","dropdown","long_text"]) { id text } subitems { id name column_values(ids: ["people","status8","stage","timeline","due_date","numeric_mkyg3qb1"]) { id text } } } } } }`;
  const res = await mondayQuery(q);
  console.log("Monday API response:", res);
  if (!res?.data?.boards?.[0]?.items_page?.items) return [];
  const items = res.data.boards[0].items_page.items;
  const inProgress = items.filter(it => it.group?.id === MONDAY_IN_PROGRESS_GROUP);
  console.log("In Progress items:", inProgress.length);
  const tasks = [];
  inProgress.forEach(parent => {
    const parentCol = (id) => parent.column_values?.find(v => v.id === id)?.text || "";
    const parentInfo = {
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
    (parent.subitems || []).forEach(sub => {
      const peopleCol = sub.column_values?.find(v => v.id === "people");
      const people = peopleCol?.text || "";
      if (!people.toLowerCase().includes(editorName.toLowerCase())) return;
      const getCol = (id) => sub.column_values?.find(v => v.id === id)?.text || "";
      const timeline = getCol("timeline");
      const status = getCol("status8");
      let startDate = null, endDate = null;
      if (timeline) {
        const parts = timeline.split(" - ");
        if (parts.length === 2) { startDate = parts[0].trim(); endDate = parts[1].trim(); }
        else if (parts.length === 1) { startDate = parts[0].trim(); endDate = parts[0].trim(); }
      }
      if (status === "DONE") return;
      tasks.push({
        id: sub.id,
        name: sub.name,
        parentName: parent.name,
        parentInfo: parentInfo,
        status: status,
        stage: getCol("stage"),
        timeline: timeline,
        startDate: startDate,
        endDate: endDate,
        people: people,
        estimatedHours: getCol("numeric_mkyg3qb1"),
      });
    });
  });
  console.log("Found tasks for", editorName, ":", tasks.length);
  return tasks;
}

export async function fetchItemUpdates(itemId) {
  const q = `query { items(ids: ${itemId}) { updates(limit: 10) { id body text_body created_at creator { name } } } }`;
  const res = await mondayQuery(q);
  return res?.data?.items?.[0]?.updates || [];
}
