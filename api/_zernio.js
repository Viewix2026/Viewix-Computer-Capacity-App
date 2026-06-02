// api/_zernio.js
//
// Zernio API client wrapper. Vercel-side surface only — the Mac Mini
// worker (workers/social-asset-transfer/) maintains its own Zernio
// media-upload client in that subdirectory because it streams large
// binary payloads that don't belong inside a Vercel function.
//
// Why a wrapper at all: keeps every Vercel endpoint that touches
// Zernio (provision-profile, schedule-posting-batch, webhook,
// schedule-item-reschedule, schedule-item-cancel, social-asset-requeue,
// the daily sync cron, the client-portal reconnect-url subroute) on
// the same auth + base-URL + error-shape contract. A schema change
// from Zernio lands here once, not in eight files.
//
// ─── RECONCILED against the real Zernio API contract (llms.txt, ──────
//     pasted 2026-05-21). The first build was written against assumed
//     shapes; this file now matches the published contract. The key
//     differences that rippled out to every caller:
//
//   • Base URL is https://zernio.com/api/v1 (NOT api.zernio.com/v1).
//   • A profile's identifier is its Mongo `_id` (we call it profileId),
//     surfaced as `profile._id` on create. There is no `profile_key`.
//   • createPost takes `{ content, scheduledFor, timezone, platforms:
//     [{platform, accountId}], mediaItems:[{type,url}], publishNow }`.
//     `accountId` is the connected social account's `_id` under the
//     profile — resolved from GET /accounts?profileId=…, NOT the
//     platform name. There is NO durable `client_reference_id`.
//   • Idempotency is two-layered and SHORT-lived, not a durable key:
//       – `x-request-id` request header → 5-minute window. A repeat
//         within 5 min returns 200 with `existingPost`.
//       – content-hash dedup → identical (platform, accountId, content)
//         within 24h returns 409 with `existingPostId`.
//     Our resume/retry logic (sync cron) leans on the 24h content-hash
//     layer: re-POSTing an identical item returns the existing post id
//     rather than forking a duplicate. createPost surfaces that id.
//   • Connect URL is GET /connect/{platform}?profileId=… → `authUrl`.
//   • TikTok creator-info is keyed by the connected ACCOUNT id, not the
//     profile: GET /accounts/{accountId}/tiktok/creator-info.
//   • Media upload is POST /media/presign {fileName, fileType} →
//     {uploadUrl, publicUrl, expires} (handled in the worker, not here).
//   • TikTok per-post settings live in a top-level `tiktokSettings`
//     object; IG Reels via `platformSpecificData.contentType:"reels"`
//     plus `trialParams.graduationStrategy`.
//   • Webhook signature is a plain lowercase-hex HMAC-SHA256 of the raw
//     body in `X-Zernio-Signature` (verified in zernio-webhook.js).
//
// ─── Sales-confirmation pedigree ────────────────────────────────────
// Confirmed by Zernio support (2026-05-20):
//   • IG Reels publish directly (true scheduled publish, not draft /
//     reminder). `trialParams.graduationStrategy: "MANUAL"` makes the
//     Reel land as a Trial Reel (non-followers only) — graduation back
//     to followers happens manually in the IG app (a Meta limitation).
//   • Zernio holds the audited TikTok Content Posting API credentials.
//     Clients post publicly via DIRECT_POST out of the box. Two
//     caveats baked into the modal + this wrapper:
//       (a) per-post `privacy_level` must come from the creator's
//           allowed options (GET /accounts/{id}/tiktok/creator-info).
//       (b) TikTok compliance confirmations must be surfaced before
//           posting and sent in `tiktokSettings`.
//
// ─── Env ────────────────────────────────────────────────────────────
//   ZERNIO_API_KEY        Bearer token (sk_…). Required.
//   ZERNIO_WEBHOOK_SECRET HMAC secret for inbound webhook verification.
//                         Read directly by api/zernio-webhook.js.
//   ZERNIO_BASE_URL       Optional override (staging).
//
// ─── Still owed before going fully live (do not block the spine PoC) ─
//   • TikTok `tiktokSettings` commercial/branded-content disclosure
//     param names: the published creator-info doc lists
//     `commercialContentTypes`, but the exact post-body param names for
//     the disclosure toggles weren't enumerated in llms.txt. The two
//     REQUIRED consent booleans (`content_preview_confirmed`,
//     `express_consent_given`) and `privacy_level` ARE confirmed and
//     are sent below. The disclosure flags are sent under TikTok's
//     standard names (`disclose_commercial_content`,
//     `disclose_branded_content`) — verify once against a live TikTok
//     post; if Zernio 400s on an unknown param, the fix is isolated to
//     buildTikTokSettings() here.

const DEFAULT_BASE_URL = "https://zernio.com/api/v1";
const DEFAULT_TIMEZONE = "Australia/Sydney";

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
// non-2xx (the thrown error carries `.status` and `.body` so callers
// can special-case e.g. a 409 dedup); the caller decides whether to
// swallow, retry, or surface.
//
// Exported so the analytics layer (api/_zernioAnalytics.js) reuses the
// exact same auth/timeout/error surface instead of duplicating it.
// Note 2xx semantics: a 202 (analytics sync pending) has `resp.ok`
// true, so it returns the parsed body normally rather than throwing —
// the analytics layer inspects the body for the pending state. 402/424
// throw with `err.status` set, which the analytics layer catches.
export async function zernio(path, { method = "GET", body, headers: extraHeaders, timeoutMs = 30000 } = {}) {
  const url = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${apiKey()}`,
    Accept: "application/json",
    ...(extraHeaders || {}),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

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

  // Parse safely — Zernio returns JSON on every documented success and
  // error response, but a 502 from their edge could be HTML. Fall back
  // to a text snippet so the error surface is still useful.
  let json = null;
  const text = await resp.text();
  if (text) {
    try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 500) }; }
  }

  if (!resp.ok) {
    // Zernio's documented error envelope:
    //   { error, type, code, param, docUrl, platform, platformError }
    const msg = json?.error || json?.message || json?._raw || resp.statusText;
    const err = new Error(`Zernio ${method} ${path} ${resp.status}: ${msg}`);
    err.code = `ZERNIO_${resp.status}`;
    err.status = resp.status;
    err.body = json;
    err.zernioType = json?.type || null;
    err.zernioCode = json?.code || null;
    err.param = json?.param || null;
    throw err;
  }
  return json;
}

// ─── Id helpers ─────────────────────────────────────────────────────
// Zernio ids are Mongo `_id` strings. Profiles / posts / accounts all
// follow the same shape; some responses nest the entity, some return
// it bare. Normalise here so callers never guess.
function pickId(obj) {
  if (!obj || typeof obj !== "object") return null;
  return obj._id || obj.id || null;
}
function extractProfileId(resp) {
  return pickId(resp?.profile) || pickId(resp);
}
function extractPostId(resp) {
  return pickId(resp?.post) || pickId(resp) || pickId(resp?.existingPost) || resp?.existingPostId || null;
}

// ─── Profiles ───────────────────────────────────────────────────────
// A Zernio "profile" represents one Viewix client. Multiple connected
// social accounts (IG, TikTok, YT, LinkedIn) hang off a single profile.
// We store the returned profileId (`profile._id`) at
// /zernio/profiles/{accountId} and pass it on every subsequent call.

export async function createProfile({ name, description } = {}) {
  if (!name) throw new Error("createProfile: name required");
  const resp = await zernio("/profiles", {
    method: "POST",
    body: { name, description: description || undefined },
  });
  return { profileId: extractProfileId(resp), raw: resp };
}

export async function getProfile(profileId) {
  if (!profileId) throw new Error("getProfile: profileId required");
  return zernio(`/profiles/${encodeURIComponent(profileId)}`);
}

// List the connected social accounts for a profile.
//   GET /accounts?profileId={id}
//   → { accounts: [{ _id, platform, username, displayName, status }] }
export async function listAccounts(profileId) {
  if (!profileId) throw new Error("listAccounts: profileId required");
  return zernio(`/accounts?profileId=${encodeURIComponent(profileId)}`);
}

// A connected account's status is usable only if Zernio reports it as
// connected/active (or doesn't expose a status at all). Anything else —
// disconnected, expired, error, pending — is NOT postable. This mirrors
// the sync cron, which treats every non-active status as disconnected.
function isUsableAccountStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "" || s === "connected" || s === "active";
}

// Pure resolver — turn our platform NAME list (["instagram","tiktok"])
// into the [{platform, accountId}] entries createPost needs, using a
// previously-fetched listAccounts() response. Fails CLOSED: an account
// whose status is anything other than connected/active (or unset) is
// treated as not present, so a disconnected TikTok/IG account surfaces
// as `missing` here rather than passing validation and only blowing up
// later at createPost. Returns { resolved, missing } so the caller can
// fail loudly (distinct from "enabled in scope on the Viewix account").
export function mapPlatformsToAccounts(accountsResp, platformNames) {
  const accounts = accountsResp?.accounts || accountsResp?.data ||
    (Array.isArray(accountsResp) ? accountsResp : []);
  const byPlatform = {};
  for (const a of accounts) {
    const p = String(a?.platform || "").toLowerCase();
    if (!p) continue;
    const status = String(a?.status || "").toLowerCase();
    const id = pickId(a);
    if (!id) continue;
    if (!isUsableAccountStatus(status)) continue; // fail closed on bad status
    // Prefer an explicitly connected/active account over a status-less one.
    if (!byPlatform[p] || status === "connected" || status === "active") {
      byPlatform[p] = { platform: p, accountId: id };
    }
  }
  const resolved = [];
  const missing = [];
  for (const name of platformNames || []) {
    const p = String(name).toLowerCase();
    if (byPlatform[p]) resolved.push(byPlatform[p]);
    else missing.push(p);
  }
  return { resolved, missing };
}

// ─── Hosted account-linking URL ─────────────────────────────────────
//   GET /connect/{platform}?profileId={id}[&headless=true]
//   → { authUrl, state }
// `headless=true` returns a URL suited to embedding (no Zernio chrome)
// — we use it for the client-portal [Reconnect] button and the
// producer-side admin "Reconnect (admin)" button.
export async function getConnectUrl({ profileId, platform, headless = true } = {}) {
  if (!profileId) throw new Error("getConnectUrl: profileId required");
  if (!platform) throw new Error("getConnectUrl: platform required");
  const qs = `profileId=${encodeURIComponent(profileId)}${headless ? "&headless=true" : ""}`;
  const resp = await zernio(`/connect/${encodeURIComponent(platform)}?${qs}`);
  return {
    authUrl: resp?.authUrl || resp?.url || null,
    state: resp?.state || null,
    raw: resp,
  };
}

// ─── TikTok creator info ────────────────────────────────────────────
//   GET /accounts/{accountId}/tiktok/creator-info?mediaType=video
//   → { creator, privacyLevels, postingLimits, commercialContentTypes }
// NOTE: keyed by the connected ACCOUNT id (the TikTok account's `_id`
// under the profile), not the profileId. Resolve the account id first
// via listAccounts(profileId) + mapPlatformsToAccounts(…, ["tiktok"]).
export async function getTikTokCreatorInfo(accountId, { mediaType = "video" } = {}) {
  if (!accountId) throw new Error("getTikTokCreatorInfo: accountId required");
  return zernio(
    `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info?mediaType=${encodeURIComponent(mediaType)}`
  );
}

// ─── TikTok settings builder ────────────────────────────────────────
// Map our domain `tikTokCompliance` shape (collected in the Schedule
// Posting modal) onto Zernio's top-level `tiktokSettings` object.
//   our shape: { discloseCommercialContent, discloseBrandedContent,
//                musicConsent, privacyLevel }
// Confirmed Zernio fields: privacy_level, content_preview_confirmed
// (REQUIRED), express_consent_given (REQUIRED), allow_comment/duet/stitch,
// video_made_with_ai. Disclosure flags sent under TikTok-standard names
// (see header note — verify once against a live TikTok post).
function buildTikTokSettings(c) {
  if (!c) return undefined;
  return {
    privacy_level: String(c.privacyLevel || "PUBLIC_TO_EVERYONE"),
    allow_comment: c.allowComment !== false,
    allow_duet: c.allowDuet !== false,
    allow_stitch: c.allowStitch !== false,
    video_made_with_ai: !!c.videoMadeWithAi,
    // Both REQUIRED by Zernio. The producer ticking music consent +
    // submitting the modal IS the express confirmation; the modal
    // blocks submit until musicConsent is checked, so by the time we
    // serialize a post these are genuinely true.
    content_preview_confirmed: true,
    express_consent_given: !!c.musicConsent,
    // Disclosure toggles — standard TikTok Content Posting API names.
    disclose_commercial_content: !!c.discloseCommercialContent,
    disclose_branded_content: !!c.discloseBrandedContent,
  };
}

// ─── Posts ──────────────────────────────────────────────────────────
// createPost is metadata-only — by the time we get here the asset is
// already in Zernio's media store (uploaded by the Mac Mini worker via
// POST /media/presign + PUT). `mediaUrl` is the publicUrl Zernio
// returned from presign, not a Frame.io signed URL.
//
// Idempotency: pass `requestId` — sent as the `x-request-id` header.
// Within 5 minutes a repeat returns 200 with `existingPost`; we surface
// its id as `deduped:true`. Beyond 5 minutes the 24h content-hash layer
// kicks in: an identical (platform, accountId, content) re-POST returns
// 409 with `existingPostId`, which we ALSO surface as `deduped:true`
// rather than throwing. This is what the sync cron's resume pass relies
// on — there is no durable client_reference_id in Zernio.
//
// Returns: { postId, deduped, raw }.
export async function createPost({
  content,
  scheduledFor,
  timezone = DEFAULT_TIMEZONE,
  platforms,          // [{ platform, accountId }] — already resolved
  mediaUrl,           // single video URL (we wrap into mediaItems)
  mediaItems,         // OR pass mediaItems directly
  publishNow = false,
  requestId,
  trialReel = false,  // IG Trial Reel toggle
  tikTokCompliance,   // our domain shape; mapped to tiktokSettings
} = {}) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error("createPost: platforms (non-empty [{platform, accountId}]) required");
  }
  for (const p of platforms) {
    if (!p || !p.platform || !p.accountId) {
      throw new Error("createPost: each platform entry needs {platform, accountId} (resolve via listAccounts first)");
    }
  }
  const items = Array.isArray(mediaItems) && mediaItems.length
    ? mediaItems
    : (mediaUrl ? [{ type: "video", url: mediaUrl }] : null);
  if (!items) throw new Error("createPost: mediaUrl or mediaItems required");
  if (!publishNow && !scheduledFor) {
    throw new Error("createPost: scheduledFor (ISO) required unless publishNow:true");
  }

  const body = {
    content: String(content || ""),
    platforms: platforms.map(p => ({ platform: String(p.platform).toLowerCase(), accountId: p.accountId })),
    mediaItems: items,
  };
  if (publishNow) {
    body.publishNow = true;
  } else {
    body.scheduledFor = scheduledFor;
    body.timezone = timezone;
  }

  const platformNames = body.platforms.map(p => p.platform);

  // Instagram: we always post vertical video as Reels.
  if (platformNames.includes("instagram")) {
    body.platformSpecificData = { ...(body.platformSpecificData || {}), contentType: "reels" };
    if (trialReel) {
      body.trialParams = { graduationStrategy: "MANUAL" };
    }
  }
  // TikTok: top-level tiktokSettings.
  if (platformNames.includes("tiktok")) {
    const settings = buildTikTokSettings(tikTokCompliance);
    if (settings) body.tiktokSettings = settings;
  }

  const headers = {};
  if (requestId) headers["x-request-id"] = String(requestId);

  let resp;
  try {
    resp = await zernio("/posts", { method: "POST", body, headers });
  } catch (e) {
    // 24h content-hash dedup → 409 + existingPostId. Treat as success:
    // the post is already scheduled, bind to its id.
    if (e.status === 409 && (e.body?.existingPostId || pickId(e.body?.existingPost))) {
      return { postId: e.body.existingPostId || pickId(e.body.existingPost), deduped: true, raw: e.body };
    }
    throw e;
  }
  // 5-min x-request-id window returns 200 with `existingPost`.
  return {
    postId: extractPostId(resp),
    deduped: !!resp?.existingPost,
    raw: resp,
  };
}

// Fetch a single post's current state. Used by the sync cron to
// reconcile a past-due "pending" item once we hold its postId.
//   GET /posts/{postId}
export async function getPost(postId) {
  if (!postId) throw new Error("getPost: postId required");
  return zernio(`/posts/${encodeURIComponent(postId)}`);
}

// Reschedule / edit a scheduled (not-yet-published) post.
//   PUT /posts/{postId}
// Pass the fields to change, e.g. { scheduledFor, timezone }.
export async function updatePost(postId, patch = {}) {
  if (!postId) throw new Error("updatePost: postId required");
  return zernio(`/posts/${encodeURIComponent(postId)}`, {
    method: "PUT",
    body: patch,
  });
}

// Cancel a draft/scheduled post.
//   DELETE /posts/{postId}
// (A published post would need POST /posts/{postId}/unpublish instead —
// we only ever cancel pending items, so DELETE is correct here.)
export async function cancelPost(postId) {
  if (!postId) throw new Error("cancelPost: postId required");
  return zernio(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
}
