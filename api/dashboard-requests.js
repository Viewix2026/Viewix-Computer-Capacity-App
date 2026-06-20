// api/dashboard-requests.js
// Founder ops for the Dashboard Requests board (bug/feature request Kanban in
// the Founders tab). /dashboardRequests is `.write:false` at the RTDB rules
// layer — ALL mutations go server-side through the admin SDK (which bypasses
// rules). The client is read-only; this endpoint owns the trust boundary.
//
// Why this exists (Codex R1-F1/F2): RTDB rules validate the *merged* node, so
// a client `update({status})` would leave every other field client-writable
// (forging github.prUrl, requestedBy, status:'done'). Routing every create/
// update/delete through a role-checked Admin-SDK endpoint closes that hole and
// lets the backend — not a rule expression — own the state machine.

import crypto from "crypto";
import { adminGet, adminSet, adminPatch } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors, actorFrom } from "./_requireAuth.js";

const STATUSES = ["triage", "ready", "building", "review", "done"];
const TYPES = ["bug", "feature"];
const PRIORITIES = ["low", "med", "high"];

// Fields a founder may edit via `update` from the board UI. Everything else
// (id, source, requestedBy, slack, github, createdAt, createdByUid) is
// server-owned and never accepted from the client on an update.
const EDITABLE = new Set(["status", "title", "body", "type", "priority", "plan"]);

function clampStr(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Ticket ids are interpolated straight into the RTDB path, so a raw `/`
// (or RTDB-illegal key chars) would let an id like "foo/createdAt" reach a
// nested node under /dashboardRequests. Even on a founders-only endpoint that
// bypasses rules, restrict ids to the minting charset (req_<ts>_<hex> and any
// Slack-intake ids stay within this set).
function validId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let decoded;
  try {
    // Founders-only — the board lives in the founders-only Founders tab and
    // /dashboardRequests is founders-only at the rules layer (Codex R1-F4: a
    // manager can't reach the Founders tab at all, so don't admit them here).
    decoded = await requireRole(req, ["founders"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { action } = req.body || {};
  const actor = actorFrom(decoded);
  const now = Date.now();

  try {
    // ─── create ──────────────────────────────────────────────────────
    if (action === "create") {
      const title = clampStr(req.body?.title, 200);
      if (!title) return res.status(400).json({ error: "title is required" });
      const body = clampStr(req.body?.body, 8000) || "";
      const type = TYPES.includes(req.body?.type) ? req.body.type : "bug";
      const priority = PRIORITIES.includes(req.body?.priority) ? req.body.priority : null;

      const id = `req_${now}_${crypto.randomBytes(4).toString("hex")}`;
      const ticket = {
        id,
        title,
        body,
        type,
        status: "triage",
        priority,
        source: "manual",
        requestedBy: { slackUserId: null, name: actor.name || actor.email || "Founder" },
        slack: null,
        screenshots: [],
        clarifications: [],
        plan: null,
        github: null,
        createdAt: now,
        updatedAt: now,
        createdByUid: actor.uid,
      };
      await adminSet(`/dashboardRequests/${id}`, ticket);
      return res.status(200).json({ ok: true, id, ticket });
    }

    // ─── update ──────────────────────────────────────────────────────
    if (action === "update") {
      const id = validId(req.body?.id);
      if (!id) return res.status(400).json({ error: "valid id is required" });

      const existing = await adminGet(`/dashboardRequests/${id}`);
      if (!existing) return res.status(404).json({ error: "ticket not found" });

      const patch = {};
      const incoming = req.body?.fields || {};
      for (const [k, v] of Object.entries(incoming)) {
        if (!EDITABLE.has(k)) continue; // silently drop server-owned fields
        if (k === "status") {
          if (!STATUSES.includes(v)) return res.status(400).json({ error: `invalid status: ${v}` });
          patch.status = v;
        } else if (k === "type") {
          if (!TYPES.includes(v)) return res.status(400).json({ error: `invalid type: ${v}` });
          patch.type = v;
        } else if (k === "priority") {
          patch.priority = PRIORITIES.includes(v) ? v : null;
        } else if (k === "title") {
          const t = clampStr(v, 200);
          if (!t) return res.status(400).json({ error: "title cannot be blank" });
          patch.title = t;
        } else if (k === "body") {
          patch.body = clampStr(v, 8000) || "";
        } else if (k === "plan") {
          patch.plan = typeof v === "string" ? v.slice(0, 20000) : null;
        }
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "no editable fields supplied" });
      }
      patch.updatedAt = now;
      await adminPatch(`/dashboardRequests/${id}`, patch);
      return res.status(200).json({ ok: true, id, patch });
    }

    // ─── delete ──────────────────────────────────────────────────────
    if (action === "delete") {
      const id = validId(req.body?.id);
      if (!id) return res.status(400).json({ error: "valid id is required" });
      const existing = await adminGet(`/dashboardRequests/${id}`);
      if (!existing) return res.status(404).json({ error: "ticket not found" });
      await adminSet(`/dashboardRequests/${id}`, null);
      return res.status(200).json({ ok: true, id });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) {
    console.error("dashboard-requests error:", e);
    return res.status(500).json({ error: e?.message || "internal error" });
  }
}
