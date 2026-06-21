// api/_dashboard-requests.js
// Shared server-side helpers for the Dashboard Requests board (Kanban in the
// Founders tab), its Slack intake (api/slack-request-listener.js) and its
// GitHub handoff (api/dashboard-requests.js update → issue; the webhook closes
// the loop). Pure logic + RTDB read + GitHub REST. No Slack here — the listener
// owns Slack so this module stays importable from the auth'd dashboard endpoint.

import crypto from "crypto";
import { adminGet } from "./_fb-admin.js";

export const STATUSES = ["triage", "ready", "building", "review", "done"];
export const TYPES = ["bug", "feature"];
export const PRIORITIES = ["low", "med", "high"];

export function newRequestId() {
  return `req_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

// Ticket ids are interpolated straight into the RTDB path, so a raw `/` (or
// RTDB-illegal key char) would let an id like "foo/createdAt" reach a nested
// node. Restrict to the minting charset on every inbound id.
export function validId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : null;
}

// Deterministic ticket id for a Slack intake thread, derived from the root
// message ts. A retried or concurrent intake then targets the SAME ticket node
// (an idempotent overwrite) instead of minting a second ticket — which lets the
// listener write the ticket BEFORE claiming `ticketCreated`, closing the
// crash-loses-the-request hole. The ts contains a ".", illegal in an RTDB key,
// so swap it for "_"; the result is also validId-safe.
export function ticketIdForThread(rootTs) {
  return `req_${String(rootTs).replace(/\./g, "_")}`;
}

// Build a fully-formed ticket with server-owned defaults. Callers supply the
// user-facing fields; this owns id/status/timestamps and the canonical shape,
// so a Slack-created and a manually-created ticket are byte-compatible.
export function buildTicket({ id, title, body, type, priority, source, requestedBy, slack, screenshots, clarifications, createdByUid }) {
  const now = Date.now();
  return {
    id,
    title: String(title || "").slice(0, 200) || "Untitled request",
    body: typeof body === "string" ? body.slice(0, 8000) : "",
    type: TYPES.includes(type) ? type : "bug",
    status: "triage",
    priority: PRIORITIES.includes(priority) ? priority : null,
    source: source === "slack" ? "slack" : "manual",
    requestedBy: requestedBy || { slackUserId: null, name: "Unknown" },
    slack: slack || null,
    screenshots: Array.isArray(screenshots) ? screenshots.slice(0, 20) : [],
    clarifications: Array.isArray(clarifications) ? clarifications.slice(0, 20) : [],
    plan: null,
    github: null,
    createdAt: now,
    updatedAt: now,
    createdByUid: createdByUid || null,
  };
}

// ─── GitHub handoff (Phase 3) ──────────────────────────────────────
// A "Ready" ticket becomes a GitHub issue formatted as a build brief that a
// cloud Claude Code session can pick up. Inert (returns null) until both env
// vars exist — callers treat null as "skip, leave the ticket at ready".
export function githubRequestsConfig() {
  const token = process.env.GITHUB_REQUESTS_TOKEN;
  const repo = process.env.GITHUB_REQUESTS_REPO; // "owner/name"
  if (!token || !repo || !repo.includes("/")) return null;
  return { token, repo };
}

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
  "User-Agent": "viewix-dashboard-requests",
});

export async function createIssueForTicket(ticket) {
  const cfg = githubRequestsConfig();
  if (!cfg) return null; // inert until configured
  const resp = await fetch(`https://api.github.com/repos/${cfg.repo}/issues`, {
    method: "POST",
    headers: GH_HEADERS(cfg.token),
    body: JSON.stringify({
      title: ghSafe(`[${ticket.type}] ${ticket.title}`).slice(0, 256),
      body: buildIssueBody(ticket),
      labels: ["dashboard-request", ticket.type === "feature" ? "enhancement" : "bug"],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`GitHub issue create ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return { issueNumber: data.number, issueUrl: data.html_url };
}

// Neutralize GitHub auto-linking in Slack-user-controlled text: a zero-width
// space after @ / # stops unintended @mentions (which ping real GitHub users)
// and #123 cross-references, without visibly changing the text (Codex R2-F9).
function ghSafe(s) {
  return String(s == null ? "" : s).replace(/@/g, "@​").replace(/#/g, "#​");
}

// Markdown-safe escaping for user-controlled text rendered into the issue
// BODY (the build brief a cloud Claude session executes): a teammate's report
// or a screenshot filename must not be able to restructure it — inject
// headings/lists/tables, break out of a link label, or open a code span.
// Backslash-escapes the CommonMark structural + inline-format chars and
// defuses @mentions (not markdown, so escaping alone won't stop the ping).
// Leaves . - ! + alone so ordinary prose ("v2.0", "drop-down") renders clean.
function mdSafe(s) {
  return String(s == null ? "" : s)
    // `<` is escaped too so raw HTML (<img>, <details>, <!-- comment -->, which
    // GitHub renders) can't be injected into the brief (Codex R2-N2).
    .replace(/([\\`*_{}\[\]()#|<>~])/g, "\\$1")
    .replace(/@/g, "@​");
}

export function buildIssueBody(ticket) {
  const lines = [mdSafe(ticket.body) || "_(no description)_", ""];
  const clar = (ticket.clarifications || []).filter(c => c && (c.q || c.a != null));
  if (clar.length) {
    lines.push("## Clarifications");
    for (const c of clar) {
      if (c.q) lines.push(`- **${mdSafe(c.q)}** — ${mdSafe(c.a ?? "(no answer)")}`);
      else lines.push(`- ${mdSafe(c.a)}`);
    }
    lines.push("");
  }
  const shots = (ticket.screenshots || []).filter(s => s && s.permalink);
  if (shots.length) {
    lines.push("## Screenshots");
    for (const s of shots) lines.push(`- [${mdSafe(s.name || "screenshot")}](${s.permalink})`);
    lines.push("");
  }
  lines.push("---");
  lines.push(`Type: \`${ticket.type}\` · Priority: \`${ticket.priority || "none"}\` · Requested by: ${mdSafe(ticket.requestedBy?.name || "?")}`);
  if (ticket.slack?.permalink) lines.push(`Slack thread: ${ticket.slack.permalink}`);
  lines.push(`Ticket id: \`${ticket.id}\``);
  return lines.join("\n");
}

// Find the ticket whose github.issueNumber matches (single repo). The board is
// small, so a full read + scan is fine. Returns [id, ticket] or null.
export async function findTicketByIssueNumber(issueNumber) {
  const all = await adminGet("/dashboardRequests");
  for (const [id, t] of Object.entries(all || {})) {
    if (t && t.github && t.github.issueNumber === issueNumber) return [id, t];
  }
  return null;
}
