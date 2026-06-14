// DEV-ONLY preview fixtures for the client portal.
//
// The portal is gated behind Firebase auth (passwordless email link),
// which cannot complete inside the Vite/Claude preview sandbox (popups
// + firebaseapp.com are blocked). This module lets `/clients/?preview`
// render the whole portal against mock data + a mock user so the design
// can be clicked through without signing in.
//
// SAFETY: every reference to this module in ClientPortal.jsx is guarded
// by `import.meta.env.DEV`, which Vite replaces with `false` in prod
// builds. The dead branches fold away, the bindings go unused, and
// Rollup tree-shakes this entire file out of the production bundle.
// (Verified by grepping dist/ for these fixtures — see the PR notes.)
// Nothing here is client-safe redaction logic; it's throwaway sample
// content, never a data path.

export const PREVIEW_USER = {
  uid: "preview-maya",
  email: "maya@chickanji.com.au",
  displayName: "Maya Chen",
};

const AM = {
  name: "Jordan Tan",
  email: "jordan@viewix.com.au",
  phone: "+61 412 884 209",
  photo: null,
  bookingUrl: "https://calendar.app.google/viewix-jordan",
};

// Data-URI logo so the image path renders offline in the sandbox.
const CHICKANJI_LOGO = { url: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="%23ff8a00"/><text x="24" y="31" font-family="Montserrat,Arial" font-size="20" font-weight="800" fill="white" text-anchor="middle">C</text><circle cx="24" cy="40" r="2" fill="white"/></svg>'), bg: "#ff8a00" };

// Test matrix for the chip gating + logos:
//  viral16  — has preprod, NOT all approved → Pre-prod chip only, has logo
//  holaedu8 — has preprod, ALL approved      → both chips, no logo (initials)
//  solfound6 — no preprod, none approved     → no chips, no logo
const PROJECTS = [
  { projectId: "viral16", orgName: "Chickanji", logo: CHICKANJI_LOGO, hasPreprod: true, projectName: "Viral Focused Package", status: "active", phase: 3, productLine: "Social — viral", counts: { total: 6, ready: 5, approved: 3, posted: 2, changes: 1, waiting: 2 }, needsYou: true, accountManager: AM },
  { projectId: "holaedu8", orgName: "Hola Health", logo: null, hasPreprod: true, projectName: "Always-on · Education series", status: "active", phase: 2, productLine: "Social — organic", counts: { total: 8, ready: 8, approved: 8, posted: 5, changes: 0, waiting: 0 }, needsYou: false, accountManager: AM },
  { projectId: "solfound6", orgName: "Solace Beauty", logo: null, hasPreprod: false, projectName: "Founder POV · 6-pack", status: "active", phase: 1, productLine: "Meta ads", counts: { total: 6, ready: 0, approved: 0, posted: 0, changes: 0, waiting: 0 }, needsYou: false, accountManager: AM },
  { projectId: "brandfilm", orgName: "Chickanji", logo: CHICKANJI_LOGO, hasPreprod: false, projectName: "Brand film · 60s", status: "archived", phase: 3, productLine: "Brand film", counts: { total: 1, ready: 1, approved: 1, posted: 1, changes: 0, waiting: 0 }, needsYou: false, accountManager: AM },
  { projectId: "winterads", orgName: "Hola Health", logo: null, hasPreprod: true, projectName: "Performance ads · winter", status: "archived", phase: 3, productLine: "Meta ads", counts: { total: 8, ready: 8, approved: 8, posted: 8, changes: 0, waiting: 0 }, needsYou: false, accountManager: AM },
];

const VIRAL_ROWS = [
  { id: "v1", idx: 0, n: 1, title: "Hook test — POV walking into the pass", link: "#", viewixStatus: "Completed", revision1: "Approved", revision2: "", posted: true, caption: "When the charcoal hits different 🔥 #charcoalchicken #sydneyeats" },
  { id: "v2", idx: 1, n: 2, title: "Charcoal chicken ASMR — the crunch", link: "#", viewixStatus: "Completed", revision1: "Approved", revision2: "", posted: true, caption: "Sound on. That's the sound of lunch sorted." },
  { id: "v3", idx: 2, n: 3, title: "Founder story — why we started Chickanji", link: "#", viewixStatus: "Ready for Review", revision1: "", revision2: "", posted: false, caption: "Three mates, one grill, zero regrets. Here's how it began." },
  { id: "v4", idx: 3, n: 4, title: "Behind the pass — the lunch rush", link: "#", viewixStatus: "Ready for Review", revision1: "", revision2: "", posted: false, caption: "12:30pm chaos, plated calm. Service never stops." },
  { id: "v5", idx: 4, n: 5, title: "Customer reaction reel — first bite", link: "#", viewixStatus: "Need Revisions", revision1: "Need Revisions", revision2: "", posted: false, caption: "" },
  { id: "v6", idx: 5, n: 6, title: "Menu drop — the new smoky wings", link: "#", viewixStatus: "Completed", revision1: "Approved", revision2: "", posted: false, caption: "New wings just landed. Smoky, sticky, gone by 2pm." },
];

function detail(p, rows, preprodType) {
  return {
    orgName: p.orgName,
    logo: p.logo || null,
    projectName: p.projectName,
    status: p.status,
    phase: p.phase,
    productLine: p.productLine,
    accountManager: AM,
    deliveries: rows.length
      ? { available: true, counts: p.counts, rows }     // deliveryId omitted: writes stay inert in preview
      : { available: false, counts: p.counts },
    // Gated on the project's hasPreprod so the pre-prod pill hides when
    // unlinked. embeddable:false renders the clean "open in its own
    // page" card — an embedded iframe to /p/{id} can't auth in sandbox.
    preproduction: p.hasPreprod
      ? { available: true, embeddable: false, url: "#", type: preprodType || "metaAds" }
      : { available: false },
  };
}

// Built on demand — NOT a top-level const map. A `const X = { k: fn() }`
// runs fn() at module-init, which Rollup can't prove pure, so it would
// pin this whole module into the prod bundle even when unused. Keeping
// every top-level binding a pure literal lets the DEV-gated tree-shake
// drop the file entirely from production.
function projectDetail(id) {
  if (id === "viral16") return detail(PROJECTS[0], VIRAL_ROWS, "socialOrganic");
  if (id === "holaedu8") return detail(PROJECTS[1], VIRAL_ROWS.slice(0, 3).map((r, i) => ({ ...r, id: "h" + i, title: ["Insulin 101 — the 60-second explainer", "Myth-busting: carbs aren't the enemy", "Ask a dietitian — your DMs answered"][i], viewixStatus: i === 0 ? "Completed" : "Ready for Review", revision1: i === 0 ? "Approved" : "", posted: i === 0 })), "socialOrganic");
  if (id === "brandfilm") return detail(PROJECTS[3], [{ id: "b1", idx: 0, n: 1, title: "Chickanji — brand film 60s master", link: "#", viewixStatus: "Completed", revision1: "Approved", revision2: "", posted: true, caption: "" }], "metaAds");
  const p = PROJECTS.find(x => x.projectId === id);
  return detail(p || { orgName: "Your organisation", projectName: "Project", status: "active", phase: 0, productLine: "Project", counts: { total: 0, ready: 0, approved: 0, posted: 0, changes: 0, waiting: 0 } }, [], "metaAds");
}

const SCHEDULE = {
  viral16: [
    { postAt: "2026-06-16T09:00:00+10:00", videoName: "Hook test — POV walking into the pass", caption: "When the charcoal hits different 🔥", platforms: ["instagram", "tiktok"], status: "posted", permalink: "#" },
    { postAt: "2026-06-18T17:30:00+10:00", videoName: "Charcoal chicken ASMR — the crunch", caption: "Sound on.", platforms: ["instagram"], status: "posted", permalink: "#" },
    { postAt: "2026-06-21T12:00:00+10:00", videoName: "Founder story — why we started Chickanji", caption: "Three mates, one grill.", platforms: ["instagram", "youtube"], status: "pending" },
    { postAt: "2026-06-24T18:00:00+10:00", videoName: "Menu drop — the new smoky wings", caption: "New wings just landed.", platforms: ["instagram", "tiktok"], status: "pending" },
  ],
};

const ANALYTICS = {
  hasAccess: true,
  accounts: [{
    accountId: "chickanji",
    name: "Chickanji",
    projection: {
      header: {
        companyName: "Chickanji",
        momentumSentence: "A clear step up from your last 30 days.",
        heroProof: "Your strongest videos this month are short charcoal-chicken hero shots. The top one reached 4.8x your usual views.",
        positive: true,
        gathering: false,
      },
      meta: {
        freshnessLine: "Updated 12 June. Based on public Instagram data we can access.",
        dataState: { header: "ready", winning: "ready", nextVideos: "ready", formatPlaybook: "ready", story: "ready", niche: "ready" },
        whatThisIncludes: "A monthly read on what's working across your public Instagram videos.",
      },
      winning: [
        { multiple: 4.8, formatLabel: "Food hero shot · 0:18", winLabel: "4.8x your usual views", views: 47200, likes: 3100, comments: 127, caption: "When the charcoal hits different - the smoky wing drop", postUrl: "#", thumbnail: null },
        { multiple: 2.9, formatLabel: "ASMR · 0:24", winLabel: "2.9x your usual views", views: 28400, likes: 1900, comments: 64, caption: "Sound on - the crunch on the new smoky wings", postUrl: "#", thumbnail: null },
        { multiple: 1.9, formatLabel: "Founder story · 0:41", winLabel: "1.9x your usual views", views: 19000, likes: 1200, comments: 88, caption: "Three mates, one grill - why we started Chickanji", postUrl: "#", thumbnail: null },
        { multiple: 1.5, formatLabel: "Behind the pass · 0:30", winLabel: "1.5x your usual views", views: 15200, likes: 940, comments: 41, caption: "12:30 lunch rush, plated calm", postUrl: "#", thumbnail: null },
      ],
      nextVideos: [
        { idea: "Another charcoal hero shot - try the new loaded fries", why: "Your food hero shots are pulling 1.4x your usual reach. Same format, a menu item your audience hasn't seen yet.", sourcePostUrl: "#" },
        { idea: "Founder rapid-fire - top 5 questions about the grill", why: "Your founder clips keep the trust and your audience is asking for more of the story.", sourcePostUrl: "#" },
        { idea: "ASMR close-up of the wing sauce pour", why: "Short ASMR is hot in your space right now - a low-effort cousin of your best post.", sourcePostUrl: null },
      ],
      formatPlaybook: [
        { format: "food hero shot", comparisonSentence: "Your food hero shots pull 1.4x your usual views.", sampleWords: "based on 6 posts so far" },
        { format: "ASMR", comparisonSentence: "ASMR clips run 1.1x your usual.", sampleWords: "based on 4 posts so far" },
        { format: "founder story", comparisonSentence: "Founder stories are about 1.0x - your baseline.", sampleWords: "based on 5 posts so far" },
        { format: "behind the scenes", comparisonSentence: "Behind-the-scenes is at 0.7x so far.", sampleWords: "based on 3 posts so far" },
      ],
      story: {
        sinceLabel: "since 12 March 2026",
        postsPublished: 28,
        bestPost: { caption: "When the charcoal hits different", views: 47200, postUrl: "#" },
        followerTrajectory: { start: 142, latest: 2184, label: "followers" },
      },
      niche: {
        comparisonSentence: "Your average reel reaches 1.4x the typical account in your space right now.",
        marketTakeaways: [
          { takeaway: "Charcoal-grill spots are leading with close-up food hero shots under 20 seconds.", sourcePostUrl: "#" },
          { takeaway: "Founder-on-camera 'why we started' clips are over-indexing across local food.", sourcePostUrl: "#" },
        ],
      },
    },
  }],
};

// Drop-in for authFetch. Returns a Response-like object (ok / status /
// json()) so callers need no changes.
export function previewFetch(input) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const qIndex = url.indexOf("?");
  const path = qIndex === -1 ? url : url.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? "" : url.slice(qIndex + 1));
  let data;
  let status = 200;
  if (path === "/api/client/projects") {
    data = { displayName: "Maya", projects: PROJECTS };
  } else if (path === "/api/client/project") {
    data = projectDetail(params.get("id"));
  } else if (path === "/api/client/analytics") {
    data = ANALYTICS;
  } else if (path === "/api/client/posting-schedule") {
    data = { items: SCHEDULE[params.get("projectId")] || [] };
  } else if (path === "/api/client/social-connections") {
    data = { accounts: [] };
  } else {
    status = 404;
    data = { error: "preview: no mock for " + path };
  }
  return Promise.resolve({ ok: status < 400, status, json: async () => data });
}
