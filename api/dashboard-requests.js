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
//
// Phase 3: a transition to `ready` opens a GitHub issue (build brief) and
// advances the ticket to `building`. Inert until GITHUB_REQUESTS_* env vars
// exist, in which case the ticket simply stays at `ready`.

import { adminGet, adminSet, adminPatch, mutateRecord } from "./_fb-admin.js";
import { handleOptions, requireRole, sendAuthError, setCors, actorFrom } from "./_requireAuth.js";
import {
  STATUSES, TYPES, PRIORITIES, newRequestId, validId, buildTicket,
  createIssueForTicket, githubRequestsConfig,
} from "./_dashboard-requests.js";

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
      const ticket = buildTicket({
        id: newRequestId(),
        title,
        body: clampStr(req.body?.body, 8000) || "",
        type: req.body?.type,
        priority: req.body?.priority,
        source: "manual",
        requestedBy: { slackUserId: null, name: actor.name || actor.email || "Founder" },
        createdByUid: actor.uid,
      });
      await adminSet(`/dashboardRequests/${ticket.id}`, ticket);
      return res.status(200).json({ ok: true, id: ticket.id, ticket });
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

      // Phase 3 handoff: a transition INTO `ready` (no prior github) opens a
      // GitHub issue and advances to `building`. Never fail the status change
      // the founder just made — the handoff is best-effort around it.
      //
      // Duplicate-safe (Codex R2-F2): the OLD try/catch left `github` unstamped
      // when the post-create patch failed, so the next ready-drag made a second
      // issue. Now we claim the handoff transactionally with a `pending` marker
      // (blocks re-entry), and only ever RELEASE the claim when no issue was
      // actually created — so an issue can never be created twice.
      let github = null;
      if (patch.status === "ready" && !existing.github && githubRequestsConfig()) {
        const claim = await mutateRecord(`/dashboardRequests/${id}`,
          cur => (cur.github ? cur : { ...cur, github: { handoff: "pending", at: Date.now() } }));
        const claimed = claim.committed && claim.snapshot?.github?.handoff === "pending";
        if (claimed) {
          try {
            github = await createIssueForTicket({ ...existing, ...patch });
          } catch (e) {
            console.error("dashboard-requests: GitHub issue create failed:", e?.message || e);
            await adminPatch(`/dashboardRequests/${id}`, { github: null }); // no issue made → allow retry
            github = null;
          }
          if (github) {
            // Issue exists — do NOT release the claim on a later failure, or a
            // re-drag would duplicate it. Stamp best-effort; worst case the
            // ticket sits at `ready` with the issue recorded as pending.
            try {
              await adminPatch(`/dashboardRequests/${id}`, { github, status: "building", updatedAt: Date.now() });
            } catch (e) {
              console.error("dashboard-requests: handoff stamp failed (issue exists):", e?.message || e);
              // Best-effort recovery so the ticket isn't orphaned from its
              // issue: record the issue identity (status stays `ready`). The
              // card then shows the link and the Phase-4 webhook can still
              // match it by issueNumber.
              await adminPatch(`/dashboardRequests/${id}`, { github }).catch(() => {});
            }
          }
        }
      }
      return res.status(200).json({ ok: true, id, patch, github });
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
