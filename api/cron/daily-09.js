// api/cron/daily-09.js
// Single daily cron, fires at 09:00 Sydney (Australia/Sydney). Three
// passes run in order; each in its own try/catch so one pass's
// failure can't kill the others.
//
//   Pass 1 — Shoot Tomorrow scan
//     For every shoot-stage subtask where startDate === tomorrow,
//     send the shoot-tomorrow client email. Same-day fallback: if
//     startDate === today and no prior log entry, post to Slack
//     #scheduling instead (booking happened too late for a
//     "tomorrow" email).
//
//   Pass 2 — Auto-progress
//     Subtasks where startDate === today AND status === "scheduled"
//     flip to status: "inProgress". One-way; never auto-flips out
//     of inProgress, done, stuck, onHold, or waitingClient.
//
//   Pass 3 — In the Edit Suite scan
//     Projects that now have at least one edit-stage subtask in
//     "inProgress" and no prior /emailLog/{projectId}/InEditSuite
//     entry get the email. Project-level idempotency.
//
// Cron schedule: vercel.json sets two entries — 22:00 UTC (AEDT) and
// 23:00 UTC (AEST). Both fire daily; the handler bails immediately
// unless the Sydney local hour is 9. This eliminates DST drift.
//
// Auth: production must hit either:
//   - x-vercel-cron header (Vercel cron platform sets this), or
//   - ?secret=$CRON_TEST_SECRET (manual / scripted testing)
// Anything else returns 401.
//
// Test-only overrides (only effective when ?secret is valid):
//   &force=1               -> skip the 09:00-Sydney guard (run any hour)
//   &today=YYYY-MM-DD      -> override "today" for fixture testing
//                             (tomorrow is computed from this)
//   &dryRunReport=1        -> return a per-pass summary instead of an
//                             aggregate count (handy for fixture diffs)
//   &skipAutoProgress=1    -> skip Pass 2 entirely. ESSENTIAL when
//                             manually invoking the cron against
//                             production with a `today=` override:
//                             Pass 2 writes status:"inProgress" to
//                             real subtasks regardless of
//                             EMAIL_DRY_RUN. Without this flag, a
//                             test invocation like
//                             ?secret=…&force=1&today=2026-05-19
//                             on production would flip every
//                             scheduled subtask with startDate=
//                             2026-05-19 to inProgress, even
//                             though you only wanted to preview
//                             the emails. EMAIL_DRY_RUN does NOT
//                             gate Pass 2 — only the email send.

import { adminGet, adminPatch, adminSet } from "../_fb-admin.js";
import { send, newCounters, postCronSummary } from "../_email/send.js";
import { getProjectContext, buildShootContext } from "../_email/getProjectContext.js";

// Subject lines (locked 2026-05-13 per Codex audit — these match the
// template body headlines and Jeremy's approved copy):
//   - Confirmation:    "You're booked in"
//   - ShootTomorrow:   "Excited to shoot tomorrow, {firstName}!" (or without name if missing)
//   - InEditSuite:     "It's in the edit suite"
//   - ReadyForReview:  set per-send in dispatchReviewBatch.js (singular vs batch)
// No emoji in v1 — protects deliverability from a new sender domain.
const SUBJECTS = {
  Confirmation: "You're booked in",
  ShootTomorrow: (firstName) => firstName
    ? `Excited to shoot tomorrow, ${firstName}!`
    : "Excited to shoot tomorrow!",
  InEditSuite: "It's in the edit suite",
};

// Subtask status whitelists for shoot-tomorrow eligibility. `stuck`
// is excluded because it now means "actively blocked" — a cheerful
// shoot-tomorrow email on a blocked shoot is dangerous.
const SHOOT_OK_STATUS = new Set(["scheduled", "inProgress", "waitingClient"]);

// Sydney date helpers. We only need YYYY-MM-DD strings to compare
// against subtask startDate, so the heavy lifting is just a TZ-aware
// formatter. Cron always runs at 22:00 or 23:00 UTC (= 09:00 AEDT
// or AEST respectively), well past the 03:00 DST transition window,
// so adding 24 UTC hours to "now" reliably produces "Sydney
// tomorrow".
function sydneyToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function addDay(yyyymmdd, delta) {
  const d = new Date(`${yyyymmdd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function sydneyHour() {
  return parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Sydney",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
    10
  );
}

// Helper: read all projects. RTDB returns object-keyed-by-id which
// is what we want here for direct project lookup.
async function readAllProjects() {
  const all = await adminGet("/projects");
  if (!all) return {};
  return all;
}

// Normalise subtasks (array vs object form, mirrors the same logic
// in getProjectContext but without resolving editors — the cron
// passes their own editorsCache through).
function listSubtasks(project) {
  const raw = project?.subtasks;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.values(raw).filter(Boolean);
}

// Slack post for the same-day-shoot fallback. Goes to #scheduling so
// the producers monitoring shoot logistics see it; they decide
// whether to reach out manually.
async function postSchedulingAlert(line) {
  const url = process.env.SLACK_SCHEDULING_WEBHOOK_URL;
  if (!url) {
    console.warn("daily-09: SLACK_SCHEDULING_WEBHOOK_URL not set — same-day shoot alert dropped");
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line }),
    });
  } catch (e) {
    console.warn("daily-09 postSchedulingAlert failed:", e.message);
  }
}

// ─── Pass 1: shoot-tomorrow scan + same-day fallback ────────────
async function passShootTomorrow({ projects, editors, today, tomorrow }) {
  const counters = newCounters();
  let evaluated = 0;
  let sameDaySkipped = 0;

  for (const [projectId, project] of Object.entries(projects)) {
    if (!project) continue;
    const subtasks = listSubtasks(project);

    for (const st of subtasks) {
      if (st.stage !== "shoot") continue;
      const start = st.startDate || "";

      // The "tomorrow" path — main case.
      if (start === tomorrow) {
        evaluated++;
        if (!SHOOT_OK_STATUS.has(st.status)) {
          counters.skipped_missing++;
          continue;
        }
        const clientEmail = (project.clientContact?.email || "").trim();
        if (!clientEmail) {
          counters.skipped_missing++;
          continue;
        }
        if (!st.id) {
          counters.skipped_missing++;
          continue;
        }
        const shoot = buildShootContext({ subtask: st, editors });
        const ctx = {
          project: {
            id: project.id || projectId,
            projectName: project.projectName || "Untitled project",
            clientName: project.clientName || "",
            numberOfVideos: project.numberOfVideos || null,
          },
          client: {
            firstName: (project.clientContact?.firstName || "").trim() || "there",
            email: clientEmail,
          },
          shoot,
        };
        await send({
          template: "ShootTomorrow",
          idempotencyKey: `${projectId}/ShootTomorrow/${st.id}/${start}`,
          to: clientEmail,
          subject: SUBJECTS.ShootTomorrow(ctx.client.firstName),
          props: ctx,
          projectId,
          counters,
        });
        continue;
      }

      // Same-day fallback: shoot is today, no prior log entry exists.
      // Post to Slack #scheduling and mark the log entry so we never
      // re-fire this case (or send a real client email later).
      if (start === today && st.id) {
        const logKey = `${projectId}/ShootTomorrow/${st.id}/${start}`;
        const prior = await adminGet(`/emailLog/${logKey}`).catch(() => null);
        if (prior) continue; // already handled (sent yesterday, or already skipped today)

        // Don't alert if the shoot status excludes us (stuck/done/onHold).
        if (!SHOOT_OK_STATUS.has(st.status)) continue;

        const clientName = project.clientName || "(unknown client)";
        const projectName = project.projectName || "(untitled project)";
        const startTime = st.startTime || "(time TBC)";
        await postSchedulingAlert(
          `:hourglass_flowing_sand: Shoot today for *${clientName} / ${projectName}* at *${startTime}* — booked too late for a day-before client email. Producer to handle client comms manually if needed.`
        );
        await adminSet(`/emailLog/${logKey}`, {
          state: "skippedSameDay",
          template: "ShootTomorrow",
          projectId,
          subtaskId: st.id,
          startDate: start,
          notedAt: Date.now(),
        });
        sameDaySkipped++;
      }
    }
  }

  return { counters, evaluated, sameDaySkipped };
}

// ─── Pass 2: auto-progress ──────────────────────────────────────
// Find subtasks with startDate === today AND status === "scheduled"
// and flip them to "inProgress". Bumps subtask.updatedAt and
// project.updatedAt so "recently touched" views stay accurate.
async function passAutoProgress({ projects, today }) {
  let touched = 0;
  let projectsTouched = 0;
  const now = new Date().toISOString();

  for (const [projectId, project] of Object.entries(projects)) {
    if (!project) continue;
    const raw = project?.subtasks;
    if (!raw) continue;
    const isArray = Array.isArray(raw);

    let projectChanged = false;

    if (isArray) {
      for (let i = 0; i < raw.length; i++) {
        const st = raw[i];
        if (!st) continue;
        if (st.startDate === today && st.status === "scheduled") {
          await adminPatch(`/projects/${projectId}/subtasks/${i}`, {
            status: "inProgress",
            updatedAt: now,
          });
          touched++;
          projectChanged = true;
        }
      }
    } else {
      for (const [key, st] of Object.entries(raw)) {
        if (!st) continue;
        if (st.startDate === today && st.status === "scheduled") {
          await adminPatch(`/projects/${projectId}/subtasks/${key}`, {
            status: "inProgress",
            updatedAt: now,
          });
          touched++;
          projectChanged = true;
        }
      }
    }

    if (projectChanged) {
      await adminPatch(`/projects/${projectId}`, { updatedAt: now });
      projectsTouched++;
    }
  }
  return { touched, projectsTouched };
}

// ─── Pass 3: in-edit-suite scan ─────────────────────────────────
// Reads (post-Pass-2) project state. Any project that now has at
// least one edit-stage subtask in "inProgress" AND has no
// /emailLog/{projectId}/InEditSuite log entry sends one email.
async function passInEditSuite({ projects, editors }) {
  const counters = newCounters();

  for (const [projectId, project] of Object.entries(projects)) {
    if (!project) continue;
    // Re-read the project — Pass 2 may have just flipped a subtask
    // to inProgress, and the in-memory `projects` snapshot is stale.
    const fresh = await adminGet(`/projects/${projectId}`).catch(() => null);
    if (!fresh) continue;
    const subtasks = listSubtasks(fresh);
    const hasActiveEdit = subtasks.some(s => s.stage === "edit" && s.status === "inProgress");
    if (!hasActiveEdit) continue;

    const logKey = `${projectId}/InEditSuite`;
    const prior = await adminGet(`/emailLog/${logKey}`).catch(() => null);
    if (prior) continue; // already sent OR previously suppressed (legacy or otherwise)

    const clientEmail = (fresh.clientContact?.email || "").trim();
    if (!clientEmail) {
      counters.skipped_missing++;
      continue;
    }

    const props = {
      client: {
        firstName: (fresh.clientContact?.firstName || "").trim() || "there",
        email: clientEmail,
      },
      project: {
        id: fresh.id || projectId,
        projectName: fresh.projectName || "your project",
        numberOfVideos: fresh.numberOfVideos || null,
      },
    };

    await send({
      template: "InEditSuite",
      idempotencyKey: logKey,
      to: clientEmail,
      subject: SUBJECTS.InEditSuite,
      props,
      projectId,
      counters,
    });
  }
  return { counters };
}

// ─── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // Auth — must be either Vercel cron or a valid secret.
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const querySecret = (typeof req.query?.secret === "string"
    ? req.query.secret
    : new URL(req.url, "http://x").searchParams.get("secret")) || "";
  const expectedSecret = process.env.CRON_TEST_SECRET || "";
  const secretValid = !!expectedSecret && querySecret === expectedSecret;
  if (!isVercelCron && !secretValid) {
    return res.status(401).json({ error: "Cron header or valid ?secret required" });
  }

  // Test-only overrides (require valid secret).
  const url = new URL(req.url, "http://x");
  const force = secretValid && url.searchParams.get("force") === "1";
  const todayOverride = secretValid ? (url.searchParams.get("today") || "") : "";
  const dryRunReport = secretValid && url.searchParams.get("dryRunReport") === "1";
  const skipAutoProgress = secretValid && url.searchParams.get("skipAutoProgress") === "1";

  // Belt-and-braces: if a `today=` override was passed AND we're not
  // explicitly opting in to auto-progress writes, refuse Pass 2.
  // A `today=` override on production means the caller is testing,
  // not running the real daily flow. Pass 2 would mutate real
  // subtasks based on a fake "today" — almost never the desired
  // behaviour for a test. Caller can re-enable Pass 2 explicitly by
  // setting `skipAutoProgress=0` (explicit opt-in) if they really
  // want the date override AND the writes.
  const skipAutoProgressEffective =
    skipAutoProgress ||
    (todayOverride && url.searchParams.get("skipAutoProgress") !== "0");

  // Time guard. The Vercel platform fires both 22:00 UTC and 23:00
  // UTC entries every day, but only one will be 09:00 in Sydney.
  // Without &force=1, the wrong-time fire returns immediately.
  if (!force) {
    const hr = sydneyHour();
    if (hr !== 9) {
      return res.status(200).json({ ok: true, skipped: "wrong_hour", sydneyHour: hr });
    }
  }

  const today = todayOverride || sydneyToday();
  const tomorrow = addDay(today, 1);

  const summary = {
    today,
    tomorrow,
    pass1: null,
    pass2: null,
    pass3: null,
  };

  // Pre-load /editors once. Pass 1 needs it for crew resolution;
  // Passes 2 and 3 don't touch editors but it's cheap to cache.
  let editors;
  try {
    editors = (await adminGet("/editors")) || [];
  } catch (e) {
    editors = [];
    console.warn("daily-09: /editors load failed:", e.message);
  }
  let projects;
  try {
    projects = await readAllProjects();
  } catch (e) {
    // Hard fail at the projects-read step — without /projects there's
    // no work for any pass to do. Return 500 so the Vercel cron log
    // surfaces it and Slack-log so a human notices.
    console.error("daily-09: /projects load failed:", e.message);
    return res.status(500).json({ error: `projects load failed: ${e.message}` });
  }

  // Pass 1 — Shoot Tomorrow + same-day fallback
  try {
    const r = await passShootTomorrow({ projects, editors, today, tomorrow });
    summary.pass1 = {
      evaluated: r.evaluated,
      sameDaySkipped: r.sameDaySkipped,
      counters: r.counters,
    };
    await postCronSummary("daily-09 · Pass 1 ShootTomorrow", r.counters);
  } catch (e) {
    console.error("daily-09 Pass 1 failed:", e);
    summary.pass1 = { error: e.message };
  }

  // Pass 2 — Auto-progress
  // Skipped when `skipAutoProgress=1` OR when a `today=` override is
  // passed without explicit `skipAutoProgress=0`. Pass 2 mutates real
  // subtasks (status: "inProgress") and is NOT gated by EMAIL_DRY_RUN
  // — only the email send is gated there. Letting a fake `today=`
  // drive real writes would be a footgun.
  if (skipAutoProgressEffective) {
    summary.pass2 = { skipped: skipAutoProgress ? "skipAutoProgress=1" : "today_override_without_explicit_optIn" };
  } else {
    try {
      const r = await passAutoProgress({ projects, today });
      summary.pass2 = r;
    } catch (e) {
      console.error("daily-09 Pass 2 failed:", e);
      summary.pass2 = { error: e.message };
    }
  }

  // Pass 3 — In Edit Suite (re-reads each project to pick up Pass 2 writes)
  try {
    const r = await passInEditSuite({ projects, editors });
    summary.pass3 = { counters: r.counters };
    await postCronSummary("daily-09 · Pass 3 InEditSuite", r.counters);
  } catch (e) {
    console.error("daily-09 Pass 3 failed:", e);
    summary.pass3 = { error: e.message };
  }

  if (dryRunReport) return res.status(200).json({ ok: true, summary });
  return res.status(200).json({ ok: true, today, tomorrow });
}
