// api/_tiers.js
// SINGLE SOURCE OF TRUTH for every product + tier the dashboard knows about.
//
// Lives under api/ because Vercel serverless functions can't reach into
// src/, but the client side imports from this file too (vite resolves the
// relative path at build time). Result: one place to add a new product /
// tier, and the webhook + script generator + Sale form + every UI badge
// all pick it up automatically.
//
// Product-line taxonomy (matches Attio's deal-type options):
//   metaAds        — starter / standard / premium / deluxe
//   socialPremium  — Social Media Premium retainer: starter pack /
//                    brand builder / market leader / market dominator
//   socialOrganic  — Social Media Organic retainer: same four tiers
//   oneOff         — single-price project types with no tier structure
//                    (Live Action, 90 Day Gameplan, Animation)
//
// To add a NEW tier to an existing product line:
//   1. Add an entry to the relevant *_TIERS array.
//   2. (metaAds only) add a PACKAGE_CONFIGS entry with motivators+ads+hooks.
//   3. (Optional) add a colour to TIER_COLORS — falls back to grey if missing.
//   4. Add an Attio deal-type option labelled e.g. "New Tier - Social Media
//      Premium". attioMatch below will pick it up automatically if you
//      follow the existing naming convention.
//
// To add a NEW one-off product type:
//   1. Add an entry to ONE_OFF_TYPES.
//   2. Add a deal-type option in Attio matching the label.

// ─── Meta Ads tiers ────────────────────────────────────────────────
// `key`          canonical camelCase id (Firebase paths, prices)
// `label`        human display name
// `attioMatch`   lowercase substrings the Attio deal type may contain
//                (identifyDeal() only scopes these to Meta Ads by also
//                requiring "- meta ads" in the string)
export const META_ADS_TIERS = [
  { key: "starter",  label: "Starter",  attioMatch: ["starter"] },
  { key: "standard", label: "Standard", attioMatch: ["standard"] },
  { key: "premium",  label: "Premium",  attioMatch: ["premium"] },
  { key: "deluxe",   label: "Deluxe",   attioMatch: ["deluxe"] },
];

// ─── Social Media Premium tiers (paid + organic retainer) ──────────
// Attio sends strings like "Brand Builder - Social Media Premium".
// identifyDeal() requires "social media premium" (not just "premium")
// to keep this list separate from Meta Ads Premium.
export const SOCIAL_PREMIUM_TIERS = [
  { key: "starter",         label: "Starter Pack",     attioMatch: ["starter pack", "start pack"] },
  { key: "brandBuilder",    label: "Brand Builder",    attioMatch: ["brand builder"] },
  { key: "marketLeader",    label: "Market Leader",    attioMatch: ["market leader"] },
  { key: "marketDominator", label: "Market Dominator", attioMatch: ["market dominator"] },
];

// ─── Social Media Organic tiers (organic-only retainer) ────────────
// Same four tier names as Social Premium; identifyDeal() splits them
// by whether the Attio string contains "social media organic". Note
// Attio currently has a typo on the Starter row ("Start Pack - Social
// Media Organic" — missing "er"). Both spellings are included so the
// typo doesn't silently break webhook routing.
export const SOCIAL_ORGANIC_TIERS = [
  { key: "starter",         label: "Starter Pack",     attioMatch: ["starter pack", "start pack"] },
  { key: "brandBuilder",    label: "Brand Builder",    attioMatch: ["brand builder"] },
  { key: "marketLeader",    label: "Market Leader",    attioMatch: ["market leader"] },
  { key: "marketDominator", label: "Market Dominator", attioMatch: ["market dominator"] },
];

// Backwards-compat alias — the old code called it SOCIAL_RETAINER_TIERS
// back when there was only one social product line. Some older imports
// may still reference this; keep the alias so nothing breaks.
export const SOCIAL_RETAINER_TIERS = SOCIAL_PREMIUM_TIERS;

// ─── One-off project types ─────────────────────────────────────────
// No tier structure. These are single-price deliverables Attio can sell
// without a retainer envelope. Webhook creates /projects + /deliveries
// entries but skips the preproduction tree since there's no scripted
// tiered workflow attached.
export const ONE_OFF_TYPES = [
  { key: "liveAction",   label: "Live Action",     attioMatch: ["live action"] },
  { key: "ninetyDayGp",  label: "90 Day Gameplan", attioMatch: ["90 day gameplan"] },
  { key: "animation",    label: "Animation",       attioMatch: ["animation"] },
];

// ─── Per-tier badge colours ────────────────────────────────────────
// Keyed by tier `key`. `bg` for soft fill, `fg` for text + accent.
// Missing entries fall back to neutral grey via tierColor() below.
export const TIER_COLORS = {
  // Meta Ads
  starter:   { bg: "rgba(20,184,166,0.12)",  fg: "#14B8A6" },
  standard:  { bg: "rgba(59,130,246,0.12)",  fg: "#3B82F6" },
  premium:   { bg: "rgba(245,158,11,0.12)",  fg: "#F59E0B" },
  deluxe:    { bg: "rgba(139,92,246,0.12)",  fg: "#8B5CF6" },
  // Social (Premium + Organic share tier keys, so shared colours are fine)
  brandBuilder:    { bg: "rgba(34,197,94,0.12)",   fg: "#22C55E" },
  marketLeader:    { bg: "rgba(236,72,153,0.12)",  fg: "#EC4899" },
  marketDominator: { bg: "rgba(239,68,68,0.12)",   fg: "#EF4444" },
  // One-off types (referenced when the Sale form shows one-off "base" price)
  liveAction:  { bg: "rgba(168,85,247,0.12)",  fg: "#A855F7" },
  ninetyDayGp: { bg: "rgba(14,165,233,0.12)",  fg: "#0EA5E9" },
  animation:   { bg: "rgba(251,146,60,0.12)",  fg: "#FB923C" },
};
const NEUTRAL = { bg: "rgba(120,130,150,0.12)", fg: "#5A6B85" };
export function tierColor(key) {
  return TIER_COLORS[key] || NEUTRAL;
}

// ─── PACKAGE_CONFIGS — Meta Ads script generator ───────────────────
// Drives the Meta Ads system prompt: how many motivators per type,
// how many total ads, and which hook strategy. New Meta Ads tiers MUST
// have an entry here or generation silently falls back to "standard".
export const PACKAGE_CONFIGS = {
  starter:  { motivatorsPerType: 2, hooks: ["problemAware"], totalAds: 6 },
  standard: { motivatorsPerType: 3, hooks: ["problemAware"], totalAds: 9 },
  premium:  { motivatorsPerType: 5, hooks: ["problemAware"], totalAds: 15 },
  deluxe:   { motivatorsPerType: 5, hooks: ["problemAware", "problemUnaware"], totalAds: 30 },
};

// ─── DEFAULT_SALE_PRICING ──────────────────────────────────────────
// Seed prices the Sale form shows before founders set live numbers via
// the Founders → Pricing subtab. Derived from the canonical arrays so
// new tiers appear automatically. One-off types get a single `base` slot.
export const DEFAULT_SALE_PRICING = {
  metaAds:       Object.fromEntries(META_ADS_TIERS.map(t => [t.key, 0])),
  socialPremium: Object.fromEntries(SOCIAL_PREMIUM_TIERS.map(t => [t.key, 0])),
  socialOrganic: Object.fromEntries(SOCIAL_ORGANIC_TIERS.map(t => [t.key, 0])),
  ...Object.fromEntries(ONE_OFF_TYPES.map(t => [t.key, { base: 0 }])),
  // Backwards-compat alias for any existing founder-entered prices at
  // /salePricing/socialRetainer. Treated identically to socialPremium.
  socialRetainer: Object.fromEntries(SOCIAL_PREMIUM_TIERS.map(t => [t.key, 0])),
};

// ─── DEFAULT_SALE_THANKYOU ─────────────────────────────────────────
// Per-package thank-you content shown on the branded payment page once a
// deposit clears. Derived from the same taxonomy as pricing so adding a
// new tier automatically gets a thank-you slot.
//   bookingUrl   — single kickoff-meeting booking link shared across
//                  every package (one Calendly / meeting type for all)
//   packages     — { videoType → { tier → { videoUrl, nextStepsCopy } } }
//                  videoUrl: YouTube or Loom URL (embedUrl() normalises
//                  share URLs → iframe src at render time)
//                  nextStepsCopy: free-text "what happens next" markdown
// Edited in Founders → Thank-You Pages. Persisted at /saleThankYou.
const emptyTierSlot = () => ({ videoUrl: "", nextStepsCopy: "" });
export const DEFAULT_SALE_THANKYOU = {
  bookingUrl: "",
  // When true, the thank-you page renders the booking URL as an inline
  // iframe below the welcome video (higher booking conversion, customer
  // doesn't leave the branded page). When false, shows a "Book your
  // kickoff call" button that opens the URL in a new tab. Iframe is
  // only attempted for recognised providers — see isEmbeddableBookingUrl
  // in utils; unknown providers fall back to the button even with
  // embed=true so the page can't break from a non-embeddable URL.
  bookingEmbed: true,
  packages: {
    metaAds:       Object.fromEntries(META_ADS_TIERS.map(t => [t.key, emptyTierSlot()])),
    socialPremium: Object.fromEntries(SOCIAL_PREMIUM_TIERS.map(t => [t.key, emptyTierSlot()])),
    socialOrganic: Object.fromEntries(SOCIAL_ORGANIC_TIERS.map(t => [t.key, emptyTierSlot()])),
    // One-off types have a single "base" tier (matches DEFAULT_SALE_PRICING shape)
    ...Object.fromEntries(ONE_OFF_TYPES.map(t => [t.key, { base: emptyTierSlot() }])),
  },
};

// ─── identifyDeal(rawAttioString) ──────────────────────────────────
// Normalise whatever Attio sent us into { productLine, tier } the rest
// of the system understands. Returns { productLine: null, tier: null }
// if the string matches none of the known project types.
//
//   productLine: "metaAds" | "socialPremium" | "socialOrganic" | "oneOff" | null
//   tier:        canonical key from the relevant *_TIERS array, or for
//                oneOff products, the one-off type key ("liveAction" etc.)
//
// Match precedence: Meta Ads → Social Premium → Social Organic → one-off.
// This ordering matters because "Premium" appears in both Meta Ads tier
// names ("Premium - Meta Ads") and Social ones ("Brand Builder - Social
// Media Premium"). We anchor Meta Ads on the "- meta ads" suffix, Social
// Premium on "social media premium", and Social Organic on "social media
// organic", so overlap can't mis-route.
export function identifyDeal(raw) {
  if (!raw) return { productLine: null, tier: null };
  const lower = String(raw).toLowerCase();

  if (lower.includes("meta ads")) {
    for (const t of META_ADS_TIERS) {
      if (t.attioMatch.some(m => lower.includes(m))) {
        return { productLine: "metaAds", tier: t.key };
      }
    }
  }
  if (lower.includes("social media premium")) {
    for (const t of SOCIAL_PREMIUM_TIERS) {
      if (t.attioMatch.some(m => lower.includes(m))) {
        return { productLine: "socialPremium", tier: t.key };
      }
    }
  }
  if (lower.includes("social media organic")) {
    for (const t of SOCIAL_ORGANIC_TIERS) {
      if (t.attioMatch.some(m => lower.includes(m))) {
        return { productLine: "socialOrganic", tier: t.key };
      }
    }
  }
  for (const t of ONE_OFF_TYPES) {
    if (t.attioMatch.some(m => lower.includes(m))) {
      return { productLine: "oneOff", tier: t.key };
    }
  }

  return { productLine: null, tier: null };
}

// ─── Predicate helpers ─────────────────────────────────────────────
// Thin wrappers around identifyDeal() for places where we only care
// about the product line, not the specific tier.
export function isMetaAdsDeal(raw)        { return identifyDeal(raw).productLine === "metaAds"; }
export function isSocialPremiumDeal(raw)  { return identifyDeal(raw).productLine === "socialPremium"; }
export function isSocialOrganicDeal(raw)  { return identifyDeal(raw).productLine === "socialOrganic"; }
export function isSocialDeal(raw) {
  const pl = identifyDeal(raw).productLine;
  return pl === "socialPremium" || pl === "socialOrganic";
}
export function isOneOffDeal(raw)         { return identifyDeal(raw).productLine === "oneOff"; }
// Backwards-compat name — "Social Retainer" predates the Premium/Organic
// split. Older callers may still reference it; map to the Premium list.
export function isSocialRetainerDeal(raw) { return isSocialPremiumDeal(raw); }

// ─── normaliseTier(raw, type) ──────────────────────────────────────
// Lightweight wrapper the webhook uses when it already knows the product
// line and just wants the canonical tier key. `type` narrows the search.
//   type = "metaAds" | "socialPremium" | "socialOrganic" | "oneOff"
export function normaliseTier(raw, type) {
  const { productLine, tier } = identifyDeal(raw);
  if (!type) return tier;
  return productLine === type ? tier : null;
}

// ─── videoTypeToPartnership(rawAttioString) ────────────────────────
// Maps an Attio `video_type` string into the canonical partnership
// label the Accounts dashboard's dropdown renders. Without this the
// raw Attio string (e.g. "Brand Builder - Social Media Premium")
// gets stored on /accounts/{id}.partnershipType, but the dashboard's
// <select> only has options like "Brand Builder - Social Media" —
// so the value-prop matches nothing, and the dropdown renders blank
// even though the data was set correctly.
//
// Returns "" when the string can't be identified — caller decides
// what to do (today: keep "" so the field reads as unset rather
// than persisting an unmapped raw string).
//
// Mapping is intentional, not derived: Social Media Premium and
// Social Media Organic deals BOTH collapse onto the same "X -
// Social Media" labels in the dashboard because the producer-
// facing distinction at this level is the tier (Brand Builder /
// Market Leader / etc.), not whether it's the paid or organic
// retainer (`productLine` already lives on /projects records for
// anything that needs to branch on it).
const _PARTNERSHIP_LABELS = {
  metaAds: {
    starter:  "Starter - Meta Ads",
    standard: "Standard - Meta Ads",
    premium:  "Premium - Meta Ads",
    deluxe:   "Deluxe - Meta Ads",
  },
  socialPremium: {
    starter:         "Starter Pack - Social Media",
    brandBuilder:    "Brand Builder - Social Media",
    marketLeader:    "Market Leader - Social Media",
    marketDominator: "Market Dominator - Social Media",
  },
  socialOrganic: {
    starter:         "Starter Pack - Social Media",
    brandBuilder:    "Brand Builder - Social Media",
    marketLeader:    "Market Leader - Social Media",
    marketDominator: "Market Dominator - Social Media",
  },
  oneOff: {
    liveAction:  "Live Action",
    ninetyDayGp: "90 Day Gameplan",
    animation:   "Animation",
  },
};
export function videoTypeToPartnership(rawAttioString) {
  if (!rawAttioString) return "";
  const { productLine, tier } = identifyDeal(rawAttioString);
  if (!productLine || !tier) return "";
  return _PARTNERSHIP_LABELS[productLine]?.[tier] || "";
}

// ─── tierLabel(key, type) ──────────────────────────────────────────
// Display name lookup. Pass `type` to disambiguate the tier keys that
// appear in multiple lists (e.g. "starter" exists in every list).
export function tierLabel(key, type) {
  if (!key) return "";
  const list = type === "metaAds"       ? META_ADS_TIERS
             : type === "socialPremium" ? SOCIAL_PREMIUM_TIERS
             : type === "socialOrganic" ? SOCIAL_ORGANIC_TIERS
             : type === "oneOff"        ? ONE_OFF_TYPES
             : [...META_ADS_TIERS, ...SOCIAL_PREMIUM_TIERS, ...SOCIAL_ORGANIC_TIERS, ...ONE_OFF_TYPES];
  return list.find(t => t.key === key)?.label || key;
}

// ─── productLineLabel(key) ─────────────────────────────────────────
// Human display name for the product-line tag shown on Projects /
// Preproduction records.
export function productLineLabel(key) {
  switch (key) {
    case "metaAds":       return "Meta Ads";
    case "socialPremium": return "Social Media Premium";
    case "socialOrganic": return "Social Media Organic";
    case "oneOff":        return "One-off project";
    default:              return "";
  }
}

// ─── SALE_VIDEO_TYPES ──────────────────────────────────────────────
// Composite shape consumed by the Sale form. One entry per product line,
// carrying its tier list. One-off types expose a single synthetic "base"
// tier so the Sale form can price them without special-casing.
export const SALE_VIDEO_TYPES = [
  { key: "metaAds",       label: "Meta Ads",              packages: META_ADS_TIERS.map(t => ({ key: t.key, label: t.label })) },
  { key: "socialPremium", label: "Social Media Premium",  packages: SOCIAL_PREMIUM_TIERS.map(t => ({ key: t.key, label: t.label })) },
  { key: "socialOrganic", label: "Social Media Organic",  packages: SOCIAL_ORGANIC_TIERS.map(t => ({ key: t.key, label: t.label })) },
  ...ONE_OFF_TYPES.map(t => ({
    key: t.key, label: t.label,
    packages: [{ key: "base", label: t.label }],
  })),
  // Custom: founder-defined schedule per client. Single synthetic package
  // key so the existing videoType + packageKey shape stays valid downstream.
  // `custom: true` lets the pricing tab, partnership-label, and webhook
  // routers branch without enumerating product lines.
  { key: "custom", label: "Custom", custom: true, packages: [{ key: "custom", label: "Custom" }] },
];

// Bounds on the founder-defined Custom schedule. Row 0 is always the
// deposit/now slice — these limits are inclusive of it.
export const CUSTOM_MIN_SLICES = 2;
export const CUSTOM_MAX_SLICES = 6;

// ─── GST (Australia) ────────────────────────────────────────────────
// All founder-entered sale prices are stored EX-GST. GST is added at
// 10% on every customer-facing total. Single constant so it's easy to
// find if the rate ever changes (unlikely but not impossible).
export const GST_RATE = 0.10;

// ─── Stripe processing fee surcharge ───────────────────────────────
// Pass-through of Stripe's AU domestic fee (1.7% + 30c per charge),
// adjusted to break-even after Stripe takes its cut of the surcharge
// itself. Formula:
//
//   Surcharge = (1.7% × original + 30c) ÷ 0.983
//
// Which simplifies to ~1.73% + 30c on each individual Stripe charge.
// Applied per slice (each instalment is a separate Stripe charge,
// each gets its own 30c fixed fee).
//
// ACCC-compliant: this is the true cost of card acceptance, not a
// profit margin. International cards / Amex cost more (~3.5% + 30c)
// but we absorb that variance — the typical Viewix client uses an
// AU domestic card so the average still sits at break-even.
export const STRIPE_SURCHARGE_PCT   = 0.0173;
export const STRIPE_SURCHARGE_FIXED = 0.30;

// Compute the Stripe processing fee surcharge for a given inc-GST
// amount. Returns the surcharge to ADD on top of `amount` so the
// customer covers Stripe's fee. Always rounded to cents.
export function computeStripeSurcharge(amount) {
  const a = Number(amount) || 0;
  if (a <= 0) return 0;
  return Math.round((a * STRIPE_SURCHARGE_PCT + STRIPE_SURCHARGE_FIXED) * 100) / 100;
}

// ─── SALE_SCHEDULES ────────────────────────────────────────────────
// Per-product-line billing schedule. Used by buildSchedule() in utils
// to produce the array of instalments on each Sale record.
//
//   kind:
//     "deposit_plus_manual"   — first slice auto-charged at checkout;
//                               remaining slices charged manually from
//                               the Sale row's "Charge Balance" button
//                               (founder decides when). Card is saved
//                               via Stripe setup_future_usage so the
//                               later charge is off-session.
//     "subscription_monthly"  — first slice charged at checkout via
//                               Stripe Embedded Checkout subscription
//                               mode; subsequent slices auto-charged by
//                               Stripe's subscription engine on the
//                               dueDaysOffset cadence. Subscription
//                               auto-cancels after the last slice.
//     "paid_in_full"          — single slice, charged at checkout. No
//                               card saving needed.
//
//   pcts must sum to 100. The last slice absorbs rounding so slice
//   amounts * 100 / grandTotal is exact.
export const SALE_SCHEDULES = {
  metaAds: {
    kind: "deposit_plus_manual",
    slices: [
      { pct: 50, label: "Deposit",  trigger: "now" },
      { pct: 50, label: "Balance",  trigger: "manual", dueDaysOffset: null },
    ],
  },
  socialPremium: {
    kind: "subscription_monthly",
    slices: [
      { pct: 33.34, label: "Payment 1", trigger: "now" },
      { pct: 33.33, label: "Payment 2", trigger: "auto", dueDaysOffset: 30 },
      { pct: 33.33, label: "Payment 3", trigger: "auto", dueDaysOffset: 60 },
    ],
  },
  socialOrganic: {
    kind: "subscription_monthly",
    slices: [
      { pct: 33.34, label: "Payment 1", trigger: "now" },
      { pct: 33.33, label: "Payment 2", trigger: "auto", dueDaysOffset: 30 },
      { pct: 33.33, label: "Payment 3", trigger: "auto", dueDaysOffset: 60 },
    ],
  },
  // One-off types (liveAction, explainer, etc.) all default to 50/50
  // with manual balance — same as Meta Ads. Individual types can be
  // overridden here if a particular one-off needs a different shape.
  _default: {
    kind: "deposit_plus_manual",
    slices: [
      { pct: 50, label: "Deposit",  trigger: "now" },
      { pct: 50, label: "Balance",  trigger: "manual", dueDaysOffset: null },
    ],
  },
  // Custom — schedule slices come from sale.customSlices[], not from
  // this config. buildSchedule() refuses to handle custom; the API and
  // UI must call buildCustomSchedule() from api/_sale-schedules.js.
  custom: {
    kind: "custom",
    slices: [],
  },
};

// Helper: look up the schedule config for a videoType key. Returns the
// explicit `custom` entry when asked; otherwise falls back to _default
// for any one-off not explicitly mapped.
export function scheduleForVideoType(videoType) {
  if (videoType === "custom") return SALE_SCHEDULES.custom;
  return SALE_SCHEDULES[videoType] || SALE_SCHEDULES._default;
}
