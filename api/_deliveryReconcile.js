// api/_deliveryReconcile.js
//
// Two shared helpers used by both the live notify-revision endpoint
// AND the daily-09 cron's reconciler pass.
//
//   1. reconcileDeliveryStatus(deliveryId)
//      Re-derives each video's `viewixStatus` from its settled
//      revision1 / revision2 values. Writes only on diff. Returns
//      { flipped: [{idx, from, to}], allCompleted, delivery }
//      so the caller can decide whether to ping the AM.
//
//      Rule (latest meaningful round wins):
//        latest = revision2 || revision1
//        latest === "Approved"       → viewixStatus = "Completed"
//        latest === "Need Revisions" → viewixStatus = "Need Revisions"
//        latest === ""               → leave alone
//
//      This handles the toggle-back case: R1=Approved + R2=NeedRevisions
//      reads R2 → flips to Need Revisions. R1=NeedRevisions + R2=Approved
//      reads R2 → flips to Completed. R1=Approved + R2=unset reads R1 →
//      Completed.
//
//   2. maybePingAccountManager({ deliveryId })
//      Idempotency-gated: if delivery.allCompletedNotifiedAt is set,
//      returns { skipped: "already_notified" } and writes nothing.
//      Otherwise checks every video has viewixStatus === "Completed",
//      resolves the AM via the linked project's account record,
//      posts a single message to the Account Manager Slack channel
//      (C0ASLSP6UM7), and stamps allCompletedNotifiedAt on success.
//      Failures are logged and swallowed — the live Slack post is the
//      primary user-facing signal and must not be blocked by this.
//
// Both helpers tolerate missing data (no delivery, no videos with
// videoId, no linked project, no AM resolvable). Errors log to
// console.warn / console.error; the helpers never throw to callers.

import { adminGet, adminPatch, adminSet } from "./_fb-admin.js";
import {
  REVISION_APPROVED,
  REVISION_NEED_REVISIONS,
  VIEWIX_STATUS_COMPLETED,
  VIEWIX_STATUS_NEED_REVISIONS,
} from "./_constants.js";
import { slackPostMessage } from "./_slack-helpers.js";
import { buildDeliveryUrl } from "./_email/deliveryUrl.js";
import { resolveAccountManagerChip } from "./_email/getProjectContext.js";

// Hard-coded per Jeremy 2026-05-28: the "Account Manager" Slack channel.
// Lifted to an env var when a second channel needs the same pattern.
const ACCOUNT_MANAGER_CHANNEL_ID = "C0ASLSP6UM7";

// Pure logic: settled revision rounds → desired viewixStatus or null
// (null = "leave alone, don't write anything"). Exported for unit
// testability + reuse if another flow ever needs the same derivation.
export function deriveViewixStatus(video) {
  const r1 = (video?.revision1 || "");
  const r2 = (video?.revision2 || "");
  const latest = r2 || r1;
  if (latest === REVISION_APPROVED) return VIEWIX_STATUS_COMPLETED;
  if (latest === REVISION_NEED_REVISIONS) return VIEWIX_STATUS_NEED_REVISIONS;
  return null;
}

// Re-derive viewixStatus for every video on the delivery from settled
// revision state. Writes only on diff. Returns a summary describing
// what changed + whether the delivery is now fully Completed so the
// caller can decide whether to ping the AM next.
export async function reconcileDeliveryStatus(deliveryId) {
  if (!deliveryId) return { flipped: [], allCompleted: false, delivery: null };
  const delivery = await adminGet(`/deliveries/${deliveryId}`);
  if (!delivery || !Array.isArray(delivery.videos)) {
    return { flipped: [], allCompleted: false, delivery };
  }

  const flipped = [];
  for (let idx = 0; idx < delivery.videos.length; idx++) {
    const v = delivery.videos[idx];
    if (!v || !v.videoId) continue; // pre-migration row — skip
    const next = deriveViewixStatus(v);
    if (!next) continue;
    if (v.viewixStatus === next) continue;
    try {
      await adminSet(`/deliveries/${deliveryId}/videos/${idx}/viewixStatus`, next);
      flipped.push({ idx, videoId: v.videoId, from: v.viewixStatus || null, to: next });
      // Keep our local view of the delivery in sync so allCompleted
      // below sees the new state without a re-read.
      v.viewixStatus = next;
    } catch (e) {
      console.error(
        `reconcileDeliveryStatus: write failed for /deliveries/${deliveryId}/videos/${idx}/viewixStatus`,
        e.message,
      );
    }
  }

  // Empty deliveries don't count as "all completed" — we don't want
  // to ping the AM for a placeholder record with no real videos yet.
  const hasVideos = delivery.videos.some(v => v && v.videoId);
  const allCompleted = hasVideos && delivery.videos.every(v =>
    !v || !v.videoId
      ? true // skip pre-migration rows
      : v.viewixStatus === VIEWIX_STATUS_COMPLETED
  );

  return { flipped, allCompleted, delivery };
}

// One-shot AM ping when every video on the delivery is Completed.
// Stamps delivery.allCompletedNotifiedAt on success so a second pass
// (live + cron) doesn't double-fire.
//
// `delivery` is accepted as an optional param so the caller can pass
// the in-memory copy returned by reconcileDeliveryStatus and avoid a
// second Firebase round-trip.
export async function maybePingAccountManager({ deliveryId, delivery: deliveryPassed }) {
  if (!deliveryId) return { skipped: "no_delivery_id" };
  const delivery = deliveryPassed || await adminGet(`/deliveries/${deliveryId}`);
  if (!delivery) return { skipped: "no_delivery" };
  if (delivery.allCompletedNotifiedAt) return { skipped: "already_notified" };
  if (!Array.isArray(delivery.videos) || delivery.videos.length === 0) {
    return { skipped: "no_videos" };
  }
  const realVideos = delivery.videos.filter(v => v && v.videoId);
  if (realVideos.length === 0) return { skipped: "no_real_videos" };
  const allCompleted = realVideos.every(v => v.viewixStatus === VIEWIX_STATUS_COMPLETED);
  if (!allCompleted) return { skipped: "not_all_completed" };

  // Reverse-lookup the linked project so we can resolve the AM. The
  // delivery itself doesn't carry the AM, only the project does.
  // Reading all projects is fine at Viewix scale (tens, not thousands)
  // and matches the pattern already in notify-revision.js.
  const projectsObj = (await adminGet("/projects")) || {};
  const project = Object.values(projectsObj).find(p =>
    p && (p.links || {}).deliveryId === deliveryId
  );
  if (!project) {
    console.warn(`maybePingAccountManager: no project links to delivery ${deliveryId}`);
    return { skipped: "no_linked_project" };
  }

  const accountsObj = (await adminGet("/accounts")) || {};
  const editorsList = (await adminGet("/editors")) || [];
  const chip = resolveAccountManagerChip({ project, accounts: accountsObj, editors: editorsList });
  if (!chip || !chip.name) {
    console.warn(`maybePingAccountManager: no AM resolvable for delivery ${deliveryId} project ${project.id}`);
    return { skipped: "no_am_resolved" };
  }
  // Find the editor record to get the slackUserId — chip itself
  // doesn't carry it (it carries avatar + phone for emails). Fall
  // back to the plain name in *bold* if we can't resolve a Slack ID.
  const lc = String(chip.name).trim().toLowerCase();
  const editor = (Array.isArray(editorsList) ? editorsList : []).find(
    e => (e?.name || "").trim().toLowerCase() === lc
  );
  const amMention = editor?.slackUserId
    ? `<@${editor.slackUserId}>`
    : `*${escapeSlack(chip.name)}*`;

  const clientName  = escapeSlack(project.clientName || "Client");
  const projectName = escapeSlack(project.projectName || "Project");
  const n = realVideos.length;
  const deliveryUrl = buildDeliveryUrl(delivery);
  const linkSuffix = deliveryUrl ? ` :link: <${deliveryUrl}|Open delivery>` : "";
  const text = `:tada: ${amMention} — *${clientName}* has approved all ${n} video${n === 1 ? "" : "s"} on *${projectName}*. Time for next steps.${linkSuffix}`;

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn("maybePingAccountManager: SLACK_BOT_TOKEN missing — skipping post");
    return { skipped: "no_bot_token" };
  }

  try {
    await slackPostMessage({
      channel: ACCOUNT_MANAGER_CHANNEL_ID,
      text,
      botToken,
    });
  } catch (e) {
    console.error("maybePingAccountManager: slackPostMessage failed", e.message);
    return { skipped: "slack_post_failed", error: e.message };
  }

  // Stamp the idempotency marker only after a successful post. A
  // Slack failure leaves it unset so the next reconcile pass tries
  // again.
  try {
    await adminPatch(`/deliveries/${deliveryId}`, {
      allCompletedNotifiedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("maybePingAccountManager: stamp failed (Slack post succeeded though)", e.message);
    // We posted to Slack, so report success — the next cron pass will
    // see the message in Slack and the stamp missing, and would try
    // again. Acceptable failure mode at Viewix scale (low double-ping
    // risk vs missed-notification risk).
  }
  return { posted: true, am: chip.name };
}

// Slack mrkdwn escaper. Local copy (same shape as notify-revision.js)
// so this module doesn't have to import from a sibling endpoint. Used
// for client-supplied strings (clientName, projectName) before they
// land in the Slack post.
function escapeSlack(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([*_`~|])/g, "​$1");
}
