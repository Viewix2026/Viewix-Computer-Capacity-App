// src/calendar-sync.js
// Client-side helpers + React context for the Google Calendar
// shoot-sync feature. Lives outside Projects.jsx so TeamBoard.jsx
// can import the same helpers without a circular dep.
//
// The actual sync work happens server-side in
// api/sync-shoot-calendar.js. This file is just the producer's
// side: enqueueing /calendarSyncQueue entries the worker picks up.

import { createContext } from "react";
import { fbSet, fbUpdate } from "./firebase";

// Live /calendarSyncQueue listener output. App.jsx wires
// useCalendarSyncQueue().calendarSyncQueue through this. Default
// empty Map so non-admin roles (who can't read the queue) and SSR
// don't crash.
export const CalendarSyncContext = createContext(new Map());

// 5-minute debounce window. Any edit to a shoot subtask resets dueAt
// to now+5min, giving producers a buffer to fix typos before invites
// land in clients' inboxes.
export const CALENDAR_SYNC_DEBOUNCE_MS = 5 * 60 * 1000;

// Days-from-today within which an unschedule prompts a confirmation
// dialog (TeamBoard). Far-future reshuffles skip the prompt.
export const CANCELLATION_PROMPT_DAYS = 7;

// Shoot-relevant fields. Editing any of these on a shoot subtask
// (or one that USED to be a shoot) enqueues a calendar-sync entry.
export const CALENDAR_RELEVANT_FIELDS = new Set([
  "stage", "startDate", "endDate", "startTime", "endTime",
  "assigneeIds", "assigneeId", "location", "name", "notes",
  "syncToCalendar",
]);

// Push a /calendarSyncQueue/<projectId>__<subtaskId> entry so the
// every-minute worker picks the change up after the 5-min debounce.
// Idempotent — re-queueing overwrites dueAt (that IS the debounce).
// Skips non-shoot subtasks unless there's an existing event to clean
// up (stage flip → "edit" must trigger a delete).
export function enqueueCalendarSync({ projectId, prevSubtask, nextSubtask, reason }) {
  if (!projectId || !nextSubtask?.id) return;
  const stageWasShoot = prevSubtask?.stage === "shoot";
  const stageIsShoot = nextSubtask?.stage === "shoot";
  const hasExistingEvent = !!(nextSubtask?.calendarEventId || prevSubtask?.calendarEventId);
  if (!stageWasShoot && !stageIsShoot && !hasExistingEvent) return;
  const now = new Date().toISOString();
  const key = `${projectId}__${nextSubtask.id}`;
  fbUpdate(`/calendarSyncQueue/${key}`, {
    projectId,
    subtaskId: nextSubtask.id,
    action: "sync",
    calendarEventId: null,
    dueAt: new Date(Date.now() + CALENDAR_SYNC_DEBOUNCE_MS).toISOString(),
    reason: reason || "subtask-edit",
    attempts: 0,
    lockedUntil: null,
    lockOwner: null,
    updatedAt: now,
  });
}

// Fan-out — enqueue a sync entry for every FUTURE-scheduled shoot
// subtask on the project. Used when a project-level field that feeds
// the event payload (clientName / projectName / clientContact.email)
// changes. Past shoots skipped.
export function fanOutCalendarSync({ project, reason }) {
  if (!project?.id || !project.subtasks) return;
  const nowMs = Date.now();
  for (const st of Object.values(project.subtasks)) {
    if (!st || st.stage !== "shoot") continue;
    if (!st.startDate) continue;
    const endStamp = (st.endDate && st.endTime)
      ? `${st.endDate}T${st.endTime}`
      : `${st.startDate}T${st.startTime || "23:59"}`;
    const endMs = Date.parse(endStamp);
    if (Number.isFinite(endMs) && endMs <= nowMs) continue;
    enqueueCalendarSync({ projectId: project.id, prevSubtask: st, nextSubtask: st, reason: reason || "project-edit" });
  }
}

// Editor-email fan-out — when a producer updates an editor's email in
// Capacity → Team Roster, every future-scheduled shoot the editor is
// on needs its event re-published (new email invited, old dropped).
export function fanOutForEditorEmail({ editorId, projects }) {
  if (!editorId || !Array.isArray(projects)) return;
  const nowMs = Date.now();
  for (const p of projects) {
    if (!p?.id || !p.subtasks) continue;
    for (const st of Object.values(p.subtasks)) {
      if (!st || st.stage !== "shoot") continue;
      if (!st.startDate) continue;
      const assignees = Array.isArray(st.assigneeIds) ? st.assigneeIds : [];
      if (!assignees.includes(editorId)) continue;
      const endStamp = (st.endDate && st.endTime)
        ? `${st.endDate}T${st.endTime}`
        : `${st.startDate}T${st.startTime || "23:59"}`;
      const endMs = Date.parse(endStamp);
      if (Number.isFinite(endMs) && endMs <= nowMs) continue;
      enqueueCalendarSync({ projectId: p.id, prevSubtask: st, nextSubtask: st, reason: "editor-edit" });
    }
  }
}

// Atomic delete-subtask intercept. If the subtask has a calendar
// event, push a "delete" queue entry (eventId cached) AND null the
// subtask row in ONE multi-path fbUpdate at the root ref. RTDB
// atomicity prevents an orphan calendar event if the network blips.
export function deleteSubtaskWithCalendarCleanup({ projectId, subtask, setProjects }) {
  if (!projectId || !subtask?.id) return;
  if (typeof setProjects === "function") {
    setProjects(prev => prev.map(pp => {
      if (!pp || pp.id !== projectId) return pp;
      const subs = { ...(pp.subtasks || {}) };
      delete subs[subtask.id];
      return { ...pp, subtasks: subs, updatedAt: new Date().toISOString() };
    }));
  }
  if (subtask.calendarEventId) {
    const key = `${projectId}__${subtask.id}`;
    const now = new Date().toISOString();
    fbUpdate("/", {
      [`calendarSyncQueue/${key}`]: {
        projectId,
        subtaskId: subtask.id,
        action: "delete",
        calendarEventId: subtask.calendarEventId,
        dueAt: now, // immediate; no debounce on a deletion
        reason: "subtask-deleted",
        attempts: 0,
        lockedUntil: null,
        lockOwner: null,
        updatedAt: now,
      },
      [`projects/${projectId}/subtasks/${subtask.id}`]: null,
    });
  } else {
    fbSet(`/projects/${projectId}/subtasks/${subtask.id}`, null);
  }
}
