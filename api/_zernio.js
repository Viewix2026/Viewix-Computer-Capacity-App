// api/_zernio.js
//
// Zernio API client wrapper. Vercel-side surface only — the Mac Mini
// worker (workers/social-asset-transfer/) maintains its own Frame.io
// + Zernio client code in that subdirectory because it streams large
// binary payloads that don't belong inside a Vercel function.
//
// Why a wrapper at all: keeps every Vercel endpoint that touches
// Zernio (provision-profile, schedule-posting-batch, webhook,
// schedule-item-reschedule, schedule-item-cancel, social-asset-requeue,
// the daily sync cron, the client-portal reconnect-url subroute) on
// the same auth + base-URL + error-shape contract. A schema change
// from Zernio lands here once, not in eight files.
//
// ─── Sales-confirmation pedigree ────────────────────────────────────
// Confirmed by Zernio support (2026-05-20) before this code was
// written:
//   • IG Reels publish directly (true scheduled publish, not draft /
//     reminder). `trialParams.graduationStrategy: "MANUAL"` makes the
//     Reel land as a Trial Reel (non-followers only) — graduation
//     back to followers happens manually in the IG app, which is a
//     Meta API limitation, not a Zernio one.
//   • Zernio holds the audited TikTok Content Posting API credentials.
//     Clients post publicly via DIRECT_POST out of the box — Viewix
//     does NOT need its own audited TikTok developer app. Two
//     associated caveats (both surfaced in Phase 3 modal):
//       (a) per-post `privacy_level` must come from TikTok's allowed
//           options per creator, fetched via `creator_info/query`.
//       (b) TikTok compliance fields (commercial-content disclosure,
//           branded-content toggle, music-usage consent) must be
//           surfaced in the integrator UI before posting.
//
// Pending at time of writing:
//   • Q3 — SLA / uptime guarantees.
//   • Q4 — Company sustainability / runway.
// Neither of those affects code shape, so build proceeds.
//
// ─── Verifications still owed before going live ─────────────────────
// 1. Zernio's update-post endpoint shape (`updatePost` below assumes
//    PATCH /posts/{id}; if Zernio only supports cancel-and-recreate,
//    `schedule-item-reschedule.js` falls back to that via cancelPost +
//    createPost with a fresh clientReferenceId).
// 2. The exact endpoint paths + field names against Zernio's current
//    docs at https://docs.zernio.com. The shapes used here match the
//    contract surfaced in the planning conversation; treat any
//    discrepancy against live docs as something to fix here rather
//    than in callers.
//
// ─── Env ────────────────────────────────────────────────────────────
//   ZERNIO_API_KEY        Bearer token. Required.
//   ZERNIO_WEBHOOK_SECRET HMAC secret for inbound webhook verification.
//                         Read directly by api/zernio-webhook.js — not
//                         used in this file. Documented here so all the
//                         Zernio env vars live in one mental space.
//   ZERNIO_BASE_URL       Optional override. Defaults to the documented
//                         v1 base; override is useful for Zernio's
//                         staging environment during the verification
//                         pilot.

const DEFAULT_BASE_URL = "https://api.zernio.com/v1";

function baseUrl() {
  return process.env.ZERNIO_BASE_URL || DEFAULT_BASE_URL;
}

function apiKey() {
  const k = process.env.ZERNIO_API_KEY;
  if (!k) {
    const err = new Error("ZERNIO_API_KEY env var is not set");
    err.code = "ZERNIO_NO_API_KEY";
    throw err;
  }
  return k;
}

// Core fetch wrapper. Every Zernio call routes through this so error
// surfaces look identical across endpoints + cron paths. Throws on
// non-2xx; the caller decides whether to swallow, retry, or surface.
async function zernio(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const url = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${apiKey()}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // AbortController-backed timeout. Zernio publishes durable jobs;
  // individual API calls should be fast (< 10s typically). 30s is the
  // generous outer bound for slow paths like createPost which uploads
  // a small descriptor payload but does no media transfer.
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    if (e.name === "AbortError") {
      const err = new Error(`Zernio ${method} ${path} timed out after ${timeoutMs}ms`);
      err.code = "ZERNIO_TIMEOUT";
      throw err;
    }
    const err = new Error(`Zernio ${method} ${path} network error: ${e.message}`);
    err.code = "ZERNIO_NETWORK";
    throw err;
  }
  clearTimeout(tid);

  // Parse safely — Zernio returns JSON on every documented success
  // and error response, but a 502 from their edge could be HTML. Fall
  // back to a text snippet so the error surface is still useful.
  let json = null;
  const text = await resp.text();
  if (text) {
    try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 500) }; }
  }

  if (!resp.ok) {
    const err = new Error(
      `Zernio ${method} ${path} ${resp.status}: ${json?.error?.message || json?._raw || resp.statusText}`
    );
    err.code = `ZERNIO_${resp.status}`;
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ─── Profiles ───────────────────────────────────────────────────────
// A Zernio "profile" represents one Viewix client. Multiple social
// accounts (IG, TikTok, YT, LinkedIn) hang off a single profile. We
// store the returned `profileKey` at /zernio/profiles/{accountId} and
// pass it on every subsequent call for that client.

export async function createProfile({ name, externalRef } = {}) {
  if (!name) throw new Error("createProfile: name required");
  return zernio("/profiles", {
    method: "POST",
    body: { name, external_ref: externalRef || null },
  });
}

export async function getProfile(profileKey) {
  if (!profileKey) throw new Error("getProfile: profileKey required");
  return zernio(`/profiles/${encodeURIComponent(profileKey)}`);
}

export async function listAccounts(profileKey) {
  if (!profileKey) throw new Error("listAccounts: profileKey required");
  return zernio(`/profiles/${encodeURIComponent(profileKey)}/accounts`);
}

// ─── Hosted account-linking URL ─────────────────────────────────────
// Returns a short-lived, JWT-signed URL the client (or Viewix team
// member acting via Leadsie BM access for non-TikTok platforms) opens
// to authorise a specific social platform. Embedded in the client
// portal Connected Accounts view's [Reconnect] button (TikTok) and in
// the producer-side SocialConnections admin's "Reconnect (admin)"
// button (Meta / YouTube / LinkedIn).

export async function getConnectUrl({ profileKey, platform } = {}) {
  if (!profileKey) throw new Error("getConnectUrl: profileKey required");
  if (!platform) throw new Error("getConnectUrl: platform required");
  return zernio(`/profiles/${encodeURIComponent(profileKey)}/connect-url`, {
    method: "POST",
    body: { platform },
  });
}

// ─── TikTok creator info ────────────────────────────────────────────
// Per Zernio support: every TikTok DIRECT_POST must use a
// `privacy_level` from the creator's allowed options at post time
// (TikTok decides which options apply per account state — not the app
// developer). Phase 3 modal calls this when TikTok is in the platform
// mix to populate the privacy-level dropdown.

export async function getTikTokCreatorInfo(profileKey) {
  if (!profileKey) throw new Error("getTikTokCreatorInfo: profileKey required");
  return zernio(
    `/profiles/${encodeURIComponent(profileKey)}/tiktok/creator-info`
  );
}

// ─── Posts ──────────────────────────────────────────────────────────
// createPost is metadata-only — by the time we get here the asset is
// already in Zernio's media store (uploaded by the Mac Mini worker via
// the presigned-upload flow, see workers/social-asset-transfer/).
// `mediaUrl` is the public URL Zernio returned from /media/presign, not
// a Frame.io signed URL.
//
// clientReferenceId is OUR idempotency anchor. The 15-minute sync cron
// and the schedule-posting-batch endpoint both pass the same id on
// retry / drift reconciliation so Zernio dedupes server-side. Shape:
// `${batchId}::${videoIdx}` (see api/schedule-posting-batch.js).
//
// trialParams: `{ graduationStrategy: "MANUAL" }` makes the IG post
// land as a Trial Reel (non-followers only). The schedule modal's
// per-video Trial-Reel toggle drives whether this is included.
//
// tikTokCompliance: surfaced per-delivery in the modal (Codex caveats
// from Zernio support). Shape:
//   {
//     discloseCommercialContent: bool,
//     discloseBrandedContent:    bool,
//     musicConsent:              bool,
//     privacyLevel:              "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY",
//   }
// Only sent when TikTok is in the `platforms` list for this item.

export async function createPost({
  profileKey,
  mediaUrl,
  caption,
  platforms,
  postAt,
  clientReferenceId,
  trialParams,
  tikTokCompliance,
} = {}) {
  if (!profileKey) throw new Error("createPost: profileKey required");
  if (!mediaUrl) throw new Error("createPost: mediaUrl required (upload to Zernio media store first)");
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error("createPost: platforms (non-empty array) required");
  }
  if (!postAt) throw new Error("createPost: postAt (ISO string) required");
  if (!clientReferenceId) throw new Error("createPost: clientReferenceId required (idempotency anchor)");

  const body = {
    profile_key: profileKey,
    media_url: mediaUrl,
    caption: String(caption || ""),
    platforms,
    post_at: postAt,
    client_reference_id: clientReferenceId,
  };
  if (trialParams && trialParams.graduationStrategy) {
    body.trial_params = { graduation_strategy: trialParams.graduationStrategy };
  }
  if (platforms.includes("tiktok") && tikTokCompliance) {
    body.tiktok_compliance = {
      disclose_commercial_content: !!tikTokCompliance.discloseCommercialContent,
      disclose_branded_content:    !!tikTokCompliance.discloseBrandedContent,
      music_consent:               !!tikTokCompliance.musicConsent,
      privacy_level:               String(tikTokCompliance.privacyLevel || "PUBLIC_TO_EVERYONE"),
    };
  }
  return zernio("/posts", { method: "POST", body });
}

export async function updatePost(zernioPostId, patch = {}) {
  if (!zernioPostId) throw new Error("updatePost: zernioPostId required");
  // The patch may carry { post_at, caption, media_url, ... }. Pass
  // exactly the keys the caller provides — don't sanitise or alias here,
  // so we can support whatever update fields Zernio adds without
  // touching the wrapper.
  return zernio(`/posts/${encodeURIComponent(zernioPostId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export async function cancelPost(zernioPostId) {
  if (!zernioPostId) throw new Error("cancelPost: zernioPostId required");
  return zernio(`/posts/${encodeURIComponent(zernioPostId)}`, {
    method: "DELETE",
  });
}

// Look a post up by our clientReferenceId. Used by the 15-minute sync
// cron BEFORE re-pushing a "stuck" pending item — never blindly
// re-create. Codex review caught the duplicate-on-retry risk in the
// original plan; this is the dedupe primitive.
export async function findPostByReference(clientReferenceId) {
  if (!clientReferenceId) throw new Error("findPostByReference: clientReferenceId required");
  return zernio(
    `/posts?client_reference_id=${encodeURIComponent(clientReferenceId)}`
  );
}
