// api/_email/dispatchReviewBatch.js
//
// Shared business logic for sending a ReadyForReview batch email.
//
// Two callers feed into this one function:
//   1. api/send-review-batch.js — the production HTTP endpoint, fired
//      by the Deliveries tab "Share with client" modal.
//   2. scripts/send-review-batch.js — the local-dev CLI for canary
//      testing without a UI.
//
// Both paths build byte-identical email props by routing through this
// helper, so the rendered HTML and idempotency log shape never drift
// between the modal-driven send and the CLI-driven send.
//
// Phase A.5 architecture decision: ReadyForReview's ONLY valid
// production trigger is the producer clicking Send in the Deliveries
// modal. Editors never trigger client emails. notify-finish.js stays
// Slack-only forever.
//
// Hard guards (each throws with `.code` set so callers can map to
// HTTP status codes / CLI exit messages):
//   - project not found           -> code: "no_project"
//   - no clientContact.email      -> code: "no_client_email"
//   - no usable delivery URL      -> code: "no_delivery_url"
//     (NB: missing shortId alone is NOT fatal — buildDeliveryUrl
//     falls back to the legacy `?d={id}` form. The guard only fires
//     when buildDeliveryUrl returns null entirely.)
//
// Soft behaviours:
//   - Empty videoIds + no Ready-for-Review videos in the delivery
//     -> throws code: "no_videos_selected" (refuse to send an email
//     about zero videos; the modal should never reach this state).
//   - videoIds reference IDs not in the delivery -> silently filtered
//     out (rather than throwing). The send proceeds with whatever
//     IDs DID match.

import { getAdmin, adminGet } from "../_fb-admin.js";
import { getProjectContext, resolveAccountManagerChip } from "./getProjectContext.js";
import { send } from "./send.js";

function makeBatchId() {
  // 14-ish char random id scoped to the idempotency key path. Not
  // cryptographically secure — it's a log key, not an auth secret.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeSubject({ count }) {
  // No first-name in subject — common spam-filter heuristic flags
  // overly-personalised subjects from new sender domains. Singular
  // vs. plural to match the template's headline shape.
  if (count > 1) return `Your ${count} videos are ready for review`;
  return "Your video is ready for review";
}

function filterDeliveryVideos(allVideos, requestedIds) {
  // Match by `videoId` first (the stable, externally-shared identifier
  // used in the delivery share URL fragment); fall back to `id` (the
  // legacy local row id) so older records still resolve.
  const wanted = new Set((requestedIds || []).map(String));
  if (wanted.size === 0) {
    // No explicit selection -> auto-pick everything currently flagged
    // Ready for Review. Mirrors what the modal pre-checks. If no
    // video is flagged at all, return empty and let the caller decide
    // (the modal will surface a "nothing to send" inline error;
    // the CLI will throw no_videos_selected).
    return allVideos.filter(v => v?.viewixStatus === "Ready for Review");
  }
  return allVideos.filter(v => {
    if (!v) return false;
    return wanted.has(String(v.videoId)) || wanted.has(String(v.id));
  });
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Dispatch a ReadyForReview batch email.
 *
 * @param {object} args
 * @param {string} args.projectId          Project record ID — required.
 * @param {string[]} [args.videoIds]       Subset of the delivery's videos
 *                                          to include. Match against either
 *                                          `videoId` or `id`. When omitted
 *                                          or empty, all currently-flagged
 *                                          ("Ready for Review") videos are
 *                                          used. Throws if neither path
 *                                          yields any videos.
 * @param {string} [args.producerNote]     Optional free-text note rendered
 *                                          as a styled block at the top
 *                                          of the email body.
 * @param {string} [args.recipientOverride]  When set, sends to this address
 *                                          instead of `clientContact.email`.
 *                                          Used by the CLI for canary
 *                                          testing.
 * @param {string} [args.subjectOverride]  Skip the auto-subject and use
 *                                          this string instead.
 * @returns {Promise<{ state, reason?, messageId?, batchId, idempotencyKey, subject, to }>}
 *          The shape from send() plus the metadata the caller needs to
 *          report back (batchId for the log, subject for the UI, etc.).
 */
export async function dispatchReviewBatch({
  projectId,
  videoIds,
  producerNote = "",
  recipientOverride,
  subjectOverride,
} = {}) {
  if (!projectId) throw err("missing_projectId", "projectId required");

  // /accounts lives separately from getProjectContext. The chip
  // resolver wants the full map. (We could fold this into
  // getProjectContext later if more callers need it.)
  const { db, err: dbErr } = getAdmin();
  if (dbErr) throw err("firebase_init_failed", dbErr);
  const accountsSnap = await db.ref("/accounts").once("value");
  const accounts = accountsSnap.val() || {};

  let ctx;
  try {
    ctx = await getProjectContext(projectId);
  } catch (e) {
    throw err("no_project", e.message);
  }

  if (!ctx.client?.email && !recipientOverride) {
    throw err("no_client_email", `project ${projectId} has no clientContact.email and no recipientOverride supplied`);
  }
  if (!ctx.delivery?.url) {
    throw err("no_delivery_url", `project ${projectId} has no usable delivery URL (buildDeliveryUrl returned null — neither shortId nor id resolved)`);
  }

  const accountManager = resolveAccountManagerChip({
    project: ctx.project,
    accounts,
    editors: ctx.editors,
  });

  const filteredVideos = filterDeliveryVideos(ctx.delivery.videos || [], videoIds);
  if (filteredVideos.length === 0) {
    throw err("no_videos_selected", `no videos to send for project ${projectId} (videoIds did not match and no videos are flagged Ready for Review)`);
  }

  // Map delivery video shape -> template's `videos` prop shape.
  // The template only needs `name` and `videoId`; everything else is
  // dropped to keep the props lean.
  const videos = filteredVideos.map(v => ({
    name: v.name || "Video",
    videoId: v.videoId || v.id || "",
  }));

  const batchId = makeBatchId();
  const idempotencyKey = `${projectId}/ReadyForReview/${batchId}`;
  const to = recipientOverride || ctx.client.email;
  const subject = subjectOverride || makeSubject({ count: videos.length });

  const props = {
    accent: "blue",
    client: {
      firstName: ctx.client.firstName,
      email: to,
    },
    project: ctx.project,
    producer: accountManager, // chip is relabelled to "Account Manager" inside the template
    editor: null,
    delivery: ctx.delivery,
    videos,
    videosCount: videos.length,
    producerNote,
  };

  const result = await send({
    template: "ReadyForReview",
    idempotencyKey,
    to,
    subject,
    props,
    projectId,
  });

  return {
    ...result,
    batchId,
    idempotencyKey,
    subject,
    to,
    videoCount: videos.length,
    videoNames: videos.map(v => v.name),
    accountManager,
  };
}
