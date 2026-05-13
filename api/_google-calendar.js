// api/_google-calendar.js
// Google Calendar API wrappers for the Viewix shoot-sync worker.
//
// Auth model: OAuth 2.0 refresh token tied to hello@viewix.com.au
// (org-owned generic Workspace inbox). Events appear as created by
// hello@viewix.com.au, invitation emails come from that address.
// No single human's personal account is the bus factor — if anyone
// leaves, a Workspace admin can re-issue the token without breaking
// sync. Service-account-only auth doesn't reliably fire invitation
// emails for external attendees, so it's not viable.
//
// All callers should use sendUpdates: "all" for create/patch/delete
// unless they explicitly want silent removal (the per-shoot toggle-OFF
// "advanced" opt-in). Default "all" — without it, Google does NOT
// send invite emails to attendees, which silently breaks the feature.

import { google } from "googleapis";
import { combineDateTimeSydney } from "./_calendar-utils.js";

// Memoised per cold start. Building the OAuth2 client is cheap, but
// minting an access token from the refresh token is a network call —
// reuse the calendar() instance across invocations within one
// function lifecycle.
let _cachedClient = null;

export function getCalendarClient() {
  if (_cachedClient) return _cachedClient;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN required."
    );
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  _cachedClient = google.calendar({ version: "v3", auth: oauth2 });
  return _cachedClient;
}

function calendarId() {
  const id = process.env.VIEWIX_CALENDAR_ID;
  if (!id) throw new Error("VIEWIX_CALENDAR_ID env var is not set");
  return id;
}

// ─── Payload builder ───────────────────────────────────────────────
// Single source of truth for the event body shape. Both create and
// patch use this — events.patch REPLACES the attendees array (does
// NOT merge), so the payload must always carry the full intended
// attendee list (client + every crew member with an email).
//
// `attendees` is an array of { email } objects already filtered to
// non-empty addresses by the caller.
export function buildEventPayload({ project, subtask, attendees, eventId }) {
  const start = combineDateTimeSydney(subtask.startDate, subtask.startTime);
  const end = combineDateTimeSydney(subtask.endDate, subtask.endTime);
  if (!start || !end) {
    throw new Error("buildEventPayload: invalid start/end datetime — caller must validate via getCalendarSyncDecision first");
  }
  const clientName = project?.clientName || "Client";
  const projectName = project?.projectName || "Project";
  const subtaskName = subtask?.name || "Shoot";

  const descriptionLines = [
    `Shoot for ${projectName}.`,
    subtask.location ? `Location: ${subtask.location}` : "",
    subtask.notes || "",
    `\n— Synced from Viewix dashboard.`,
  ].filter(Boolean);

  const payload = {
    summary: `${clientName}: ${subtaskName}`,
    description: descriptionLines.join("\n"),
    location: subtask.location || "",
    start: { dateTime: start, timeZone: "Australia/Sydney" },
    end: { dateTime: end, timeZone: "Australia/Sydney" },
    attendees,
    reminders: { useDefault: true },
    // Privacy guards. Default Google behaviour leaks crew emails to
    // the client and lets attendees forward invites to anyone —
    // neither is appropriate for client-facing shoot invites.
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: {
      private: {
        source: "viewix-dashboard",
        projectId: String(project?.id || ""),
        subtaskId: String(subtask?.id || ""),
      },
    },
  };
  if (eventId) payload.id = eventId;
  return payload;
}

// ─── CRUD wrappers ─────────────────────────────────────────────────

export async function createShootEvent({ project, subtask, attendees, eventId }) {
  const cal = getCalendarClient();
  const body = buildEventPayload({ project, subtask, attendees, eventId });
  const res = await cal.events.insert({
    calendarId: calendarId(),
    sendUpdates: "all",
    requestBody: body,
  });
  return { id: res.data.id, htmlLink: res.data.htmlLink };
}

export async function updateShootEvent({ eventId, project, subtask, attendees }) {
  const cal = getCalendarClient();
  const body = buildEventPayload({ project, subtask, attendees });
  // events.patch — note attendees array REPLACES, not merges. Caller
  // must pass the FULL intended list every time.
  const res = await cal.events.patch({
    calendarId: calendarId(),
    eventId,
    sendUpdates: "all",
    requestBody: body,
  });
  return { id: res.data.id, htmlLink: res.data.htmlLink };
}

// Idempotent delete — 404 (already gone) and 410 (resource expired)
// are both swallowed. Caller passes sendUpdates: "all" for clean
// cancellation (default) or "none" for silent removal (per-shoot
// toggle-OFF "advanced" opt-in).
export async function deleteShootEvent({ eventId, sendUpdates = "all" }) {
  if (!eventId) return { ok: true, skipped: "no-event-id" };
  const cal = getCalendarClient();
  try {
    await cal.events.delete({
      calendarId: calendarId(),
      eventId,
      sendUpdates,
    });
    return { ok: true };
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 404 || status === 410) return { ok: true, swallowed: status };
    throw e;
  }
}

export async function getEventById({ eventId }) {
  const cal = getCalendarClient();
  const res = await cal.events.get({
    calendarId: calendarId(),
    eventId,
  });
  return res.data;
}
