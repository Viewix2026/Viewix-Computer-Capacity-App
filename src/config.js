// ─── Monday.com Editor Defaults ───
export const DEFAULT_MONDAY_EDITORS = [
  { id: "66265733", name: "Angus Roche" },
  { id: "96885430", name: "Billy White" },
  { id: "68480795", name: "David Esdaile" },
  { id: "94902565", name: "Felipe Fuhr" },
  { id: "97138079", name: "Jude Palmer Rowlands" },
  { id: "100235454", name: "Luke Genovese-Kollar" },
  { id: "97345986", name: "Matt Healey" },
  { id: "85363605", name: "Mia Wolczak" },
  { id: "90227304", name: "Vish Peiris" },
  { id: "99188387", name: "Farah" },
];

// ─── Content Categories ───
export const CONTENT_CATEGORIES = ["Meta Ad", "Social Media", "Corporate Video", "Other"];
export const CAT_COLORS = { "Meta Ad": "#8B5CF6", "Social Media": "#0082FA", "Corporate Video": "#F87700", "Other": "#5A6B85" };

// ─── Deliveries ───
export const VIEWIX_STATUSES = ["In Development", "Ready for Review", "Need Revisions", "Completed"];
export const VIEWIX_STATUS_COLORS = { "In Development": "#F59E0B", "Ready for Review": "#0082FA", "Need Revisions": "#EF4444", "Completed": "#10B981" };
export const CLIENT_REVISION_OPTIONS = ["", "Approved", "Need Revisions"];
export const CLIENT_REVISION_COLORS = { "Approved": "#10B981", "Need Revisions": "#EF4444" };

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

// ─── Default Editors (Capacity Grid) ───
export const DEF_EDS = [
  { id: "ed-1", name: "Angus", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: false, fri: true } },
  { id: "ed-2", name: "David", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } },
  { id: "ed-3", name: "Billy", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: false, wed: true, thu: true, fri: true } },
  { id: "ed-4", name: "Jude", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: false, thu: true, fri: true } },
  { id: "ed-5", name: "Mia", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: false, fri: false } },
  { id: "ed-6", name: "Matt", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: false } },
  { id: "ed-7", name: "Luke", phone: "", email: "", role: "editor", defaultDays: { mon: true, tue: true, wed: true, thu: true, fri: true } },
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

// ─── Shared Styles ───
export const TH = { padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "2px solid var(--border)", background: "var(--card)" };
export const TD = { padding: "6px 10px", borderBottom: "1px solid var(--border-light)" };
export const NB = { height: 36, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 12px" };
export const BTN = { padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer" };

// ─── CSS ───
export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;600;700;800&display=swap');
:root{--bg:#0B0F1A;--fg:#E8ECF4;--card:#131825;--border:#1E2A3A;--border-light:#161D2C;--muted:#5A6B85;--accent:#0082FA;--accent-soft:rgba(0,130,250,0.12);--bar-bg:#1A2030;--input-bg:#0F1520;}
*{box-sizing:border-box;margin:0;padding:0;}
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;}
input[type="number"]{-moz-appearance:textfield;}
::-webkit-scrollbar{width:6px;height:6px;}
::-webkit-scrollbar-track{background:var(--bg);}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
`;
