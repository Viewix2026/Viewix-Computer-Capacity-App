// api/cron/social-schedule-sync.js
//
// 15-minute reconciliation cron. Two jobs:
//
//   1. Items with postAt in the past + status "pending" — webhook
//      may have missed delivery. BEFORE doing anything, query Zernio
//      by clientReferenceId. If Zernio shows the post as published,
//      flip our local status to match. If Zernio shows the post as
//      still pending past its scheduled time, log a warning — that's
//      Zernio-side stuck, not ours.
//
//   2. Per-profile drift check. Poll Zernio's getProfile / listAccounts
//      to catch account disconnects that didn't fire a webhook. (Belt-
//      and-braces — most drops will arrive via webhook, but the cron
//      catches the small fraction that don't.)
//
// Never blindly re-creates posts — Codex review caught that risk.
// The dedupe primitive is findPostByReference: if Zernio has a post
// with our clientReferenceId, it's already there.

import { isAuthorizedCron } from "../_cronAuth.js";
import { adminGet, getAdmin } from "../_fb-admin.js";
import { findPostByReference, getProfile, listAccounts } from "../_zernio.js";

export default async function handler(req, res) {
  const auth = isAuthorizedCron(req);
  if (!auth.authorized) return res.status(401).json({ error: "Unauthorized" });

  const { db, err } = getAdmin();
  if (err) return res.status(500).json({ error: err });

  const now = Date.now();
  let reconciledPosted = 0;
  let reconciledFailed = 0;
  let stuck = 0;
  let accountsChecked = 0;
  let accountDriftFlagged = 0;

  // ─── Job 1: pending-past-due posts ────────────────────────────────
  const schedules = (await adminGet("/socialSchedule")) || {};
  for (const [scheduleId, schedule] of Object.entries(schedules)) {
    if (scheduleId === "byBatchId") continue;
    const items = Array.isArray(schedule?.items) ? schedule.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.status !== "pending") continue;
      const postAtMs = it.postAt ? Date.parse(it.postAt) : NaN;
      if (!Number.isFinite(postAtMs)) continue;
      if (postAtMs > now) continue; // not due yet

      // Look it up on Zernio's side. NEVER blindly re-create.
      let lookup;
      try {
        lookup = await findPostByReference(it.clientReferenceId);
      } catch (e) {
        console.warn(`sync: findPostByReference failed for ${scheduleId}/${i}:`, e.message);
        continue;
      }
      const posts = lookup?.posts || lookup?.data || (Array.isArray(lookup) ? lookup : []);
      const remote = posts && posts[0];

      if (remote?.status === "published" || remote?.status === "posted") {
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          status: "posted",
          publishedAt: Date.parse(remote.published_at || remote.publishedAt) || now,
          permalink: remote.permalink || remote.url || null,
          zernioPostId: remote.id || remote.post_id || it.zernioPostId || null,
        });
        reconciledPosted++;
        continue;
      }
      if (remote?.status === "failed" || remote?.status === "error") {
        await db.ref(`/socialSchedule/${scheduleId}/items/${i}`).update({
          status: "failed",
          failedAt: now,
          failedReason: String(remote.error || remote.reason || "zernio reported failed via sync").slice(0, 500),
        });
        reconciledFailed++;
        continue;
      }
      // Past-due but Zernio still shows pending — flag as stuck so
      // we can investigate (don't change status; producer needs to see
      // it's overdue). Add a stuckSince timestamp the producer
      // dashboard / Phase 6 admin view can surface.
      stuck++;
      await db.ref(`/socialSchedule/${scheduleId}/items/${i}/stuckSince`).set(it.stuckSince || now);
    }
  }

  // ─── Job 2: per-profile account drift ─────────────────────────────
  const profiles = (await adminGet("/zernio/profiles")) || {};
  for (const [accountId, p] of Object.entries(profiles)) {
    if (!p?.profileKey) continue;
    accountsChecked++;
    let accounts;
    try {
      const resp = await listAccounts(p.profileKey);
      accounts = resp?.accounts || resp?.data || (Array.isArray(resp) ? resp : []);
    } catch (e) {
      console.warn(`sync: listAccounts failed for ${accountId}:`, e.message);
      continue;
    }
    if (!Array.isArray(accounts)) continue;
    for (const a of accounts) {
      const platform = String(a.platform || "").toLowerCase();
      if (!platform) continue;
      const status = String(a.status || "").toLowerCase();
      const local = await adminGet(`/zernio/connections/${accountId}/${platform}`);
      const localStatus = local?.status || null;
      const remoteStatus = status === "connected" || status === "active" ? "connected"
        : status === "expiring" ? "expiring"
        : "disconnected";
      if (localStatus !== remoteStatus) {
        await db.ref(`/zernio/connections/${accountId}/${platform}`).update({
          status: remoteStatus,
          lastSyncedAt: now,
        });
        accountDriftFlagged++;
      }
    }
  }

  return res.status(200).json({
    ok: true,
    ranAt: now,
    reconciledPosted,
    reconciledFailed,
    stuck,
    accountsChecked,
    accountDriftFlagged,
  });
}
