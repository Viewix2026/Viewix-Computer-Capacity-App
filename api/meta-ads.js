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
import { PACKAGE_CONFIGS } from "./_tiers.js";
import { handleOptions, requireRole, sendAuthError, setCors } from "./_requireAuth.js";

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
    if (Array.isArray(images) && images[0]) return images[0].original_image_url || images[0].resized_image_url || images[0].url || null;
    const videosForThumb = snapshot?.videos || raw?.videos || [];
    if (Array.isArray(videosForThumb) && videosForThumb[0]) return videosForThumb[0].video_preview_image_url || videosForThumb[0].preview_image_url || videosForThumb[0].image_url || null;
    const cards = snapshot?.cards || raw?.cards || [];
    if (Array.isArray(cards) && cards[0]) return cards[0].original_image_url || cards[0].resized_image_url || cards[0].image_url || cards[0].url || null;
    return snapshot?.creative_body_image || raw?.thumbnail_url || raw?.thumbnailUrl || null;
  };
  const pickVideo = () => {
    const videos = snapshot?.videos || raw?.videos || [];
    if (Array.isArray(videos) && videos[0]) return videos[0].video_hd_url || videos[0].video_sd_url || videos[0].url || null;
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
    adUrl: raw?.url || raw?.ad_library_url || raw?.ad_snapshot_url || raw?.permalink_url || raw?.snapshot?.url
      || ((raw?.page_id || raw?.pageId)
        ? `https://www.facebook.com/ads/library/?id=${adId}&view_all_page_id=${raw.page_id || raw.pageId}`
        : `https://www.facebook.com/ads/library/?id=${adId}`),
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
    let skippedNoId = 0;       // normaliseScrapedAd couldn't find an ad id — most likely an actor schema drift
    let skippedDupe = 0;
    let skippedWrongPage = 0;  // ad came from a page producers didn't search for — Apify's keyword search returns ads that *mention* the term too
    const droppedPages = new Set();

    // Apify's facebook-ads-library actor does a keyword search, so the
    // result pool includes ads from any advertiser whose ad text or
    // metadata mentions the searched name. Producers want only ads
    // FROM the searched advertisers, so filter by matching the ad's
    // page_name against each searched target (case-insensitive, with
    // bidirectional substring matching to tolerate brand-name variants
    // like "Acme" vs "Acme Co").
    const normalisePageKey = (s) => String(s || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(?:www\.)?facebook\.com\//i, "")
      .replace(/^@/, "")
      .replace(/\/$/, "");
    const searchTargets = pages.map(p => normalisePageKey(p.pageName || p.pageUrl)).filter(Boolean);

    for (const raw of items) {
      const adPageKey = normalisePageKey(raw?.page_name || raw?.pageName || raw?.snapshot?.page_name);
      if (searchTargets.length > 0) {
        const matches = adPageKey && searchTargets.some(t => adPageKey.includes(t) || t.includes(adPageKey));
        if (!matches) {
          skippedWrongPage++;
          if (adPageKey) droppedPages.add(adPageKey);
          continue;
        }
      }
      const ad = normaliseScrapedAd(raw, null);
      if (!ad) { skippedNoId++; continue; }
      if (merged[ad.id]) { skippedDupe++; continue; }
      merged[ad.id] = ad;
      added++;
    }
    await fbSet(`/preproduction/metaAds/${projectId}/adLibraryResearch/ads`, merged);

    // Surface a warning on the record when the actor returned items
    // we couldn't normalise OR when the page-name filter dropped a
    // bunch — both cases were previously invisible to producers,
    // who'd just see "scraped 100, added 12" with no hint why.
    const warningParts = [];
    if (skippedWrongPage > 0) {
      const sampleDropped = Array.from(droppedPages).slice(0, 5).join(", ");
      warningParts.push(`${skippedWrongPage} ad${skippedWrongPage === 1 ? "" : "s"} dropped — came from pages outside your search (${sampleDropped}${droppedPages.size > 5 ? `, +${droppedPages.size - 5} more` : ""}). Facebook's keyword search pulls in ads that just mention the searched name; we filter those out so the pool stays on-target.`);
    }
    if (skippedNoId > 0) {
      warningParts.push(`${skippedNoId} item${skippedNoId === 1 ? "" : "s"} from Apify had no recognisable ad id — the actor may have changed its output schema. Check api/meta-ads.js:normaliseScrapedAd if you've recently updated the actor.`);
    }
    const warning = warningParts.length > 0 ? warningParts.join(" ") : null;
    await fbPatch(`/preproduction/metaAds/${projectId}/adLibraryResearch`, {
      scrapeStatus: "done",
      scrapeFinishedAt: new Date().toISOString(),
      scrapeError: null,
      scrapeWarning: warning,
    });

    return res.status(200).json({
      success: true,
      scraped: items.length,
      added,
      skipped: items.length - added,
      skippedWrongPage,
      skippedNoId,
      skippedDupe,
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
// Script generator
// ────────────────────────────────────────────────────────────────
// Takes the project's approved Brand Truth + selected formats + package
// tier and produces a scriptTable using Claude Opus. Hormozi-aware:
// for the Hormozi format specifically, emits motivator-tagged rows
// (Toward / AwayFrom / TriedBefore × PA/PU) in the count the package
// config expects. Other Meta Ads formats get N plain rows as set by
// the producer's videoCount allocation.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

async function callClaude({ model, systemPrompt, userMessage, maxTokens, apiKey }) {
  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Anthropic ${r.status}: ${err.slice(0, 400)}`);
  }
  const d = await r.json();
  return d.content?.[0]?.text || "";
}
function parseJSON(raw) {
  let cleaned = (raw || "").trim();
  if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

const META_ADS_SCRIPT_PROMPT = `You are a senior Meta ad script writer at Viewix, a Sydney-based video production agency. You produce direct-response Meta ad scripts designed to run on Facebook and Instagram, built around Alex Hormozi's motivator framework (Toward / Away From / Tried Before) and audience-awareness targeting (Problem Aware / Problem Unaware).

Each script you write is a single 30-60s video scripted through the Hormozi seven-column blueprint:
  Hook · Explain the Pain · Results · Offer · Why the Offer · CTA · Meta Headline + Ad Copy

═══════════════════════════════════════════════════
HOOK — the most important line
═══════════════════════════════════════════════════
The hook interrupts, confronts or challenges the viewer in the first 3 seconds. Default slightly more aggressive than safe. Prioritise memorability over neutrality. Use second person, lead with tension not explanation, use declarative language. Match the brand personality — Challenger (confrontation), Authoritative (direct certainty), Refined (sharp control), Friendly (direct warmth), Playful (clever, not goofy).

Avoid soft hook patterns:
- "If you're struggling with..."
- "You might be experiencing..."
- "Sometimes businesses find..."

Aim for hooks like:
- "One winning Meta ad is not a strategy."
- "If your ads don't look credible, clients will scroll."
- "Invisible brands die."

For Problem Unaware (PU) hooks, the viewer doesn't yet know they have this problem. Create awareness via curiosity, surprise, or a reframe that makes them realise something they hadn't considered.

═══════════════════════════════════════════════════
EXPLAIN THE PAIN
═══════════════════════════════════════════════════
One sentence only. Name the core frustration via a metaphor, specific physical detail, or telling moment. Do NOT explain at length.

Bad: "Some weeks your phone rings nonstop. Other weeks, silence..."
Good: "You're running a business on hope, and hope isn't a pipeline."
Good: "It's 9:30pm, your phone propped on a coffee cup, filming take seven of a video you'll never post."

═══════════════════════════════════════════════════
RESULTS
═══════════════════════════════════════════════════
One sentence. The aspirational outcome in the viewer's world. Do NOT name the client's company, do NOT pitch the product, do NOT describe what the client delivers. Bridge naturally from Explain the Pain (feels like a continuation, not a reset).

Bad: "At [Company], our clients use our high performing videos..."
Good: "You need a clear, straightforward path from no idea to the perfect ring."

═══════════════════════════════════════════════════
THE OFFER
═══════════════════════════════════════════════════
Always open with "At {company}, we..." or "Here at {company}, we've built...". Two sentences max. Spoken, natural language. Focus on what the client receives, not how it's made. Accurate to the offer described in Brand Truth — do NOT invent services.

═══════════════════════════════════════════════════
WHY THE OFFER
═══════════════════════════════════════════════════
One or two short sentences. The emotional reason to want the product — feeling behind the decision, not a logical summary.

═══════════════════════════════════════════════════
CALL TO ACTION
═══════════════════════════════════════════════════
One short sentence. Must relate to the pain raised at the top. Always use "tap" (never click or similar).

Good: "If you want consistent leads every month, tap the link below."

═══════════════════════════════════════════════════
META AD HEADLINE
═══════════════════════════════════════════════════
One punchy line. Hard 35-character limit. Do NOT exceed — longer headlines get truncated on mobile.

═══════════════════════════════════════════════════
META AD COPY
═══════════════════════════════════════════════════
60-120 words. No em dashes. Write like a person explaining something to a mate, not a brand pitching a product. Structure every ad body around ONE idea: Pain → Insight → Outcome → Simple action. Replace claims with reasoning.

═══════════════════════════════════════════════════
MOTIVATOR FRAMING (Hormozi format only)
═══════════════════════════════════════════════════
Toward Motivator (TM) — write to the outcome they want, paint the future state, use forward-looking aspirational language.
Away From (AF) — write to the pain they want to avoid, name the risk, use consequence-driven framing.
Tried Before (TB) — write to their scepticism, call out past failures, explain why this approach is structurally different.

═══════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════
Return STRICTLY valid JSON. No markdown, no code fences, no preamble.

{
  "scriptTable": [
    {
      "videoNumber": 1,
      "videoName": "01_TM_PipelineCertainty_PA",  // {n}_{motivator}_{topic}_{audience}
      "formatName": "Hormozi",                      // must match one of the selected formats verbatim
      "motivatorType": "toward" | "awayFrom" | "triedBefore" | "other",
      "audienceType": "problemAware" | "problemUnaware",
      "hook": "...",
      "explainPain": "...",
      "results": "...",
      "offer": "...",
      "whyOffer": "...",
      "cta": "...",
      "headline": "...",   // <=35 chars
      "adCopy": "..."
    }
  ]
}

RULES:
- Total rows must match the counts specified per format in the Selected Formats block.
- formatName must match a selected format's name verbatim.
- For Hormozi-format rows: motivatorType and audienceType follow the package's rules (see input). For non-Hormozi formats: set motivatorType:"other", audienceType:"problemAware" by default.
- Headlines >35 chars will be rejected. Count characters before returning.
- Every row must be specific — cite real business details from the Brand Truth, not generic advice.
`;

async function handleScriptGenerate(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const selected = Array.isArray(project.selectedFormats) ? project.selectedFormats : [];
  if (selected.length === 0) return res.status(400).json({ error: "No selected formats. Pick some on the Selection tab first." });

  // Resolve library entries for each selected format so Claude gets
  // the full structure guidance.
  const selectedFormatObjects = [];
  for (const s of selected) {
    let fmt = null;
    if (s.formatLibraryId) fmt = await fbGet(`/formatLibrary/${s.formatLibraryId}`);
    selectedFormatObjects.push({
      name: s.formatName,
      videoCount: s.videoCount ?? null,
      videoAnalysis: fmt?.videoAnalysis || s.description || "",
      filmingInstructions: fmt?.filmingInstructions || "",
      structureInstructions: fmt?.structureInstructions || "",
      isHormozi: (s.formatName || "").trim().toLowerCase() === "hormozi",
    });
  }

  const totalAds = selectedFormatObjects.reduce((n, f) => n + (f.videoCount || 0), 0)
    || project.numberOfVideos
    || (PACKAGE_CONFIGS[project.packageTier]?.totalAds ?? 6);

  const pkg = PACKAGE_CONFIGS[project.packageTier] || PACKAGE_CONFIGS.standard;
  const bt = project.brandTruth?.fields || {};

  const formatsBlock = selectedFormatObjects.map((f, i) => {
    const count = f.videoCount != null ? `Count: ${f.videoCount}` : `Count: (not set — distribute evenly over remaining rows)`;
    const hormoziRule = f.isHormozi
      ? `Hormozi rules apply: generate ${pkg.motivatorsPerType} rows per motivator type (Toward, Away From, Tried Before) = ${pkg.motivatorsPerType * 3} base rows, ${pkg.hooks.includes("problemUnaware") ? "DOUBLED for Problem Aware + Problem Unaware audiences" : "Problem Aware only"}.`
      : "Non-Hormozi format: use motivatorType: 'other' and audienceType: 'problemAware'.";
    return [
      `FORMAT ${i + 1}: ${f.name}`,
      count,
      hormoziRule,
      f.videoAnalysis ? `Analysis: ${f.videoAnalysis}` : null,
      f.structureInstructions ? `Structure: ${f.structureInstructions}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const userMessage = `CLIENT: ${project.companyName}
PACKAGE TIER: ${project.packageTier || "(not set)"}
TOTAL ADS TO PRODUCE: ${totalAds}

BRAND TRUTH:
- Brand Truths: ${bt.brandTruths || "(none)"}
- Product / Offer: ${bt.productOffer || "(none)"}
- Unique Value Prop: ${bt.uniqueValueProp || "(none)"}
- Target Customer: ${bt.targetCustomer || "(none)"}
- Pain Points: ${bt.painPoints || "(none)"}
- Desired Outcome: ${bt.desiredOutcome || "(none)"}
- Proof Points: ${bt.proofPoints || "(none)"}
- Competitors: ${bt.competitors || "(none)"}

${project.brandTruth?.transcript ? `\nONBOARDING TRANSCRIPT (excerpt):\n${project.brandTruth.transcript.slice(0, 6000)}\n` : ""}
${project.brandTruth?.producerNotes ? `\nPRODUCER NOTES:\n${project.brandTruth.producerNotes}\n` : ""}

SELECTED FORMATS:
${formatsBlock}

Produce the scriptTable JSON now.`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt: META_ADS_SCRIPT_PROMPT,
      userMessage,
      maxTokens: 16000,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 500) });
  }

  // Post-process: stable ids, headline length trim, default numbering
  const scriptTable = (parsed.scriptTable || []).map((row, i) => ({
    id: `meta_${Date.now()}_${i}`,
    videoNumber: row.videoNumber || i + 1,
    videoName: row.videoName || `${String(i + 1).padStart(2, "0")}_AD`,
    formatName: row.formatName || "Hormozi",
    motivatorType: row.motivatorType || "other",
    audienceType: row.audienceType || "problemAware",
    hook: row.hook || "",
    explainPain: row.explainPain || "",
    results: row.results || "",
    offer: row.offer || "",
    whyOffer: row.whyOffer || "",
    cta: row.cta || "",
    headline: (row.headline || "").slice(0, 35),
    adCopy: row.adCopy || "",
  }));

  await fbPatch(`/preproduction/metaAds/${projectId}`, {
    scriptTable,
    updatedAt: new Date().toISOString(),
    scriptGeneratedAt: new Date().toISOString(),
  });

  return res.status(200).json({ success: true, rows: scriptTable.length });
}

// ────────────────────────────────────────────────────────────────
// Cell-level rewrite
// ────────────────────────────────────────────────────────────────
// Producer clicks any cell in the script table, types a free-text
// instruction ("make this shorter", "more aggressive hook", "use
// specific dollar numbers"), and Claude rewrites just that field.
// Brand Truth + the rest of the row is passed in as context so the
// rewrite stays consistent with the other cells.

// Human-friendly column labels + writing-rule hints used in the
// rewrite prompt. Keeping this server-side so clients can't smuggle
// rules that'd confuse Claude (e.g. asking for a 500-word headline).
const COLUMN_RULES = {
  hook:         { label: "Hook",            rule: "One or two sentences max. Confrontational, direct, second-person. Pattern-interrupt, not soft." },
  explainPain:  { label: "Explain the Pain", rule: "One sentence only. Metaphor or telling moment. Don't explain at length." },
  results:      { label: "Results",          rule: "One sentence. Viewer's world only — no company name, no product mention. Bridges from Pain." },
  offer:        { label: "The Offer",        rule: "Two sentences max. Opens with \"At {company}, we...\". Spoken natural language." },
  whyOffer:     { label: "Why the Offer",    rule: "One or two short sentences. Emotional reason to want it, not a logical summary." },
  cta:          { label: "CTA",              rule: "One short sentence. Must use \"tap\" (never click). Relates to the pain." },
  headline:     { label: "Meta Ad Headline", rule: "Punchy, 35-character hard limit. Don't exceed." },
  adCopy:       { label: "Meta Ad Copy",     rule: "60-120 words. No em dashes. One idea per ad (Pain → Insight → Outcome → Simple action). Write like a person, not a brand." },
  videoName:    { label: "Video Name",       rule: "{number}_{motivator}_{topic}_{audience}. TM/AF/TB × PA/PU. CamelCase topic, no spaces." },
  motivatorType:{ label: "Motivator Type",    rule: "Enum: toward / awayFrom / triedBefore / other. Lowercase, no other values." },
  audienceType: { label: "Audience Type",     rule: "Enum: problemAware / problemUnaware. Lowercase, no other values." },
  formatName:   { label: "Format Name",      rule: "Must match one of the project's selectedFormats names verbatim." },
};

// Persistent producer feedback lives at /preproduction/metaAds/{id}
// /scriptFeedback. Three scopes: global (applies to all rewrites in
// this project), rows[rowId] (one script), cells[rowId][column] (one
// field). Each scope is an array of { text, addedAt } so prior
// instructions accumulate — Claude sees the full history on every
// future rewrite. Producers manage the history through the Scripting
// tab UI; we just append from the rewrite handlers.
function buildPriorFeedbackBlock(project, rowId, column) {
  const fb = project.scriptFeedback || {};
  const globalArr = Array.isArray(fb.global) ? fb.global : [];
  const rowArr = (rowId && Array.isArray(fb.rows?.[rowId])) ? fb.rows[rowId] : [];
  const cellArr = (rowId && column && Array.isArray(fb.cells?.[rowId]?.[column])) ? fb.cells[rowId][column] : [];
  const lines = [];
  for (const e of globalArr) if (e?.text) lines.push(`- (project-wide) ${e.text}`);
  for (const e of rowArr) if (e?.text) lines.push(`- (this script) ${e.text}`);
  for (const e of cellArr) if (e?.text) lines.push(`- (this field, earlier) ${e.text}`);
  if (lines.length === 0) return "";
  return `\nPRIOR PRODUCER INSTRUCTIONS (respect these — don't undo earlier guidance unless the current instruction explicitly overrides it):\n${lines.join("\n")}\n`;
}

// Compact tonal-reference of the OTHER scripts in the table. Used by
// every rewrite handler so Claude doesn't write each script in
// isolation — producers were getting outputs that drifted away from
// the table's voice. Only the load-bearing fields are included
// (videoName, format/motivator/audience tags, hook, offer, headline)
// to keep tokens contained.
function buildOtherScriptsBlock(scriptTable, currentRowId) {
  const others = (scriptTable || []).filter(r => r && r.id !== currentRowId);
  if (others.length === 0) return "";
  const lines = others.map((r, i) => {
    const tags = [r.formatName, r.motivatorType, r.audienceType].filter(Boolean).join(", ");
    return [
      `[${String(r.videoNumber || i + 1).padStart(2, "0")}] ${r.videoName || "(unnamed)"}${tags ? ` (${tags})` : ""}`,
      r.hook       ? `   Hook: ${r.hook}` : null,
      r.offer      ? `   Offer: ${r.offer}` : null,
      r.headline   ? `   Headline: ${r.headline}` : null,
    ].filter(Boolean).join("\n");
  });
  return `\nOTHER SCRIPTS IN THIS TABLE (for tone consistency — don't repeat hooks, match the project's voice):\n${lines.join("\n")}\n`;
}

function appendFeedbackEntry(existing, text) {
  const arr = Array.isArray(existing) ? existing : [];
  return [...arr, { text, addedAt: new Date().toISOString() }];
}

async function handleRewriteCell(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, rowId, column, instruction, currentValue } = req.body || {};
  if (!projectId || !rowId || !column || !instruction) {
    return res.status(400).json({ error: "Missing projectId / rowId / column / instruction" });
  }
  const colMeta = COLUMN_RULES[column];
  if (!colMeta) return res.status(400).json({ error: `Unknown column: ${column}` });

  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const scriptTable = Array.isArray(project.scriptTable) ? project.scriptTable : [];
  const rowIndex = scriptTable.findIndex(r => r && r.id === rowId);
  if (rowIndex < 0) return res.status(404).json({ error: "Row not found in script table" });
  const row = scriptTable[rowIndex];
  const bt = project.brandTruth?.fields || {};
  const priorFeedback = buildPriorFeedbackBlock(project, rowId, column);
  const otherScripts = buildOtherScriptsBlock(scriptTable, rowId);

  const systemPrompt = `You rewrite a single field in a Meta Ad script row. You are given the client's Brand Truth, the full existing row so you can keep voice consistent, the specific field to rewrite, and a free-text instruction from the producer. Return ONLY the rewritten field value as plain text — no JSON, no markdown, no preamble, no quotes around the value.

FIELD: ${colMeta.label}
FIELD RULE: ${colMeta.rule}

HARD CONSTRAINTS:
- Never use em dashes. Use commas, full stops, or rewrite.
- Use contractions.
- Match the tone of the rest of the row.
- Respect the field rule above — if it says one sentence, write one sentence.`;

  const userMessage = `CLIENT: ${project.companyName}

BRAND TRUTH:
- Brand Truths: ${bt.brandTruths || "(none)"}
- Product / Offer: ${bt.productOffer || "(none)"}
- Unique Value Prop: ${bt.uniqueValueProp || "(none)"}
- Target Customer: ${bt.targetCustomer || "(none)"}
- Pain Points: ${bt.painPoints || "(none)"}
- Desired Outcome: ${bt.desiredOutcome || "(none)"}
- Proof Points: ${bt.proofPoints || "(none)"}
${priorFeedback}
EXISTING ROW (for voice consistency):
- Video Name: ${row.videoName || ""}
- Format: ${row.formatName || ""}
- Motivator: ${row.motivatorType || ""} · Audience: ${row.audienceType || ""}
- Hook: ${row.hook || ""}
- Explain the Pain: ${row.explainPain || ""}
- Results: ${row.results || ""}
- Offer: ${row.offer || ""}
- Why Offer: ${row.whyOffer || ""}
- CTA: ${row.cta || ""}
- Headline: ${row.headline || ""}
- Ad Copy: ${row.adCopy || ""}
${otherScripts}
CURRENT VALUE OF ${colMeta.label}:
${currentValue || row[column] || "(empty)"}

PRODUCER'S INSTRUCTION:
${instruction}

Return the rewritten ${colMeta.label} only.`;

  let rewritten;
  try {
    rewritten = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 800,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  // Trim surrounding whitespace + quotes the model sometimes adds.
  let cleaned = (rewritten || "").trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Headline hard 35-char limit (trim rather than fail)
  if (column === "headline" && cleaned.length > 35) cleaned = cleaned.slice(0, 35);

  // Re-look up the row index right before writing. If the script table
  // was regenerated in a parallel call between the read above (used for
  // context) and this write, the rowIndex we computed is stale — it'd
  // point at whichever row ended up in that position after regen,
  // and we'd silently corrupt the wrong row's cell. Re-reading catches
  // the structural change (row id no longer exists) and returns a 409;
  // a narrow race window remains if regen completes AFTER this read,
  // but that's ms-wide rather than the seconds-wide Claude-call window.
  const freshTable = await fbGet(`/preproduction/metaAds/${projectId}/scriptTable`);
  const freshList = Array.isArray(freshTable) ? freshTable : Object.values(freshTable || {});
  const freshIndex = freshList.findIndex(r => r && r.id === rowId);
  if (freshIndex < 0) {
    return res.status(409).json({ error: "Row no longer in script table — it may have been regenerated. Reopen the row and try again." });
  }
  await fbSet(`/preproduction/metaAds/${projectId}/scriptTable/${freshIndex}/${column}`, cleaned);
  // Persist the instruction so future rewrites (cell, whole-script, or
  // all-scripts) see the producer's accumulated guidance for this field.
  const cellHistory = appendFeedbackEntry(project.scriptFeedback?.cells?.[rowId]?.[column], instruction);
  await fbSet(`/preproduction/metaAds/${projectId}/scriptFeedback/cells/${rowId}/${column}`, cellHistory);
  await fbPatch(`/preproduction/metaAds/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, value: cleaned });
}

// Shared whole-script rewrite. Returns { ok: true, fields } or
// { ok: false, status, error, detail }. Both handleRewriteWholeScript
// (single row) and handleRewriteAllScripts (looped) lean on this so
// the prompt + parse logic stays in one place. The caller handles
// Firebase writes — this just talks to Claude and validates output.
const WHOLE_SCRIPT_SYSTEM_PROMPT = `You rewrite ONE Meta Ad script — all seven Hormozi blueprint fields together as a coherent unit (Hook, Explain the Pain, Results, Offer, Why the Offer, CTA, Meta Headline, Meta Ad Copy). Hold the row's identity steady (motivator, audience, format) while honouring the producer's instruction. Every field must stay internally consistent with the others.

HARD CONSTRAINTS:
- Never use em dashes. Use commas, full stops, or rewrite.
- Use contractions.
- Hook: One or two sentences. Confrontational, second-person, pattern-interrupt. Not soft.
- Explain the Pain: One sentence. Metaphor or telling moment. Don't explain at length.
- Results: One sentence. Viewer's world only — no company name, no product mention. Bridges from Pain.
- Offer: Two sentences max. Opens with "At {company}, we..." or "Here at {company}, we've built...". Spoken natural language.
- Why the Offer: One or two short sentences. Emotional reason to want it.
- CTA: One short sentence. Use "tap" (never click). Tied to the pain.
- Meta Headline: 35-character hard limit. Count before returning.
- Meta Ad Copy: 60-120 words. One idea per ad (Pain → Insight → Outcome → Simple action). Write like a person, not a brand.

OUTPUT FORMAT:
Return STRICTLY valid JSON, no preamble, no markdown, no code fences:
{
  "hook": "...",
  "explainPain": "...",
  "results": "...",
  "offer": "...",
  "whyOffer": "...",
  "cta": "...",
  "headline": "...",
  "adCopy": "..."
}`;

async function runWholeScriptRewrite({ project, scriptTable, row, instruction, apiKey, includeCurrentRowFeedback = true }) {
  const bt = project.brandTruth?.fields || {};
  const priorFeedback = buildPriorFeedbackBlock(project, includeCurrentRowFeedback ? row.id : null, null);
  const otherScripts = buildOtherScriptsBlock(scriptTable, row.id);

  const userMessage = `CLIENT: ${project.companyName}

BRAND TRUTH:
- Brand Truths: ${bt.brandTruths || "(none)"}
- Product / Offer: ${bt.productOffer || "(none)"}
- Unique Value Prop: ${bt.uniqueValueProp || "(none)"}
- Target Customer: ${bt.targetCustomer || "(none)"}
- Pain Points: ${bt.painPoints || "(none)"}
- Desired Outcome: ${bt.desiredOutcome || "(none)"}
- Proof Points: ${bt.proofPoints || "(none)"}
${priorFeedback}
CURRENT SCRIPT (you are rewriting this — all seven fields together):
- Video Name: ${row.videoName || ""}
- Format: ${row.formatName || ""}
- Motivator: ${row.motivatorType || ""} · Audience: ${row.audienceType || ""}
- Hook: ${row.hook || ""}
- Explain the Pain: ${row.explainPain || ""}
- Results: ${row.results || ""}
- Offer: ${row.offer || ""}
- Why Offer: ${row.whyOffer || ""}
- CTA: ${row.cta || ""}
- Headline: ${row.headline || ""}
- Ad Copy: ${row.adCopy || ""}
${otherScripts}
PRODUCER'S INSTRUCTION:
${instruction}

Return the rewritten script JSON now.`;

  let raw;
  try {
    raw = await callClaude({ model: "claude-opus-4-6", systemPrompt: WHOLE_SCRIPT_SYSTEM_PROMPT, userMessage, maxTokens: 3000, apiKey });
  } catch (e) {
    return { ok: false, status: 502, error: "Claude call failed", detail: e.message };
  }
  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    return { ok: false, status: 422, error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 500) };
  }
  // Headlines are the only hard-fail field — trim rather than reject so
  // a one-character overage doesn't lose the whole rewrite.
  const fields = {
    hook:        typeof parsed.hook === "string" ? parsed.hook : row.hook,
    explainPain: typeof parsed.explainPain === "string" ? parsed.explainPain : row.explainPain,
    results:     typeof parsed.results === "string" ? parsed.results : row.results,
    offer:       typeof parsed.offer === "string" ? parsed.offer : row.offer,
    whyOffer:    typeof parsed.whyOffer === "string" ? parsed.whyOffer : row.whyOffer,
    cta:         typeof parsed.cta === "string" ? parsed.cta : row.cta,
    headline:    (typeof parsed.headline === "string" ? parsed.headline : row.headline || "").slice(0, 35),
    adCopy:      typeof parsed.adCopy === "string" ? parsed.adCopy : row.adCopy,
  };
  return { ok: true, fields };
}

async function handleRewriteWholeScript(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, rowId, instruction } = req.body || {};
  if (!projectId || !rowId || !instruction) {
    return res.status(400).json({ error: "Missing projectId / rowId / instruction" });
  }

  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const scriptTable = Array.isArray(project.scriptTable) ? project.scriptTable : [];
  const rowIndex = scriptTable.findIndex(r => r && r.id === rowId);
  if (rowIndex < 0) return res.status(404).json({ error: "Row not found in script table" });
  const row = scriptTable[rowIndex];

  const result = await runWholeScriptRewrite({ project, scriptTable, row, instruction, apiKey: ANTHROPIC_KEY });
  if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail, rawPreview: result.rawPreview });

  // Race-safe re-read: the script table could have been regenerated
  // during the Claude call. Refusing the write is better than silently
  // corrupting the wrong row.
  const freshTable = await fbGet(`/preproduction/metaAds/${projectId}/scriptTable`);
  const freshList = Array.isArray(freshTable) ? freshTable : Object.values(freshTable || {});
  const freshIndex = freshList.findIndex(r => r && r.id === rowId);
  if (freshIndex < 0) {
    return res.status(409).json({ error: "Row no longer in script table — it may have been regenerated. Reopen the row and try again." });
  }
  const updatedRow = { ...freshList[freshIndex], ...result.fields };
  await fbSet(`/preproduction/metaAds/${projectId}/scriptTable/${freshIndex}`, updatedRow);

  const rowHistory = appendFeedbackEntry(project.scriptFeedback?.rows?.[rowId], instruction);
  await fbSet(`/preproduction/metaAds/${projectId}/scriptFeedback/rows/${rowId}`, rowHistory);
  await fbPatch(`/preproduction/metaAds/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, row: updatedRow });
}

async function handleRewriteAllScripts(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, instruction } = req.body || {};
  if (!projectId || !instruction) return res.status(400).json({ error: "Missing projectId / instruction" });

  // Persist the project-wide note first. Even if the loop fails,
  // future per-cell rewrites will still see the producer's guidance.
  const projectPre = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!projectPre) return res.status(404).json({ error: "Project not found" });
  const globalHistory = appendFeedbackEntry(projectPre.scriptFeedback?.global, instruction);
  await fbSet(`/preproduction/metaAds/${projectId}/scriptFeedback/global`, globalHistory);

  // Re-read so the saved global entry is in the project we pass to
  // runWholeScriptRewrite — that way every rewrite sees the new note
  // in its prior-feedback block.
  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  const scriptTable = Array.isArray(project.scriptTable) ? project.scriptTable : [];
  if (scriptTable.length === 0) return res.status(400).json({ error: "Script table is empty — generate scripts first." });

  // Parallel Claude calls — each row's rewrite is independent and sees
  // the pre-rewrite state of every other row. Anthropic Tier 1 handles
  // 10-20 parallel requests comfortably; tables larger than ~15 rows
  // are rare so we don't bother chunking.
  const calls = scriptTable.map(row =>
    runWholeScriptRewrite({ project, scriptTable, row, instruction, apiKey: ANTHROPIC_KEY, includeCurrentRowFeedback: false })
      .then(result => ({ row, result }))
  );
  const results = await Promise.all(calls);

  // Race-safe write loop: re-read the table once, then write each
  // rewritten row to its fresh index. Rows that vanished mid-flight
  // are skipped (rather than failing the whole batch).
  const freshTable = await fbGet(`/preproduction/metaAds/${projectId}/scriptTable`);
  const freshList = Array.isArray(freshTable) ? freshTable : Object.values(freshTable || {});
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];
  for (const { row, result } of results) {
    if (!result.ok) { failed++; errors.push({ rowId: row.id, error: result.error, detail: result.detail }); continue; }
    const freshIndex = freshList.findIndex(r => r && r.id === row.id);
    if (freshIndex < 0) { skipped++; continue; }
    const updatedRow = { ...freshList[freshIndex], ...result.fields };
    await fbSet(`/preproduction/metaAds/${projectId}/scriptTable/${freshIndex}`, updatedRow);
    succeeded++;
  }
  await fbPatch(`/preproduction/metaAds/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, succeeded, failed, skipped, total: results.length, errors });
}

// ────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════
// BRAND TRUTH (Tab 1)
//
// generateBrandTruth: one-shot extraction from the pre-production
// transcript + producer notes. Mirrors the Social Organic pattern
// but fills the 8 Meta-Ads-specific fields (brandTruths, productOffer,
// uniqueValueProp, targetCustomer, painPoints, desiredOutcome,
// proofPoints, competitors). Output is bullet-style: 3-5 lines per
// field, separated by newline. Frontend renders them as bullets.
// ═══════════════════════════════════════════════════════════════════

const META_ADS_BRAND_TRUTH_PROMPT = `You are a senior creative strategist at Viewix, a Sydney-based video production agency. You have just sat in on a pre-production meeting with a client about to shoot a round of Meta video ads. Produce the "Brand Truth" block the producer will carry through the rest of the pre-production workflow — Ad Library benchmarking, video review, shortlist, selection, and Hormozi-style script generation.

RULES:
- Be specific, opinionated, evidence-based. No generic agency-speak.
- Quote the client's own language where useful. Verbatim quotes are more valuable than paraphrased ones.
- Never use em dashes. Use commas, full stops, or rewrite.
- Return a single JSON object with the exact structure below. No markdown, no preamble, no code fences.

STRUCTURE — every field is a list of 3-5 short bullet-style lines, one idea per line, separated by a newline character ("\\n"). Do NOT output prose paragraphs. Do NOT include leading bullet markers (no •, no dashes, no numbers) — the frontend renders the bullets automatically. Each line is one specific, concrete claim or observation. Keep lines under 25 words where possible.
{
  "brandTruths":     "3-5 lines on what's actually true about this business. Not marketing fluff, the real version — operational truths, founder quirks, what this brand does better than most.",
  "productOffer":    "3-5 lines on what exactly is being sold in these ads. Deliverable, format, and price point. Be specific about the package / promise the ads are driving to.",
  "uniqueValueProp": "3-5 lines on what makes this different from every other agency / provider in the space. Why a prospect would pick THIS one over the competitor Instagram suggests next.",
  "targetCustomer":  "3-5 lines on who is seeing these ads. Demographic + psychographic, specific. Business owners 30-50 in trades, first-time founders, existing 7-figure ecomm brands — that level of specificity.",
  "painPoints":      "3-5 lines, each a specific pain the viewer is struggling with RIGHT NOW. Use direct viewer-voice quotes where the transcript supports it. Concrete, not abstract.",
  "desiredOutcome":  "3-5 lines on what the viewer wants to be true AFTER buying. The toward state — aspirational, concrete. What changes in their business / life / identity when this works.",
  "proofPoints":     "3-5 lines of specific case studies, numbers, named clients, testimonials the scripts can cite. Vague proof = weak ads, so get specific. Quote numbers from the transcript where available.",
  "competitors":     "3-5 lines on who they're up against. Named competitors if the transcript mentions them. What the prospect's Instagram feed looks like filled with competitor content."
}`;

async function getBrandTruthPromptOverride() {
  const p = await fbGet("/preproductionTemplates/metaAdsBrandTruthPrompt");
  return (typeof p === "string" && p.trim()) ? p : META_ADS_BRAND_TRUTH_PROMPT;
}

async function handleGenerateBrandTruth(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const transcript = project.brandTruth?.transcript || "";
  const producerNotes = project.brandTruth?.producerNotes || "";
  if (!transcript.trim()) {
    return res.status(400).json({ error: "Paste the pre-production transcript before processing." });
  }

  // Flag the record as in-flight so the UI shows a processing spinner
  // even if the producer navigates between tabs during the ~15-30s
  // Claude call. Cleared on success OR failure below.
  await fbPatch(`/preproduction/metaAds/${projectId}/brandTruth`, {
    processingAt: new Date().toISOString(),
  });

  // Pull Sherpa / account-level context so Claude has the client
  // background to ground the truths. Mirrors Social Organic's pattern.
  let sherpaBlock = "";
  if (project.attioCompanyId) {
    const accounts = await fbGet("/accounts");
    if (accounts) {
      const acct = Object.values(accounts).find(a => a?.attioId === project.attioCompanyId);
      if (acct) {
        const bits = [];
        if (acct.industry) bits.push(`Industry: ${acct.industry}`);
        if (acct.websiteUrl) bits.push(`Website: ${acct.websiteUrl}`);
        if (acct.notes) bits.push(`Notes: ${acct.notes}`);
        if (bits.length) sherpaBlock = `\nSHERPA (saved client context):\n${bits.join("\n")}\n`;
      }
    }
  }

  const systemPrompt = await getBrandTruthPromptOverride();
  const userMessage = `CLIENT: ${project.companyName}
${project.packageTier ? `PACKAGE: ${project.packageTier}` : ""}
${sherpaBlock}
PRE-PRODUCTION MEETING TRANSCRIPT:
"""
${transcript.slice(0, 12000)}
"""

PRODUCER NOTES:
"""
${producerNotes.slice(0, 4000) || "(none)"}
"""

Produce the brand truth JSON now.`;

  const runId = `metaAds_brandtruth_${Date.now()}`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 4000,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    await fbPatch(`/preproduction/metaAds/${projectId}/brandTruth`, { processingAt: null });
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    await fbPatch(`/preproduction/metaAds/${projectId}/brandTruth`, { processingAt: null });
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 500) });
  }

  const fields = {
    brandTruths:     parsed.brandTruths     || "",
    productOffer:    parsed.productOffer    || "",
    uniqueValueProp: parsed.uniqueValueProp || "",
    targetCustomer:  parsed.targetCustomer  || "",
    painPoints:      parsed.painPoints      || "",
    desiredOutcome:  parsed.desiredOutcome  || "",
    proofPoints:     parsed.proofPoints     || "",
    competitors:     parsed.competitors     || "",
  };

  await fbPatch(`/preproduction/metaAds/${projectId}/brandTruth`, {
    fields,
    generatedAt: new Date().toISOString(),
    modelUsed: "claude-opus-4-6",
    runId,
    processingAt: null,
  });
  await fbPatch(`/preproduction/metaAds/${projectId}`, {
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({ ok: true, fields, runId });
}

// Cell-level AI rewrite for a single brand-truth field. Called by
// CellRewriteModal's "AI" tab. Receives a path (e.g. "brandTruths"),
// the current value, and a natural-language instruction, and writes
// the rewritten value back to /preproduction/metaAds/{id}/brandTruth
// /fields/{path}. Keeps the rest of the fields untouched.
async function handleRewriteBrandTruthField(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId, path, instruction, currentValue } = req.body || {};
  if (!projectId || !path) return res.status(400).json({ error: "Missing projectId or path" });
  if (!instruction || !instruction.trim()) return res.status(400).json({ error: "Missing instruction" });

  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  // Build a scoped rewrite prompt that carries the OTHER fields as
  // context so Claude doesn't contradict them. Keep output bullet-
  // style (newline-separated lines) to match the rest of the step.
  const fields = project.brandTruth?.fields || {};
  const fieldLabelMap = {
    brandTruths:     "Brand Truths",
    productOffer:    "Product / Offer",
    uniqueValueProp: "Unique Value Proposition",
    targetCustomer:  "Target Customer",
    painPoints:      "Pain Points",
    desiredOutcome:  "Desired Outcome",
    proofPoints:     "Proof Points",
    competitors:     "Competitors / Category",
  };
  const targetLabel = fieldLabelMap[path] || path;

  const contextBits = Object.entries(fields)
    .filter(([k, v]) => k !== path && v && v.trim())
    .map(([k, v]) => `${fieldLabelMap[k] || k}:\n${v}`)
    .join("\n\n");

  const systemPrompt = `You are a senior creative strategist at Viewix, a Sydney-based video production agency. You're editing ONE field of a client's Brand Truth block used to drive Meta ad scripts.

RULES:
- Rewrite ONLY the target field. Do not touch any other field.
- Follow the producer's instruction literally.
- Keep the output as 3-5 bullet-style lines, one idea per line, separated by "\\n". No leading bullet markers (•, -, *, 1.) — the frontend renders bullets.
- Never use em dashes. Use commas, full stops, or rewrite.
- Be specific, opinionated, evidence-based. No generic agency-speak.
- Return ONLY the new value for the field. No preamble, no code fences, no JSON.`;

  const userMessage = `CLIENT: ${project.companyName}
${project.packageTier ? `PACKAGE: ${project.packageTier}` : ""}

OTHER BRAND FIELDS (for context — do NOT modify):
${contextBits || "(no other fields filled yet)"}

FIELD BEING REWRITTEN: ${targetLabel}

CURRENT VALUE:
"""
${currentValue || "(empty)"}
"""

PRODUCER INSTRUCTION:
"""
${instruction.trim()}
"""

Return the new value for the "${targetLabel}" field now.`;

  let rewritten;
  try {
    rewritten = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 800,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  const cleaned = (rewritten || "").trim().replace(/^```[a-z]*\s*/, "").replace(/\s*```$/, "");
  if (!cleaned) return res.status(422).json({ error: "Claude returned an empty rewrite" });

  await fbSet(`/preproduction/metaAds/${projectId}/brandTruth/fields/${path}`, cleaned);
  await fbPatch(`/preproduction/metaAds/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ ok: true, value: cleaned });
}

// Suggest Facebook Ad Library scrape inputs from the brand truth.
// Reads project.brandTruth.{fields.competitors, transcript} and asks
// Claude to extract 3-6 likely Facebook page names (or URLs) that
// the producer should scrape. Returns them as an array the frontend
// dumps straight into inputs.pages.
async function handleSuggestAdLibraryInputs(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });

  const project = await fbGet(`/preproduction/metaAds/${projectId}`);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const bt = project.brandTruth || {};
  const fields = bt.fields || {};
  const competitorsText = fields.competitors || "";
  const brandTruthsText = fields.brandTruths || "";
  const targetText = fields.targetCustomer || "";
  const transcript = bt.transcript || "";

  if (!competitorsText.trim() && !transcript.trim()) {
    return res.status(400).json({ error: "Run Begin Processing on the Brand Truth tab first so we have something to extract competitors from." });
  }

  const systemPrompt = `You are a Viewix creative strategist extracting Facebook page names to feed the Meta Ad Library scraper.

RULES:
- Return a single JSON object: { "pages": ["pageName1", "pageName2", ...] }
- 3 to 6 entries.
- Each entry should be the Facebook page handle or simple page name a human would search for, e.g. "NikeAustralia", "Tesla", "AussieFitnessCo". No URLs, no @ signs, no facebook.com/... prefix.
- Prefer named specific competitors from the context. Do NOT invent businesses that weren't referenced.
- If the context names ≤3 competitors and the category is well defined, you MAY add 1-2 well-known Australian category leaders.
- Return ONLY the JSON object. No markdown, no preamble, no code fences.`;

  const userMessage = `CLIENT: ${project.companyName}

COMPETITORS (from Brand Truth):
${competitorsText || "(not filled yet)"}

BRAND TRUTHS:
${brandTruthsText || "(not filled yet)"}

TARGET CUSTOMER:
${targetText || "(not filled yet)"}

TRANSCRIPT EXCERPT (first 4000 chars):
"""
${transcript.slice(0, 4000) || "(no transcript)"}
"""

Extract the pages JSON now.`;

  let raw;
  try {
    raw = await callClaude({
      model: "claude-opus-4-6",
      systemPrompt,
      userMessage,
      maxTokens: 500,
      apiKey: ANTHROPIC_KEY,
    });
  } catch (e) {
    return res.status(502).json({ error: "Claude call failed", detail: e.message });
  }

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) {
    return res.status(422).json({ error: "Claude returned invalid JSON", detail: e.message, rawPreview: raw.slice(0, 300) });
  }

  const rawPages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const pages = rawPages
    .map(p => String(p || "").trim().replace(/^https?:\/\/(?:www\.)?facebook\.com\//i, "").replace(/\/$/, "").replace(/^@/, ""))
    .filter(Boolean)
    .slice(0, 6)
    .map(name => ({ pageName: name, pageUrl: "" }));

  return res.status(200).json({ ok: true, pages });
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await requireRole(req, ["founders", "founder", "lead"]);
  } catch (e) {
    return sendAuthError(res, e);
  }

  const { action } = req.body || {};
  try {
    switch (action) {
      case "scrapeAdLibrary":   return await handleScrapeAdLibrary(req, res);
      case "addManualAd":       return await handleAddManualAd(req, res);
      case "scriptGenerate":    return await handleScriptGenerate(req, res);
      case "rewriteCell":           return await handleRewriteCell(req, res);
      case "rewriteWholeScript":    return await handleRewriteWholeScript(req, res);
      case "rewriteAllScripts":     return await handleRewriteAllScripts(req, res);
      case "generateBrandTruth":     return await handleGenerateBrandTruth(req, res);
      case "rewriteBrandTruthField": return await handleRewriteBrandTruthField(req, res);
      case "suggestAdLibraryInputs": return await handleSuggestAdLibraryInputs(req, res);
      default:                       return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`meta-ads ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
