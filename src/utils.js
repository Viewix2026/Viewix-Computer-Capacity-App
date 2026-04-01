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

// ─── Delivery Helpers ───
export function newDelivery(clientName, projectName) {
  return { id: `del-${Date.now()}`, clientName: clientName || "", projectName: projectName || "", logoUrl: "", videos: [], createdAt: new Date().toISOString() };
}

export function newVideo() {
  return { id: `v-${Date.now()}`, name: "", link: "", viewixStatus: "In Development", revision1: "", revision2: "", notes: "" };
}
