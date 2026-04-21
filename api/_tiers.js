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
];
