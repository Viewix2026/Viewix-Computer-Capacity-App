import { GST_RATE, scheduleForVideoType, computeStripeSurcharge } from "../api/_tiers.js";

// ─── Date Helpers ───
export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function tomorrowKey() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getMonday(d) {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day + (day === 0 ? -6 : 1));
  x.setHours(0, 0, 0, 0);
  return x;
}

export function wKey(m) {
  const d = new Date(m);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtD(d) {
  return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function fmtRange(m) {
  const a = new Date(m), b = new Date(a);
  b.setDate(b.getDate() + 4);
  return `${fmtD(a)} - ${fmtD(b)}`;
}

export function fmtLabel(m) {
  return new Date(m).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export function dayDates(m) {
  return [0, 1, 2, 3, 4].map(i => { const d = new Date(m); d.setDate(d.getDate() + i); return d; });
}

export function addW(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n * 7);
  return x;
}

// ─── Editor daily target ───
// Single source of truth for the editor's daily logged-hours target.
// Drives the Today tile in EditorDashboardViewix — label, percent
// fill, and over-target colour flip. Pulled here so producer-driven
// changes only edit one number.
export const EDITOR_DAILY_TARGET_HOURS = 8;
export const EDITOR_DAILY_TARGET_SECS = EDITOR_DAILY_TARGET_HOURS * 3600;

// ─── Time Formatters ───
export function fmtSecs(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? h + "h " : ""}${m > 0 ? m + "m " : ""}${sec}s`;
}

export function fmtSecsShort(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ─── Content Categorization ───
export function categorizeContent(parentName, type) {
  const name = (parentName || "").toLowerCase();
  const t = (type || "").toLowerCase();
  if (name.includes("meta ad") || t.includes("meta ad") || t.includes("meta")) return "Meta Ad";
  if (name.includes("social media") || t.includes("social media") || t.includes("retainer")) return "Social Media";
  if (t.includes("live action") || t.includes("corporate")) return "Corporate Video";
  return "Other";
}

// ─── Capacity Calculations ───
export function doCalc(inp, occ) {
  const mxSD = inp.totalSuites * 5, rCap = occ * inp.hoursPerSuitePerDay, mCap = mxSD * inp.hoursPerSuitePerDay;
  const wl = inp.currentActiveProjects * inp.avgEditHoursPerProject;
  const rU = rCap > 0 ? wl / rCap : 0, fU = mCap > 0 ? wl / mCap : 0;
  const sp = Math.max(0, rCap - wl), emSD = mxSD - occ, edN = Math.ceil(emSD / 5);
  const fc = [];
  let p = inp.currentActiveProjects;
  for (let w = 0; w <= 12; w++) {
    const fw = p * inp.avgEditHoursPerProject, fr = rCap > 0 ? fw / rCap : 0, ff = mCap > 0 ? fw / mCap : 0;
    const sn = Math.ceil(fw / (5 * inp.hoursPerSuitePerDay * inp.targetUtilisation));
    fc.push({ week: w, projects: Math.round(p), workload: Math.round(fw * 10) / 10, realUtil: fr, filledUtil: ff, suitesNeeded: sn });
    p = p - p / inp.avgProjectDuration + inp.newProjectsPerWeek;
  }
  return { occupiedSuiteDays: occ, maxSuiteDays: mxSD, realCapacity: rCap, maxCapacity: mCap, workload: wl, realUtil: rU, filledUtil: fU, spareHours: sp, emptySuiteDays: emSD, editorsNeeded: edN, forecast: fc };
}

// ─── Number/Currency Formatters ───
export const pct = v => `${Math.round(v * 100)}%`;
export const fmtCur = v => v.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ─── Status Color Helpers ───
export function sCol(u) {
  if (u >= 0.95) return { bg: "#FEE2E2", text: "#991B1B", label: "MAXED", border: "#FECACA" };
  if (u >= 0.85) return { bg: "#FEF3C7", text: "#92400E", label: "DANGER", border: "#FDE68A" };
  if (u >= 0.7) return { bg: "#FEF9C3", text: "#854D0E", label: "TIGHT", border: "#FEF08A" };
  return { bg: "#D1FAE5", text: "#065F46", label: "OK", border: "#A7F3D0" };
}

export function gSC(u) {
  if (u >= 0.95) return { bg: "#991B1B", text: "#FEE2E2", label: "MAXED OUT", glow: "0 0 40px rgba(220,38,38,0.3)" };
  if (u >= 0.85) return { bg: "#92400E", text: "#FEF3C7", label: "DANGER", glow: "0 0 40px rgba(245,158,11,0.3)" };
  if (u >= 0.7) return { bg: "#854D0E", text: "#FEF9C3", label: "TIGHT", glow: "0 0 40px rgba(234,179,8,0.3)" };
  return { bg: "#065F46", text: "#D1FAE5", label: "HEALTHY", glow: "0 0 40px rgba(16,185,129,0.3)" };
}

// ─── Grid Helpers ───
export function dayVal(v) {
  if (v === true || v === "in") return "in";
  if (v === "shoot") return "shoot";
  return "off";
}

export function nextState(v) {
  const cur = dayVal(v);
  if (cur === "in") return "shoot";
  if (cur === "shoot") return false;
  return "in";
}

// ─── Logo Background ───
// Returns the background colour to render behind a client logo, based on the
// account's logoBg preference. "white" (default) suits dark/colourful logos,
// "dark" suits white-on-transparent logos, "transparent" lets the card show through.
export function logoBg(pref) {
  if (pref === "dark") return "#1A1D23";
  if (pref === "transparent") return "transparent";
  return "#fff";
}

// ─── Pretty Share URLs ───
// URL-friendly slug from any string. "Woolcott St — Market Leader!" → "woolcott-st-market-leader"
export function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Cryptographically-random public URL prefix.
export function makeShortId(length = 10) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l for legibility
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// Build a pretty share URL: /d/HASH/client-project or /p/HASH/client
// Falls back to the legacy ?d=ID format if no shortId exists yet.
export function deliveryShareUrl(d) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (!d) return origin;
  if (d.shortId) {
    const slug = slugify(`${d.clientName || ""} ${d.projectName || ""}`);
    return `${origin}/d/${d.shortId}${slug ? "/" + slug : ""}`;
  }
  return `${origin}/?d=${d.id}`;
}

// Normalise an image URL to something that actually loads inside an <img>.
// Primary case: Google Drive share links (what producers paste when they
// drop a file in a shared Drive folder) don't work as img sources —
// Drive returns HTML, not image bytes. The `/thumbnail?id=…&sz=…` endpoint
// does return bytes, and handles the "file is publicly shared" check
// the same way the share view does. We also accept the `uc?export=view`
// form Google used to document; it redirects to the same thumbnail path.
//
// Falls through unchanged for non-Drive URLs so Imgur / Cloudinary /
// arbitrary https links keep working as-is.
export function normaliseImageUrl(url, size = 400) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  // Google Drive share link: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  // Also: https://drive.google.com/open?id=FILE_ID
  // Also: https://drive.google.com/uc?export=view&id=FILE_ID
  const m = trimmed.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^#]*\bid=)([A-Za-z0-9_-]{20,})/);
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w${size}`;
  // Reject anything that isn't HTTPS — http:// trips mixed-content
  // blocks on the production HTTPS frontend (image fails to load with
  // a console warning), and `javascript:` / `data:` URLs in an <img>
  // src are an XSS vector if they ever slipped through founder input.
  // Drive thumbnails handled above are always rewritten to https.
  if (!/^https:\/\//i.test(trimmed)) return "";
  return trimmed;
}

// Validate a URL is safe to use as an `<a href>` external link.
// Rejects `javascript:`, `data:`, `file:`, `http:` (insecure) — only
// `https:` passes. Returns the trimmed URL on success or empty string
// on failure so callers can do `href={validateLinkUrl(x) || undefined}`.
export function validateLinkUrl(url) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  let parsed;
  try { parsed = new URL(trimmed); } catch { return ""; }
  if (parsed.protocol !== "https:") return "";
  return trimmed;
}

// Does the given URL belong to a scheduling provider known to allow iframe
// embedding? We maintain a small allow-list rather than trying to iframe
// any arbitrary URL, because many sites block framing via X-Frame-Options
// or CSP frame-ancestors — an iframe on those would silently render
// blank. Providers on this list have been verified to permit framing as
// of 2026: TidyCal, Calendly, Cal.com, SavvyCal.
//
// Matching is hostname-based (not substring) so a URL like
// `https://attacker.example/?x=tidycal.com` can't slip through the
// allow-list and get iframed — a real audit finding from 2026-04.
const EMBEDDABLE_BOOKING_HOSTS = ["tidycal.com", "calendly.com", "cal.com", "savvycal.com"];
export function isEmbeddableBookingUrl(url) {
  if (!url || typeof url !== "string") return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return EMBEDDABLE_BOOKING_HOSTS.some(h => host === h || host.endsWith("." + h));
}

// Convert a YouTube or Loom share URL to its iframe-embed URL. Returns
// empty string for anything else — callers iframe this directly so we
// CANNOT fall through to arbitrary URLs (that would let a founder with
// a typo paste a `javascript:` or attacker-controlled URL into the
// iframe src on the customer-facing thank-you page). Audit finding 2026-04.
const YT_EMBED_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
const LOOM_EMBED_HOSTS = ["loom.com"];
const VIMEO_EMBED_HOSTS = ["vimeo.com", "player.vimeo.com"];
export function embedUrl(url) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  let parsed;
  try { parsed = new URL(trimmed); } catch { return ""; }
  if (parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  // YouTube: watch?v=X  /  youtu.be/X  /  youtube.com/shorts/X
  // Honour list= and t= query params on the way through so playlists
  // and timestamp deep-links survive the rewrite.
  if (YT_EMBED_HOSTS.some(h => host === h || host.endsWith("." + h))) {
    const ytWatch = trimmed.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
    if (ytWatch) {
      const ytPlaylist = trimmed.match(/[?&]list=([\w-]+)/);
      const ytStart = trimmed.match(/[?&]t=(\d+)/);
      const params = [];
      if (ytPlaylist) params.push(`list=${ytPlaylist[1]}`);
      if (ytStart) params.push(`start=${ytStart[1]}`);
      return `https://www.youtube.com/embed/${ytWatch[1]}${params.length ? "?" + params.join("&") : ""}`;
    }
  }
  // Loom: loom.com/share/HASH  →  loom.com/embed/HASH
  if (LOOM_EMBED_HOSTS.some(h => host === h || host.endsWith("." + h))) {
    const loomShare = trimmed.match(/loom\.com\/share\/([a-f0-9]{16,})/);
    if (loomShare) return `https://www.loom.com/embed/${loomShare[1]}`;
  }
  // Vimeo: vimeo.com/123 or vimeo.com/video/123 → player.vimeo.com/video/123.
  // Already-embed URLs pass through unchanged.
  if (VIMEO_EMBED_HOSTS.some(h => host === h || host.endsWith("." + h))) {
    if (host === "player.vimeo.com") return trimmed;
    const vimeoMatch = trimmed.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  }
  // Unrecognised host or URL shape — refuse rather than blindly iframe
  // something that might be hostile or render blank.
  return "";
}

export function saleShareUrl(s) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (!s) return origin;
  if (s.shortId) {
    const slug = slugify(s.clientName || "");
    return `${origin}/s/${s.shortId}${slug ? "/" + slug : ""}`;
  }
  return `${origin}/?s=${s.id}`;
}

// ─── Sale pricing + GST + schedule ─────────────────────────────────
// All founder-entered sale prices live in /salePricing as EX-GST
// numbers. The customer always pays INC-GST (10% on top). Slice
// amounts stored on the sale record are already INC-GST — that's the
// number Stripe charges the card on each instalment.
// (Imports hoisted to the top of the file.)

// Format with cents — for payment page totals, GST lines, invoices.
// (fmtCur above is whole-dollar for dashboard chrome.)
export function fmtCurExact(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Round to cents — avoid the floating-point crumbs that creep in
// when you multiply e.g. 3000.01 * 0.10.
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

// Inputs: totalExGst (number, AUD).
// Returns: { totalExGst, gstAmount, grandTotal } — all rounded to cents.
export function computeGst(totalExGst) {
  const ex   = round2(totalExGst);
  const gst  = round2(ex * GST_RATE);
  const inc  = round2(ex + gst);
  return { totalExGst: ex, gstAmount: gst, grandTotal: inc };
}

// Build the instalment schedule for a sale. Slice amounts are derived
// from the inc-GST grand total, with the final slice absorbing
// rounding so the sum equals grandTotal exactly.
//
//   videoType  — "metaAds" | "socialPremium" | "socialOrganic" | one-off key
//   totalExGst — the ex-GST project total (from /salePricing, may be overridden)
//   depositDate — Date|string|null; dueAt for auto slices is depositDate + dueDaysOffset.
//                 Defaults to now. Manual-trigger slices get dueAt: null.
//
// Each slice: { idx, label, trigger, pct, amount, dueDaysOffset,
//               dueAt, dueLabel, status }
// status is "pending" for every slice at build time — the webhook
// flips it to "paid" with paidAt + stripe refs as Stripe fires events.
export function buildSchedule(videoType, totalExGst, depositDate) {
  const { grandTotal } = computeGst(totalExGst);
  const cfg = scheduleForVideoType(videoType);
  const anchor = depositDate ? new Date(depositDate) : new Date();

  // Compute all slice amounts, then adjust the last one to absorb any
  // rounding drift so Σ slices === grandTotal (in cents).
  const rawAmounts = cfg.slices.map(s => round2(grandTotal * s.pct / 100));
  const sumFirstN  = round2(rawAmounts.slice(0, -1).reduce((a, b) => a + b, 0));
  const lastAmount = round2(grandTotal - sumFirstN);
  const amounts    = [...rawAmounts.slice(0, -1), lastAmount];

  return cfg.slices.map((s, idx) => {
    let dueAt = null;
    let dueLabel = "";
    if (s.trigger === "now") {
      dueAt = anchor.toISOString();
      dueLabel = "Today";
    } else if (s.trigger === "auto" && typeof s.dueDaysOffset === "number") {
      const d = new Date(anchor.getTime());
      d.setDate(d.getDate() + s.dueDaysOffset);
      dueAt = d.toISOString();
      dueLabel = d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
    } else if (s.trigger === "manual") {
      dueAt = null;
      dueLabel = "On project completion";
    }
    // Each slice is its own Stripe charge, so each gets its own
    // 1.73% + 30c surcharge to cover Stripe's 1.7% + 30c fee.
    // slice.amount is the FULL amount Stripe charges the customer
    // (project share + surcharge). projectAmount + surcharge break
    // it down for display.
    const projectAmount = amounts[idx];
    const surcharge = computeStripeSurcharge(projectAmount);
    const amount = round2(projectAmount + surcharge);
    return {
      idx,
      label: s.label,
      trigger: s.trigger,
      pct: s.pct,
      projectAmount,   // share of grandTotal allocated to the project
      surcharge,       // Stripe processing fee passed through to customer
      amount,          // what Stripe actually charges (projectAmount + surcharge)
      dueDaysOffset: s.dueDaysOffset ?? null,
      dueAt,
      dueLabel,
      status: "pending",
    };
  });
}

// Re-derive the schedule if something on the sale changed (e.g.
// founder edited the total after creation but before deposit paid).
// If any slice is already paid, we refuse to rebuild — the record is
// locked once money has moved. Call this before saving totalExGst
// changes to a sale.
export function canRebuildSchedule(sale) {
  return !Array.isArray(sale?.schedule) || sale.schedule.every(s => s.status !== "paid");
}

export function newSale() {
  const videoType  = "metaAds";
  const packageKey = "starter";
  const totalExGst = 0;
  const { gstAmount, grandTotal } = computeGst(totalExGst);
  return {
    id: `sale-${Date.now()}`,
    shortId: makeShortId(),
    videoType,
    packageKey,
    clientName: "",
    logoUrl: "",
    scopeNotes: "",
    // New money fields — totals-based, GST-aware, schedule-driven.
    totalExGst,
    gstAmount,
    grandTotal,
    schedule: buildSchedule(videoType, totalExGst, null),
    // Stripe linkage filled in as checkout completes.
    stripeCustomerId: null,
    stripePaymentMethodId: null,
    stripeSubscriptionId: null,        // socialPremium / socialOrganic only
    stripeSubscriptionScheduleId: null,
    // Top-level paid flag — flipped true once every slice is settled.
    // Kept for dashboard filtering; per-slice state is the source of truth.
    paid: false,
    createdAt: new Date().toISOString(),
  };
}

export function preproductionShareUrl(p) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (!p) return origin;
  if (p.shortId) {
    const slug = slugify(p.companyName || "");
    return `${origin}/p/${p.shortId}${slug ? "/" + slug : ""}`;
  }
  return `${origin}/?p=${p.id}`;
}

// ─── Sherpa Lookup ───
// Match a project / account name against /clients records to find its
// sherpa Google Doc. Old /clients records were typed manually with short
// names ("Canva") in the now-removed Sherpas tab; new ones come from the
// Attio webhook with full registered names ("Canva Pty Ltd"). An exact
// match would miss either side, so we layer three strategies, strictest
// first:
//   1. Exact case-insensitive match.
//   2. Bidirectional startsWith — "Canva Pty Ltd".startsWith("Canva") OR
//      "Canva".startsWith() of the longer one. 4-char floor stops e.g.
//      "AB" matching "ABC Corp".
//   3. First-word match for cases where the registered name diverges
//      after the brand word ("Trimble Geospatial" ↔ "Trimble Group").
// Returns the matched /clients record or null.
export function matchSherpaForName(targetName, clients) {
  if (!targetName) return null;
  const list = Array.isArray(clients) ? clients : Object.values(clients || {}).filter(Boolean);
  const lc = targetName.trim().toLowerCase();
  if (!lc) return null;

  // 1. Exact case-insensitive
  let m = list.find(c => (c?.name || "").trim().toLowerCase() === lc);
  if (m) return m;

  // 2. Bidirectional startsWith (4-char floor on both sides). A brand
  //    stem like "Auto" can collide on multiple records ("Automation
  //    Co" + "Automotive Inc") so we collect all candidates and only
  //    accept a single unambiguous winner — otherwise we punt to the
  //    next strategy / null and let the producer disambiguate via
  //    the explicit Sherpa Doc field on the Account row.
  const swMatches = list.filter(c => {
    const cn = (c?.name || "").trim().toLowerCase();
    if (cn.length < 4 || lc.length < 4) return false;
    return cn.startsWith(lc) || lc.startsWith(cn);
  });
  if (swMatches.length === 1) return swMatches[0];

  // 3. First-word match (4-char floor on the brand word). Same
  //    collision-safety rule as strategy 2.
  const fwTarget = lc.split(/\s+/)[0];
  if (!fwTarget || fwTarget.length < 4) return null;
  const fwMatches = list.filter(c => {
    const cn = (c?.name || "").trim().toLowerCase();
    return cn.split(/\s+/)[0] === fwTarget;
  });
  if (fwMatches.length === 1) return fwMatches[0];
  return null;
}

// ─── Delivery Helpers ───
export function newDelivery(clientName, projectName) {
  return { id: `del-${Date.now()}`, shortId: makeShortId(), clientName: clientName || "", projectName: projectName || "", logoUrl: "", videos: [], createdAt: new Date().toISOString() };
}

// Canonical cross-system video id. Travels with a video record across
// pre-prod scriptTable rows, /deliveries/{id}.videos[], and project
// subtasks (source: "video" / "revision"). Lets automations like the
// "subtask waiting-on-client → delivery video Ready for Review" flow
// resolve the right delivery video without name-matching, which broke
// every time a producer renamed something. 10-char base36 random tail
// avoids Date.now() collisions when several videos are created in the
// same millisecond (e.g. on pre-prod approval batch-seeding).
export function newVideoId() {
  return `v-${Math.random().toString(36).slice(2, 12)}`;
}

export function newVideo() {
  return { id: `v-${Date.now()}`, videoId: newVideoId(), name: "", link: "", viewixStatus: "In Development", revision1: "", revision2: "", notes: "" };
}

// Resolve the /accounts entry that owns a given project. Used by the
// Projects row's Lead column, the editor's task more-info dropdown,
// and the client-goal pill across both views — all of which need
// account-side fields (accountManager / projectLead / goal) without
// requiring every project to have a perfectly-set links.accountId.
//
// Three-tier resolution:
//   1. project.links.accountId → /accounts/{id}   (set by the
//      Attio webhook when a deal flips Won — most reliable).
//   2. project.attioCompanyId  → match account.attioId   (catches
//      projects whose accountId was never stamped, but the canonical
//      Attio id was).
//   3. project.clientName      → match account.companyName (case-
//      insensitive, trimmed)   (catches manually-created accounts not
//      yet linked to Attio, and older project records).
//
// Returns null when nothing matches — callers render an empty / "—"
// state. /accounts arrives as a keyed object, so direct-id lookup is
// O(1); the fallback scans iterate /accounts which is fine at Viewix
// scale (tens of accounts).
export function resolveAccountForProject(project, accounts) {
  if (!project || !accounts) return null;
  const links = project.links || {};
  if (links.accountId && accounts[links.accountId]) return accounts[links.accountId];
  if (project.attioCompanyId) {
    for (const a of Object.values(accounts)) {
      if (a && a.attioId === project.attioCompanyId) return a;
    }
  }
  const wantName = (project.clientName || "").trim().toLowerCase();
  if (wantName) {
    for (const a of Object.values(accounts)) {
      if (a && (a.companyName || "").trim().toLowerCase() === wantName) return a;
    }
  }
  return null;
}
