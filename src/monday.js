import { authFetch } from "./firebase";

async function mondayAction(action, args = {}) {
  const r = await authFetch("/api/monday", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Monday request failed");
  return data;
}

export async function fetchMondayUsers() {
  const data = await mondayAction("users");
  return data.users || null;
}

export async function fetchActiveProjectCount() {
  const data = await mondayAction("activeProjectCount");
  return data.count ?? null;
}

export async function fetchInProgressParents() {
  const data = await mondayAction("inProgressParents");
  return data.parents || [];
}

export async function fetchEditorTasks(editorName) {
  const data = await mondayAction("editorTasks", { editorName });
  return data.tasks || [];
}

export async function fetchItemUpdates(itemId) {
  const data = await mondayAction("itemUpdates", { itemId });
  return data.updates || [];
}
