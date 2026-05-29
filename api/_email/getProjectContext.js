// api/_email/getProjectContext.js
// Single source of truth for the merge-tag payload that every
// touchpoint email receives. All templates read from the same
// normalised shape so a missing field is missing in exactly one
// place, not four.
//
// The loader is tolerant on purpose:
//   - Missing crew member in /editors            -> recorded in `gaps`, not thrown
//   - Crew member with no phone                  -> recorded in `gaps`, name still rendered
//   - Missing delivery record / shortId          -> deliveryUrl is null (template degrades)
//   - Subtask without location                   -> location is empty string
// Hard errors (project not found, /editors unreadable) propagate to
// the caller so the calling endpoint can decide whether to skip and
// log to Slack or fail loudly.
//
// Templates receive a flat-ish object with everything pre-resolved
// (so JSX doesn't need to do its own data-lookup acrobatics):
//
// {
//   project: { id, shortId, projectName, clientName, dueDate, productLine, packageTier, numberOfVideos, links },
//   client:  { firstName, email },
//   delivery: { id, shortId, slug, url } | null,
//   subtasks: array of all subtasks with parsed dates,
//   shoot:   null OR { id, name, startDate, endDate, startTime, endTime, location, dateLabel, timeLabel, multiDay, crew, gaps },
//   gaps:    array of { kind: "missing_editor" | "missing_phone" | "missing_delivery", detail: "..." }
// }

import { adminGet } from "../_fb-admin.js";
import { buildDeliveryUrl, slugify } from "./deliveryUrl.js";
import { normalizeAvatarUrl } from "../_avatarUrl.js";

// Re-export so existing imports keep working. The implementation moved
// to api/_avatarUrl.js so it can be reused by the client-portal AM
// block (api/_clientRedact.js) too — same URL needs to render in inboxes
// AND on /clients/* / /d/{shortId}.
export { normalizeAvatarUrl };

// Normalise /editors. Stored shape varies between an array and an
// object-keyed-by-index (Firebase RTDB array semantics quirk). Either
// way we collapse to an array of entries with at least { id, name }.
function normaliseEditors(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "object") return Object.values(raw).filter(Boolean);
  return [];
}

// Find a single editor record by id. Tolerant of a few legacy id
// shapes — some older subtask `assigneeIds` use the editor's index
// (string) rather than the explicit id field.
function findEditor(editors, assigneeId) {
  if (!assigneeId) return null;
  const id = String(assigneeId);
  return editors.find(e =>
    String(e?.id) === id ||
    String(e?.uid) === id ||
    String(e?.editorId) === id
  ) || null;
}

// Given an array of `assigneeIds` from a subtask, return:
//   { crew: [{ id, name, phone, role, hasPhone }], gaps: [...] }
// Crew entries are always rendered in the email (by name); a missing
// phone is a soft gap that the template hides per-row but the parent
// email still sends.
export function resolveCrew(editors, assigneeIds) {
  const crew = [];
  const gaps = [];
  const ids = Array.isArray(assigneeIds) ? assigneeIds : [];
  for (const aid of ids) {
    const ed = findEditor(editors, aid);
    if (!ed) {
      gaps.push({ kind: "missing_editor", detail: `assigneeId ${aid} not found in /editors` });
      crew.push({ id: aid, name: "(unassigned)", phone: "", role: "", hasPhone: false });
      continue;
    }
    const phone = (ed.phone || "").trim();
    if (!phone) {
      gaps.push({ kind: "missing_phone", detail: `${ed.name || aid} has no phone in /editors` });
    }
    crew.push({
      id: ed.id || aid,
      name: ed.name || "(unnamed)",
      phone,
      role: ed.role || "",
      hasPhone: !!phone,
      // Slack profile photo from /editors. Used to render a face
      // next to each crew row in the ShootTomorrow email's
      // "Who you'll meet" block. Falls back to initials in the
      // template when missing.
      avatar: normalizeAvatarUrl(ed.avatarUrl || ed.avatar),
    });
  }
  return { crew, gaps };
}

// Resolve the account manager chip for a project. Per Jeremy
// 2026-05-12 the chip MUST carry the AM's mobile so every client
// touchpoint exposes a direct escalation channel.
//
// Resolution order (matches the preview script in
// scripts/render-preview-from-firebase.js):
//   1. accounts[project.links.accountId].accountManager
//   2. project.accountManager
//   3. project.projectLead
//
// Once a name is resolved, look it up (case-insensitive) in
// /editors to attach the Slack avatar URL and phone number.
// Returns null when no name can be resolved at all (chip is then
// hidden in the email — by design).
export function resolveAccountManagerChip({ project, accounts, editors }) {
  let name = null;
  const acctId = project?.links?.accountId;
  const accountsMap = accounts || {};
  if (acctId && accountsMap[acctId]?.accountManager) {
    name = accountsMap[acctId].accountManager;
  } else if (project?.accountManager) {
    name = project.accountManager;
  } else if (project?.projectLead) {
    name = project.projectLead;
  }
  if (!name) return null;
  const list = Array.isArray(editors) ? editors : [];
  const lc = String(name).trim().toLowerCase();
  const editor = list.find(e => (e?.name || "").trim().toLowerCase() === lc);
  return {
    name,
    role: "Account Manager",
    avatar: normalizeAvatarUrl(editor?.avatarUrl || editor?.avatar),
    phone: (editor?.phone || "").trim() || null,
  };
}

// Resolve the recipient list for any project-touchpoint email
// (Confirmation, ShootTomorrow, InEditSuite, ReadyForReview). Returns
// { to, cc } where:
//   - to: the primary client's contact email.
//     Resolution: project.links.accountId → accounts[id].clientContact.email
//     (canonical), falling back to project.clientContact.email (legacy).
//   - cc: every additionalAccountIds entry's clientContact.email, with
//     valid format, deduped, and primary-removed.
//
// Returns to: null when no primary email resolves — callers MUST treat
// that as a skip (don't fire an email to additional clients only).
//
// Email validation is lightweight (looks for an `@`); the boundary that
// matters is whether Resend rejects it, not whether it's RFC5322.
const EMAIL_LIGHT = (s) => typeof s === "string" && s.includes("@") && s.length < 255;

export function resolveProjectEmailRecipients(project, accounts) {
  const accountsMap = accounts || {};
  const acctId = project?.links?.accountId;
  const primaryAccountEmail = acctId && accountsMap[acctId]?.clientContact?.email
    ? accountsMap[acctId].clientContact.email.trim()
    : "";
  const primaryProjectEmail = (project?.clientContact?.email || "").trim();
  // Account record is the canonical source — falls back to the
  // project record for legacy projects predating the schema move.
  const to = EMAIL_LIGHT(primaryAccountEmail)
    ? primaryAccountEmail
    : (EMAIL_LIGHT(primaryProjectEmail) ? primaryProjectEmail : null);

  const additionalIds = Array.isArray(project?.links?.additionalAccountIds)
    ? project.links.additionalAccountIds
    : [];
  const ccSet = new Set();
  for (const id of additionalIds) {
    const acct = accountsMap[id];
    const email = (acct?.clientContact?.email || "").trim();
    if (!EMAIL_LIGHT(email)) continue;
    if (to && email.toLowerCase() === to.toLowerCase()) continue;
    ccSet.add(email);
  }
  return { to, cc: ccSet.size > 0 ? Array.from(ccSet) : null };
}

// Format a date for human reading. `dateStr` is YYYY-MM-DD as stored
// in the subtask. We render in Australia/Sydney conventions because
// every Viewix client is local. Falls back to the raw string if
// parsing fails so the email still sends with imperfect data.
function formatDateLabel(dateStr) {
  if (!dateStr) return "";
  try {
    // Force midday so DST shifts don't flip the day backward.
    const d = new Date(`${dateStr}T12:00:00+10:00`);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-AU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return dateStr;
  }
}

// HH:MM (24h) -> "9:30am" / "2:00pm"
function formatTimeLabel(timeStr) {
  if (!timeStr) return "";
  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return timeStr;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${mm}${ampm}`;
}

// Build a "Friday 17 May from 9:30am to 5:00pm" or "9:30am – 5:00pm"
// depending on which fields are present. Never throws — degrades
// gracefully if any piece is missing.
function buildShootTimeWindow({ startDate, endDate, startTime, endTime }) {
  const sameDay = !endDate || endDate === startDate;
  const sLabel = formatTimeLabel(startTime);
  const eLabel = formatTimeLabel(endTime);
  if (sLabel && eLabel) return `${sLabel} – ${eLabel}`;
  if (sLabel) return `from ${sLabel}`;
  return "";
  // (sameDay flag exposed elsewhere on the shoot object for templates that need it)
}

// Build the shoot context for a specific shoot subtask. Returns the
// flat object that ShootTomorrow templates need.
export function buildShootContext({ subtask, editors }) {
  if (!subtask) return null;
  const { crew, gaps } = resolveCrew(editors, subtask.assigneeIds);
  const multiDay = !!(subtask.endDate && subtask.endDate !== subtask.startDate);
  return {
    id: subtask.id,
    name: subtask.name || "Shoot",
    startDate: subtask.startDate || "",
    endDate: subtask.endDate || subtask.startDate || "",
    startTime: subtask.startTime || "",
    endTime: subtask.endTime || "",
    location: (subtask.location || "").trim(),
    dateLabel: formatDateLabel(subtask.startDate),
    endDateLabel: formatDateLabel(subtask.endDate || subtask.startDate),
    timeLabel: buildShootTimeWindow(subtask),
    multiDay,
    crew,
    gaps,
  };
}

// Project-level loader. Hard-fails if the project doesn't exist.
// Soft-fails on every other piece (delivery, editors) — those go
// into the `gaps` array.
//
// `opts.shootSubtaskId` (optional): if passed, also resolves and
// attaches the shoot context for that subtask.
//
// `opts.editorsCache` (optional): callers (the cron) load /editors
// once per run and pass it in here to avoid hammering Firebase.
export async function getProjectContext(projectId, opts = {}) {
  if (!projectId) throw new Error("projectId required");

  const project = await adminGet(`/projects/${projectId}`);
  if (!project) throw new Error(`project ${projectId} not found`);

  const editorsRaw = opts.editorsCache != null
    ? opts.editorsCache
    : await adminGet("/editors").catch(() => null);
  const editors = normaliseEditors(editorsRaw);

  // Subtasks live nested on the project record. Older records may
  // store them as an array, newer as object-keyed-by-id. Normalise.
  const subtaskRaw = project.subtasks || {};
  const subtasks = Array.isArray(subtaskRaw)
    ? subtaskRaw.filter(Boolean)
    : Object.values(subtaskRaw).filter(Boolean);

  const gaps = [];

  // Resolve delivery if present. Lookup is best-effort; a missing
  // delivery becomes `null` and the ReadyForReview template knows to
  // suppress its CTA (the calling handler should also Slack-log and
  // skip the email entirely — see notify-finish.js).
  let delivery = null;
  const deliveryId = project?.links?.deliveryId;
  if (deliveryId) {
    try {
      const d = await adminGet(`/deliveries/${deliveryId}`);
      if (d) {
        const slug = slugify(`${d.clientName || project.clientName || ""} ${d.projectName || project.projectName || ""}`);
        // Videos array exposed so ReadyForReview senders can filter
        // to the producer-selected subset. Firebase RTDB stores
        // delivery videos as either an array or an object-keyed-by-
        // index — normalise to a plain array of {id, videoId, name,
        // viewixStatus, ...}.
        const rawVideos = d.videos;
        const videos = Array.isArray(rawVideos)
          ? rawVideos.filter(Boolean)
          : (rawVideos && typeof rawVideos === "object" ? Object.values(rawVideos).filter(Boolean) : []);
        delivery = {
          id: d.id || deliveryId,
          shortId: d.shortId || null,
          slug,
          url: buildDeliveryUrl(d) || null,
          clientName: d.clientName || project.clientName || "",
          projectName: d.projectName || project.projectName || "",
          videos,
        };
        if (!delivery.url) gaps.push({ kind: "missing_delivery", detail: `delivery ${deliveryId} has no usable URL (no shortId AND no id)` });
      } else {
        gaps.push({ kind: "missing_delivery", detail: `delivery ${deliveryId} not found` });
      }
    } catch (e) {
      gaps.push({ kind: "missing_delivery", detail: `delivery ${deliveryId} fetch failed: ${e.message}` });
    }
  }

  let shoot = null;
  if (opts.shootSubtaskId) {
    const st = subtasks.find(s => String(s.id) === String(opts.shootSubtaskId));
    if (st) {
      shoot = buildShootContext({ subtask: st, editors });
      if (shoot.gaps.length) gaps.push(...shoot.gaps);
    } else {
      gaps.push({ kind: "missing_subtask", detail: `subtask ${opts.shootSubtaskId} not found on project ${projectId}` });
    }
  }

  return {
    project: {
      id: project.id || projectId,
      shortId: project.shortId || null,
      projectName: project.projectName || "Untitled project",
      clientName: project.clientName || "",
      dueDate: project.dueDate || null,
      productLine: project.productLine || null,
      packageTier: project.packageTier || null,
      numberOfVideos: project.numberOfVideos || null,
      links: project.links || {},
    },
    client: {
      firstName: (project.clientContact?.firstName || "").trim() || "there",
      email: (project.clientContact?.email || "").trim(),
    },
    delivery,
    subtasks,
    editors, // raw for any template that needs deeper crew context
    shoot,
    gaps,
  };
}
