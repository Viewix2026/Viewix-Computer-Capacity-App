// api/meta-ads.js
// Meta Ads preproduction backend — mirrors api/social-organic.js in
// shape but handles the Meta-Ads-specific flows. Current actions:
//
//   scrapeAdLibrary  — kick off an Apify actor against FB Ad Library,
//                      write ads back into /preproduction/metaAds/{id}
//                      /adLibraryResearch/ads keyed by adId
//   addManualAd      — store a single FB Ad Library URL in the same pool
//                      as a `source: "manual"` record
//
// The scrape uses the run-sync pattern (blocking Apify API call) for
// small scrapes; larger scrapes should later move to the async actor-
// runs + webhook pattern already in api/apify-webhook.js. Start simple,
// upgrade if producers need >300-ad pulls.

import { adminGet, adminSet, adminPatch, getAdmin } from "./_fb-admin.js";

const FIREBASE_URL = "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app";

// Apify actor for the FB Ad Library. Start with Apify's official
// `facebook-ads-library-scraper` (tilde-form: `apify~facebook-ads-library-scraper`).
// Swap via env var APIFY_META_ADS_ACTOR if a different actor is preferred —
// the run-sync endpoint takes the actor path verbatim.
const DEFAULT_META_ADS_ACTOR = "curious_coder~facebook-ads-library-scraper";

async function fbGet(path) {
  const { err } = getAdmin();
  if (!err) return adminGet(path);
  const r = await fetch(`${FIREBASE_URL}${path}.json`);
  return r.json();
}
async function fbSet(path, data) {
  const { err } = getAdmin();
  if (!err) return adminSet(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function fbPatch(path, data) {
  const { err } = getAdmin();
  if (!err) return adminPatch(path, data);
  await fetch(`${FIREBASE_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

// Normalise an Apify ad record into the shape MetaAdsResearch expects.
// The actor's schema varies between versions — we probe a few common
// field names and fall back to the raw value where the field is missing.
// Safe-by-default: if we can't find an adId we skip the record entirely
// rather than poison the /ads map with null keys.
function normaliseScrapedAd(raw, pageName) {
  const adId = raw?.ad_archive_id || raw?.ad_id || raw?.adId || raw?.id || raw?.snapshot?.ad_archive_id;
  if (!adId) return null;
  const snapshot = raw?.snapshot || {};
  const pickImage = () => {
    const images = snapshot?.images || raw?.images || [];
    if (Array.isArray(images) && images[0]) return images[0].original_image_url || images[0].resized_image_url || images[0].url;
    return snapshot?.creative_body_image || raw?.thumbnail_url || raw?.thumbnailUrl || null;
  };
  const pickVideo = () => {
    const videos = snapshot?.videos || raw?.videos || [];
    if (Array.isArray(videos) && videos[0]) return videos[0].video_hd_url || videos[0].video_sd_url || videos[0].url;
    return raw?.video_url || raw?.videoUrl || null;
  };
  const pickBody = () => {
    const text = snapshot?.body?.text || snapshot?.body_text || raw?.ad_creative_bodies?.[0] || raw?.bodyText || raw?.body || "";
    return typeof text === "string" ? text : "";
  };
  const pickHeadline = () => {
    return snapshot?.title || snapshot?.headline || raw?.ad_creative_link_titles?.[0] || raw?.headline || "";
  };
  const pickCta = () => {
    return snapshot?.cta_text || raw?.cta_type || raw?.cta || "";
  };
  const pickLinkUrl = () => {
    return snapshot?.link_url || raw?.ad_creative_link_captions?.[0] || raw?.linkUrl || "";
  };
  const pickDisplayFormat = () => {
    const videos = snapshot?.videos || raw?.videos || [];
    if (Array.isArray(videos) && videos.length > 0) return "VIDEO";
    const cards = snapshot?.cards || raw?.cards || [];
    if (Array.isArray(cards) && cards.length > 1) return "CAROUSEL";
    return raw?.display_format || "IMAGE";
  };
  const startedRunning = raw?.start_date || raw?.ad_delivery_start_time || snapshot?.start_date || null;
  const lastSeen = raw?.end_date || raw?.ad_delivery_stop_time || snapshot?.end_date || null;
  return {
    id: String(adId),
    adId: String(adId),
    adUrl: raw?.url || raw?.ad_library_url || `https://www.facebook.com/ads/library/?id=${adId}`,
    pageName: raw?.page_name || raw?.pageName || pageName || "Unknown",
    pageId: raw?.page_id || raw?.pageId || null,
    pageUrl: raw?.page_url || raw?.pageUrl || null,
    advertiserName: raw?.advertiser_name || raw?.advertiserName || raw?.page_name || pageName || null,
    startedRunning: typeof startedRunning === "number" ? new Date(startedRunning * 1000).toISOString() : startedRunning || null,
    lastSeenActive: typeof lastSeen === "number" ? new Date(lastSeen * 1000).toISOString() : lastSeen || null,
    isActive: raw?.is_active ?? !raw?.end_date ?? true,
    adType: pickDisplayFormat(),
    displayFormat: pickDisplayFormat(),
    videoUrl: pickVideo(),
    thumbnailUrl: pickImage(),
    bodyText: pickBody(),
    headline: pickHeadline(),
    cta: pickCta(),
    linkUrl: pickLinkUrl(),
    estimatedReach: raw?.impressions?.lower_bound && raw?.impressions?.upper_bound
      ? `${raw.impressions.lower_bound.toLocaleString()}-${raw.impressions.upper_bound.toLocaleString()}`
      : null,
    source: "apify",
    rawPreview: null,   // deliberately not persisted — avoids Firebase blowup on huge snapshots
    addedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────
// Actions
// ────────────────────────────────────────────────────────────────

async function handleScrapeAdLibrary(req, res) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not configured" });

  const { projectId, pages = [], country = "AU", dateRange = {} } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });
  if (!Array.isArray(pages) || pages.length === 0) return res.status(400).json({ error: "At least one page is required" });

  const actor = process.env.APIFY_META_ADS_ACTOR || DEFAULT_META_ADS_ACTOR;

  // Mark scrape running immediately so the UI can show the indicator
  // while the synchronous Apify call runs.
  await fbPatch(`/preproduction/metaAds/${projectId}/adLibraryResearch`, {
    scrapeStatus: "running",
    scrapeStartedAt: new Date().toISOString(),
    scrapeError: null,
    inputs: {
      pages,
      country,
      dateRange,
    },
  });

  // Build actor input. The curious_coder actor accepts either a list of
  // page-name search URLs or a list of search queries. We construct
  // ad-library search URLs per page so the actor scrapes each page's
  // ad set independently.
  //   https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=AU&q=<page_name>&search_type=keyword_unordered
  const buildSearchUrl = (pageName) => {
    const qs = new URLSearchParams({
      active_status: "all",
      ad_type: "all",
      country,
      q: pageName,
      search_type: "keyword_unordered",
    });
    return `https://www.facebook.com/ads/library/?${qs.toString()}`;
  };

  const actorInput = {
    urls: pages.map(p => ({ url: buildSearchUrl(p.pageName || p.pageUrl) })),
    count: 30,  // per search — generous, producer can trim in Video Review
  };
  if (dateRange?.from) actorInput.startDate = dateRange.from;
  if (dateRange?.to) actorInput.endDate = dateRange.to;

  try {
    const runUrl = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`;
    const r = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
    });
    if (!r.ok) {
      const errText = await r.text();
      await fbPatch(`/preproduction/metaAds/${projectId}/adLibraryResearch`, {
        scrapeStatus: "error",
        scrapeError: `Apify run failed (${r.status}): ${errText.slice(0, 200)}`,
      });
      return res.status(502).json({ error: "Apify run failed", detail: errText.slice(0, 500) });
    }
    const items = await r.json();
    if (!Array.isArray(items)) {
      await fbPatch(`/preproduction/metaAds/${projectId}/adLibraryResearch`, {
        scrapeStatus: "error",
        scrapeError: "Apify returned non-array dataset — check actor input shape",
      });
      return res.status(502).json({ error: "Apify returned non-array items", sample: String(items).slice(0, 200) });
    }

    // Normalise + write per-ad entries. We read the existing ads map
    // first so manual paste entries are preserved.
    const existing = (await fbGet(`/preproduction/metaAds/${projectId}/adLibraryResearch/ads`)) || {};
    const merged = { ...existing };
    let added = 0;
    for (const raw of items) {
      const ad = normaliseScrapedAd(raw, null);
      if (!ad) continue;
      if (merged[ad.id]) continue;  // don't overwrite an existing manual or prior-scrape entry
      merged[ad.id] = ad;
      added++;
    }
    await fbSet(`/preproduction/metaAds/${projectId}/adLibraryResearch/ads`, merged);
    await fbPatch(`/preproduction/metaAds/${projectId}/adLibraryResearch`, {
      scrapeStatus: "done",
      scrapeFinishedAt: new Date().toISOString(),
      scrapeError: null,
    });

    return res.status(200).json({
      success: true,
      scraped: items.length,
      added,
      skipped: items.length - added,
      totalInPool: Object.keys(merged).length,
    });
  } catch (e) {
    await fbPatch(`/preproduction/metaAds/${projectId}/adLibraryResearch`, {
      scrapeStatus: "error",
      scrapeError: e.message || String(e),
    });
    return res.status(500).json({ error: e.message });
  }
}

async function handleAddManualAd(req, res) {
  const { projectId, adUrl, adId } = req.body || {};
  if (!projectId || !adUrl || !adId) return res.status(400).json({ error: "Missing projectId / adUrl / adId" });

  // Dedupe — if this ad is already in the pool (manual or scraped),
  // return the existing entry rather than overwriting.
  const existing = await fbGet(`/preproduction/metaAds/${projectId}/adLibraryResearch/ads/${adId}`);
  if (existing) {
    return res.status(200).json({ success: true, action: "exists", ad: existing });
  }

  const ad = {
    id: String(adId),
    adId: String(adId),
    adUrl,
    pageName: "Manual entry",
    advertiserName: null,
    pageId: null,
    pageUrl: null,
    startedRunning: null,
    lastSeenActive: null,
    isActive: true,
    adType: "UNKNOWN",
    videoUrl: null,
    thumbnailUrl: null,
    bodyText: "",
    headline: "",
    cta: "",
    linkUrl: "",
    estimatedReach: null,
    source: "manual",
    addedAt: new Date().toISOString(),
  };
  await fbSet(`/preproduction/metaAds/${projectId}/adLibraryResearch/ads/${adId}`, ad);
  return res.status(200).json({ success: true, action: "created", ad });
}

// ────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { action } = req.body || {};
  try {
    switch (action) {
      case "scrapeAdLibrary": return await handleScrapeAdLibrary(req, res);
      case "addManualAd":     return await handleAddManualAd(req, res);
      default:                return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`meta-ads ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
