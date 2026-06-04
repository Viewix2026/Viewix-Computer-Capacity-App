// api/send-review-batch.js
//
// Phase A.5 — the producer-driven ReadyForReview send endpoint.
//
// Fires when a producer clicks "Send" inside the Deliveries tab's
// "Share with client" modal. POSTs go through this endpoint, NOT
// through notify-finish.js or any editor flow.
//
// Architecture rule (LOCKED 2026-05-12):
//   ReadyForReview's only valid production trigger is this endpoint,
//   reached via the Deliveries modal. Editors never trigger client
//   emails. notify-finish.js stays Slack-only forever.
//
// Auth:
//   - Firebase ID token via `Authorization: Bearer <token>` header
//   - Allowed roles: founders / founder / lead. **Not editor.**
//
// Request body (JSON):
//   {
//     deliveryId:    string  // delivery record id (required)
//     videoIds:      string[] // subset of the delivery's videos
//                              (each entry matches against
//                              video.videoId OR video.id; empty
//                              array means "all Ready-for-Review
//                              videos in the delivery")
//     producerNote:  string  // optional free-text producer note
//   }
//
// Response (JSON):
//   200 { ok: true, state, messageId?, batchId, ... }
//   400 { ok: false, error: "..." }    invalid request
//   401/403 { ok: false, error: "..." }  auth issues
//   404 { ok: false, error: "..." }    deliveryId not found
//   422 { ok: false, error: "..." }    business validation
//                                       (no_project_for_delivery,
//                                       no_client_email,
//                                       no_delivery_url,
//                                       no_videos_selected)
//   502 { ok: false, error: "..." }    upstream send failure
//   200 { ok: true,  state: "dryRun" } EMAIL_DRY_RUN=true short-circuit
//                                       inside send()

import { adminGet, adminPatch } from "./_fb-admin.js";
import { findProjectForDelivery } from "./_findOwningProject.js";
import { handleOptions, setCors, requireRole, sendAuthError } from "./_requireAuth.js";
import { dispatchReviewBatch } from "./_email/dispatchReviewBatch.js";

// Role allow-list. Deliberately excludes "editor" — the locked rule
// is that editors never trigger client emails. If an editor logs in
// and somehow reaches this endpoint, the role check returns 403.
const ALLOWED_ROLES = ["founders", "manager", "lead"];

// Map dispatchReviewBatch errors to HTTP status codes. Each thrown
// error has a `.code` field set; we look up the status here so the
// modal can render a clean inline message.
const STATUS_BY_CODE = {
  missing_projectId: 400,
  invalid_batchId: 400,
  firebase_init_failed: 500,
  no_project: 404,
  no_client_email: 422,
  no_delivery_url: 422,
  no_videos_selected: 422,
};

// Reverse-lookup: find the project that owns this delivery. Matching
// rules (authoritative link → canonical videoId bridge → strict unique
// name fallback, fail-closed on ambiguity) live in the shared
// findProjectForDelivery() so this and the daily-09 reconciler can't
// drift. We keep the link self-heal write here so a heuristic-matched
// send repairs the link for next time.
//
// At ~50–100 projects this scan is cheap; add a reverse-index in
// Firebase later if latency becomes an issue.
async function findProjectIdForDelivery(deliveryId, delivery) {
  const projectsRaw = await adminGet("/projects").catch(() => null);
  const { projectId, matchedBy, ambiguous } = findProjectForDelivery(projectsRaw, deliveryId, delivery);
  if (ambiguous || !projectId) return null;

  // Repair the link for any heuristic match (videoId / name) — "link"
  // means it was already correct. A write failure must not block the
  // email; the projectId we resolved is still correct.
  if (matchedBy && matchedBy !== "link") {
    try {
      await adminPatch(`/projects/${projectId}/links`, { deliveryId });
      console.log(`[send-review-batch] self-healed link (${matchedBy}): project ${projectId} -> delivery ${deliveryId}`);
    } catch (e) {
      console.warn(`[send-review-batch] link self-heal write failed for project ${projectId}: ${e.message}`);
    }
  }
  return projectId;
}

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  setCors(req, res, "POST, OPTIONS");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  // Auth gate — producers + founders only. Editors get 403.
  let decoded;
  try {
    decoded = await requireRole(req, ALLOWED_ROLES);
  } catch (e) {
    return sendAuthError(res, e);
  }

  // Parse body. Vercel auto-parses JSON when Content-Type is set;
  // fall back to manual parse for non-JSON callers.
  let body;
  try {
    body = typeof req.body === "object" && req.body !== null
      ? req.body
      : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const deliveryId = (body.deliveryId || "").toString().trim();
  const videoIds = Array.isArray(body.videoIds)
    ? body.videoIds.map(v => String(v).trim()).filter(Boolean)
    : [];
  const producerNote = String(body.producerNote || "").slice(0, 2000); // soft cap
  // batchId is client-minted (one per modal open). Same value on every
  // retry/double-click means the second POST hits the existing /emailLog
  // lock and short-circuits to skipped:already_sent. Format validated
  // again inside dispatchReviewBatch — the regex check here is just to
  // surface a clean 400 instead of a 500 if a malformed value arrives.
  const batchId = body.batchId != null ? String(body.batchId).trim() : "";
  if (batchId && !/^[a-zA-Z0-9-]{6,40}$/.test(batchId)) {
    return res.status(400).json({ ok: false, error: "invalid_batchId", detail: "batchId must be 6-40 chars, alphanumerics + hyphens only" });
  }

  if (!deliveryId) {
    return res.status(400).json({ ok: false, error: "deliveryId required" });
  }

  // Confirm the delivery actually exists before doing the project
  // scan — clearer 404 than "no project found" when the operator
  // pasted the wrong id.
  let delivery;
  try {
    delivery = await adminGet(`/deliveries/${deliveryId}`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `delivery lookup failed: ${e.message}` });
  }
  if (!delivery) {
    return res.status(404).json({ ok: false, error: "delivery_not_found", deliveryId });
  }

  // Reverse-lookup: which project owns this delivery? Required because
  // /emailLog and getProjectContext both key on projectId.
  let projectId;
  try {
    projectId = await findProjectIdForDelivery(deliveryId, delivery);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `project lookup failed: ${e.message}` });
  }
  if (!projectId) {
    return res.status(422).json({
      ok: false,
      error: "no_project_for_delivery",
      detail: `delivery ${deliveryId} is not linked to any project, and no single project uniquely matches its clientName + projectName ("${delivery.clientName || ""}" / "${delivery.projectName || ""}"). Check the delivery's client/project names match the project record exactly, or set project.links.deliveryId.`,
      deliveryId,
    });
  }

  // Hand off to the shared helper. Throws with `.code` on each
  // validation failure; map to clean HTTP responses.
  let result;
  try {
    result = await dispatchReviewBatch({
      projectId,
      videoIds,
      producerNote,
      batchId: batchId || undefined, // empty string -> let helper mint a server id (no client batchId case)
    });
  } catch (e) {
    const status = STATUS_BY_CODE[e.code] || 500;
    return res.status(status).json({
      ok: false,
      error: e.code || "dispatch_error",
      detail: e.message,
      projectId,
      deliveryId,
    });
  }

  // send() result handling. Two non-success states are still 200s:
  //   - state: "dryRun" -> the dry-run path ran successfully (UI
  //     shows "Dry-run logged"). Distinct from a "send failure".
  //   - state: "skipped" -> idempotency lock already held (in-flight
  //     or already-sent). Surface to UI so producer knows.
  //   - state: "noop" with reason "kill_switch" -> CLIENT_EMAILS_ENABLED=false
  if (result.state === "failed") {
    return res.status(502).json({
      ok: false,
      error: "send_failed",
      detail: result.reason || "unknown",
      batchId: result.batchId,
      projectId,
      deliveryId,
    });
  }

  return res.status(200).json({
    ok: true,
    state: result.state, // "sent" | "dryRun" | "skipped" | "noop"
    reason: result.reason || null,
    messageId: result.messageId || null,
    batchId: result.batchId,
    subject: result.subject,
    to: result.to,
    videoCount: result.videoCount,
    projectId,
    deliveryId,
    invokedBy: decoded.uid || null,
  });
}
