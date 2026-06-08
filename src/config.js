// ─── Content Categories ───
export const CONTENT_CATEGORIES = ["Meta Ad", "Social Media", "Corporate Video", "Other"];
export const CAT_COLORS = { "Meta Ad": "#8B5CF6", "Social Media": "#0082FA", "Corporate Video": "#F87700", "Other": "#5A6B85" };

// ─── Deliveries ───
// Canonical strings live in api/_constants.js so the Vercel
// serverless functions and this frontend bundle can't drift apart
// (notify-revision.js once compared against "Needs Revisions" while
// the dropdown wrote "Need Revisions"). Re-exported under the same
// names existing imports already use.
export {
  VIEWIX_STATUSES,
  VIEWIX_STATUS_COLORS,
  CLIENT_REVISION_OPTIONS,
  CLIENT_REVISION_COLORS,
  CLIENT_GOAL_OPTIONS,
  CLIENT_GOAL_LABELS,
  CLIENT_GOAL_COLORS,
} from "../api/_constants.js";

// ─── Training ───
export const DEFAULT_TRAINING = [
  { id: "tc-1", name: "Editor Onboarding", order: 1, modules: [
    { id: "tm-01", name: "Editor Onboarding Start", order: 0, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-02", name: "Viewix Software Suite", order: 1, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-03", name: "Navigating the Server", order: 2, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-04", name: "Project Setup Basics", order: 3, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-05", name: "Premiere Productions", order: 4, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-06", name: "Colour Grading", order: 5, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-07", name: "Sound Mix and Final Delivery", order: 6, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-08", name: "Social Retainers Intro", order: 7, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-09", name: "Editing Social Retainers", order: 8, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-10", name: "Hook Find Guide", order: 9, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-11", name: "Meta Ads Intro", order: 10, description: "", videoUrl: "", comments: [], completions: {} },
  ]},
  { id: "tc-2", name: "Sales Training", order: 2, modules: [
    { id: "tm-20", name: "ICP 1 & Sales Funnel", order: 1, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-21", name: "ICP2 & Sales Mentality", order: 2, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-22", name: "Sales Process & Meeting Structure", order: 3, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-23", name: "Buyer Personality Types", order: 4, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-24", name: "Meta Ads Funnel", order: 5, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-25", name: "Call Leads Instantly", order: 6, description: "", videoUrl: "", comments: [], completions: {} },
  ]},
  { id: "tc-3", name: "Producer Onboarding", order: 3, modules: [
    { id: "tm-30", name: "Project Lead Roles and Responsibilities", order: 1, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-31", name: "Social Media Retainer", order: 2, description: "", videoUrl: "", comments: [], completions: {} },
    { id: "tm-32", name: "Meta Ads", order: 3, description: "", videoUrl: "", comments: [], completions: {} },
  ]},
];

// ─── Day/Week Constants ───
export const DK = ["mon", "tue", "wed", "thu", "fri"];
export const DL = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// ─── Queueing Theory Table ───
export const QT = [
  { util: 0.5, wait: "1x" }, { util: 0.7, wait: "2.3x" }, { util: 0.75, wait: "3x" },
  { util: 0.8, wait: "4x" }, { util: 0.85, wait: "5.7x" }, { util: 0.9, wait: "9x" },
  { util: 0.95, wait: "19x" }, { util: 0.99, wait: "99x" }
];

// ─── Default Team Roster ───
// `role` controls whether they occupy an edit suite & appear in the Weekly Schedule
//  - "editor" → needs a suite, counted toward computer capacity
//  - "crew"   → no suite, doesn't show in weekly schedule (producers, founders, etc.)
export const DEF_EDS = [
  { id: "ed-1", name: "Angus", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: false, fri: true } },
  { id: "ed-2", name: "David", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } },
  { id: "ed-3", name: "Billy", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: false, wed: true, thu: true, fri: true } },
  { id: "ed-4", name: "Jude", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: true, wed: false, thu: true, fri: true } },
  { id: "ed-5", name: "Mia", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: false, fri: false } },
  { id: "ed-6", name: "Matt", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: false } },
  { id: "ed-7", name: "Luke", phone: "", email: "", bookingUrl: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } },
  { id: "ed-jeremy", name: "Jeremy", phone: "", email: "", bookingUrl: "", role: "crew", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } },
  { id: "ed-steve", name: "Steve", phone: "", email: "", bookingUrl: "", role: "crew", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } },
];

// ─── Default Inputs ───
export const DEF_IN = {
  totalSuites: 7, hoursPerSuitePerDay: 8, avgEditHoursPerProject: 4.5,
  newProjectsPerWeek: 6, avgProjectDuration: 12, targetUtilisation: 0.75, currentActiveProjects: 42
};

// ─── Quote Sections ───
export const QUOTE_SECTIONS = [
  { id: "preprod", name: "Pre-Production", items: [
    { id: "pp1", role: "Pre Production", rate: 42 }, { id: "pp2", role: "Crewing", rate: 34 },
    { id: "pp3", role: "Site Recce", rate: 34 }, { id: "pp4", role: "Scriptwriting", rate: 34 }
  ]},
  { id: "prod", name: "Production", items: [
    { id: "pr1", role: "Producer", rate: 66 }, { id: "pr2", role: "Cinematographer", rate: 66 },
    { id: "pr3", role: "Shooter/Editor", rate: 42.31 }, { id: "pr4", role: "Second Shooter", rate: 100 },
    { id: "pr5", role: "PA/Runner", rate: 85 }, { id: "pr6", role: "AC", rate: 100 }
  ]},
  { id: "postprod", name: "Post-Production", items: [
    { id: "po1", role: "Editor (Internal)", rate: 42 }, { id: "po2", role: "VFX/Graphics", rate: 187.5 },
    { id: "po3", role: "External Editor", rate: 75 }, { id: "po4", role: "Producer", rate: 125 }
  ]},
  { id: "anim", name: "Animation", items: [
    { id: "an1", role: "Scripting", rate: 100 }, { id: "an2", role: "Storyboarding", rate: 150 },
    { id: "an3", role: "Animator", rate: 150 }
  ]},
  { id: "photo", name: "Photography", items: [
    { id: "ph1", role: "Photographer", rate: 0 }
  ]},
  { id: "addl", name: "Additional Costs", items: [
    { id: "ad1", role: "Music", rate: 80 }, { id: "ad2", role: "Travel (p/km)", rate: 0.72 },
    { id: "ad3", role: "VO Artist", rate: 350 }, { id: "ad4", role: "Misc", rate: 1 },
    { id: "ad5", role: "Overheads", rate: 38 }, { id: "ad6", role: "Data Storage (1TB)", rate: 63.5 }
  ]}
];

// ─── Output Presets ───
export const OUTPUT_PRESETS = [
  "1 x 15 sec Social Media Cutdown",
  "1 x 25 sec Social Media Cutdown (16:9, 9:16, 1:1)",
  "1 x 30 sec Social Media Cutdown",
  "1 x 60 sec Hype Video",
];

// ─── Filming & Editing Defaults ───
export const FILMING_DEFAULTS = [
  "3 Hours Filming", "2 Videographers", "2 x Cameras", "Full Lighting Kit", "Microphones"
];
export const EDITING_DEFAULTS = [
  "1 Day Editing", "Color Grade", "Music Licencing", "Graphic Supers (lower thirds text)",
  "Logo Animation", "2 x Rounds of Revisions"
];

// ─── Rate Cards ───
export const DEFAULT_RATE_CARDS = [
  { id: "rc-zoo", name: "Sydney Zoo", rates: { "Scheduling": 100, "Crewing": 100, "Site Recce": 100, "Scriptwriting": 100, "Cinematographer": 125, "Producer": 125, "PA/Runner": 85, "AC": 100, "Second Shooter": 100, "Shooter/Editor": 100, "Editor (Internal)": 75, "VFX/Graphics": 187.5, "External Editor": 75, "Scripting": 100, "Storyboarding": 150, "Animator": 150, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-wsa", name: "Western Sydney Airport", zeroMargin: true, rates: { "Scheduling": 140.8, "Crewing": 140.8, "Site Recce": 140.8, "Scriptwriting": 140.8, "Cinematographer": 140.8, "Producer": 140.8, "PA/Runner": 140.8, "AC": 140.8, "Second Shooter": 140.8, "Shooter/Editor": 140.8, "Editor (Internal)": 140.8, "VFX/Graphics": 140.8, "External Editor": 140.8, "Scripting": 140.8, "Storyboarding": 140.8, "Animator": 140.8, "Photographer": 168.96, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 415, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-tg", name: "Transgrid", rates: { "Scheduling": 34, "Crewing": 34, "Site Recce": 34, "Scriptwriting": 34, "Cinematographer": 100, "Producer": 100, "Shooter/Editor": 42.31, "Editor (Internal)": 42, "VFX/Graphics": 187.5, "External Editor": 75, "Scripting": 100, "Storyboarding": 150, "Animator": 150, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-bmd", name: "BMD", rates: { "Scheduling": 34, "Crewing": 34, "Site Recce": 34, "Scriptwriting": 34, "Cinematographer": 100, "Producer": 100, "Shooter/Editor": 42.31, "Editor (Internal)": 42, "VFX/Graphics": 187.5, "External Editor": 75, "Scripting": 100, "Storyboarding": 150, "Animator": 150, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-thnsw", name: "THNSW", zeroMargin: true, rates: { "Scheduling": 150, "Crewing": 150, "Site Recce": 150, "Scriptwriting": 150, "Cinematographer": 150, "Producer": 150, "PA/Runner": 150, "AC": 150, "Second Shooter": 150, "Shooter/Editor": 150, "Editor (Internal)": 150, "VFX/Graphics": 150, "External Editor": 150, "Scripting": 150, "Storyboarding": 150, "Animator": 150, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-snowy", name: "Snowy Hydro", zeroMargin: true, rates: { "Scheduling": 150, "Crewing": 150, "Site Recce": 150, "Scriptwriting": 150, "Cinematographer": 150, "Producer": 150, "PA/Runner": 150, "AC": 150, "Shooter/Editor": 150, "Editor (Internal)": 150, "VFX/Graphics": 150, "External Editor": 150, "Scripting": 150, "Storyboarding": 150, "Animator": 150, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-pnsw", name: "Property NSW", rates: { "Scheduling": 133, "Crewing": 133, "Site Recce": 133, "Scriptwriting": 133, "Cinematographer": 133, "Producer": 133, "PA/Runner": 133, "AC": 133, "Second Shooter": 133, "Shooter/Editor": 133, "Editor (Internal)": 133, "VFX/Graphics": 133, "External Editor": 133, "Scripting": 133, "Storyboarding": 133, "Animator": 133, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
  { id: "rc-d2c", name: "D2C", rates: { "Scheduling": 100, "Crewing": 100, "Site Recce": 100, "Scriptwriting": 100, "Cinematographer": 80, "Producer": 80, "PA/Runner": 80, "AC": 80, "Second Shooter": 80, "Shooter/Editor": 80, "Editor (Internal)": 50, "VFX/Graphics": 187.5, "External Editor": 75, "Scripting": 100, "Storyboarding": 150, "Animator": 150, "Music": 80, "Travel (p/km)": 0.72, "VO Artist": 350, "Overheads": 38, "Data Storage (1TB)": 63.5 } },
];

// ─── Sale Packages ───
// Tier definitions (Meta Ads + Social Retainer), per-tier colours, the
// PACKAGE_CONFIGS used by the Meta Ads script generator, and the default
// $0 pricing seed all live in api/_tiers.js — single source of truth so
// adding a new tier doesn't require hunting through six files. We
// re-export here so existing client-side imports (`from "./config"`)
// keep working.
export {
  META_ADS_TIERS,
  SOCIAL_PREMIUM_TIERS,
  SOCIAL_ORGANIC_TIERS,
  SOCIAL_RETAINER_TIERS,   // legacy alias → SOCIAL_PREMIUM_TIERS
  ONE_OFF_TYPES,
  TIER_COLORS,
  tierColor,
  tierLabel,
  productLineLabel,
  PACKAGE_CONFIGS,
  identifyDeal,
  normaliseTier,
  isMetaAdsDeal,
  isSocialPremiumDeal,
  isSocialOrganicDeal,
  isSocialDeal,
  isOneOffDeal,
  isSocialRetainerDeal,    // legacy alias
  SALE_VIDEO_TYPES,
  DEFAULT_SALE_PRICING,
  DEFAULT_SALE_THANKYOU,
} from "../api/_tiers.js";

// ─── Client Milestones ─────────────────────────────────────────────
// The fixed post-sale milestone sequence used in two places:
//   1. AccountsDashboard — computes per-account "next milestone due"
//      dates from the client's signing date + these gap defaults.
//   2. BuyerJourney — stages can link to a milestoneKey so editing
//      "days to next stage" there writes to /turnaround and auto-syncs
//      with AccountsDashboard's due-date calculations.
//
// DEFAULT_MILESTONE_GAPS is the fallback when /turnaround has no entry
// for a given key — typically the first-load bootstrap.
// Each entry has a `type`:
//   "date"   — a single date input. Producers fill manually (signing
//              is the most recent signed-deal date for the client;
//              goLive / finalLive are video posting dates).
//   "status" — a single dropdown with custom options on `statuses`.
//              Used for milestone work that doesn't have a single
//              date — Boosting Strategy / Many Chat are workflow
//              checkpoints, not scheduled events.
//
// The previous schema's date+status pair on every milestone was
// over-fitted to the original Pre-Prod / Shoot / Posting / Review
// flow. Real producer activity splits cleanly into "happens on a
// date" vs "is in this state right now".
//
// Older accounts in Firebase carry milestone records with both
// `date` and `status` plus the legacy keys (preProductionMeeting,
// shoot, etc.); we don't delete that data, we just stop rendering
// the old keys. BuyerJourney still references some of them
// internally for stage-to-key mapping; that path is unaffected.
export const MILESTONE_DEFS = [
  { key: "signing",          label: "Signing",          type: "date" },
  { key: "goLive",           label: "Go Live",          type: "date" },
  { key: "finalLive",        label: "Final Live",       type: "date" },
  { key: "boostingStrategy", label: "Boosting Strategy", type: "status",
    statuses: ["Not started", "Scheduled", "Done"] },
  { key: "manyChat",         label: "Many Chat",         type: "status",
    statuses: ["Not started", "Scheduled", "Done"] },
];

// Auto-cascade gaps from Signing date → other milestones is no
// longer used (Go Live / Final Live are manually entered when the
// videos actually post). Kept as an empty object so any code that
// still imports it doesn't crash.
export const DEFAULT_MILESTONE_GAPS = {};

// ─── Shared Styles ───
export const TH = { padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "2px solid var(--border)", background: "var(--card)" };
export const TD = { padding: "6px 10px", borderBottom: "1px solid var(--border-light)" };
export const NB = { height: 36, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 12px" };
export const BTN = { padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer" };

// ─── CSS ───
export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;600;700;800&display=swap');
/* Unified Design Language tokens. The brand hues are unchanged (Viewix Blue
   #0082FA, Orange #F87700); the neutral ramp is deepened and layered so
   surfaces read as real elevation, and the text scale gains a legible
   secondary step the old tokens lacked. Existing variable NAMES are preserved
   so every tab that already consumes --bg/--card/--accent/etc. inherits the
   refined palette with no edits; the new tokens (--rail, --card-2, --fg-2,
   status hues, radii, elevation) are additive for components that opt in. */
:root{
  /* surfaces (dark, low → high) */
  --bg:#0A0E17;--rail:#0D1220;--card:#141A29;--card-2:#19202F;--inset:#0E131F;
  /* hairlines */
  --border:#222D40;--border-soft:#1A2231;--border-light:#1A2231;
  /* text — 4-step hierarchy */
  --fg:#EAEEF6;--fg-2:#9DABC2;--muted:#61728C;--faint:#3D4B62;
  /* brand + status */
  --accent:#0082FA;--accent-bright:#3DA2FF;--accent-soft:rgba(0,130,250,0.13);
  --orange:#F87700;--orange-soft:rgba(248,119,0,0.13);
  --success:#1EC081;--success-soft:rgba(30,192,129,0.13);
  --amber:#F5A623;--amber-soft:rgba(245,166,35,0.13);
  --danger:#F2545B;--purple:#9B7BF0;--purple-soft:rgba(155,123,240,0.14);--pink:#EC6FA8;
  /* radii scale */
  --r1:6px;--r2:8px;--r3:10px;--r4:14px;--r5:18px;
  /* elevation */
  --shadow1:0 1px 2px rgba(0,0,0,0.4);--shadow2:0 8px 24px -14px rgba(0,0,0,0.8);
  --shadow3:0 18px 48px -22px rgba(0,0,0,0.9);
  --glow:0 0 0 1px rgba(0,130,250,0.18), 0 10px 32px -16px rgba(0,130,250,0.55);
  /* legacy aliases kept for existing consumers */
  --bar-bg:#19202F;--input-bg:#0E131F;
}
*{box-sizing:border-box;margin:0;padding:0;}
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;}
input[type="number"]{-moz-appearance:textfield;}
::-webkit-scrollbar{width:6px;height:6px;}
::-webkit-scrollbar-track{background:var(--bg);}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
/* Chunky-scroll: opt-in class for scroll panels where grabbiness > minimalism.
   Used on the Team Board because producers were missing the 6px target. The
   !important flags defeat the global ::-webkit-scrollbar above (the global
   rule and this scoped rule have the same specificity at the pseudo level
   in some Chromium builds, and we want the chunky version to always win).
   Min thumb size keeps the grip visible on long scrolls, the accent flash
   on active-drag confirms a successful grab, and the inset shadow on the
   thumb adds a subtle ridge so it reads as a physical object even against
   the dark grid cells under the schedule. */
.chunky-scroll{scrollbar-width:auto !important;scrollbar-color:#5A7AA0 rgba(255,255,255,0.05) !important;}
.chunky-scroll::-webkit-scrollbar{width:18px !important;height:14px !important;}
.chunky-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,0.05) !important;border-left:1px solid var(--border);border-top:1px solid var(--border);}
.chunky-scroll::-webkit-scrollbar-thumb{background:#5A7AA0 !important;border-radius:9px !important;border:2px solid var(--bg) !important;min-height:48px !important;min-width:48px !important;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08);}
.chunky-scroll::-webkit-scrollbar-thumb:hover{background:#7E9DC2 !important;}
.chunky-scroll::-webkit-scrollbar-thumb:active{background:var(--accent) !important;}
.chunky-scroll::-webkit-scrollbar-corner{background:var(--bg) !important;}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
@keyframes founders-ticker-scroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
.founders-ticker-track{animation:founders-ticker-scroll 60s linear infinite;}
.founders-ticker-track:hover{animation-play-state:paused;}
`;

// CSS_LIGHT — the EXTERNAL (client-facing) theme. Same CSS variable
// NAMES as the dark theme above, brand-compliant LIGHT values, scoped
// to a `.viewix-portal` wrapper so it never leaks into the internal
// app. "dark = internal, light = external" — token-only theming, one
// component layer, two maps. Full Viewix brand: white/light-grey
// surfaces, Viewix Blue primary, Viewix Orange accent (≤10%, used via
// --accent-2), Montserrat throughout.
export const CSS_LIGHT = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,600;0,700;0,800;1,400;1,600&display=swap');
.viewix-portal{
  --bg:#FFFFFF;--fg:#1A2233;--card:#F4F5F9;--border:#CBCCD1;--border-light:#E3E5EC;
  --muted:#6B7280;--accent:#0082FA;--accent-2:#F87700;--accent-soft:rgba(0,130,250,0.10);
  --navy:#004F99;--bar-bg:#ECEEF3;--input-bg:#FFFFFF;--good:#10B981;
  font-family:'Montserrat',Arial,Helvetica,sans-serif;
  background:var(--bg);color:var(--fg);min-height:100vh;line-height:1.55;
}
.viewix-portal *{box-sizing:border-box;margin:0;padding:0;font-family:inherit;}
.viewix-portal ::-webkit-scrollbar{width:8px;height:8px;}
.viewix-portal ::-webkit-scrollbar-track{background:var(--card);}
.viewix-portal ::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
@keyframes viewix-portal-rise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
.viewix-portal .rise{animation:viewix-portal-rise .45s ease both;}
`;
