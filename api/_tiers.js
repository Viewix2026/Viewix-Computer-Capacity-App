// api/_tiers.js
// SINGLE SOURCE OF TRUTH for every package tier the dashboard knows about.
//
// Lives under api/ because Vercel serverless functions can't reach into
// src/, but the client side imports from this file too (vite resolves the
// relative path at build time). Result: one place to add a new tier, and
// the webhook + script generator + Sale form + every UI badge all pick it
// up automatically.
//
// To add a new tier:
//   1. Add an entry to META_ADS_TIERS or SOCIAL_RETAINER_TIERS.
//   2. (Meta Ads only) add a PACKAGE_CONFIGS entry with motivators+ads+hooks.
//   3. (Optional) add a colour to TIER_COLORS — falls back to grey if missing.
//   4. Add to DEFAULT_SALE_PRICING so the Sale form shows it before founders
//      set a real price.
//   5. Make sure Zapier sends the matching deal type string from Attio
//      (the normaliseTier helper handles spacing / casing variations).

// ─── Meta Ads tiers ────────────────────────────────────────────────
// `key`   — canonical camelCase id used everywhere (Firebase paths, prices)
// `label` — human display name (UI badges, dropdowns)
// `attioMatch` — substring(s) the Attio deal type may contain (case-
//   insensitive). If the producer renames a tier upstream, add the new
//   spelling here so the webhook keeps detecting it.
export const META_ADS_TIERS = [
  { key: "starter",  label: "Starter",  attioMatch: ["starter"] },
  { key: "standard", label: "Standard", attioMatch: ["standard"] },
  { key: "premium",  label: "Premium",  attioMatch: ["premium"] },
  { key: "deluxe",   label: "Deluxe",   attioMatch: ["deluxe"] },
];

// ─── Social Retainer tiers ─────────────────────────────────────────
// Same shape as META_ADS_TIERS. Note Attio sends spaced names like
// "Brand Builder" — listed in attioMatch so normaliseTier picks them up.
export const SOCIAL_RETAINER_TIERS = [
  { key: "starter",         label: "Starter Pack",     attioMatch: ["starter pack", "starter"] },
  { key: "brandBuilder",    label: "Brand Builder",    attioMatch: ["brand builder"] },
  { key: "marketLeader",    label: "Market Leader",    attioMatch: ["market leader"] },
  { key: "marketDominator", label: "Market Dominator", attioMatch: ["market dominator"] },
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
  // Social Retainer
  brandBuilder:    { bg: "rgba(34,197,94,0.12)",   fg: "#22C55E" },
  marketLeader:    { bg: "rgba(236,72,153,0.12)",  fg: "#EC4899" },
  marketDominator: { bg: "rgba(239,68,68,0.12)",   fg: "#EF4444" },
};
const NEUTRAL = { bg: "rgba(120,130,150,0.12)", fg: "#5A6B85" };
export function tierColor(key) {
  return TIER_COLORS[key] || NEUTRAL;
}

// ─── PACKAGE_CONFIGS — Meta Ads script generator ───────────────────
// Drives the Meta Ads system prompt: how many motivators per type,
// how many total ads, and which hook strategy. New Meta Ads tiers MUST
// have an entry here or generation will fall back to "standard" silently.
export const PACKAGE_CONFIGS = {
  starter:  { motivatorsPerType: 2, hooks: ["problemAware"], totalAds: 6 },
  standard: { motivatorsPerType: 3, hooks: ["problemAware"], totalAds: 9 },
  premium:  { motivatorsPerType: 5, hooks: ["problemAware"], totalAds: 15 },
  deluxe:   { motivatorsPerType: 5, hooks: ["problemAware", "problemUnaware"], totalAds: 30 },
};

// ─── DEFAULT_SALE_PRICING ──────────────────────────────────────────
// Seed prices the Sale form uses before founders set live numbers via the
// Founders → Pricing subtab. Keep one entry per tier in each type.
export const DEFAULT_SALE_PRICING = {
  metaAds:        Object.fromEntries(META_ADS_TIERS.map(t => [t.key, 0])),
  socialRetainer: Object.fromEntries(SOCIAL_RETAINER_TIERS.map(t => [t.key, 0])),
};

// ─── normaliseTier(rawString, type) ────────────────────────────────
// Convert whatever Attio (or any upstream) sent us into a canonical key
// the rest of the system understands. Returns null if no match.
//   type = "metaAds" | "socialRetainer"   (optional — narrows the search)
export function normaliseTier(raw, type) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase();
  const candidates = type === "metaAds"
    ? META_ADS_TIERS
    : type === "socialRetainer"
    ? SOCIAL_RETAINER_TIERS
    : [...META_ADS_TIERS, ...SOCIAL_RETAINER_TIERS];
  for (const t of candidates) {
    if (t.attioMatch.some(m => lower.includes(m))) return t.key;
  }
  return null;
}

// ─── isMetaAdsDeal / isSocialRetainerDeal ──────────────────────────
// Quick predicates the webhook uses to pick which preproduction tree
// to write into.
export function isMetaAdsDeal(rawType) {
  return META_ADS_TIERS.some(t => t.attioMatch.some(m => String(rawType || "").toLowerCase().includes(m)));
}
export function isSocialRetainerDeal(rawType) {
  return SOCIAL_RETAINER_TIERS.some(t => t.attioMatch.some(m => String(rawType || "").toLowerCase().includes(m)));
}

// ─── tierLabel(key) ────────────────────────────────────────────────
// Display name lookup. Works across both types since `key`s don't collide
// (META_ADS_TIERS and SOCIAL_RETAINER_TIERS share "starter" — caller
// should pass `type` if disambiguation matters).
export function tierLabel(key, type) {
  if (!key) return "";
  const list = type === "metaAds" ? META_ADS_TIERS
             : type === "socialRetainer" ? SOCIAL_RETAINER_TIERS
             : [...META_ADS_TIERS, ...SOCIAL_RETAINER_TIERS];
  return list.find(t => t.key === key)?.label || key;
}

// ─── SALE_VIDEO_TYPES ──────────────────────────────────────────────
// Composite shape consumed by the Sale form (one entry per video type
// each carrying its tier list). Stays in sync automatically since we
// derive it from the canonical arrays.
export const SALE_VIDEO_TYPES = [
  { key: "metaAds", label: "Meta Ads", packages: META_ADS_TIERS.map(t => ({ key: t.key, label: t.label })) },
  { key: "socialRetainer", label: "Social Media Retainer", packages: SOCIAL_RETAINER_TIERS.map(t => ({ key: t.key, label: t.label })) },
];
