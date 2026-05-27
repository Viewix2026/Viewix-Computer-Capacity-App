# Phase 4 — Internal Review subsystem (design + build status)

Items #C / #D / #E. Built in this PR: the **verified pure core** + the
**per-video ping switch**. The integration-heavy remainder is **designed
here, not blind-built** — it's the part that can't be verified headlessly
(live Slack round-trips + Google Calendar) and is easy to get subtly
wrong, so it's specced for a confident build + Codex audit, mirroring the
Phase 6 treatment.

## Built + verified in this PR
- `shared/scheduling/reviewPipeline.js` (pure, 9 tests green via
  `node shared/scheduling/__tests__/reviewPipeline.test.mjs`):
  - `projectEditsAllFinished(project)` — true iff the project has ≥1
    video edit (stage edit + `videoId`, **excluding reformats**) and all
    are `done`. This is the gate for kicking off the internal review.
  - `earliestCommonAvailableDay(attendeeIds, editors, weekData, fromDate)`
    — soonest day every confirmed attendee is working; for auto-booking.
  - `isVideoEditSubtask` — the shared definition.
- `api/notify-finish.js` — per-video pings now behind
  `PER_VIDEO_PINGS_ENABLED` (default **on**; set `=false` to silence once
  the aggregate alerts below are proven). Codex's "keep behind a switch".

## To build (designed)

### 1. Trigger — `api/internal-review-trigger.js` (new endpoint)
Fired fire-and-forget from `EditorDashboardViewix.handleSubmit` whenever
an edit subtask is set to `done` (POST `{ projectId }`).
- Auth: authenticated (editors finish edits) — `requireRole` incl. editor.
- Re-read the project; if `!projectEditsAllFinished(project)` → 200 noop.
- **Idempotency:** if `/projects/{id}/notifications/internalReviewPosted`
  is set → 200 noop. Set it when we post.
- Create an **"Internal Review" subtask** (own stage or Revisions, 30-min,
  initially **unscheduled** — date is set on auto-book below), assignees
  = Project Lead + Steve + Jeremy (resolve via accounts/editors + the
  `check-contacts` map for Steve/Jeremy).
- Post **one** interactive message to `#scheduling` (Slack Web API token,
  same client `slack-interactivity.js` uses) with attendance buttons —
  `action_id`s `review_attend_yes` / `review_attend_no`, `value` =
  `{projectId, reviewSubtaskId, editorId}` JSON.

### 2. Attendance + auto-book — extend `api/slack-interactivity.js`
- New `block_actions` branch for `review_attend_yes/no`: record the
  click in `/projects/{id}/subtasks/{reviewId}/attendance/{editorId}` =
  `yes|no`, and `slackUpdateMessage` the card to show running RSVPs.
- **Booking trigger:** a short response window (default ~3h — store
  `attendanceOpenedAt`; a tiny cron tick OR the last-of-3 response closes
  it). On close, `earliestCommonAvailableDay(confirmedAttendeeIds, …)` from
  tomorrow; write the review subtask `startDate`/`endDate` + a default
  `startTime`/`endTime` (e.g. 09:30–10:00) + `status: scheduled`.
- **Calendar invite:** call the calendar module (`createShootEvent` /
  `buildEventPayload` from `api/_google-calendar.js`) — works as-is since
  the review subtask now has date + times + a `clientName: subtaskName`
  summary. Add a thin `createEvent` alias if the shoot-specific naming
  grates. Store the returned `eventId` on the subtask for update/delete.
  (Internal `@viewix.com.au` attendees, so the invite-email caveat in the
  calendar helper doesn't apply.)

### 3. Outcome — #D / #E
- Outcome settable from **both** the review subtask (Approve / Needs
  Changes buttons) **and** the Slack thread (buttons). Either writes
  `/projects/{id}/subtasks/{reviewId}/outcome`.
- **Needs changes →** auto-create an **"Internal Changes"** subtask
  (Revisions stage, Project Lead, next available working day via
  `nextWorkingDayFor`, `dayPriority` appended — reuse the safe placement
  from the reformat fix, not raw 1).
- **Approved →** flip the project to **Ready for Client Delivery**: fire
  the client-ready alert (below) and ensure each video's Frame.io link is
  on its `videoId` in Deliveries. **Do NOT auto-send client emails** —
  `api/send-review-batch.js` stays the only client-email path.

### 4. Client-ready alert — #E
- When the **last** video is marked ready-for-client (existing editor
  Finish "client" path completing the set, or the Approved flow), fire
  **one** Slack alert that the whole project is ready for client review,
  tagging **only the Account Manager**. Idempotent via
  `/projects/{id}/notifications/clientReady`.
- Then flip `PER_VIDEO_PINGS_ENABLED=false` to retire the per-video spam.

## Risks / why designed-not-built
- The Slack attendance round-trip + auto-book + calendar invite can't be
  exercised headlessly — needs a live Slack workspace + the Google
  Calendar creds. Building it blind risks the same throwaway Codex warned
  about for Phase 6.
- The response-window close mechanism (cron vs last-responder) is a small
  design choice to confirm before coding.
