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
    let skippedNoId = 0;   // normaliseScrapedAd couldn't find an ad id — most likely an actor schema drift
    let skippedDupe = 0;
    for (const raw of items) {
      const ad = normaliseScrapedAd(raw, null);
      if (!ad) { skippedNoId++; continue; }
      if (merged[ad.id]) { skippedDupe++; continue; }
      merged[ad.id] = ad;
      added++;
    }
    await fbSet(`/preproduction/metaAds/${projectId}/adLibraryResearch/ads`, merged);
    // Surface a warning on the record when the actor returned items we
    // couldn't normalise — producers were previously seeing "scraped 100,
    // added 0" with no hint why. scrapeWarning shows in the UI next to
    // scrapeStatus: "done".
    const warning = skippedNoId > 0
      ? `${skippedNoId} item${skippedNoId === 1 ? "" : "s"} from Apify had no recognisable ad id — the actor may have changed its output schema. Check api/meta-ads.js:normaliseScrapedAd if you've recently updated the actor.`
      : null;
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
  await fbPatch(`/preproduction/metaAds/${projectId}`, { updatedAt: new Date().toISOString() });

  return res.status(200).json({ success: true, value: cleaned });
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
      case "scriptGenerate":  return await handleScriptGenerate(req, res);
      case "rewriteCell":     return await handleRewriteCell(req, res);
      default:                return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`meta-ads ${action} error:`, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
